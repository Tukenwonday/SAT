// One-off Firestore -> Postgres import.
// 1. Export from Firestore (Firebase console or a small getDocs script) into
//    firestore-export.json shaped like:
//    {
//      "attempts": [{ "user_name": "ali", "question_id": "RW-001", "selected": "B",
//                     "is_correct": true, "answered_at_ms": 1730000000000, "session_id": null }],
//      "status": { "ali": { "currentIndex": 41 } }
//    }
//    Only "attempts" is required. Names are verified unique by construction.
// 2. DATABASE_URL=... node src/migrate-firestore.js [path]
// Users get auto-generated PINs (printed at the end — hand them out once).
// Today's counters are RECOMPUTED from attempts, never trusted from export.
require("dotenv").config();
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const dayKeyOf = (ms) => {
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

(async () => {
  if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL first."); process.exit(1); }
  const path = process.argv[2] || "firestore-export.json";
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  const attempts = Array.isArray(data.attempts) ? data.attempts : [];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const names = [...new Set(attempts.map(a => String(a.user_name || "").trim().slice(0, 20)).filter(Boolean))];
  console.log(`attempts: ${attempts.length}, users: ${names.length} (${names.join(", ")})`);

  const pins = {};
  for (const n of names) {
    const pin = String(crypto.randomInt(100000, 1000000));
    pins[n] = pin;
    await pool.query("INSERT INTO users(name, pin) VALUES($1,$2) ON CONFLICT (name) DO NOTHING", [n, pin]);
    await pool.query(
      "INSERT INTO status(name, current_index, last_seen, day_key, today_count) VALUES($1,0,0,'',0) ON CONFLICT (name) DO NOTHING",
      [n]);
  }
  let skipped = 0;
  for (const a of attempts) {
    const user = String(a.user_name || "").trim().slice(0, 20);
    if (!names.includes(user) || !a.question_id || !/^[A-D]$/.test(String(a.selected || ""))) { skipped++; continue; }
    await pool.query(
      "INSERT INTO attempts(user_name, question_id, selected, is_correct, answered_at, session_id) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),$6)",
      [user, String(a.question_id), a.selected, !!a.is_correct, +a.answered_at_ms || Date.now(), a.session_id || null]);
  }
  // Recompute today's counters from the ledger (export values are NOT trusted).
  const today = dayKeyOf(Date.now());
  for (const n of names) {
    const r = await pool.query(
      "SELECT COUNT(*)::int c FROM attempts WHERE user_name=$1 AND answered_at >= date_trunc('day', now())", [n]);
    await pool.query("UPDATE status SET day_key=$2, today_count=$3 WHERE name=$1", [n, today, r.rows[0].c]);
  }
  const st = (data.status && typeof data.status === "object") ? data.status : {};
  for (const [n, s] of Object.entries(st)) {
    if (!names.includes(n)) continue;
    await pool.query("UPDATE status SET current_index=$2 WHERE name=$1",
      [n, Math.max(0, +s.currentIndex || 0)]);
  }
  console.log(`imported ${attempts.length - skipped} attempts, skipped ${skipped}.`);
  console.log("PINs (hand out once, then delete this output):");
  for (const n of names) console.log(`  ${n}: ${pins[n]}`);
  await pool.end();
})().catch(e => { console.error("migrate failed:", e.message); process.exit(1); });
