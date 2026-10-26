// SAT practice VPS backend — Express + PostgreSQL + Socket.IO (multi-user).
// Identity = typed name + PIN (plain text, collision protection only — NOT real security).
// See schema.sql, README-DEPLOY.md. Frontend client: ../backend.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const PORT = +(process.env.PORT || 3001);
const ONLINE_WINDOW_MS = +(process.env.ONLINE_WINDOW_MS || 75000);
const INVITE_TTL_MS = +(process.env.INVITE_TTL_MS || 90000);
const MAX_PRESENCE = +(process.env.MAX_PRESENCE || 30);
const ORIGINS = String(process.env.CORS_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", err => console.error("pg pool error", err.message));

async function initDb() {
  try {
    await pool.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS players TEXT[];
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS accepted_by TEXT[];
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS forfeited_players TEXT[];
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'wait';
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS rush_answers JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS finished_players TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS player_times JSONB NOT NULL DEFAULT '{}';
      UPDATE sessions SET players = ARRAY[host, guest] WHERE players IS NULL AND guest IS NOT NULL;
      UPDATE sessions SET accepted_by = ARRAY[host, guest] WHERE accepted_by IS NULL AND guest IS NOT NULL;
    `);
  } catch (e) {
    console.error("initDb migration error:", e.message);
  }
}
initDb();

const app = express();
app.disable("x-powered-by"); // no framework fingerprint header
app.use(cors({ origin: ORIGINS.includes("*") ? true : ORIGINS }));
app.use(express.json({ limit: "256kb", type: ["application/json", "text/plain"] }));
// text/plain: cross-origin sendBeacon forfeits are preflight-free but still parsed.

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGINS.includes("*") ? true : ORIGINS } });

// ── helpers ────────────────────────────────────────────────────────────────
const dayKeyOf = (ms) => {
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
const cleanName = (n) => String(n || "").trim().slice(0, 20);
const isOnline = (lastSeen, now) => (now - (+lastSeen || 0)) < ONLINE_WINDOW_MS;
const newPin = () => String(crypto.randomInt(100000, 1000000)); // 6 digits
// One-duel-at-a-time per pair. pairKey is order-independent; the advisory
// xact lock serializes create/accept for a pair so two simultaneous
// challenges merge instead of producing two separate sessions.
const pairKey = (a, b) => {
  const pair = [cleanName(a), cleanName(b)].sort();
  return pair[0] + "|" + pair[1];
};

// In-memory name→pin cache: avoids a users-table round-trip on EVERY request.
// All writes go through setPinCached/invalidatePin so it never goes stale; a
// restart repopulates lazily from Postgres.
const pinCache = new Map();
function setPinCached(name, pin) { pinCache.set(cleanName(name), String(pin)); }
function invalidatePin(name) { pinCache.delete(cleanName(name)); }
async function getPin(name) {
  name = cleanName(name);
  if (pinCache.has(name)) return pinCache.get(name);
  const r = await pool.query("SELECT pin FROM users WHERE name=$1", [name]);
  const pin = r.rowCount ? r.rows[0].pin : null;
  if (pin !== null) pinCache.set(name, pin);
  return pin;
}
async function checkPin(name, pin) {
  name = cleanName(name);
  if (!name) return { ok: false, error: "bad-name" };
  const want = await getPin(name);
  if (want === null) return { ok: false, error: "unknown-user" };
  if (String(pin || "") !== want) return { ok: false, error: "bad-pin" };
  return { ok: true, name };
}
// Friends of a user. [] = no friend rows -> closed-group mode (no filtering).
async function friendNames(name) {
  const r = await pool.query("SELECT friend_name FROM friends WHERE user_name=$1", [name]);
  return r.rows.map(x => x.friend_name);
}
// Scoped presence list for viewer: self + friends, or everyone (capped) when no friends.
async function presenceFor(viewer) {
  const friends = viewer ? await friendNames(viewer) : [];
  let rows;
  const [statusRes, activeRes] = await Promise.all([
    !friends.length
      ? pool.query("SELECT s.* FROM status s ORDER BY s.last_seen DESC LIMIT $1", [MAX_PRESENCE])
      : pool.query("SELECT s.* FROM status s WHERE s.name = ANY($1)", [[...new Set([viewer, ...friends])]]),
    pool.query("SELECT id, host, guest, players FROM sessions WHERE status = 'active'"),
  ]);
  rows = statusRes.rows;
  const duelMap = {};
  for (const d of activeRes.rows) {
    const plist = (d.players && d.players.length) ? d.players : [d.host, d.guest].filter(Boolean);
    for (const p of plist) {
      const foes = plist.filter(x => x !== p);
      duelMap[p] = { id: d.id, vs: foes.join(", ") };
    }
  }
  const now = Date.now();
  const today = dayKeyOf(now);
  return rows.map(r => ({
    name: r.name,
    currentIndex: r.current_index,
    lastSeen: +r.last_seen,
    // Counters only reset on next answer — clamp stale (pre-today) rows to 0.
    todayCount: r.day_key === today ? r.today_count : 0,
    dayKey: r.day_key,
    online: isOnline(r.last_seen, now),
    duel: duelMap[r.name] || null,
  })).sort((a, b) => (a.name === viewer ? -1 : b.name === viewer ? 1 : a.name.localeCompare(b.name)));
}
// Push a fresh scoped presence:list to everyone in changedUser's circle.
// THROTTLED: callers fire this on every answer/move/heartbeat edge, and each
// call used to mean a fresh roster rebuild + broadcast. Now changes queue in
// _presencePending and at most ONE flush happens per PRESENCE_THROTTLE_MS,
// covering every change queued in between. Closed-group updates coalesce into
// a single global broadcast; friend-scoped viewers are computed in parallel.
const PRESENCE_THROTTLE_MS = +(process.env.PRESENCE_THROTTLE_MS || 1000);
const _presencePending = new Set(); // changed user names since the last flush
let _presenceTimer = null;
let _presenceFlushing = false;

function emitPresenceCircle(changedUser) {
  const name = cleanName(changedUser);
  if (!name) return;
  _presencePending.add(name);
  if (_presenceTimer || _presenceFlushing) return;
  _presenceTimer = setTimeout(() => { _presenceTimer = null; flushPresence(); }, PRESENCE_THROTTLE_MS);
}

function schedulePresenceFlush(delayMs) {
  if (_presenceTimer) return;
  _presenceTimer = setTimeout(() => { _presenceTimer = null; flushPresence(); }, delayMs);
}

async function flushPresence() {
  if (_presenceFlushing) { schedulePresenceFlush(PRESENCE_THROTTLE_MS); return; }
  const users = [..._presencePending];
  _presencePending.clear();
  if (!users.length) return;
  _presenceFlushing = true;
  try {
    // One friend-list query for ALL queued users (was: one query per user per emit).
    const fr = await pool.query(
      "SELECT user_name, friend_name FROM friends WHERE user_name = ANY($1)", [users]);
    const fmap = {};
    for (const row of fr.rows) (fmap[row.user_name] = fmap[row.user_name] || []).push(row.friend_name);
    // Any friendless queued user dirties the closed-group global list — one emit covers it.
    const globalDirty = users.some(u => !(fmap[u] || []).length);
    const members = new Set();
    for (const u of users) for (const m of [u, ...(fmap[u] || [])]) members.add(m);
    if (globalDirty) io.emit("presence:list", await presenceFor("")); // capped global list for everyone
    await Promise.all([...members].map(async (m) =>
      io.to("user:" + m).emit("presence:list", await presenceFor(m)))); // per-viewer scope, parallel
  } catch (e) { console.error("flushPresence", e.message); }
  finally { _presenceFlushing = false; }
  if (_presencePending.size) schedulePresenceFlush(50); // changes that queued mid-flush
}
function sessionOut(r) {
  const players = (r.players && r.players.length) ? r.players : [r.host, r.guest].filter(Boolean);
  return {
    id: r.id, host: r.host, guest: r.guest || (players[1] || null),
    players,
    acceptedBy: (r.accepted_by && r.accepted_by.length) ? r.accepted_by : (r.status === "active" || r.status === "finished" ? players : [r.host]),
    forfeitedPlayers: r.forfeited_players || (r.forfeited_by ? [r.forfeited_by] : []),
    totalQuestions: r.total_questions, status: r.status,
    currentIndex: r.current_index, questionIds: r.question_ids || [],
    currentAnswers: r.current_answers || {},
    mode: r.mode || 'wait',
    rushAnswers: r.rush_answers || {},
    finishedPlayers: r.finished_players || [],
    playerTimes: r.player_times || {},
    createdAt: +r.created_at,
    startedAt: r.started_at ? new Date(r.started_at).getTime() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null,
    forfeitedBy: r.forfeited_by || null,
  };
}
// Server-side invite sweep. MUST NOT rely on client timers (tabs close).
async function sweepExpiredInvites() {
  try {
    const r = await pool.query(
      "UPDATE sessions SET status='expired' WHERE status='pending' AND created_at < $1 RETURNING *",
      [Date.now() - INVITE_TTL_MS]);
    for (const row of r.rows) {
      const s = sessionOut(row);
      for (const p of s.players) {
        if (p !== s.host) io.to("user:" + p).emit("invite:expired", { id: s.id });
      }
      io.to("session:" + s.id).emit("session:update", s);
    }
    return r.rowCount;
  } catch (e) { console.error("sweep", e.message); return 0; }
}

// Abandoned-duel sweep: an active session where ALL participants have been
// silent longer than the presence window is dead.
async function sweepAbandonedSessions(now) {
  try {
    const r = await pool.query(
      `UPDATE sessions SET status='forfeited', finished_at=now()
       WHERE status='active' AND started_at < now() - interval '60 seconds'
       AND NOT EXISTS (SELECT 1 FROM status st
         WHERE (st.name = sessions.host OR st.name = sessions.guest OR st.name = ANY(COALESCE(sessions.players, '{}')))
         AND st.last_seen > ($1::bigint - 90000))
       RETURNING *`,
      [now]);
    for (const row of r.rows) {
      const s = sessionOut(row);
      io.to("session:" + s.id).emit("session:update", s);
      for (const p of s.players) emitPresenceCircle(p);
    }
    return r.rowCount;
  } catch (e) { console.error("sweep-abandoned", e.message); return 0; }
}

// ── REST ───────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ ok: true, now: Date.now() }));

// Identify: create-on-first-use (auto-PIN when none sent) or validate PIN.
// Migrated users with no PIN get one generated here and told once.
app.post("/api/identify", async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ ok: false, error: "bad-name" });
    const pin = String(req.body.pin || "");
    const now = Date.now(), today = dayKeyOf(now);
    let row = (await pool.query("SELECT * FROM users WHERE name=$1", [name])).rows[0];
    let generatedPin = null;
    if (!row) {
      const finalPin = pin || (generatedPin = newPin());
      if (pin && (pin.length < 1 || pin.length > 64))
        return res.status(400).json({ ok: false, error: "bad-pin" });
      // Conflict-safe: two tabs claiming the same new name collapse to one row.
      await pool.query("INSERT INTO users(name, pin) VALUES($1,$2) ON CONFLICT (name) DO NOTHING",
        [name, finalPin]);
      row = (await pool.query("SELECT * FROM users WHERE name=$1", [name])).rows[0];
      if (pin && pin !== row.pin)
        return res.status(403).json({ ok: false, error: "bad-pin" });
      if (!pin) generatedPin = row.pin;
    } else if (!row.pin) {
      generatedPin = newPin(); // migrated user without a PIN
      await pool.query("UPDATE users SET pin=$2 WHERE name=$1", [name, generatedPin]);
    } else if (pin !== row.pin) {
      return res.status(403).json({ ok: false, error: "bad-pin" });
    }
    setPinCached(name, generatedPin || row.pin); // generatedPin covers create/migrate branches
    // Upsert presence, preserving today's count when the day matches.
    await pool.query(
      `INSERT INTO status(name, current_index, last_seen, day_key, today_count)
       VALUES($1, 0, $2, $3, 0)
       ON CONFLICT (name) DO UPDATE SET last_seen=$2`,
      [name, now, today]);
    const st = (await pool.query("SELECT * FROM status WHERE name=$1", [name])).rows[0];
    const out = { ok: true, name, todayCount: st.day_key === today ? st.today_count : 0, dayKey: today };
    if (generatedPin) out.generatedPin = generatedPin;
    res.json(out);
    emitPresenceCircle(name);
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

app.get("/api/me", async (req, res) => {
  const c = await checkPin(req.query.user, req.query.pin);
  if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
  const st = (await pool.query("SELECT * FROM status WHERE name=$1", [c.name])).rows[0];
  res.json({ ok: true, name: c.name, status: st || null });
});

app.put("/api/status/:name", async (req, res) => {
  const c = await checkPin(req.params.name, req.body.pin);
  if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
  const ci = Math.max(0, +req.body.currentIndex || 0);
  await pool.query("UPDATE status SET current_index=$2, last_seen=$3 WHERE name=$1",
    [c.name, ci, Date.now()]);
  res.json({ ok: true });
  emitPresenceCircle(c.name);
});

app.post("/api/status/:name/heartbeat", async (req, res) => {
  const c = await checkPin(req.params.name, req.body.pin);
  if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
  await pool.query("UPDATE status SET last_seen=$2 WHERE name=$1", [c.name, Date.now()]);
  res.json({ ok: true });
});

app.post("/api/status/:name/offline", async (req, res) => {
  // Instant "went offline" (pagehide keepalive). PIN optional here — best effort.
  const name = cleanName(req.params.name);
  await pool.query("UPDATE status SET last_seen=0 WHERE name=$1", [name]).catch(() => {});
  res.json({ ok: true });
  emitPresenceCircle(name);
});

app.get("/api/status", async (req, res) => {
  try {
    const scope = String(req.query.scope || "self");
    if (scope === "self") {
      const st = (await pool.query("SELECT * FROM status WHERE name=$1",
        [cleanName(req.query.user)])).rows;
      return res.json({ ok: true, people: st.map(r => ({
        name: r.name, currentIndex: r.current_index, lastSeen: +r.last_seen,
        todayCount: r.today_count, dayKey: r.day_key,
        online: isOnline(r.last_seen, Date.now()),
      })) });
    }
    const c = await checkPin(req.query.user, req.query.pin);
    if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
    res.json({ ok: true, people: await presenceFor(c.name) });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

app.get("/api/users/online", async (req, res) => {
  try {
    const scope = String(req.query.scope || "friends");
    const me = cleanName(req.query.user);
    let names = null;
    if (me && scope === "friends") {
      const f = await friendNames(me);
      if (f.length) names = f; // friends-only; else fall through to everyone (closed group)
    }
    const rows = names
      ? (await pool.query("SELECT name FROM status WHERE name = ANY($1) AND last_seen > $2",
          [names, Date.now() - ONLINE_WINDOW_MS])).rows
      : (await pool.query("SELECT name FROM status WHERE last_seen > $1 LIMIT $2",
          [Date.now() - ONLINE_WINDOW_MS, MAX_PRESENCE])).rows;
    res.json({ ok: true, online: rows.map(r => r.name).filter(n => n !== me).sort() });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

app.post("/api/friends", async (req, res) => {
  const c = await checkPin(req.body.user_name, req.body.pin);
  const other = cleanName(req.body.friend);
  if (!c.ok) return res.status(403).json({ ok: false, error: c.error });
  if (!other || other === c.name) return res.status(400).json({ ok: false, error: "bad-friend" });
  if (!(await getPin(other))) return res.status(404).json({ ok: false, error: "unknown-user" });
  await pool.query(
    "INSERT INTO friends(user_name, friend_name) VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING",
    [c.name, other]);
  res.json({ ok: true, friends: await friendNames(c.name) });
  emitPresenceCircle(c.name);
});

app.delete("/api/friends", async (req, res) => {
  const c = await checkPin(req.body.user_name, req.body.pin);
  const other = cleanName(req.body.friend);
  if (!c.ok) return res.status(403).json({ ok: false, error: c.error });
  await pool.query("DELETE FROM friends WHERE (user_name=$1 AND friend_name=$2) OR (user_name=$2 AND friend_name=$1)",
    [c.name, other]);
  res.json({ ok: true });
  emitPresenceCircle(c.name);
});

// Record one answer (solo or duel). Increments today's counter atomically.
app.post("/api/answers", async (req, res) => {
  try {
    const c = await checkPin(req.body.user_name, req.body.pin);
    if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
    const { question_id, selected, is_correct, session_id } = req.body;
    if (!question_id || !/^[A-D]$/.test(String(selected || "")))
      return res.status(400).json({ ok: false, error: "bad-answer" });
    const now = Date.now(), today = dayKeyOf(now);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Prevent duplicate attempts & score inflation (e.g. repeated clicks or network retry)
      const existing = await client.query(
        "SELECT id FROM attempts WHERE user_name=$1 AND question_id=$2 AND session_id IS NOT DISTINCT FROM $3 LIMIT 1",
        [c.name, String(question_id), session_id || null]);
      if (existing.rows.length > 0) {
        const st = (await client.query("SELECT today_count, day_key FROM status WHERE name=$1", [c.name])).rows[0];
        await client.query("COMMIT");
        const count = st && st.day_key === today ? st.today_count : 0;
        return res.json({ ok: true, todayCount: count, duplicate: true });
      }
      await client.query(
        "INSERT INTO attempts(user_name, question_id, selected, is_correct, session_id) VALUES($1,$2,$3,$4,$5)",
        [c.name, String(question_id), selected, !!is_correct, session_id || null]);
      const st = (await client.query(
        `UPDATE status SET
           today_count = CASE WHEN day_key=$2 THEN today_count+1 ELSE 1 END,
           day_key=$2, last_seen=$3 WHERE name=$1 RETURNING today_count`,
        [c.name, today, now])).rows[0];
      await client.query("COMMIT");
      res.json({ ok: true, todayCount: st ? st.today_count : 0 });
      emitPresenceCircle(c.name); // instant today-count push to the roster
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// Clear one answer everywhere: deletes ALL ledger rows for (user, question)
// — solo AND duel attempts — so progress derivation stops seeing it.
// NOTE: duel history cards derive scores from the ledger, so clearing an old
// duel answer retroactively lowers that duel's totals. Today's counter is
// recounted from the remaining rows (no blind decrement, no stale-day bugs).
app.delete("/api/answers", async (req, res) => {
  try {
    const c = await checkPin(req.body.user_name, req.body.pin);
    if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
    const qid = String(req.body.question_id || "");
    if (!qid) return res.status(400).json({ ok: false, error: "bad-question" });
    const now = Date.now(), today = dayKeyOf(now);
    const sod = new Date(); sod.setHours(0, 0, 0, 0); // server-local start of today
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const del = await client.query(
        "DELETE FROM attempts WHERE user_name=$1 AND question_id=$2", [c.name, qid]);
      const cnt = await client.query(
        "SELECT COUNT(*)::int AS c FROM attempts WHERE user_name=$1 AND answered_at >= to_timestamp($2 / 1000.0)",
        [c.name, sod.getTime()]);
      await client.query("UPDATE status SET today_count=$2, day_key=$3, last_seen=$4 WHERE name=$1",
        [c.name, cnt.rows[0].c, today, now]);
      await client.query("COMMIT");
      res.json({ ok: true, deleted: del.rowCount, todayCount: cnt.rows[0].c });
      emitPresenceCircle(c.name); // roster today-counts update live
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// Progress = latest answer per question, derived from the ledger (no cache table).
app.get("/api/progress/:name", async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT DISTINCT ON (question_id) question_id, selected FROM attempts
       WHERE user_name=$1 ORDER BY question_id, answered_at DESC`, [cleanName(req.params.name)])).rows;
    const answers = {};
    for (const r of rows) answers[r.question_id] = r.selected;
    res.json({ ok: true, answers });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// History grouped by day. scope=friends (default) | all. Falls back to all when no friends.
app.get("/api/history", async (req, res) => {
  try {
    const me = cleanName(req.query.user);
    const scope = String(req.query.scope || "friends");
    let names = null;
    if (scope === "friends" && me) {
      const f = await friendNames(me);
      names = f.length ? [...new Set([me, ...f])] : null;
    }
    // Aggregate in the DB: GROUP BY day + user over a bounded 31-day window
    // (browser slices to the newest 30 day-keys — same day math as before,
    // but rows stop growing with lifetime attempts). The old code pulled
    // EVERY attempt ever recorded and grouped client-side.
    const dayExpr = `to_char(date_trunc('day', answered_at AT TIME ZONE 'UTC' AT TIME ZONE current_setting('TIMEZONE')), 'YYYY-MM-DD')`;
    const cutoff = `date_trunc('day', CURRENT_TIMESTAMP) - interval '30 days'`;
    const rows = (names
      ? await pool.query(
          `SELECT ${dayExpr} AS day, user_name,
                  COUNT(*)::int AS tot, COUNT(*) FILTER (WHERE is_correct)::int AS ok
           FROM attempts
           WHERE user_name = ANY($1) AND answered_at >= ${cutoff}
           GROUP BY 1, 2`, [names])
      : await pool.query(
          `SELECT ${dayExpr} AS day, user_name,
                  COUNT(*)::int AS tot, COUNT(*) FILTER (WHERE is_correct)::int AS ok
           FROM attempts
           WHERE answered_at >= ${cutoff}
           GROUP BY 1, 2`)).rows;
    const byDay = {};
    const nameSet = me ? { [me]: 1 } : {};
    for (const a of rows) {
      if (!a.day || !a.user_name) continue;
      nameSet[a.user_name] = 1;
      byDay[a.day] = byDay[a.day] || {};
      byDay[a.day][a.user_name] = { tot: a.tot, ok: a.ok };
    }
    const names2 = Object.keys(nameSet).sort((a, b) =>
      (a === me ? -1 : b === me ? 1 : a.localeCompare(b)));
    const days = Object.keys(byDay).sort().reverse().slice(0, 30).map(d => ({ day: d, per: byDay[d] }));
    res.json({ ok: true, names: names2, days });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

app.get("/api/invites/pending", async (req, res) => {
  try {
    const c = await checkPin(req.query.user, req.query.pin);
    if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
    const r = await pool.query(
      `SELECT * FROM sessions WHERE status='pending'
       AND ($1 = ANY(players) OR guest=$1) AND host<>$1
       AND NOT ($1 = ANY(COALESCE(accepted_by, ARRAY[host])))
       ORDER BY created_at DESC LIMIT 1`,
      [c.name]);
    res.json({ ok: true, invite: r.rowCount ? sessionOut(r.rows[0]) : null });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// Live session for rejoin across reload: latest pending/active duel I'm in (excluding forfeited matches).
app.get("/api/sessions/live", async (req, res) => {
  try {
    const c = await checkPin(req.query.user, req.query.pin);
    if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
    const r = await pool.query(
      `SELECT * FROM sessions WHERE ($1 = ANY(players) OR host=$1 OR guest=$1)
       AND status IN ('pending','active')
       AND NOT ($1 = ANY(COALESCE(forfeited_players, '{}')))
       AND (forfeited_by IS NULL OR forfeited_by <> $1)
       ORDER BY created_at DESC LIMIT 1`,
      [c.name]);
    res.json({ ok: true, session: r.rowCount ? sessionOut(r.rows[0]) : null });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// Duel history: finished sessions with scores derived from the
// attempts ledger (scores live only in client memory mid-duel — the ledger
// is the permanent record). Scope: me + friends, or all when no friends.
app.get("/api/sessions/history", async (req, res) => {
  try {
    const me = cleanName(req.query.user);
    const scope = String(req.query.scope || "friends");
    let names = null;
    if (scope === "friends" && me) {
      const c = await checkPin(req.query.user, req.query.pin);
      if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
      const f = await friendNames(me);
      names = f.length ? [...new Set([me, ...f])] : null;
    }
    const limit = Math.min(50, Math.max(1, +req.query.limit || 10));
    const offset = Math.max(0, +req.query.offset || 0);
    const liveRows = (offset === 0)
      ? (names
          ? (await pool.query(
              `SELECT * FROM sessions WHERE status = 'active'
               AND (host = ANY($1) OR guest = ANY($1) OR players && $1) ORDER BY created_at DESC`, [names])).rows
          : (await pool.query(
              `SELECT * FROM sessions WHERE status = 'active'
               ORDER BY created_at DESC`)).rows)
      : [];
    const rows = (names
      ? (await pool.query(
          `SELECT * FROM sessions WHERE status = 'finished'
           AND (host = ANY($1) OR guest = ANY($1) OR players && $1)
           ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [names, limit, offset])).rows
      : (await pool.query(
          `SELECT * FROM sessions WHERE status = 'finished'
           ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset])).rows);
    const allRows = [...liveRows, ...rows];
    const ids = allRows.map(r => r.id);
    const sc = {};
    if (ids.length) {
      const rr = await pool.query(
        `SELECT session_id, user_name, COUNT(*) FILTER (WHERE is_correct) AS ok, COUNT(*) AS tot
         FROM attempts WHERE session_id = ANY($1) GROUP BY session_id, user_name`, [ids]);
      for (const a of rr.rows) {
        (sc[a.session_id] = sc[a.session_id] || {})[a.user_name] = { ok: +a.ok, tot: +a.tot };
      }
    }
    const mapSession = r => {
      const s = sessionOut(r);
      const scores = {};
      for (const p of s.players) {
        scores[p] = (sc[r.id] && sc[r.id][p]) || { ok: 0, tot: 0 };
      }
      return { ...s, scores };
    };
    res.json({
      ok: true,
      live: liveRows.map(mapSession),
      sessions: rows.map(mapSession),
      hasMore: rows.length === limit,
      offset,
      limit,
    });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// Player profile metrics & stats derived from ledger and finished sessions
app.get("/api/users/:name/profile", async (req, res) => {
  try {
    const name = cleanName(req.params.name);
    if (!name) return res.status(400).json({ ok: false, error: "bad-name" });

    // 1. Overall accuracy and total distinct questions solved from attempts ledger
    const attRes = await pool.query(
      `SELECT
         COUNT(*)::int AS total_attempts,
         COUNT(DISTINCT question_id)::int AS distinct_solved,
         COUNT(*) FILTER (WHERE is_correct)::int AS correct_attempts
       FROM attempts
       WHERE user_name = $1`,
      [name]
    );
    const att = attRes.rows[0] || {};
    const totalAttempts = att.total_attempts || 0;
    const correctAttempts = att.correct_attempts || 0;
    const questionsSolved = att.distinct_solved || 0;
    const accuracy = totalAttempts > 0 ? +((correctAttempts / totalAttempts) * 100).toFixed(1) : 0;

    // 2. Finished sessions involving this user
    const sessRes = await pool.query(
      `SELECT id, host, guest, players, started_at, finished_at, total_questions, created_at, player_times, mode
       FROM sessions
       WHERE status = 'finished'
         AND ($1 = ANY(COALESCE(players, ARRAY[host, guest])) OR host = $1 OR guest = $1)
       ORDER BY created_at ASC`,
      [name]
    );
    const sessions = sessRes.rows || [];
    const sessionIds = sessions.map(s => s.id);

    // 3. Scores for these sessions derived from the attempts ledger
    const sc = {};
    if (sessionIds.length) {
      const scRes = await pool.query(
        `SELECT session_id, user_name,
                COUNT(*) FILTER (WHERE is_correct)::int AS ok,
                COUNT(*)::int AS tot
         FROM attempts
         WHERE session_id = ANY($1)
         GROUP BY session_id, user_name`,
        [sessionIds]
      );
      for (const row of scRes.rows) {
        if (!sc[row.session_id]) sc[row.session_id] = {};
        sc[row.session_id][row.user_name] = { ok: row.ok, tot: row.tot };
      }
    }

    let wins = 0;
    let losses = 0;
    let ties = 0;
    let currentStreak = 0;
    let bestStreak = 0;
    let totalDuelSeconds = 0;
    let totalDuelQuestions = 0;

    for (const s of sessions) {
      const plist = (s.players && s.players.length) ? s.players : [s.host, s.guest].filter(Boolean);
      if (!plist.includes(name)) continue;

      const scores = sc[s.id] || {};
      const myScore = (scores[name] && scores[name].ok) || 0;

      let maxOtherScore = -1;
      for (const p of plist) {
        if (p === name) continue;
        const oppScore = (scores[p] && scores[p].ok) || 0;
        if (oppScore > maxOtherScore) maxOtherScore = oppScore;
      }

      if (myScore > maxOtherScore) {
        wins++;
        currentStreak++;
        if (currentStreak > bestStreak) bestStreak = currentStreak;
      } else if (myScore === maxOtherScore) {
        // Tie-breaker: faster total time wins
        const pTimes = s.player_times || {};
        const getPTime = p => {
          const val = pTimes[p];
          if (!val) return 0;
          if (typeof val === "object" && val !== null) return +val.totalTimeMs || 0;
          return +val || 0;
        };
        const myTime = getPTime(name);
        let bestOtherTime = Infinity;
        for (const p of plist) {
          if (p === name) continue;
          const oppScore = (scores[p] && scores[p].ok) || 0;
          if (oppScore === myScore) {
            const oppTime = getPTime(p) || Infinity;
            if (oppTime < bestOtherTime) bestOtherTime = oppTime;
          }
        }
        if (myTime > 0 && bestOtherTime > 0 && bestOtherTime !== Infinity && myTime !== bestOtherTime) {
          if (myTime < bestOtherTime) {
            wins++;
            currentStreak++;
            if (currentStreak > bestStreak) bestStreak = currentStreak;
          } else {
            losses++;
            currentStreak = 0;
          }
        } else {
          ties++;
          currentStreak = 0;
        }
      } else {
        losses++;
        currentStreak = 0;
      }

      if (s.started_at && s.finished_at && s.total_questions > 0) {
        const durMs = new Date(s.finished_at).getTime() - new Date(s.started_at).getTime();
        if (durMs > 1000 && durMs < 1000 * 60 * 60) {
          totalDuelSeconds += (durMs / 1000);
          totalDuelQuestions += s.total_questions;
        }
      }
    }

    const totalDuels = wins + losses + ties;
    const winRate = totalDuels > 0 ? Math.round((wins / totalDuels) * 100) : 0;
    const avgSpeed = totalDuelQuestions > 0 ? (totalDuelSeconds / totalDuelQuestions).toFixed(1) + "s" : "—";

    res.json({
      ok: true,
      profile: {
        name,
        winRate,
        wins,
        losses,
        ties,
        totalDuels,
        avgSpeed,
        bestStreak,
        currentStreak,
        accuracy,
        questionsSolved,
      }
    });
  } catch (e) {
    console.error("profile error:", e.message);
    res.status(500).json({ ok: false, error: "server" });
  }
});


// Change PIN: proves the old one, sets a new one (min 4 chars).
app.post("/api/users/:name/pin", async (req, res) => {
  try {
    const c = await checkPin(req.params.name, req.body.oldPin);
    if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
    const np = String(req.body.newPin || "");
    if (np.length < 4 || np.length > 64) return res.status(400).json({ ok: false, error: "bad-pin" });
    await pool.query("UPDATE users SET pin=$2 WHERE name=$1", [c.name, np]);
    setPinCached(c.name, np);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

app.delete("/api/users/:name", async (req, res) => {
  const c = await checkPin(req.params.name, req.body.pin);
  if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
  invalidatePin(c.name);
  await pool.query("DELETE FROM users WHERE name=$1", [c.name]); // cascades status/attempts/friends
  // Keep finished sessions as history; cancel live ones involving this user.
  await pool.query("UPDATE sessions SET status='expired' WHERE status IN ('pending','active') AND (host=$1 OR guest=$1 OR $1=ANY(COALESCE(players, '{}')))",
    [c.name]);
  res.json({ ok: true });
});

app.post("/api/sessions", async (req, res) => {
  try {
    const c = await checkPin(req.body.host, req.body.pin);
    if (!c.ok) return res.status(403).json({ ok: false, error: c.error });
    let guests = [];
    if (Array.isArray(req.body.guests)) {
      guests = req.body.guests.map(cleanName).filter(Boolean);
    } else if (req.body.guest) {
      guests = [cleanName(req.body.guest)];
    }
    guests = [...new Set(guests)].filter(g => g && g !== c.name);
    const qids = Array.isArray(req.body.questionIds) ? req.body.questionIds.map(String) : [];
    const n = +req.body.totalQuestions || qids.length;
    const mode = req.body.mode === "rush" ? "rush" : "wait";
    if (!guests.length) return res.status(400).json({ ok: false, error: "bad-guest" });
    if (guests.length > 3) return res.status(400).json({ ok: false, error: "too-many-guests" });
    for (const g of guests) {
      if (!(await getPin(g))) return res.status(404).json({ ok: false, error: "unknown-guest", guest: g });
    }
    if (!qids.length || qids.length < n) return res.status(400).json({ ok: false, error: "bad-questions" });

    const client = await pool.connect();
    let s, merged = false, expired = [];
    const allPlayers = [c.name, ...guests];
    try {
      await client.query("BEGIN");
      if (guests.length === 1) {
        const guest = guests[0];
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [pairKey(c.name, guest)]);
        const live = (await client.query(
          `SELECT * FROM sessions WHERE status IN ('pending','active')
           AND ((host=$1 AND guest=$2) OR (host=$2 AND guest=$1) OR (players @> ARRAY[$1,$2]::text[] AND array_length(players, 1)=2))
           ORDER BY created_at DESC`, [c.name, guest])).rows;
        const active = live.find(r => r.status === "active");
        if (active) {
          s = sessionOut(active);
          merged = true;
        } else {
          const mirror = live.find(r => r.status === "pending" && r.host === guest && (r.guest === c.name || (r.players && r.players.includes(c.name))));
          if (mirror) {
            const r = await client.query(
              "UPDATE sessions SET status='active', started_at=now(), accepted_by=players WHERE id=$1 RETURNING *", [mirror.id]);
            s = sessionOut(r.rows[0]);
            merged = true;
            const exp = await client.query(
              `UPDATE sessions SET status='expired' WHERE status='pending' AND host=$1 AND id<>$2
               RETURNING id, host, guest, players`, [c.name, mirror.id]);
            expired = exp.rows;
          } else {
            const exp = await client.query(
              `UPDATE sessions SET status='expired' WHERE status='pending' AND host=$1
               RETURNING id, host, guest, players`, [c.name]);
            expired = exp.rows;
            const r = await client.query(
              `INSERT INTO sessions(host, guest, players, accepted_by, forfeited_players, total_questions, status, current_index, question_ids, current_answers, created_at, mode)
               VALUES($1,$2,$3,$4,'{}',$5,'pending',0,$6,'{}',$7,$8) RETURNING *`,
              [c.name, guest, allPlayers, [c.name], n, qids.slice(0, n), Date.now(), mode]);
            s = sessionOut(r.rows[0]);
          }
        }
      } else {
        // Multi-guest challenge (1v1v1)
        const exp = await client.query(
          `UPDATE sessions SET status='expired' WHERE status='pending' AND host=$1
           RETURNING id, host, guest, players`, [c.name]);
        expired = exp.rows;
        const r = await client.query(
          `INSERT INTO sessions(host, guest, players, accepted_by, forfeited_players, total_questions, status, current_index, question_ids, current_answers, created_at, mode)
           VALUES($1,$2,$3,$4,'{}',$5,'pending',0,$6,'{}',$7,$8) RETURNING *`,
          [c.name, guests[0], allPlayers, [c.name], n, qids.slice(0, n), Date.now(), mode]);
        s = sessionOut(r.rows[0]);
      }
      await client.query("COMMIT");
    } catch (e) { try { await client.query("ROLLBACK"); } catch (_) {} throw e; }
    finally { client.release(); }
    for (const x of expired) {
      const expPlayers = (x.players && x.players.length) ? x.players : [x.host, x.guest].filter(Boolean);
      io.to("session:" + x.id).emit("session:update",
        { id: x.id, host: x.host, guest: x.guest, players: expPlayers, status: "expired" });
      for (const p of expPlayers) {
        if (p !== c.name) io.to("user:" + p).emit("invite:expired", { id: x.id });
      }
    }
    io.to("session:" + s.id).emit("session:update", s);
    if (!merged) {
      for (const g of guests) {
        io.to("user:" + g).emit("invite:new", s);
      }
    } else {
      for (const p of allPlayers) {
        io.to("user:" + p).emit("session:update", s);
      }
    }
    res.json({ ok: true, session: s, ...(merged ? { merged: true } : {}) });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

app.get("/api/sessions/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM sessions WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "unknown-session" });
    const s = sessionOut(r.rows[0]);
    const me = cleanName(req.query.user);
    if (!s.players.includes(me)) return res.status(403).json({ ok: false, error: "forbidden" });
    res.json({ ok: true, session: s });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

app.patch("/api/sessions/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const action = String(req.body.action || "");
    const c = await checkPin(req.body.actor, req.body.pin);
    if (!c.ok) return res.status(403).json({ ok: false, error: c.error });
    const cur = (await pool.query("SELECT * FROM sessions WHERE id=$1", [id])).rows[0];
    if (!cur) return res.status(404).json({ ok: false, error: "unknown-session" });
    let s = sessionOut(cur);
    const isHost = c.name === s.host;
    const isParticipant = s.players.includes(c.name);
    if (!isParticipant) return res.status(403).json({ ok: false, error: "forbidden" });

    let todayCount = null;

    if (action === "accept") {
      if (isHost || s.status !== "pending") return res.status(409).json({ ok: false, error: "bad-state" });
      const client = await pool.connect();
      let expired = [];
      try {
        await client.query("BEGIN");
        const curR = await client.query("SELECT * FROM sessions WHERE id=$1", [id]);
        const curS = curR.rowCount ? sessionOut(curR.rows[0]) : null;
        if (!curS || curS.status !== "pending" || !curS.players.includes(c.name)) {
          await client.query("ROLLBACK");
          return res.status(409).json({ ok: false, error: "bad-state" });
        }
        const other = await client.query(
          "SELECT id FROM sessions WHERE status='active' AND id<>$2 AND (host=$1 OR guest=$1 OR $1=ANY(players)) LIMIT 1",
          [c.name, id]);
        if (other.rowCount) {
          await client.query("ROLLBACK");
          return res.status(409).json({ ok: false, error: "already-active" });
        }
        const exp = await client.query(
          `UPDATE sessions SET status='expired' WHERE status='pending' AND id<>$2
           AND (host=$1 OR guest=$1 OR $1=ANY(players)) RETURNING id, host, guest, players`, [c.name, id]);
        expired = exp.rows;

        let acceptedBy = Array.isArray(curS.acceptedBy) ? [...curS.acceptedBy] : [curS.host];
        if (!acceptedBy.includes(c.name)) acceptedBy.push(c.name);

        const allAccepted = curS.players.every(p => acceptedBy.includes(p));
        let r;
        if (allAccepted) {
          r = await client.query(
            "UPDATE sessions SET status='active', started_at=now(), accepted_by=$2 WHERE id=$1 RETURNING *",
            [id, acceptedBy]);
        } else {
          r = await client.query(
            "UPDATE sessions SET accepted_by=$2 WHERE id=$1 RETURNING *",
            [id, acceptedBy]);
        }
        s = sessionOut(r.rows[0]);
        await client.query("COMMIT");
      } catch (e) { try { await client.query("ROLLBACK"); } catch (_) {} throw e; }
      finally { client.release(); }

      for (const x of expired) {
        const expPlayers = (x.players && x.players.length) ? x.players : [x.host, x.guest].filter(Boolean);
        io.to("session:" + x.id).emit("session:update",
          { id: x.id, host: x.host, guest: x.guest, players: expPlayers, status: "expired" });
        for (const p of expPlayers) {
          if (p !== c.name) io.to("user:" + p).emit("invite:expired", { id: x.id });
        }
      }
    } else if (action === "decline") {
      if (isHost || s.status !== "pending") return res.status(409).json({ ok: false, error: "bad-state" });
      const r = await pool.query(
        "UPDATE sessions SET status='declined', finished_at=now() WHERE id=$1 RETURNING *", [id]);
      s = sessionOut(r.rows[0]);
      for (const p of s.players) {
        if (p !== c.name) {
          io.to("user:" + p).emit("invite:declined", { id: s.id, by: c.name });
          io.to("user:" + p).emit("invite:expired", { id: s.id });
        }
      }
    } else if (action === "forfeit") {
      if (s.status !== "pending" && s.status !== "active")
        return res.status(409).json({ ok: false, error: "bad-state" });

      if (s.status === "pending") {
        const r = await pool.query(
          "UPDATE sessions SET status='expired', finished_at=now() WHERE id=$1 RETURNING *", [id]);
        s = sessionOut(r.rows[0]);
        for (const p of s.players) {
          if (p !== c.name) io.to("user:" + p).emit("invite:expired", { id: s.id });
        }
      } else {
        let forfeited = Array.isArray(s.forfeitedPlayers) ? [...s.forfeitedPlayers] : [];
        if (!forfeited.includes(c.name)) forfeited.push(c.name);
        const remaining = s.players.filter(p => !forfeited.includes(p));

        let r;
        if (remaining.length <= 1) {
          r = await pool.query(
            "UPDATE sessions SET status='forfeited', forfeited_by=$2, forfeited_players=$3, finished_at=now() WHERE id=$1 RETURNING *",
            [id, c.name, forfeited]);
        } else {
          // A player left a 3-way match: reassign host if host left, and update guest so match becomes clean 1v1
          const newHost = remaining.includes(s.host) ? s.host : remaining[0];
          const newGuest = remaining.find(p => p !== newHost) || remaining[1];
          r = await pool.query(
            "UPDATE sessions SET forfeited_players=$2, host=$3, guest=$4 WHERE id=$1 RETURNING *",
            [id, forfeited, newHost, newGuest]);
        }
        s = sessionOut(r.rows[0]);
      }
    } else if (action === "answer") {
      if (s.status !== "active") return res.status(409).json({ ok: false, error: "bad-state" });
      if ((s.forfeitedPlayers || []).includes(c.name)) return res.status(409).json({ ok: false, error: "forfeited" });
      const sel = String(req.body.selected || "");
      const qi = +req.body.questionIndex || 0;
      if (!/^[A-D]$/.test(sel)) return res.status(400).json({ ok: false, error: "bad-answer" });
      const qid = (s.questionIds || [])[qi];
      if (!qid) return res.status(400).json({ ok: false, error: "bad-index" });
      const entry = {
        [c.name]: {
          user_name: c.name, questionIndex: qi, selected: sel,
          is_correct: !!req.body.is_correct, timeMs: +req.body.timeMs || 0,
        },
      };
      const upd = await pool.query(
        `UPDATE sessions SET current_answers = current_answers || $2::jsonb
         WHERE id=$1 AND NOT (current_answers ? $3) RETURNING *`,
        [id, JSON.stringify(entry), c.name]);
      if (!upd.rowCount) return res.json({ ok: false, error: "duplicate" });
      s = sessionOut(upd.rows[0]);
      const now = Date.now(), today = dayKeyOf(now);
      await pool.query(
        "INSERT INTO attempts(user_name, question_id, selected, is_correct, session_id) VALUES($1,$2,$3,$4,$5)",
        [c.name, qid, sel, !!req.body.is_correct, id]);
      await pool.query(
        `UPDATE status SET today_count = CASE WHEN day_key=$2 THEN today_count+1 ELSE 1 END,
         day_key=$2, last_seen=$3 WHERE name=$1`, [c.name, today, now]);
      const tc = (await pool.query("SELECT today_count FROM status WHERE name=$1", [c.name])).rows[0];
      todayCount = tc ? tc.today_count : 0;
      emitPresenceCircle(c.name);
    } else if (action === "advance") {
      const activeRemaining = s.players.filter(p => !(s.forfeitedPlayers || []).includes(p));
      const effectiveHost = activeRemaining.includes(s.host) ? s.host : activeRemaining[0];
      const isParticipantActive = activeRemaining.includes(c.name);
      if (!isParticipantActive || s.status !== "active") return res.status(409).json({ ok: false, error: "bad-state" });
      const ni = Math.max(0, +req.body.currentIndex || 0);
      if (ni <= (s.currentIndex || 0)) {
        return res.json({ ok: true, session: s });
      }
      const allActiveAnswered = activeRemaining.length > 0 && activeRemaining.every(p => s.currentAnswers && s.currentAnswers[p]);
      const canAdvance = isHost || c.name === effectiveHost || allActiveAnswered;
      if (!canAdvance) return res.status(409).json({ ok: false, error: "bad-state" });
      const r = await pool.query(
        "UPDATE sessions SET current_index=$2, current_answers='{}' WHERE id=$1 RETURNING *", [id, ni]);
      s = sessionOut(r.rows[0]);
    } else if (action === "rush_submit") {
      const activeRemaining = s.players.filter(p => !(s.forfeitedPlayers || []).includes(p));
      if (!activeRemaining.includes(c.name) || s.status !== "active") return res.status(409).json({ ok: false, error: "bad-state" });
      const curFinished = s.finishedPlayers || [];
      const answers = req.body.answers || {};
      const totalTimeMs = +req.body.totalTimeMs || 0;
      const qTimes = req.body.qTimes || {};
      const correctMap = req.body.correctMap || {};

      const pTimeEntry = { [c.name]: { totalTimeMs, qTimes } };
      const pAnswersEntry = { [c.name]: answers };

      const willBeFinished = curFinished.includes(c.name) ? curFinished : [...curFinished, c.name];
      const allActiveDone = activeRemaining.length > 0 && activeRemaining.every(p => willBeFinished.includes(p));

      const r = await pool.query(
        `UPDATE sessions SET
          finished_players = $2::text[],
          rush_answers = rush_answers || $3::jsonb,
          player_times = player_times || $4::jsonb,
          status = CASE WHEN $5 = true THEN 'finished' ELSE status END,
          finished_at = CASE WHEN $5 = true THEN now() ELSE finished_at END
         WHERE id=$1 RETURNING *`,
        [id, willBeFinished, JSON.stringify(pAnswersEntry), JSON.stringify(pTimeEntry), allActiveDone]
      );
      s = sessionOut(r.rows[0]);

      // Bulk insert attempts into ledger for this player — ONE multi-row
      // INSERT (the old loop did one DB round-trip per question, up to 100).
      const now = Date.now(), today = dayKeyOf(now);
      const qids = s.questionIds || [];
      const vals = [], args = [];
      for (const qid of qids) {
        if (answers[qid]) {
          args.push(c.name, qid, String(answers[qid]), !!correctMap[qid], id);
          vals.push(`($${args.length - 4},$${args.length - 3},$${args.length - 2},$${args.length - 1},$${args.length})`);
        }
      }
      const insertCount = vals.length;
      if (insertCount > 0) {
        await pool.query(
          `INSERT INTO attempts(user_name, question_id, selected, is_correct, session_id) VALUES ${vals.join(", ")}`,
          args);
        await pool.query(
          `UPDATE status SET today_count = CASE WHEN day_key=$2 THEN today_count+$4 ELSE $4 END,
           day_key=$2, last_seen=$3 WHERE name=$1`, [c.name, today, now, insertCount]);
      }
      const tc = (await pool.query("SELECT today_count FROM status WHERE name=$1", [c.name])).rows[0];
      todayCount = tc ? tc.today_count : 0;
      emitPresenceCircle(c.name);
    } else if (action === "finish") {
      if (s.status !== "active") return res.status(409).json({ ok: false, error: "bad-state" });
      const pTimes = req.body.playerTimes ? JSON.stringify(req.body.playerTimes) : null;
      const r = pTimes ? await pool.query(
        "UPDATE sessions SET status='finished', finished_at=now(), player_times=player_times || $2::jsonb WHERE id=$1 RETURNING *", [id, pTimes])
        : await pool.query(
        "UPDATE sessions SET status='finished', finished_at=now() WHERE id=$1 RETURNING *", [id]);
      s = sessionOut(r.rows[0]);
    } else {
      return res.status(400).json({ ok: false, error: "bad-action" });
    }
    io.to("session:" + s.id).emit("session:update", s);
    if (action === "accept" || action === "finish" || action === "forfeit" || (action === "rush_submit" && s.status === "finished")) {
      for (const p of s.players) emitPresenceCircle(p);
    }
    res.json({ ok: true, session: s, ...(typeof todayCount === "number" ? { todayCount } : {}) });
  } catch (e) { console.error("patch session", e.message); res.status(500).json({ ok: false, error: "server" }); }
});

// ── Duel chat (ephemeral: broadcast-only, NEVER stored) ─────────────────────
// Messages live only in the two players' browsers. No table, no writes, no
// cleanup: a reload mid-duel loses chat, and match end drops it entirely.
const CHAT_MAX_LEN = 200;
const CHAT_MIN_INTERVAL_MS = 1000;
const _chatLastMs = new Map(); // name -> ms of last accepted message (single instance)
async function checkChatSend(sessionId, actor, pin, text) {
  const c = await checkPin(actor, pin);
  if (!c.ok) return { ok: false, error: c.error };
  const msg = String(text || "").trim().slice(0, CHAT_MAX_LEN);
  if (!msg) return { ok: false, error: "bad-text" };
  const cur = (await pool.query("SELECT * FROM sessions WHERE id=$1", [String(sessionId)])).rows[0];
  if (!cur) return { ok: false, error: "unknown-session" };
  const s = sessionOut(cur);
  if (s.status !== "active") return { ok: false, error: "bad-state" };
  if (!s.players.includes(c.name)) return { ok: false, error: "forbidden" };
  if (_chatLastMs.size > 1000) _chatLastMs.clear();
  const last = _chatLastMs.get(c.name) || 0;
  if (Date.now() - last < CHAT_MIN_INTERVAL_MS) return { ok: false, error: "too-fast" };
  _chatLastMs.set(c.name, Date.now());
  return { ok: true, session: s, from: c.name, text: msg };
}
function emitChat(sessionId, from, text) {
  io.to("session:" + sessionId).emit("chat:new",
    { sessionId, from, text, at: Date.now() });
}

// REST send-fallback (same validation, broadcast-only, zero storage).
app.post("/api/sessions/:id/chat", async (req, res) => {
  try {
    const r = await checkChatSend(req.params.id, req.body.actor, req.body.pin, req.body.text);
    if (!r.ok) {
      const code = r.error === "bad-text" ? 400
        : r.error === "too-fast" ? 429
        : r.error === "bad-pin" ? 403
        : (r.error === "unknown-session" ? 404 : 409);
      return res.status(code).json({ ok: false, error: r.error });
    }
    emitChat(r.session.id, r.from, r.text);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// ── Socket.IO ──────────────────────────────────────────────────────────────
const userSockets = new Map(); // name -> Set(socket.id)

io.on("connection", (socket) => {
  sweepExpiredInvites(); // spec: sweep on every new connect, not just the timer
  sweepAbandonedSessions(Date.now()); // same for abandoned duels
  let who = null;

  socket.on("identify", async ({ name, pin } = {}) => {
    try {
      const want = await getPin(name); // cached; no users-table round-trip per reconnect
      if (want === null || String(pin || "") !== want) {
        socket.emit("identify:reject", { error: "bad-pin" });
        return;
      }
      who = cleanName(name);
      socket.join("user:" + who);
      if (!userSockets.has(who)) userSockets.set(who, new Set());
      userSockets.get(who).add(socket.id);
      await pool.query("UPDATE status SET last_seen=$2 WHERE name=$1", [who, Date.now()]);
      socket.emit("identify:ok", { name: who });
      socket.emit("presence:list", await presenceFor(who));
      // Re-deliver latest pending invite + rejoin any live session after reload.
      const inv = (await pool.query(
        "SELECT * FROM sessions WHERE ($1=ANY(COALESCE(players, '{}')) OR guest=$1) AND host<>$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",
        [who])).rows[0];
      if (inv) socket.emit("invite:new", sessionOut(inv));
      const live = (await pool.query(
        `SELECT * FROM sessions WHERE (host=$1 OR guest=$1 OR $1=ANY(COALESCE(players, '{}'))) AND status IN ('pending','active')
         ORDER BY created_at DESC LIMIT 1`, [who])).rows[0];
      if (live) { const s = sessionOut(live); socket.join("session:" + s.id); socket.emit("session:update", s); }
      emitPresenceCircle(who);
    } catch (e) { socket.emit("identify:reject", { error: "server" }); }
  });

  socket.on("presence:move", async ({ name, pin, currentIndex } = {}) => {
    const c = await checkPin(name, pin);
    if (!c.ok || c.name !== who) return;
    await pool.query("UPDATE status SET current_index=$2, last_seen=$3 WHERE name=$1",
      [c.name, Math.max(0, +currentIndex || 0), Date.now()]);
    emitPresenceCircle(c.name);
  });

  socket.on("session:join", async ({ id } = {}) => {
    if (!id) return;
    socket.join("session:" + String(id));
    // Direct catch-up: broadcasts fired before this join are missed by definition.
    try {
      const r = await pool.query("SELECT * FROM sessions WHERE id=$1", [String(id)]);
      if (r.rowCount) socket.emit("session:update", sessionOut(r.rows[0]));
    } catch (e) {}
  });
  socket.on("session:leave", ({ id } = {}) => { if (id) socket.leave("session:" + String(id)); });

  // Duel answer over socket (same serialization as REST). Client falls back to REST on ack failure.
  socket.on("duel:answer", async (msg = {}, ack) => {
    try {
      const c = await checkPin(msg.actor, msg.pin);
      if (!c.ok || c.name !== who) return ack && ack({ ok: false, error: c.error });
      const cur = (await pool.query("SELECT * FROM sessions WHERE id=$1", [msg.sessionId])).rows[0];
      if (!cur) return ack && ack({ ok: false, error: "unknown-session" });
    let s = sessionOut(cur);
    let todayCount = null;
      if (s.status !== "active") return ack && ack({ ok: false, error: "bad-state" });
      if (!s.players.includes(c.name)) return ack && ack({ ok: false, error: "forbidden" });
      if ((s.forfeitedPlayers || []).includes(c.name)) return ack && ack({ ok: false, error: "forfeited" });
      const sel = String(msg.selected || "");
      const qi = +msg.questionIndex || 0;
      const qid = (s.questionIds || [])[qi];
      if (!/^[A-D]$/.test(sel) || !qid) return ack && ack({ ok: false, error: "bad-answer" });
      const entry = {
        [c.name]: {
          user_name: c.name, questionIndex: qi, selected: sel,
          is_correct: !!msg.is_correct, timeMs: +msg.timeMs || 0,
        },
      };
      const upd = await pool.query(
        `UPDATE sessions SET current_answers = current_answers || $2::jsonb
         WHERE id=$1 AND NOT (current_answers ? $3) RETURNING *`,
        [s.id, JSON.stringify(entry), c.name]);
      if (!upd.rowCount) return ack && ack({ ok: false, error: "duplicate" });
      s = sessionOut(upd.rows[0]);
      const now = Date.now(), today = dayKeyOf(now);
      await pool.query(
        "INSERT INTO attempts(user_name, question_id, selected, is_correct, session_id) VALUES($1,$2,$3,$4,$5)",
        [c.name, qid, sel, !!msg.is_correct, s.id]);
      await pool.query(
        `UPDATE status SET today_count = CASE WHEN day_key=$2 THEN today_count+1 ELSE 1 END,
         day_key=$2, last_seen=$3 WHERE name=$1`, [c.name, today, now]);
      const tc = (await pool.query("SELECT today_count FROM status WHERE name=$1", [c.name])).rows[0];
      io.to("session:" + s.id).emit("session:update", s);
      emitPresenceCircle(c.name);
      ack && ack({ ok: true, session: s, todayCount: tc ? tc.today_count : 0 });
    } catch (e) { ack && ack({ ok: false, error: "server" }); }
  });

  // Duel rush submit over socket
  socket.on("duel:rush_submit", async (msg = {}, ack) => {
    try {
      const c = await checkPin(msg.actor, msg.pin);
      if (!c.ok || c.name !== who) return ack && ack({ ok: false, error: c.error });
      const cur = (await pool.query("SELECT * FROM sessions WHERE id=$1", [msg.sessionId])).rows[0];
      if (!cur) return ack && ack({ ok: false, error: "unknown-session" });
      let s = sessionOut(cur);
      if (s.status !== "active") return ack && ack({ ok: false, error: "bad-state" });
      if (!s.players.includes(c.name)) return ack && ack({ ok: false, error: "forbidden" });
      if ((s.forfeitedPlayers || []).includes(c.name)) return ack && ack({ ok: false, error: "forfeited" });

      const activeRemaining = s.players.filter(p => !(s.forfeitedPlayers || []).includes(p));
      const curFinished = s.finishedPlayers || [];
      const answers = msg.answers || {};
      const totalTimeMs = +msg.totalTimeMs || 0;
      const qTimes = msg.qTimes || {};
      const correctMap = msg.correctMap || {};

      const pTimeEntry = { [c.name]: { totalTimeMs, qTimes } };
      const pAnswersEntry = { [c.name]: answers };

      const willBeFinished = curFinished.includes(c.name) ? curFinished : [...curFinished, c.name];
      const allActiveDone = activeRemaining.length > 0 && activeRemaining.every(p => willBeFinished.includes(p));

      const r = await pool.query(
        `UPDATE sessions SET
          finished_players = $2::text[],
          rush_answers = rush_answers || $3::jsonb,
          player_times = player_times || $4::jsonb,
          status = CASE WHEN $5 = true THEN 'finished' ELSE status END,
          finished_at = CASE WHEN $5 = true THEN now() ELSE finished_at END
         WHERE id=$1 RETURNING *`,
        [s.id, willBeFinished, JSON.stringify(pAnswersEntry), JSON.stringify(pTimeEntry), allActiveDone]
      );
      s = sessionOut(r.rows[0]);

      // Bulk insert attempts into ledger for this player — ONE multi-row
      // INSERT (the old loop did one DB round-trip per question, up to 100).
      const now = Date.now(), today = dayKeyOf(now);
      const qids = s.questionIds || [];
      const vals = [], args = [];
      for (const qid of qids) {
        if (answers[qid]) {
          args.push(c.name, qid, String(answers[qid]), !!correctMap[qid], s.id);
          vals.push(`($${args.length - 4},$${args.length - 3},$${args.length - 2},$${args.length - 1},$${args.length})`);
        }
      }
      const insertCount = vals.length;
      if (insertCount > 0) {
        await pool.query(
          `INSERT INTO attempts(user_name, question_id, selected, is_correct, session_id) VALUES ${vals.join(", ")}`,
          args);
        await pool.query(
          `UPDATE status SET today_count = CASE WHEN day_key=$2 THEN today_count+$4 ELSE $4 END,
           day_key=$2, last_seen=$3 WHERE name=$1`, [c.name, today, now, insertCount]);
      }
      const tc = (await pool.query("SELECT today_count FROM status WHERE name=$1", [c.name])).rows[0];
      io.to("session:" + s.id).emit("session:update", s);
      emitPresenceCircle(c.name);
      if (allActiveDone) {
        for (const p of s.players) emitPresenceCircle(p);
      }
      ack && ack({ ok: true, session: s, todayCount: tc ? tc.today_count : 0 });
    } catch (e) {
      console.error("duel:rush_submit socket error", e.message);
      ack && ack({ ok: false, error: "server" });
    }
  });

  // Duel chat over socket (ephemeral — same validation as REST, zero storage).
  // Client falls back to REST on ack failure.
  socket.on("chat:send", async (msg = {}, ack) => {
    try {
      if (!msg || typeof msg !== "object") return ack && ack({ ok: false, error: "bad-text" });
      const r = await checkChatSend(msg.sessionId, msg.actor, msg.pin, msg.text);
      if (!r.ok) return ack && ack({ ok: false, error: r.error });
      if (r.from !== who) return ack && ack({ ok: false, error: "forbidden" });
      emitChat(r.session.id, r.from, r.text);
      ack && ack({ ok: true });
    } catch (e) { ack && ack({ ok: false, error: "server" }); }
  });

  socket.on("disconnect", async () => {
    if (!who) return;
    const set = userSockets.get(who);
    if (set) { set.delete(socket.id); if (set.size) return; }
    // Grace period: a reload/reconnect inside a few seconds restores the set
    // (see identify) and presence never blinks. Only a real goodbye zeroes it.
    setTimeout(async () => {
      try {
        const cur = userSockets.get(who);
        if (cur && cur.size) return; // reconnected during grace
        userSockets.delete(who);
        await pool.query("UPDATE status SET last_seen=0 WHERE name=$1", [who]).catch(() => {});
        emitPresenceCircle(who);
      } catch (e) {}
    }, 8000);
  });
});

// Refresh online/offline edges even when nobody acts. In closed-group mode
// this is ONE global broadcast (the old per-user loop sent the same list N
// times every interval); friends mode refreshes each scoped viewer in parallel.
async function emitPresenceAll() {
  try {
    const withFriends = (await pool.query("SELECT DISTINCT user_name FROM friends")).rows.map(r => r.user_name);
    if (!withFriends.length) {
      io.emit("presence:list", await presenceFor("")); // single broadcast covers every edge
      return;
    }
    await Promise.all(withFriends.map(async (m) =>
      io.to("user:" + m).emit("presence:list", await presenceFor(m))));
  } catch (e) { console.error("emitPresenceAll", e.message); }
}
setInterval(() => { sweepExpiredInvites(); sweepAbandonedSessions(Date.now()); }, 15000);
setInterval(emitPresenceAll, ONLINE_WINDOW_MS);

// ── Admin APIs ──────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = () => process.env.ADMIN_PASSWORD || "admin123";

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.admin_key || req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
  if (!key || key !== ADMIN_PASSWORD()) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

app.post("/api/admin/auth", (req, res) => {
  const pwd = String(req.body.password || "").trim();
  if (pwd && pwd === ADMIN_PASSWORD()) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "invalid-password" });
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const [uCount, onlineCount, attStats, todayAtt, sessStats, hardest] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM users"),
      pool.query("SELECT COUNT(*)::int AS count FROM status WHERE last_seen > 0 AND ($1 - last_seen) < $2", [now, ONLINE_WINDOW_MS]),
      pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_correct)::int AS correct FROM attempts"),
      pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_correct)::int AS correct FROM attempts WHERE answered_at >= CURRENT_DATE"),
      pool.query("SELECT status, COUNT(*)::int AS count FROM sessions GROUP BY status"),
      pool.query(`
        SELECT question_id, COUNT(*)::int AS total, 
               COUNT(*) FILTER (WHERE NOT is_correct)::int AS wrong,
               ROUND(100.0 * COUNT(*) FILTER (WHERE is_correct) / COUNT(*), 1)::float AS accuracy
        FROM attempts
        GROUP BY question_id
        HAVING COUNT(*) >= 1
        ORDER BY wrong DESC, total DESC
        LIMIT 10
      `),
    ]);

    const sessionCounts = {};
    (sessStats.rows || []).forEach(r => { sessionCounts[r.status] = r.count; });

    res.json({
      ok: true,
      stats: {
        totalUsers: uCount.rows[0].count,
        onlineUsers: onlineCount.rows[0].count,
        totalAttempts: attStats.rows[0].total,
        correctAttempts: attStats.rows[0].correct,
        accuracy: attStats.rows[0].total ? Math.round((attStats.rows[0].correct / attStats.rows[0].total) * 100) : 0,
        todayAttempts: todayAtt.rows[0].total,
        todayCorrect: todayAtt.rows[0].correct,
        todayAccuracy: todayAtt.rows[0].total ? Math.round((todayAtt.rows[0].correct / todayAtt.rows[0].total) * 100) : 0,
        sessions: sessionCounts,
        hardestQuestions: hardest.rows,
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const q = `
      SELECT u.name, u.pin, u.created_at,
             COALESCE(s.current_index, 0) AS current_index,
             COALESCE(s.last_seen, 0) AS last_seen,
             COALESCE(s.today_count, 0) AS today_count,
             (COALESCE(s.last_seen, 0) > 0 AND ($1 - COALESCE(s.last_seen, 0)) < $2) AS is_online,
             COUNT(a.id)::int AS total_attempts,
             COUNT(a.id) FILTER (WHERE a.is_correct)::int AS correct_attempts
      FROM users u
      LEFT JOIN status s ON s.name = u.name
      LEFT JOIN attempts a ON a.user_name = u.name
      GROUP BY u.name, u.pin, u.created_at, s.current_index, s.last_seen, s.today_count
      ORDER BY is_online DESC, u.created_at DESC
    `;
    const r = await pool.query(q, [now, ONLINE_WINDOW_MS]);
    res.json({ ok: true, users: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const pin = String(req.body.pin || "").trim() || newPin();
    if (!name) return res.status(400).json({ ok: false, error: "bad-name" });
    await pool.query("INSERT INTO users(name, pin) VALUES($1, $2)", [name, pin]);
    setPinCached(name, pin);
    await pool.query("INSERT INTO status(name, current_index, last_seen, day_key, today_count) VALUES($1, 0, 0, '', 0) ON CONFLICT DO NOTHING", [name]);
    res.json({ ok: true, user: { name, pin } });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ ok: false, error: "user-exists" });
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch("/api/admin/users/:name/pin", requireAdmin, async (req, res) => {
  try {
    const name = cleanName(req.params.name);
    const pin = String(req.body.pin || "").trim();
    if (!pin) return res.status(400).json({ ok: false, error: "bad-pin" });
    const r = await pool.query("UPDATE users SET pin=$1 WHERE name=$2 RETURNING name, pin", [pin, name]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "not-found" });
    setPinCached(name, pin);
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/admin/users/:name", requireAdmin, async (req, res) => {
  try {
    const name = cleanName(req.params.name);
    const r = await pool.query("DELETE FROM users WHERE name=$1 RETURNING name", [name]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "not-found" });
    invalidatePin(name);
    emitPresenceCircle(name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/admin/sessions", requireAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    let q = "SELECT * FROM sessions";
    const args = [];
    if (status && status !== "all") {
      args.push(status);
      q += " WHERE status = $1";
    }
    q += " ORDER BY created_at DESC LIMIT 50";
    const r = await pool.query(q, args);
    res.json({ ok: true, sessions: r.rows.map(sessionOut) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/sessions/:id/terminate", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query(
      "UPDATE sessions SET status='forfeited', finished_at=now(), forfeited_by='admin' WHERE id=$1 RETURNING *",
      [id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "not-found" });
    const s = sessionOut(r.rows[0]);
    io.to("session:" + id).emit("session:update", s);
    res.json({ ok: true, session: s });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/admin/sessions/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const r = await pool.query("DELETE FROM sessions WHERE id=$1 RETURNING id", [id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "not-found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Database direct inspection & editing
const ALLOWED_TABLES = ["users", "status", "attempts", "sessions", "friends"];

app.get("/api/admin/db/tables", requireAdmin, async (req, res) => {
  try {
    const tablesInfo = [];
    for (const t of ALLOWED_TABLES) {
      const countR = await pool.query(`SELECT COUNT(*)::int AS count FROM "${t}"`);
      const colsR = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default 
         FROM information_schema.columns 
         WHERE table_schema = 'public' AND table_name = $1 
         ORDER BY ordinal_position`, [t]
      );
      tablesInfo.push({
        name: t,
        count: countR.rows[0].count,
        columns: colsR.rows
      });
    }
    res.json({ ok: true, tables: tablesInfo });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/admin/db/:table", requireAdmin, async (req, res) => {
  try {
    const table = req.params.table;
    if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ ok: false, error: "forbidden-table" });

    const limit = Math.min(100, Math.max(1, +(req.query.limit || 25)));
    const offset = Math.max(0, +(req.query.offset || 0));
    const search = String(req.query.search || "").trim();

    const colsR = await pool.query(
      `SELECT column_name, data_type, is_nullable 
       FROM information_schema.columns 
       WHERE table_schema = 'public' AND table_name = $1 
       ORDER BY ordinal_position`, [table]
    );
    const columns = colsR.rows;

    let queryStr = `SELECT * FROM "${table}"`;
    let countStr = `SELECT COUNT(*)::int AS total FROM "${table}"`;
    const params = [];

    if (search) {
      const textCols = columns
        .filter(c => ["text", "character varying", "uuid", "character"].includes(c.data_type))
        .map(c => `"${c.column_name}"::text ILIKE $1`);
      if (textCols.length) {
        const where = " WHERE " + textCols.join(" OR ");
        queryStr += where;
        countStr += where;
        params.push(`%${search}%`);
      }
    }

    const countRes = await pool.query(countStr, params);
    const total = countRes.rows[0].total;

    queryStr += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const rowsRes = await pool.query(queryStr, params);

    res.json({ ok: true, table, total, limit, offset, columns, rows: rowsRes.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/db/:table/row", requireAdmin, async (req, res) => {
  try {
    const table = req.params.table;
    if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ ok: false, error: "forbidden-table" });
    const data = req.body.data;
    if (!data || typeof data !== "object") return res.status(400).json({ ok: false, error: "bad-data" });

    const keys = Object.keys(data).filter(k => /^[a-zA-Z0-9_]+$/.test(k));
    if (!keys.length) return res.status(400).json({ ok: false, error: "no-fields" });

    const cols = keys.map(k => `"${k}"`).join(", ");
    const vals = keys.map((_, i) => `$${i + 1}`).join(", ");
    const args = keys.map(k => data[k]);

    const r = await pool.query(`INSERT INTO "${table}" (${cols}) VALUES (${vals}) RETURNING *`, args);
    if (table === "users" && data.name != null) {
      if (typeof data.pin === "string") setPinCached(data.name, data.pin);
      else invalidatePin(data.name);
    }
    res.json({ ok: true, row: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch("/api/admin/db/:table/row", requireAdmin, async (req, res) => {
  try {
    const table = req.params.table;
    if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ ok: false, error: "forbidden-table" });
    const { pk, data } = req.body;
    if (!pk || typeof pk !== "object" || !data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "bad-payload" });
    }

    const updateKeys = Object.keys(data).filter(k => /^[a-zA-Z0-9_]+$/.test(k));
    const pkKeys = Object.keys(pk).filter(k => /^[a-zA-Z0-9_]+$/.test(k));
    if (!updateKeys.length || !pkKeys.length) return res.status(400).json({ ok: false, error: "no-keys" });

    const setClauses = [];
    const args = [];
    updateKeys.forEach((k) => {
      args.push(data[k]);
      setClauses.push(`"${k}" = $${args.length}`);
    });

    const whereClauses = [];
    pkKeys.forEach((k) => {
      args.push(pk[k]);
      whereClauses.push(`"${k}" = $${args.length}`);
    });

    const q = `UPDATE "${table}" SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")} RETURNING *`;
    const r = await pool.query(q, args);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "row-not-found" });
    if (table === "users") { // pk may hold the old name; data may rename or re-pin
      if (data.name != null) invalidatePin(data.name);
      if (pk.name != null) invalidatePin(pk.name);
    }
    res.json({ ok: true, row: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/admin/db/:table/row", requireAdmin, async (req, res) => {
  try {
    const table = req.params.table;
    if (!ALLOWED_TABLES.includes(table)) return res.status(400).json({ ok: false, error: "forbidden-table" });
    const pk = req.body.pk;
    if (!pk || typeof pk !== "object") return res.status(400).json({ ok: false, error: "bad-pk" });

    const pkKeys = Object.keys(pk).filter(k => /^[a-zA-Z0-9_]+$/.test(k));
    if (!pkKeys.length) return res.status(400).json({ ok: false, error: "no-pk-keys" });

    const args = [];
    const whereClauses = pkKeys.map(k => {
      args.push(pk[k]);
      return `"${k}" = $${args.length}`;
    });

    const q = `DELETE FROM "${table}" WHERE ${whereClauses.join(" AND ")} RETURNING *`;
    const r = await pool.query(q, args);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "row-not-found" });
    if (table === "users" && pk.name != null) invalidatePin(pk.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function getSatDbPath() {
  const candidates = [
    path.resolve(__dirname, "../../sat_db.json"),
    path.resolve(__dirname, "../sat_db.json"),
    path.resolve(__dirname, "sat_db.json"),
    path.resolve(process.cwd(), "sat_db.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.get("/api/admin/questions", requireAdmin, async (req, res) => {
  try {
    const dbPath = getSatDbPath();
    if (!dbPath) return res.status(404).json({ ok: false, error: "sat_db.json not found on server" });
    const raw = fs.readFileSync(dbPath, "utf8");
    const all = JSON.parse(raw);

    const q = String(req.query.q || "").toLowerCase().trim();
    const domain = String(req.query.domain || "").trim();
    const difficulty = String(req.query.difficulty || "").trim();
    const page = Math.max(1, +(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, +(req.query.limit || 20)));

    let filtered = all;
    if (q) {
      filtered = filtered.filter(item => 
        (item.id && item.id.toLowerCase().includes(q)) ||
        (item.question && item.question.toLowerCase().includes(q)) ||
        (item.skill && item.skill.toLowerCase().includes(q)) ||
        (item.rationale && item.rationale.toLowerCase().includes(q))
      );
    }
    if (domain && domain !== "all") {
      filtered = filtered.filter(item => item.domain === domain);
    }
    if (difficulty && difficulty !== "all") {
      filtered = filtered.filter(item => item.difficulty === difficulty);
    }

    const total = filtered.length;
    const startIndex = (page - 1) * limit;
    const slice = filtered.slice(startIndex, startIndex + limit);

    res.json({
      ok: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      questions: slice,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch("/api/admin/questions/:id", requireAdmin, async (req, res) => {
  try {
    const dbPath = getSatDbPath();
    if (!dbPath) return res.status(404).json({ ok: false, error: "sat_db.json not found" });
    const id = req.params.id;
    const raw = fs.readFileSync(dbPath, "utf8");
    const all = JSON.parse(raw);

    const idx = all.findIndex(item => item && item.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "question-not-found" });

    const updated = { ...all[idx], ...req.body };
    updated.id = id;
    all[idx] = updated;

    fs.writeFileSync(dbPath, JSON.stringify(all, null, 1), "utf8");
    res.json({ ok: true, question: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Generic responses last: no framework fingerprint pages, no stack/SQL leaks.
app.use((req, res) => res.status(404).json({ ok: false, error: "unknown" }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(500).json({ ok: false, error: "server" }));

server.listen(PORT, () => console.log(`satbank-server listening on :${PORT}`));
