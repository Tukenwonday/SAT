#!/usr/bin/env python3
"""Enrich sat_db.json with clean bullet formatting for all Rhetorical Synthesis notes questions.
Extracts vector bullet geometries from the answers PDF and produces clean bulleted notes.
"""
import fitz
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
from build_db import clean
DB_PATH = BASE / "sat_db.json"
PDF_PATH = BASE / "questionbank-export-2026-10-23.pdf"
if not PDF_PATH.exists():
    PDF_PATH = BASE / "answers.pdf"

if not PDF_PATH.exists():
    raise SystemExit(f"Missing PDF: {PDF_PATH}")

doc = fitz.open(PDF_PATH)
db = json.load(open(DB_PATH, encoding="utf-8"))

id_to_page = {}
for i, page in enumerate(doc):
    txt = page.get_text()
    m = re.search(r"Question ID:\s*([0-9a-fA-F]+)", txt)
    if m:
        id_to_page[m.group(1).lower()] = i

updated = 0
for q in db:
    if "taken the following notes" not in q["question"]:
        continue
    qid = q["id"]
    page_idx = id_to_page.get(qid)
    if page_idx is None:
        continue
    page = doc[page_idx]
    bullets = sorted([d["rect"] for d in page.get_drawings() if 35 < d["rect"].x0 < 40 and d["rect"].y0 > 140], key=lambda r: r.y0)
    if not bullets:
        continue
    blocks = page.get_text("dict")["blocks"]
    lines = [l for b in blocks if "lines" in b for l in b["lines"] if l["bbox"][1] > 140]
    task_lines = [l for l in lines if l["bbox"][0] < 30 and l["bbox"][1] > bullets[-1].y0]
    task_y = task_lines[0]["bbox"][1] if task_lines else 9999
    
    header_lines = [l for l in lines if l["bbox"][1] < bullets[0].y0 and "taken the following notes" in "".join(s["text"] for s in l["spans"])]
    header = clean(" ".join("".join(s["text"] for s in l["spans"]).strip() for l in header_lines)) or "While researching a topic, a student has taken the following notes:"
    
    notes_list = []
    for idx, b in enumerate(bullets):
        y_min = b.y0 - 5
        y_max = bullets[idx+1].y0 - 5 if idx + 1 < len(bullets) else task_y - 2
        note_lines = [l for l in lines if y_min <= l["bbox"][1] < y_max and l["bbox"][0] > 40]
        raw = " ".join("".join(s["text"] for s in l["spans"]).strip() for l in note_lines)
        c = clean(raw)
        if c:
            notes_list.append(c)
    
    task_lines_all = [l for l in lines if l["bbox"][1] >= task_y - 2]
    task_text_lines = []
    for l in task_lines_all:
        ltxt = "".join(s["text"] for s in l["spans"]).strip()
        if ltxt == "Answer":
            break
        task_text_lines.append(ltxt)
    task_text = clean(" ".join(task_text_lines))
    if "The student wants" not in task_text:
        s_idx = q["question"].find("The student wants")
        if s_idx != -1:
            task_text = q["question"][s_idx:]
        
    if len(notes_list) >= 2 and "The student wants" in task_text:
        new_q = header + "\n\n" + "\n\n".join("• " + n for n in notes_list) + "\n" + task_text
        q["question"] = new_q
        updated += 1

print(f"Updated {updated} notes questions in {DB_PATH}")

with open(DB_PATH, "w", encoding="utf-8") as f:
    json.dump(db, f, ensure_ascii=False, indent=1)

print("Saved updated sat_db.json successfully.")
