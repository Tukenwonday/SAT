#!/usr/bin/env python3
"""Extract figure/chart regions from questions.pdf as PNGs.

Charts are vector drawings (not embedded images), so this script finds the
figure region per question page via drawing/text geometry and renders a
clipped PNG into fig/. Patches sat_db.json: sets entry["fig"] and refines
entry["needs_figure"] (keyword match + real vector graphics required).
"""
import fitz
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "sat_db.json"
FIGDIR = BASE / "fig"
QPDF = BASE / "questions.pdf"

TOP = 140.0          # below the "Question" label (ends y=135 on every page)
MIN_DRAWINGS = 5     # fewer than this below TOP = noise, not a figure
PAD = 10.0
ZOOM = 2.0
# table rows extract as full-width blocks, so "full width" alone does not
# mean passage text; only blocks starting well below the graphics do.
BELOW_TOL = 15.0
Q_SENTENCE_RE = re.compile(
    r"^(Which|What|How|Why|Based on|According to|Answer|[A-D]\.)\b")


def is_full_width(b):
    x0, y0, x1, y1 = b["bbox"]
    return (x1 - x0) > 400 and x0 < 60


def block_text(b):
    return " ".join(s["text"] for line in b["lines"] for s in line["spans"])


def figure_clip(page):
    """Return (clip_rect, n_drawings, included_texts) or (None, n, [])."""
    drawings = [d for d in page.get_drawings() if d["rect"].y0 > TOP]
    if len(drawings) < MIN_DRAWINGS:
        return None, len(drawings), []
    boxes = [d["rect"] for d in drawings]
    x0 = min(r.x0 for r in boxes)
    y0 = min(r.y0 for r in boxes)
    x1 = max(r.x1 for r in boxes)
    y1 = max(r.y1 for r in boxes)
    dy1 = y1
    # figure text: non-full-width blocks near the graphics band
    texts = []
    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 0:
            continue
        r = fitz.Rect(b["bbox"])
        if r.y0 <= TOP:
            continue
        if is_full_width(b):
            continue
        if r.y0 < dy1 + 10:
            texts.append((r, block_text(b)))
            x0 = min(x0, r.x0)
            y0 = min(y0, r.y0)
            x1 = max(x1, r.x1)
            y1 = max(y1, r.y1)
    clip = fitz.Rect(max(4, x0 - PAD), max(TOP - 4, y0 - 8),
                     min(608, x1 + PAD), y1 + PAD)
    return clip, len(drawings), texts


def main():
    db = json.load(open(DB_PATH, encoding="utf-8"))
    doc = fitz.open(QPDF)
    FIGDIR.mkdir(exist_ok=True)
    n_img = n_off = 0
    problems = []
    for e in db:
        if not e.get("needs_figure"):
            e["fig"] = None
            continue
        page = doc[e["q_page"] - 1]
        clip, n, texts = figure_clip(page)
        if clip is None:
            # keyword matched but no real figure graphics on the page
            e["needs_figure"] = False
            e["fig"] = None
            n_off += 1
            continue
        # sanity: no question/choice sentence may be inside the clip, and
        # the clip must end before true passage text (full-width blocks
        # starting well below the graphics; table rows inside the grid
        # are fine and expected)
        for r, t in texts:
            if Q_SENTENCE_RE.match(t.strip()):
                problems.append((e["id"], e["q_page"], "text: " + t[:60]))
                break
        for b in page.get_text("dict")["blocks"]:
            if b["type"] != 0:
                continue
            r = fitz.Rect(b["bbox"])
            dy1 = clip.y1 - PAD  # unpadded figure bottom approx
            if (r.y0 > TOP and is_full_width(b)
                    and r.y0 > dy1 + BELOW_TOL and r.y0 < clip.y1):
                problems.append((e["id"], e["q_page"], "overlap"))
                break
        pix = page.get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM), clip=clip)
        out = FIGDIR / f"fig_{e['id']}.png"
        pix.save(out)
        e["fig"] = f"fig/{out.name}"
        n_img += 1
    json.dump(db, open(DB_PATH, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    total_mb = sum(p.stat().st_size for p in FIGDIR.glob("*.png")) / 1e6
    print(f"figures extracted: {n_img}, flags cleared (no graphics): {n_off}")
    print(f"fig/ size: {total_mb:.1f} MB")
    if problems:
        print(f"WARNING: {len(problems)} suspicious clips:")
        for qid, p, why in problems[:15]:
            print(f"  {qid} (Q p.{p}): {why}")


if __name__ == "__main__":
    main()
