// duo-lib.js — pure, dependency-free shared logic for SAT-BANK Duo Mode.
// Runs in browsers (imported by online.js) and in Node (imported by tests).
// This file must never import Firebase, DOM, or Node APIs.

export const CHALLENGE_SIZE = 10;

// ── Rank ladder: 8 tiered ranks x 3 tiers x 100 RR, Radiant single top rank ──
export const RANKS = ["Iron", "Bronze", "Silver", "Gold",
  "Platinum", "Diamond", "Ascendant", "Immortal"];
export const RR_PER_TIER = 100;
export const RADIANT_AT = 2400;

// ── Difficulty weights (fair RR across different question sets) ──
const WEIGHTS = { Easy: 1, Medium: 2, Hard: 3 };
export function weightFor(difficulty) {
  return WEIGHTS[difficulty] || 2; // blank/unknown difficulty counts as Medium
}

// ── Rank lookup: rankFor(rr) -> {rank, tier|null, rr} ──
export function rankFor(rr) {
  rr = Math.max(0, Math.floor(Number(rr) || 0));
  if (rr >= RADIANT_AT) return { rank: "Radiant", tier: null, rr };
  const band = Math.floor(rr / RR_PER_TIER); // 0..23
  return { rank: RANKS[Math.floor(band / 3)], tier: (band % 3) + 1, rr };
}

// ── Daily gain: completion bonus + difficulty-weighted accuracy ──
// entries: [{ok: bool, w: weight}] -> 20..120
export function gainFor(entries) {
  let possible = 0, earned = 0;
  for (const r of entries || []) {
    const w = Number(r.w) || 0;
    possible += w;
    if (r.ok) earned += w;
  }
  if (possible <= 0) return 0;
  return 20 + Math.round(100 * earned / possible);
}

// ── Challenge date: calendar day in Asia/Hebron, always YYYY-MM-DD ──
// Uses formatToParts (never locale string order) so every environment agrees.
export function hebronDayKey(d) {
  d = d || new Date();
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Hebron", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  return p.year + "-" + p.month + "-" + p.day;
}

// Shift a YYYY-MM-DD key by delta days (UTC-noon anchored, DST-safe).
export function shiftDayKey(dayKey, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey || "");
  if (!m) throw new Error("bad dayKey: " + dayKey);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], 12) + (delta || 0) * 864e5;
  const d = new Date(t);
  const pad = n => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

// ── Streak: consecutive sealed days ending today (or yesterday if today open) ──
export function streakFromSealedDays(sealedKeys, todayKey) {
  const set = new Set(sealedKeys || []);
  let cursor = set.has(todayKey) ? todayKey : shiftDayKey(todayKey, -1);
  let n = 0;
  while (set.has(cursor)) { n++; cursor = shiftDayKey(cursor, -1); }
  return n;
}

// ── Cloud answer entry: {a: letter, o: 0|1, t: unix seconds} ──
export function toCloudEntry(letter, correctLetter, ts) {
  const a = String(letter || "").toUpperCase();
  return { a, o: a === String(correctLetter || "").toUpperCase() ? 1 : 0, t: ts || 0 };
}

export function isAnswerLetter(x) {
  return x === "A" || x === "B" || x === "C" || x === "D";
}

// ── Idempotent union merge: cloud wins conflicts, local fills gaps ──
// Both maps: {qid: {a, o, t}}. Local entries without ts count as oldest.
export function mergeAnswerMaps(cloud, local) {
  const out = {};
  for (const [qid, e] of Object.entries(local || {})) {
    if (e && isAnswerLetter(e.a)) out[qid] = ("t" in e) ? e : { a: e.a, o: e.o | 0, t: 0 };
  }
  for (const [qid, e] of Object.entries(cloud || {})) {
    if (e && isAnswerLetter(e.a)) out[qid] = e;
  }
  return out;
}

// ── Pairing: deterministic duo ids + Gmail-addressed invite ids ──
// duoIdFor(a, b) is order-independent, so double-accepts collapse to one duo.
// inviteIdFor(email) lets both sides compute the same doc id — no listing.
export function duoIdFor(a, b) {
  return [String(a || ""), String(b || "")].sort().join("_");
}
export function inviteIdFor(email) {
  return "to_" + String(email || "").trim().toLowerCase();
}
export function isEmailish(s) {
  if (typeof s !== "string") return false;
  s = s.trim();
  if (s.includes(" ") || s.includes("/")) return false;
  const at = s.indexOf("@");
  return at > 0 && s.indexOf(".", at) > at + 1 && at === s.lastIndexOf("@");
}
