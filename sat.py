#!/usr/bin/env python3
"""SAT answer checker — interactive quiz + batch checker for sat_db.json.

Usage:
  python sat.py quiz [--n 20] [--domain X] [--skill Y] [--difficulty Z]
                     [--no-shuffle] [--only-misses] [--seed N]
  python sat.py check <question-id> <your-answer>   # one-off check
  python sat.py show <question-id>                  # full Q + answer + rationale
  python sat.py batch <answers.txt>                 # file lines: "<id> <A|B|C|D>"
  python sat.py stats                               # progress so far
  python sat.py fig <question-id> [--out DIR]       # render Q page(s) to PNG
                                                    # (for graph/figure questions)

Progress is saved to progress.json next to this script.
"""
import argparse
import json
import random
import re
import sys
import textwrap
from collections import Counter
from pathlib import Path

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "sat_db.json"
PROG_PATH = BASE / "progress.json"
WIDTH = 100


def wrap(s):
    s = re.sub(r"</?u>", "", s or "")
    return textwrap.fill(s, width=WIDTH) if s else "(missing)"


def load_db():
    if not DB_PATH.exists():
        sys.exit(f"missing {DB_PATH} — run: python build_db.py")
    with open(DB_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_progress():
    if PROG_PATH.exists():
        try:
            with open(PROG_PATH, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_progress(prog):
    with open(PROG_PATH, "w", encoding="utf-8") as f:
        json.dump(prog, f, indent=1)


def record(prog, qid, ok, given):
    e = prog.get(qid, {"attempts": 0, "correct": 0})
    e["attempts"] += 1
    e["correct"] += 1 if ok else 0
    e["last"] = given
    e["ok"] = ok
    prog[qid] = e


def print_question(e, num=None, total=None):
    tag = f"[{num}/{total}] " if num else ""
    print("=" * WIDTH)
    print(f"{tag}ID {e['id']}  |  {e['domain']} / {e['skill']} / "
          f"{e['difficulty']}")
    print(f"questions.pdf p.{e['q_page']}   answers.pdf p.{e['a_page']}")
    if e.get("needs_figure"):
        print("!! uses a graph/figure/table -> look at "
              f"questions.pdf p.{e['q_page']} for the visual "
              f"(or run: python sat.py fig {e['id']})")
    print("-" * WIDTH)
    print(wrap(e["question"]))
    print()
    for k in ("A", "B", "C", "D"):
        v = e["choices"].get(k, "")
        print(f"  {k}. " + (wrap(v) if v else "(choice text missing in "
                             "source PDF)"))
    print()


def print_result(e, given):
    correct = e["correct"]
    ok = given == correct
    print("CORRECT!" if ok else f"WRONG — correct answer: {correct}")
    print(f"(answers.pdf p.{e['a_page']})")
    if e.get("rationale"):
        print("-" * WIDTH)
        print(wrap(e["rationale"]))
    print()
    return ok


def filter_db(db, args):
    out = db
    if args.domain:
        out = [e for e in out
               if args.domain.lower() in e["domain"].lower()]
    if args.skill:
        out = [e for e in out
               if args.skill.lower() in e["skill"].lower()]
    if args.difficulty:
        out = [e for e in out
               if e["difficulty"].lower() == args.difficulty.lower()]
    return out


def cmd_quiz(args):
    db = load_db()
    pool = filter_db(db, args)
    if args.only_misses:
        prog = load_progress()
        missed = {qid for qid, v in prog.items() if not v.get("ok", True)}
        pool = [e for e in pool if e["id"] in missed]
    if not pool:
        sys.exit("no questions match those filters (try --only-misses after "
                 "a quiz, or loosen filters).")
    if args.shuffle:
        rnd = random.Random(args.seed)
        rnd.shuffle(pool)
    items = pool[:args.n] if args.n else pool
    prog = load_progress()
    score = 0
    answered = 0
    skips = 0
    print(f"{len(items)} question(s). Type A/B/C/D, or S to reveal, Q to quit.")
    try:
        for i, e in enumerate(items, 1):
            print_question(e, i, len(items))
            while True:
                try:
                    given = input("Your answer [A-D, S=reveal, Q=quit]: "
                                  ).strip().upper()
                except EOFError:
                    print()
                    given = "Q"
                if given in ("Q", "QUIT", "EXIT"):
                    print(f"\nStopped. Score so far: {score}/{answered} "
                          f"({skips} revealed).")
                    save_progress(prog)
                    return
                if given in ("S", "SKIP", "REVEAL"):
                    print(f"-- revealed: correct answer is {e['correct']} "
                          f"(answers.pdf p.{e['a_page']})")
                    if e.get("rationale"):
                        print(wrap(e["rationale"]))
                    print()
                    skips += 1
                    break
                if given in ("A", "B", "C", "D"):
                    ok = print_result(e, given)
                    record(prog, e["id"], ok, given)
                    answered += 1
                    score += 1 if ok else 0
                    break
                print("  enter A, B, C, D, S, or Q.")
    except KeyboardInterrupt:
        print()
    save_progress(prog)
    print("=" * WIDTH)
    print(f"FINAL: {score}/{answered} correct "
          f"({score / answered * 100:.1f}%)" if answered else "No answers given.")
    if answered:
        wrong = [e["id"] for e in items[:answered]]
        prog2 = load_progress()
        misses = [qid for qid in wrong
                  if qid in prog2 and not prog2[qid].get("ok")]
        if misses:
            print(f"Missed ({len(misses)}): {' '.join(misses)}")
            print("Re-quiz misses with: python sat.py quiz --only-misses")


def cmd_check(args):
    db = {e["id"]: e for e in load_db()}
    qid = args.id.lower()
    e = db.get(qid)
    if not e:
        sys.exit(f"unknown ID '{args.id}'. IDs look like: f1bfbed3")
    given = args.answer.strip().upper()
    if given not in ("A", "B", "C", "D"):
        sys.exit("answer must be A, B, C, or D")
    print_question(e)
    ok = print_result(e, given)
    prog = load_progress()
    record(prog, qid, ok, given)
    save_progress(prog)


def cmd_show(args):
    db = {e["id"]: e for e in load_db()}
    qid = args.id.lower()
    e = db.get(qid)
    if not e:
        sys.exit(f"unknown ID '{args.id}'. IDs look like: f1bfbed3")
    print_question(e)
    print(f"Correct answer: {e['correct']}  (answers.pdf p.{e['a_page']})")
    if e.get("rationale"):
        print("-" * WIDTH)
        print(wrap(e["rationale"]))


def parse_batch_line(line):
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    parts = re.split(r"[\s,=;:]+", line)
    parts = [p for p in parts if p]
    if len(parts) < 2:
        return None
    return parts[0].lower(), parts[1].upper()


def cmd_batch(args):
    db = {e["id"]: e for e in load_db()}
    try:
        lines = Path(args.file).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        sys.exit(f"cannot read {args.file}: {exc}")
    prog = load_progress()
    results = []
    for lineno, line in enumerate(lines, 1):
        parsed = parse_batch_line(line)
        if parsed is None:
            continue
        qid, given = parsed
        e = db.get(qid)
        if e is None:
            print(f"line {lineno}: unknown ID '{qid}' — skipped")
            continue
        if given not in ("A", "B", "C", "D"):
            print(f"line {lineno}: bad answer '{given}' for {qid} — skipped")
            continue
        ok = given == e["correct"]
        record(prog, qid, ok, given)
        results.append((e, given, ok))
    save_progress(prog)
    if not results:
        sys.exit("no valid '<id> <answer>' lines found.")
    score = sum(1 for _, _, ok in results if ok)
    for e, given, ok in results:
        mark = "OK " if ok else "X  "
        print(f"{mark} {e['id']}  yours={given}  correct={e['correct']}  "
              f"{e['skill']}/{e['difficulty']}  "
              f"(Q p.{e['q_page']}, A p.{e['a_page']})")
    print("-" * WIDTH)
    print(f"SCORE: {score}/{len(results)} ({score / len(results) * 100:.1f}%)")
    for label, key in (("by skill", "skill"), ("by difficulty", "difficulty"),
                       ("by domain", "domain")):
        c_ok, c_tot = Counter(), Counter()
        for e, _, ok in results:
            c_tot[e[key] or "?"] += 1
            c_ok[e[key] or "?"] += 1 if ok else 0
        print(f"-- {label}: " + ", ".join(
            f"{k} {c_ok[k]}/{c_tot[k]}" for k in sorted(c_tot)))
    misses = [e["id"] for e, _, ok in results if not ok]
    if misses:
        print(f"Missed: {' '.join(misses)}")


def cmd_stats(_args):
    prog = load_progress()
    db = {e["id"]: e for e in load_db()}
    if not prog:
        print("no attempts yet — run: python sat.py quiz")
        return
    att = sum(v["attempts"] for v in prog.values())
    cor = sum(v["correct"] for v in prog.values())
    print(f"attempted questions: {len(prog)}  total attempts: {att}  "
          f"overall: {cor}/{att} ({cor / att * 100:.1f}%)")
    for label, key in (("skill", "skill"), ("difficulty", "difficulty"),
                       ("domain", "domain")):
        c_ok, c_tot = Counter(), Counter()
        for qid, v in prog.items():
            e = db.get(qid)
            k = (e[key] if e and e[key] else "?")
            c_tot[k] += v["attempts"]
            c_ok[k] += v["correct"]
        print(f"-- by {label}:")
        for k in sorted(c_tot):
            print(f"   {k}: {c_ok[k]}/{c_tot[k]} "
                  f"({c_ok[k] / c_tot[k] * 100:.0f}%)")


def cmd_fig(args):
    try:
        import fitz
    except ImportError:
        sys.exit("pymupdf not installed — run: pip install pymupdf")
    db = {e["id"]: e for e in load_db()}
    qid = args.id.lower()
    e = db.get(qid)
    if not e:
        sys.exit(f"unknown ID '{args.id}'.")
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(BASE / "questions.pdf")
    for p in e["q_pages"]:
        pix = doc[p - 1].get_pixmap(matrix=fitz.Matrix(2, 2))
        out = outdir / f"fig_{qid}_q-p{p}.png"
        pix.save(out)
        print(f"saved {out}")


def main():
    ap = argparse.ArgumentParser(description="SAT answer checker")
    sub = ap.add_subparsers(dest="cmd", required=True)

    q = sub.add_parser("quiz", help="interactive quiz")
    q.add_argument("--n", type=int, default=20)
    q.add_argument("--domain", default="")
    q.add_argument("--skill", default="")
    q.add_argument("--difficulty", default="")
    q.add_argument("--shuffle", dest="shuffle", action="store_true",
                   default=True)
    q.add_argument("--no-shuffle", dest="shuffle", action="store_false")
    q.add_argument("--only-misses", action="store_true")
    q.add_argument("--seed", type=int, default=None)
    q.set_defaults(func=cmd_quiz)

    c = sub.add_parser("check", help="check one answer")
    c.add_argument("id")
    c.add_argument("answer")
    c.set_defaults(func=cmd_check)

    s = sub.add_parser("show", help="show full Q + answer + rationale")
    s.add_argument("id")
    s.set_defaults(func=cmd_show)

    b = sub.add_parser("batch", help="check answers file (id + answer/line)")
    b.add_argument("file")
    b.set_defaults(func=cmd_batch)

    st = sub.add_parser("stats", help="show saved progress stats")
    st.set_defaults(func=cmd_stats)

    f = sub.add_parser("fig", help="export question page(s) as PNG")
    f.add_argument("id")
    f.add_argument("--out", default=".")
    f.set_defaults(func=cmd_fig)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
