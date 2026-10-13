// tools/test-duo-lib.mjs — run: node tools/test-duo-lib.mjs
import {
  rankFor, weightFor, gainFor, hebronDayKey, shiftDayKey,
  streakFromSealedDays, toCloudEntry, isAnswerLetter,
  mergeAnswerMaps, duoIdFor, inviteIdFor, isEmailish, RADIANT_AT,
} from "../duo-lib.js";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; }
  else { fail++; console.error(`FAIL ${name}: got ${a}, want ${b}`); }
}
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`FAIL ${name}`); }
}

// ── rank boundaries ──
eq("iron1 lo", rankFor(0), { rank: "Iron", tier: 1, rr: 0 });
eq("iron1 hi", rankFor(99), { rank: "Iron", tier: 1, rr: 99 });
eq("iron2", rankFor(100), { rank: "Iron", tier: 2, rr: 100 });
eq("iron3 hi", rankFor(299), { rank: "Iron", tier: 3, rr: 299 });
eq("bronze1", rankFor(300), { rank: "Bronze", tier: 1, rr: 300 });
eq("silver3 hi", rankFor(899), { rank: "Silver", tier: 3, rr: 899 });
eq("gold1", rankFor(900), { rank: "Gold", tier: 1, rr: 900 });
eq("plat3 hi", rankFor(1499), { rank: "Platinum", tier: 3, rr: 1499 });
eq("diamond1", rankFor(1500), { rank: "Diamond", tier: 1, rr: 1500 });
eq("asc3 hi", rankFor(2099), { rank: "Ascendant", tier: 3, rr: 2099 });
eq("imm1", rankFor(2100), { rank: "Immortal", tier: 1, rr: 2100 });
eq("imm3 hi", rankFor(2399), { rank: "Immortal", tier: 3, rr: 2399 });
eq("radiant lo", rankFor(2400), { rank: "Radiant", tier: null, rr: 2400 });
eq("radiant hi", rankFor(99999), { rank: "Radiant", tier: null, rr: 99999 });
eq("negative clamps", rankFor(-50), { rank: "Iron", tier: 1, rr: 0 });
eq("radiant const", RADIANT_AT, 2400);

// ── weights ──
eq("w easy", weightFor("Easy"), 1);
eq("w medium", weightFor("Medium"), 2);
eq("w hard", weightFor("Hard"), 3);
eq("w blank", weightFor(""), 2);
eq("w undef", weightFor(undefined), 2);

// ── gains ──
// 10 easy, all correct -> 20 + 100 = 120
eq("gain perfect easy", gainFor(Array(10).fill({ ok: true, w: 1 })), 120);
// mixed set: 4 easy + 4 med + 2 hard = 4+8+6 = 18 possible; correct 3E+2M+1H = 3+4+3 = 10
eq("gain mixed", gainFor([
  { ok: true, w: 1 }, { ok: true, w: 1 }, { ok: true, w: 1 }, { ok: false, w: 1 },
  { ok: true, w: 2 }, { ok: true, w: 2 }, { ok: false, w: 2 }, { ok: false, w: 2 },
  { ok: true, w: 3 }, { ok: false, w: 3 },
]), 20 + Math.round(100 * 10 / 18));
// all wrong but completed -> floor 20
eq("gain zero", gainFor(Array(10).fill({ ok: false, w: 2 })), 20);
eq("gain empty", gainFor([]), 0);
// fairness (plan example): 6/10 with 4 hards correct beats 7/10 all-easy.
// set A: 4H+6E, correct = 4H+2E -> earned 14/18. set B: 10E, correct 7 -> 7/10.
const mixed6 = gainFor([
  { ok: true, w: 3 }, { ok: true, w: 3 }, { ok: true, w: 3 }, { ok: true, w: 3 },
  { ok: true, w: 1 }, { ok: true, w: 1 },
  { ok: false, w: 1 }, { ok: false, w: 1 }, { ok: false, w: 1 }, { ok: false, w: 1 },
]);
const easy7 = gainFor([...Array(7).fill({ ok: true, w: 1 }), ...Array(3).fill({ ok: false, w: 1 })]);
eq("mixed 6/10 value", mixed6, 20 + Math.round(100 * 14 / 18)); // 98
eq("easy 7/10 value", easy7, 90);
ok("hard-heavy 6/10 beats easy 7/10", mixed6 > easy7);
// uniform-difficulty sets reduce to pure accuracy (correct behavior)
const hard6 = gainFor([...Array(6).fill({ ok: true, w: 3 }), ...Array(4).fill({ ok: false, w: 3 })]);
eq("uniform hard 6/10", hard6, 80);

// ── dates ──
const k = hebronDayKey(new Date(Date.UTC(2026, 0, 15, 12, 0))); // Jan: Hebron UTC+2 -> 14:00 same day
eq("hebron jan", k, "2026-01-15");
ok("daykey format", /^\d{4}-\d{2}-\d{2}$/.test(hebronDayKey()));
eq("shift -1", shiftDayKey("2026-01-15", -1), "2026-01-14");
eq("shift +30", shiftDayKey("2026-01-15", 30), "2026-02-14");
eq("shift leap", shiftDayKey("2024-02-28", 1), "2024-02-29");
eq("shift year", shiftDayKey("2026-01-01", -1), "2025-12-31");

// ── streaks ──
eq("streak 3", streakFromSealedDays(["2026-10-08", "2026-10-09", "2026-10-10"], "2026-10-10"), 3);
eq("streak today open", streakFromSealedDays(["2026-10-08", "2026-10-09"], "2026-10-10"), 2);
eq("streak broken", streakFromSealedDays(["2026-10-06", "2026-10-09", "2026-10-10"], "2026-10-10"), 2);
eq("streak none", streakFromSealedDays([], "2026-10-10"), 0);
eq("streak stale", streakFromSealedDays(["2026-10-01"], "2026-10-10"), 0);

// ── entries + merge ──
eq("entry correct", toCloudEntry("b", "B", 5), { a: "B", o: 1, t: 5 });
eq("entry wrong", toCloudEntry("A", "B", 5), { a: "A", o: 0, t: 5 });
ok("letters", isAnswerLetter("C") && !isAnswerLetter("E") && !isAnswerLetter(""));
const merged = mergeAnswerMaps(
  { q1: { a: "A", o: 0, t: 100 }, q2: { a: "B", o: 1, t: 100 } },
  { q1: { a: "B", o: 1 }, q3: { a: "C", o: 0 } }, // q1 conflicts (local older, no ts)
);
eq("merge cloud wins", merged.q1, { a: "A", o: 0, t: 100 });
eq("merge local fills", merged.q3, { a: "C", o: 0, t: 0 });
eq("merge keeps cloud", merged.q2, { a: "B", o: 1, t: 100 });

// ── pairing ids ──
eq("duo deterministic", duoIdFor("uidB", "uidA"), duoIdFor("uidA", "uidB"));
eq("duo format", duoIdFor("a1", "b2"), "a1_b2");
ok("duo contains both", duoIdFor("x", "y").includes("x") && duoIdFor("x", "y").includes("y"));
eq("invite id", inviteIdFor("  Friend@Gmail.com "), "to_friend@gmail.com");
ok("email ok", isEmailish("waleed@gmail.com"));
ok("email bad no-at", !isEmailish("waleedgmail.com"));
ok("email bad space", !isEmailish("a b@c.com"));
ok("email bad slash", !isEmailish("a/b@c.com"));
ok("email bad double-at", !isEmailish("a@@b.com"));
ok("email bad nodot", !isEmailish("a@b"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
