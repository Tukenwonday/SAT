#!/usr/bin/env python3
"""Detect underlined text in questions.pdf / answers.pdf and mark it in sat_db.json.

Underlines are stored in the PDFs as thin horizontal drawings just below the
text baseline (not as font flags), so the text extractor drops them. This
script maps each underline segment to the characters it covers and wraps those
runs in <u>...</u> inside question / choices / rationale strings.

PIPELINE NOTE: run AFTER clean_figtext.py (it needs final strings + fig links):
    python build_db.py -> python build_figs.py -> python clean_figtext.py
    -> python build_underline.py
The script is idempotent (strips existing <u> tags before re-marking).

Method per entry:
  1. Take geometry from answers.pdf a_pages (question/choices/rationale source),
     falling back to questions.pdf q_pages for question/choices.
  2. Keep body text lines (below header, outside figure clip for fig entries),
     drop header marker lines.
  3. Underline candidates = thin horizontal drawings near a text line bottom,
     with no other text line starting just below (fraction-bar guard).
  4. Align final strings to geometry on alphanumeric sequences and transfer
     underline flags, then wrap runs in <u>.
"""
import fitz
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "sat_db.json"
QPDF = BASE / "questions.pdf"
APDF = BASE / "answers.pdf"

TOP = 140.0  # header height on entry-start pages ("Question" label ends y=135)
# continuation pages start with body text at the top, so no band is skipped
MARKERS = {"assessment", "test", "difficulty", "question", "answer", "rationale"}
U_RE = re.compile(r"</?u>")


def thin_segs(page, top):
    """Thin horizontal drawings below the header band."""
    out = []
    for d in page.get_drawings():
        r = d["rect"]
        if abs(r.y1 - r.y0) < 2.5 and (r.x1 - r.x0) > 5 and r.y0 > top:
            out.append((r.x0, r.y0, r.x1))
    return out


def page_lines(page, clip, top):
    """Kept body lines: (text, spans[(text, x0, x1)], y0, y1) in reading order."""
    kept = []
    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 0:
            continue
        for line in b["lines"]:
            r = fitz.Rect(line["bbox"])
            if r.y0 <= top:
                continue
            if clip is not None:
                cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
                if clip.x0 - 1 < cx < clip.x1 + 1 and clip.y0 - 1 < cy < clip.y1 + 1:
                    continue
            text = "".join(s["text"] for s in line["spans"])
            if text.strip().lower() in MARKERS:
                continue
            if text.strip().lower().startswith("question id:"):
                continue
            if text.strip().lower().startswith("correct answer"):
                continue
            spans = [(s["text"], s["bbox"][0], s["bbox"][2]) for s in line["spans"]]
            kept.append({"text": text, "spans": spans,
                         "y0": r.y0, "y1": r.y1})
    return kept


def mark_line(line, segs):
    """Char-level underline flags for one line's text. segs = [(x0, y, x1)]."""
    flags = [False] * len(line["text"])
    if not segs:
        return flags
    # candidate segments near this line's bottom, with no text right below
    # (fraction-bar guard: a denominator line starts just under a bar)
    cands = []
    for (x0, y, x1) in segs:
        if abs(y - (line["y1"] - 1.5)) <= 2.5:
            cands.append((x0, x1))
    if not cands:
        return flags
    pos = 0
    for (t, sx0, sx1) in line["spans"]:
        n = len(t)
        w = (sx1 - sx0) / n if n else 0
        for i in range(n):
            cx = sx0 + (i + 0.5) * w
            if any(x0 - 1 <= cx <= x1 + 1 for (x0, x1) in cands):
                flags[pos + i] = True
        pos += n
    return flags


def build_stream(pages_lines):
    """Concatenate kept lines -> (alnum_str, flags_per_alnum)."""
    chars, flags = [], []
    for (text, fl) in pages_lines:
        for ch, f in zip(text, fl):
            if ch.isalnum():
                chars.append(ch.lower())
                flags.append(f)
    return "".join(chars), flags


def transfer(field, stream, off):
    """Find field's alnum seq in stream from off; return (field_flags, new_off)."""
    seq = [c.lower() for c in field if c.isalnum()]
    if not seq:
        return [False] * len(field), off
    needle = "".join(seq)
    at = stream[0].find(needle, off)
    if at < 0:
        return None, off
    # map alnum positions in field to stream flags
    ff = [False] * len(field)
    j = at
    ai = 0
    for i, ch in enumerate(field):
        if ch.isalnum():
            ff[i] = stream[1][j]
            j += 1
            ai += 1
    # snap runs to whole words: proportional x-mapping can land a boundary
    # a char or two inside a word, but print underlines always cover
    # whole words (extend over adjacent alnum chars only)
    n = len(field)
    for i in range(n):
        if ff[i]:
            j = i - 1
            while j >= 0 and field[j].isalnum() and not ff[j]:
                ff[j] = True
                j -= 1
            j = i + 1
            while j < n and field[j].isalnum() and not ff[j]:
                ff[j] = True
                j += 1
    # fill short non-alnum gaps inside runs (", ", ". ", " ")
    k = 0
    while k < len(field):
        if not ff[k]:
            k += 1
            continue
        m = k
        while m < len(field) and ff[m]:
            m += 1
        # gap of non-flagged run starting at m; look ahead
        g = m
        while g < len(field) and not ff[g] and not field[g].isalnum() and g - m <= 4:
            g += 1
        if g < len(field) and ff[g] and g - m <= 4 and g - m > 0:
            for t in range(m, g):
                ff[t] = True
        k = m if m == k else m
        if m == k:
            k += 1
    return ff, at + len(needle)


def wrap_u(field, ff):
    out, i, n = [], 0, len(field)
    while i < n:
        if not ff[i]:
            out.append(field[i])
            i += 1
            continue
        j = i
        has_alnum = False
        while j < n and ff[j]:
            has_alnum = has_alnum or field[j].isalnum()
            j += 1
        run = field[i:j]
        out.append(f"<u>{run}</u>" if has_alnum else run)
        i = j
    return "".join(out)


def main():
    sys.path.insert(0, str(BASE))
    from build_figs import figure_clip

    db = json.load(open(DB_PATH, encoding="utf-8"))
    qdoc = fitz.open(QPDF)
    adoc = fitz.open(APDF)
    line_cache, seg_cache, clip_cache = {}, {}, {}

    def geo(doc_key, doc, pno, clip, first):
        key = (doc_key, pno, bool(clip), bool(first))
        top = TOP if first else 0.0
        if key not in line_cache:
            page = doc[pno - 1]
            if key not in seg_cache:
                seg_cache[key] = thin_segs(page, top)
            if clip is None:
                cp = None
            else:
                ck = (doc_key, pno)
                if ck not in clip_cache:
                    clip_cache[ck] = figure_clip(page)[0]
                cp = clip_cache[ck]
            lines = page_lines(page, cp, top)
            flagged = [(l["text"], mark_line(l, seg_cache[key])) for l in lines]
            line_cache[key] = flagged
        return line_cache[key]

    marked = skipped = 0
    no_mark_mention = []
    for e in db:
        # strip previous run (idempotent)
        fields = {"question": e["question"],
                  **{f"c{k}": e["choices"].get(k, "") for k in "ABCD"},
                  "rationale": e.get("rationale", "")}
        for k in fields:
            fields[k] = U_RE.sub("", fields[k])
        # primary geometry: answers pages; fallback: questions pages
        clips = e.get("fig")
        a_pages = e.get("a_pages", [])
        a_lines = []
        for i, p in enumerate(a_pages):
            a_lines += geo("a", adoc, p, clips, i == 0)
        q_pages = e.get("q_pages", [])
        q_lines = []
        for i, p in enumerate(q_pages):
            q_lines += geo("q", qdoc, p, clips, i == 0)
        a_stream = build_stream(a_lines)
        q_stream = build_stream(q_lines) if q_lines else (None, None)

        # ordered search with running offsets per stream
        off_a = off_q = 0
        used_any = False
        new_vals = {}
        for k in ["question", "cA", "cB", "cC", "cD"]:
            text = fields[k]
            ff, off_a2 = transfer(text, a_stream, off_a)
            if ff is not None:
                off_a = off_a2
            elif q_stream[0] is not None:
                ff2, off_q2 = transfer(text, q_stream, off_q)
                if ff2 is not None:
                    ff, off_q = ff2, off_q2
                else:
                    skipped += 1
                    new_vals[k] = text
                    continue
            else:
                skipped += 1
                new_vals[k] = text
                continue
            if any(ff):
                used_any = True
            new_vals[k] = wrap_u(text, ff)
        # rationale always comes from the answers copy
        text = fields["rationale"]
        ff, _ = transfer(text, a_stream, 0)
        if ff is None:
            new_vals["rationale"] = text
        else:
            if any(ff):
                used_any = True
            new_vals["rationale"] = wrap_u(text, ff)

        e["question"] = new_vals["question"]
        for k in "ABCD":
            e["choices"][k] = new_vals[f"c{k}"]
        e["rationale"] = new_vals["rationale"]
        if used_any:
            marked += 1
        if "underlin" in e["question"].lower() and "<u>" not in e["question"]:
            no_mark_mention.append(e["id"])

    json.dump(db, open(DB_PATH, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"entries with new <u> marks: {marked}/{len(db)}")
    print(f"fields failed to align (skipped): {skipped}")
    print(f"mention-underline but no mark in question: {len(no_mark_mention)}")
    for qid in no_mark_mention[:15]:
        print(f"  NOMARK {qid}")


if __name__ == "__main__":
    main()
