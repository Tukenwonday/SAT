#!/usr/bin/env python3
"""Build sat_db.json from questions.pdf + answers.pdf.

Groups pages into entries by 'Question ID:' marker (continuation pages
without an ID belong to the previous entry), then parses fields.

Extracted PDF text is sanitized: soft hyphens stripped, words split by
line wraps re-joined (dictionary-validated), inline spacing normalized.

PIPELINE NOTE: this regenerates sat_db.json from scratch (no fig links,
no underline marks). After running, re-run in this order:
  build_figs.py -> clean_figtext.py -> build_underline.py

Output: sat_db.json -> list of:
  {id, assessment, test, domain, skill, difficulty,
   question, choices {A,B,C,D}, correct, rationale,
   q_page, q_pages, a_page, a_pages, needs_figure}
"""
import fitz
import re
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
QPDF = BASE / "questions.pdf"
APDF = BASE / "answers.pdf"
OUT = BASE / "sat_db.json"

ID_RE = re.compile(r"Question ID:\s*([0-9a-fA-F]+)")
CORRECT_RE = re.compile(r"Correct Answer:\s*([A-D])")
CHOICE_START_RE = re.compile(r"^([A-D])\.\s*(.*)$")
FIGURE_RE = re.compile(r"\b(graph|figure|table|chart|diagram|plot)\b")
DIFFICULTIES = ("Easy", "Medium", "Hard")
# Domain/Skill values can wrap across 2 lines in the PDF text layer
# (e.g. 'Standard English' + 'Conventions'), so match by prefix.
KNOWN_DOMAINS = (
    "Information and Ideas",
    "Craft and Structure",
    "Expression of Ideas",
    "Standard English Conventions",
)
KNOWN_TESTS = ("Reading and Writing", "Math")


def group_entries(doc):
    """Split a PDF into entries. Each entry starts at a page containing
    'Question ID:'; following pages without an ID are continuations."""
    entries = []
    for i in range(len(doc)):
        text = doc[i].get_text()
        if "Question ID" in text and ID_RE.search(text):
            entries.append({"pages": [i + 1], "texts": [text]})
        else:
            if not entries:
                print(f"WARNING: page {i + 1} before first ID, skipping",
                      file=sys.stderr)
                continue
            entries[-1]["pages"].append(i + 1)
            entries[-1]["texts"].append(text)
    for e in entries:
        e["full"] = "\n".join(e["texts"])
    return entries


def clean(s):
    """Collapse whitespace and normalize spacing around punctuation."""
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+([.,;:!?%)\]])", r"\1", s)
    s = re.sub(r"([(\[])\s+", r"\1", s)
    return s


_WORDS = None
_ZIPF = None

def get_words():
    """English word set used to validate wrap-join repairs (loaded lazily
    so importing this module stays dependency-free)."""
    global _WORDS, _ZIPF
    if _WORDS is None:
        try:
            from functools import lru_cache
            from wordfreq import top_n_list, zipf_frequency
        except ImportError:
            sys.exit("build_db.py needs the 'wordfreq' package: pip install wordfreq")
        _WORDS = set()
        for t in top_n_list("en", 60000):
            t = t.replace("’", "'").lower()
            if t and t.replace("'", "").isalpha():
                _WORDS.add(t)
        _ZIPF = lru_cache(maxsize=65536)(
            lambda w: zipf_frequency(w, "en"))
        print(f"loaded {len(_WORDS)} words for wrap repair", file=sys.stderr)
    return _WORDS


def _zipf(w):
    return _ZIPF(w)


# soft wrap (\x01) = PDF line break, hyphen wrap (\x02) = line ending in '-'
SEP_RE = re.compile(r"([A-Za-z'’]*[a-z'’])([\x01\x02])([a-z][A-Za-z'’]*)")
LEAD_RE = re.compile("\x01([a-z][A-Za-z'’]*)")
# common two-letter words: the only short fragments that may legitimately
# start a wrapped line (anything else short is a word splinter like 't')
_CORE_TWO = frozenset(
    "to of in on at as is it or an be by do go he me my no so up us we "
    "if am ox ad id ex de et".split()
)
# a right-hand fragment that is really a suffix means a split word
_SUFFIX_FRAGS = frozenset(
    "th est ness tion sion ing ed er es ly al ic ous ment able ible "
    "ful less ize ise ate en ify ne st nd nt rd ld lt ss ll ff ck ty "
    "ry sy ted".split()
)
# a fragment counts as a real word only if reasonably frequent; splinters
# like 'por', 'mar', 'nor' score below this even though they occur in corpora
_MIN_ZIPF = 5.0
# two-letter onsets that never begin an English word ('a|nd' is 'and' split)
_ONSET2 = frozenset({"nd", "ng", "nk", "mb", "mn", "ps", "ts", "ct"})
# spaced readings of these are never valid English ('with in', 'where as')
_ALWAYS_JOIN = frozenset({"within", "without", "throughout", "whereas"})
# prepositions: '[content word] [prep]' is usually a genuine phrase
_PREP = frozenset(
    "in on at to of for by with from over under about into onto upon "
    "among between through during before after above below across against "
    "along around behind beyond despite toward towards within without per "
    "via versus until till since near off out up down".split()
)
# conjunctions: '[content word] [conj]' is usually genuine ('survey|or')
_CONJ = frozenset({"and", "or", "but", "nor", "yet"})


def _counts_as_word(p, words):
    if p in ("a", "i"):
        return True
    if len(p) <= 2:
        return p in _CORE_TWO
    return p in words and _zipf(p) >= _MIN_ZIPF


IN_RE = re.compile("([A-Za-z'’]*[a-z'’]) ([a-z][A-Za-z'’]*)")


def _resolve(F, G, words):
    """Decide what a soft boundary between fragments F and G was:
    '' (wrap splinter -> glue) or ' ' (real space)."""
    fl, gl = F.lower(), G.lower()
    combo = fl + gl
    for _suf in ("ist", "tion", "sion", "ment", "ous", "ly", "ing",
                 "ed", "es", "ate", "ify", "ize", "ise", "ful", "al", "ic"):
        _stem = fl + gl[:len(gl) - len(_suf)]
        if gl.endswith(_suf) and len(gl) > len(_suf) and \
                gl not in words and \
                not _counts_as_word(_stem, words) and \
                not _counts_as_word(fl, words):
            return ""  # por|traitist (suffix can never stand alone)
    gv0 = re.sub("[" + chr(0x2019) + chr(39) + "]+$", "", gl)
    for cand in dict.fromkeys((gl, gv0)):
        if cand.endswith("s") and len(cand) > 2 and \
                (fl + cand[:-1]) in words:
            return ""  # por|traits -> portraits (via portrait)
    if combo not in words:
        gv = re.sub("[" + chr(0x2019) + "']+$", "", gl)
        if gv != gl and (fl + gv) in words:
            return ""  # par|ticles + possessive mark (possessive splinter)
        if len(gl) > 2 and gl[-2] in (chr(0x2019), "'") and gl[-1] == "s" \
                and (fl + gl[:-2]) in words:
            return ""  # par|ticle's -> particle's (singular possessive)
        return " "
    if combo in _ALWAYS_JOIN:
        return ""  # within, without, throughout, whereas
    if fl in ("a", "i"):
        if gl not in words and len(G) == 2 and G in _ONSET2:
            return ""  # a|nd -> and
        return " "  # a|bout, a|test stay split (chains heal rightward)
    if len(G) == 1 and gl not in ("a", "i", "y"):
        if (not _counts_as_word(fl, words)) or _zipf(combo) >= 4.5:
            return ""  # por|t, an|d join; of|t, is|s stay for chaining
    if gl in ("a", "i"):
        return " "  # ran|a, are|a stay split (single letters never join here)
    if gl in _SUFFIX_FRAGS and _zipf(combo) >= 4.0:
        return ""  # Nor|th, for|est, on|ly, star|ted
    if gl in _PREP and fl in words:
        return " "  # constant|in, based|on stay split
    if gl in _CONJ and fl in words:
        return " "  # survey|or, arm|and stay split
    if len(F) == 2 and fl in _CORE_TWO:
        if gl in _CORE_TWO or gl in ("a", "i"):
            return " "  # in|to, on|to, to|be stay split
        if gl not in words or _zipf(gl) < 4.5:
            return ""  # in|sect (G cannot stand alone)
        if _zipf(combo) >= 6.0:
            return ""  # ultra-common compounds only
        return " "  # of|ten, to|day, be|low stay split
    if len(G) > 1 and gl not in words:
        return ""  # total|itarian (G is not a word at all)
    if len(F) == 1:
        return "" if _zipf(combo) >= 5.0 else " "
    if fl not in words:
        return ""  # pure splinter first half (por, repor - "F G" can't be valid)
    if ((not _counts_as_word(fl, words)) and (not _counts_as_word(gl, words)) \
            and (len(G) <= 3 or (_zipf(combo) > _zipf(fl)
                                 and _zipf(combo) > _zipf(gl)))) \
            or (_zipf(combo) > _zipf(fl) and _zipf(combo) > _zipf(gl)):
        return ""  # both splinters (Mar|ta), or compound eclipsing parts
    return " "  # fresh|water, super|man stay split

def smart_join(lines):
    """Join extracted PDF lines into one string, repairing words split
    across line wraps (e.g. 'repor ted' -> 'reported'). A wrap is only
    removed when the glued fragments form a known word while the parts
    alone do not both stand as words — so real spaces ('reported
    approximately') are never merged."""
    lines = [l for l in lines if l]
    if not lines:
        return ""
    segs = []
    for i, ln in enumerate(lines):
        if i == 0:
            segs.append(("", ln))
            continue
        prev = segs[-1][1]
        if (prev.endswith("-") and len(prev) >= 2 and prev[-2].isalnum()
                and re.match(r"[a-z]", ln)):
            segs[-1] = (segs[-1][0], prev[:-1])
            segs.append(("\x02", ln))
        else:
            segs.append(("\x01", ln))
    s = "".join(sep + t for sep, t in segs)
    words = get_words()
    if "\x01" in s or "\x02" in s:
        while True:
            m = SEP_RE.search(s)
            if not m:
                break
            left, sep, right = m.group(1), m.group(2), m.group(3)
            lo, ro = left.lower(), right.lower()
            if sep == "\x02":
                combo = lo + ro
                if combo in words and (lo not in words or len(left) <= 2):
                    s = s[:m.start()] + left + right + s[m.end():]
                else:
                    s = s[:m.start()] + left + "-" + right + s[m.end():]
                continue
            # soft wrap: a known line break
            s = s[:m.start()] + left + _resolve(left, right, words) + right + s[m.end():]
    # repair splinters merged onto one line by the extractor
    # ('por trait' -> 'portrait', 'Mar ta' -> 'Marta')
    pos = 0
    while True:
        m = IN_RE.search(s, pos)
        if not m:
            break
        glue = _resolve(m.group(1), m.group(2), words)
        if glue == " ":
            s = s[:m.start()] + m.group(1) + " " + m.group(2) + s[m.end():]
            # advance past the left word only, so the right word is
            # re-examined as a left word (else 'the por|trait' is skipped)
            pos = m.start() + len(m.group(1))
        else:
            s = s[:m.start()] + m.group(1) + glue + m.group(2) + s[m.end():]
            pos = m.start()
    # any separator the rules could not classify was a real space
    s = s.replace(" ", " ").replace("\x01", " ").replace("\x02", " ")
    return clean(s)


def parse_entry(full):
    """Parse one stitched entry's text. Returns dict or None on failure."""
    full = full.replace("\u00ad", "").replace("\u200b", "").replace("\ufeff", "")
    m = ID_RE.search(full)
    if not m:
        return None
    qid = m.group(1).lower()
    lines = [l.strip() for l in full.splitlines()]
    # drop empty lines but keep markers findable
    lines = [l for l in lines if l != ""]

    assessment = test = domain = skill = difficulty = ""
    try:
        ai = lines.index("Assessment")
        di = lines.index("Difficulty", ai + 1)
        qi0 = lines.index("Question", di + 1)
        block = lines[di + 1: qi0]  # values block (wrapping-aware)
        if block:
            if block[-1] in DIFFICULTIES:
                difficulty = block[-1]
                rest = block[:-1]
            else:
                rest = block
            if rest:
                assessment = rest[0]
            if len(rest) >= 2 and rest[1] in KNOWN_TESTS:
                test = rest[1]
                middle = rest[2:]
            else:
                middle = rest[1:]
                if middle and middle[0] in KNOWN_TESTS:
                    test = middle[0]
                    middle = middle[1:]
            if middle:
                joined = smart_join(middle)
                for d in KNOWN_DOMAINS:
                    if joined == d or joined.startswith(d + " ") or \
                            joined.startswith(d):
                        domain = d
                        skill = clean(joined[len(d):])
                        break
                else:
                    # fallback: first line(s) -> domain, rest -> skill
                    domain = clean(middle[0])
                    skill = smart_join(middle[1:])
    except (ValueError, IndexError):
        pass

    # question body: between 'Question' and 'Answer' markers
    question = ""
    try:
        qi = lines.index("Question", (lines.index("Difficulty") + 1
                                      if "Difficulty" in lines else 0))
        try:
            ans_i = lines.index("Answer", qi + 1)
        except ValueError:
            ans_i = len(lines)
        question = smart_join(lines[qi + 1: ans_i])
    except ValueError:
        pass

    # choices: between 'Answer' marker and 'Correct Answer...' (or end)
    choices = {}
    try:
        ans_i = lines.index("Answer", qi + 1)
        end_i = len(lines)
        for j in range(ans_i + 1, len(lines)):
            if lines[j].startswith("Correct Answer"):
                end_i = j
                break
        cur = None
        buf = []
        for line in lines[ans_i + 1: end_i]:
            cm = CHOICE_START_RE.match(line)
            if cm:
                if cur:
                    choices[cur] = smart_join(buf)
                cur = cm.group(1)
                buf = [cm.group(2)]
            else:
                if cur is not None:
                    buf.append(line)
        if cur:
            choices[cur] = smart_join(buf)
    except (ValueError, NameError):
        pass

    correct = ""
    cm = CORRECT_RE.search(full)
    if cm:
        correct = cm.group(1).upper()

    rationale = ""
    # rationale = everything after the line 'Rationale'
    try:
        ri = lines.index("Rationale")
        rationale = smart_join(lines[ri + 1:])
    except ValueError:
        # fallback: text after 'Correct Answer: X'
        if cm:
            rationale = smart_join(full[cm.end():].splitlines())

    return {
        "id": qid,
        "assessment": assessment,
        "test": test,
        "domain": domain,
        "skill": skill,
        "difficulty": difficulty,
        "question": question,
        "choices": choices,
        "correct": correct,
        "rationale": rationale,
    }


def main():
    if not QPDF.exists():
        sys.exit(f"missing {QPDF}")
    if not APDF.exists():
        sys.exit(f"missing {APDF}")

    print(f"opening {QPDF.name} + {APDF.name} ...")
    qdoc = fitz.open(QPDF)
    adoc = fitz.open(APDF)
    print(f"pages: questions={len(qdoc)} answers={len(adoc)}")

    q_entries = group_entries(qdoc)
    a_entries = group_entries(adoc)
    print(f"grouped: q_entries={len(q_entries)} a_entries={len(a_entries)}")

    q_parsed, a_parsed = [], []
    for e in q_entries:
        d = parse_entry(e["full"])
        if d is None:
            print(f"WARNING: could not parse Q pages {e['pages']}",
                  file=sys.stderr)
            continue
        d["q_page"] = e["pages"][0]
        d["q_pages"] = e["pages"]
        q_parsed.append(d)
    for e in a_entries:
        d = parse_entry(e["full"])
        if d is None:
            print(f"WARNING: could not parse A pages {e['pages']}",
                  file=sys.stderr)
            continue
        d["a_page"] = e["pages"][0]
        d["a_pages"] = e["pages"]
        a_parsed.append(d)

    print(f"parsed: q={len(q_parsed)} a={len(a_parsed)}")

    # join on ID; prefer question/choices from answers entry (complete text),
    # fall back to questions entry when answers copy is empty
    a_by_id = {d["id"]: d for d in a_parsed}
    q_by_id = {d["id"]: d for d in q_parsed}
    print(f"unique ids: q={len(q_by_id)} a={len(a_by_id)}")

    only_q = [i for i in q_by_id if i not in a_by_id]
    only_a = [i for i in a_by_id if i not in q_by_id]
    if only_q:
        print(f"WARNING: {len(only_q)} IDs only in questions: {only_q[:5]}",
              file=sys.stderr)
    if only_a:
        print(f"WARNING: {len(only_a)} IDs only in answers: {only_a[:5]}",
              file=sys.stderr)

    db = []
    bad_choices = 0
    no_correct = 0
    for qd in q_parsed:  # keep original PDF order
        qid = qd["id"]
        ad = a_by_id.get(qid, {})
        question = ad.get("question") or qd["question"]
        choices = ad.get("choices") or qd["choices"]
        if set(choices.keys()) != {"A", "B", "C", "D"}:
            bad_choices += 1
        correct = ad.get("correct", "")
        if not correct:
            no_correct += 1
        qlow = question.lower()
        needs_figure = bool(FIGURE_RE.search(qlow))
        db.append({
            "id": qid,
            "assessment": ad.get("assessment") or qd["assessment"],
            "test": ad.get("test") or qd["test"],
            "domain": ad.get("domain") or qd["domain"],
            "skill": ad.get("skill") or qd["skill"],
            "difficulty": ad.get("difficulty") or qd["difficulty"],
            "question": question,
            "choices": {k: choices.get(k, "") for k in ("A", "B", "C", "D")},
            "correct": correct,
            "rationale": ad.get("rationale", ""),
            "q_page": qd["q_page"],
            "q_pages": qd["q_pages"],
            "a_page": ad.get("a_page", qd["q_page"]),
            "a_pages": ad.get("a_pages", qd["q_pages"]),
            "needs_figure": needs_figure,
        })

    print(f"joined: {len(db)} entries")
    print(f"entries with !=4 choices: {bad_choices}, missing correct: "
          f"{no_correct}")
    if bad_choices or no_correct:
        print("first problem entries:",
              [d["id"] for d in db
               if set(k for k, v in d["choices"].items() if v) !=
               {"A", "B", "C", "D"} or not d["correct"]][:10])

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
