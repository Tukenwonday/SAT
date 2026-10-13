#!/usr/bin/env python3
"""Remove figure-region text (chart ticks, legend words, table cells) from the
question strings of figure entries by dropping get_text() lines whose bbox
center falls inside the figure clip, then re-parsing. The figure now lives
in fig/*.png, so the text copy is redundant noise.
"""
import fitz
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_db import parse_entry, group_entries
from build_figs import figure_clip

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "sat_db.json"
QPDF = BASE / "questions.pdf"


def page_lines(page):
    """Return (text_lines, bboxes) paired 1:1, or (None, None)."""
    tl = page.get_text().splitlines()
    bl = []
    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 0:
            continue
        for line in b["lines"]:
            bl.append(fitz.Rect(line["bbox"]))
    if len(tl) != len(bl):
        return None, None
    return tl, bl


def main():
    db = json.load(open(DB_PATH, encoding="utf-8"))
    doc = fitz.open(QPDF)
    # rebuild Q-side grouping to stitch multi-page entries identically
    q_groups = group_entries(doc)
    assert len(q_groups) == 1845
    by_id_page = {}
    for g in q_groups:
        t = g["texts"][0]
        import re
        m = re.search(r"Question ID:\s*([0-9a-fA-F]+)", t)
        by_id_page[m.group(1).lower()] = g

    fixed = same = unpaired = bad = 0
    for e in db:
        if not e.get("fig"):
            continue
        g = by_id_page[e["id"]]
        page = doc[e["q_page"] - 1]
        clip, n, _ = figure_clip(page)
        if clip is None:
            continue
        tl, bl = page_lines(page)
        if tl is None:
            unpaired += 1
            continue
        drop = set()
        for i, r in enumerate(bl):
            cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
            if clip.x0 - 1 < cx < clip.x1 + 1 and clip.y0 - 1 < cy < clip.y1 + 1:
                drop.add(i)
        kept = [ln for i, ln in enumerate(tl) if i not in drop]
        texts = ["\n".join(kept)] + g["texts"][1:]
        d = parse_entry("\n".join(texts))
        if d is None or not d["question"] or set(d["choices"]) != {"A", "B", "C", "D"}:
            bad += 1
            print(f"  REPARSE-FAIL {e['id']}")
            continue
        if d["choices"] != e["choices"]:
            bad += 1
            print(f"  CHOICES-CHANGED {e['id']}")
            continue
        if d["question"] == e["question"]:
            same += 1
        else:
            e["question"] = d["question"]
            # prefer fuller field values (unchanged in practice)
            for k in ("assessment", "test", "domain", "skill", "difficulty"):
                e[k] = d[k] or e[k]
            fixed += 1
    json.dump(db, open(DB_PATH, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"cleaned: {fixed}, already-clean: {same}, "
          f"unpaired-lines: {unpaired}, failed: {bad}")


if __name__ == "__main__":
    main()
