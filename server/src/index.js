// SAT practice VPS backend — Express + PostgreSQL + Socket.IO (multi-user).
// Identity = typed name + PIN (plain text, collision protection only — NOT real security).
// See schema.sql, README-DEPLOY.md. Frontend client: ../backend.js
require("dotenv").config();
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

async function getPin(name) {
  const r = await pool.query("SELECT pin FROM users WHERE name=$1", [name]);
  return r.rowCount ? r.rows[0].pin : null;
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
  const friends = await friendNames(viewer);
  let rows;
  if (!friends.length) {
    rows = (await pool.query(
      "SELECT s.* FROM status s ORDER BY s.last_seen DESC LIMIT $1", [MAX_PRESENCE])).rows;
  } else {
    const names = [...new Set([viewer, ...friends])];
    rows = (await pool.query("SELECT s.* FROM status s WHERE s.name = ANY($1)", [names])).rows;
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
  })).sort((a, b) => (a.name === viewer ? -1 : b.name === viewer ? 1 : a.name.localeCompare(b.name)));
}
// Push a fresh scoped presence:list to everyone in changedUser's circle.
async function emitPresenceCircle(changedUser) {
  try {
    const friends = await friendNames(changedUser);
    const audience = friends.length ? [...new Set([changedUser, ...friends])] : null;
    if (!audience) { // closed-group mode: everyone gets the capped global list
      const rows = (await pool.query(
        "SELECT s.* FROM status s ORDER BY s.last_seen DESC LIMIT $1", [MAX_PRESENCE])).rows;
      const now = Date.now();
      const today = dayKeyOf(now);
      const list = rows.map(r => ({
        name: r.name, currentIndex: r.current_index, lastSeen: +r.last_seen,
        todayCount: r.day_key === today ? r.today_count : 0,
        dayKey: r.day_key, online: isOnline(r.last_seen, now),
      }));
      io.emit("presence:list", list);
      return;
    }
    for (const m of audience) io.to("user:" + m).emit("presence:list", await presenceFor(m));
  } catch (e) { console.error("emitPresenceCircle", e.message); }
}
function sessionOut(r) {
  return {
    id: r.id, host: r.host, guest: r.guest,
    totalQuestions: r.total_questions, status: r.status,
    currentIndex: r.current_index, questionIds: r.question_ids || [],
    currentAnswers: r.current_answers || {},
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
      "UPDATE sessions SET status='expired' WHERE status='pending' AND created_at < $1 RETURNING id, host, guest",
      [Date.now() - INVITE_TTL_MS]);
    for (const s of r.rows) {
      io.to("user:" + s.guest).emit("invite:expired", { id: s.id });
      io.to("session:" + s.id).emit("session:update",
        { id: s.id, host: s.host, guest: s.guest, status: "expired" });
    }
    return r.rowCount;
  } catch (e) { console.error("sweep", e.message); return 0; }
}

// Abandoned-duel sweep: an active session where BOTH participants have been
// silent longer than the presence window is dead (lost forfeit write, double
// refresh, ...). Mark it forfeited so reloads stop rejoining a ghost
// countdown. forfeited_by stays NULL = "nobody is here", not "someone quit".
async function sweepAbandonedSessions(now) {
  try {
    const r = await pool.query(
      `UPDATE sessions SET status='forfeited', finished_at=now()
       WHERE status='active' AND started_at < now() - interval '60 seconds'
       AND NOT EXISTS (SELECT 1 FROM status st
         WHERE (st.name = sessions.host OR st.name = sessions.guest)
         AND st.last_seen > ($1::bigint - 90000))
       RETURNING id, host, guest`,
      [now]);
    for (const s of r.rows) {
      io.to("session:" + s.id).emit("session:update",
        { id: s.id, host: s.host, guest: s.guest, status: "forfeited", forfeitedBy: null });
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
      emitPresenceCircle(c.name); // instant today-count push (Firestore onSnapshot parity)
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
    const rows = (names
      ? await pool.query(
          "SELECT user_name, answered_at AT TIME ZONE 'UTC' AT TIME ZONE current_setting('TIMEZONE') AS local_ts, is_correct FROM attempts WHERE user_name = ANY($1)",
          [names])
      : await pool.query(
          "SELECT user_name, answered_at AT TIME ZONE 'UTC' AT TIME ZONE current_setting('TIMEZONE') AS local_ts, is_correct FROM attempts")).rows;
    const byDay = {};
    const nameSet = me ? { [me]: 1 } : {};
    for (const a of rows) {
      if (!a.user_name) continue;
      nameSet[a.user_name] = 1;
      const ms = new Date(a.local_ts).getTime();
      if (!ms) continue;
      const day = dayKeyOf(ms);
      byDay[day] = byDay[day] || {};
      const cell = byDay[day][a.user_name] = byDay[day][a.user_name] || { tot: 0, ok: 0 };
      cell.tot++; if (a.is_correct) cell.ok++;
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
      "SELECT * FROM sessions WHERE guest=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",
      [c.name]);
    res.json({ ok: true, invite: r.rowCount ? sessionOut(r.rows[0]) : null });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// Live session for rejoin across reload: latest pending/active duel I'm in.
app.get("/api/sessions/live", async (req, res) => {
  try {
    const c = await checkPin(req.query.user, req.query.pin);
    if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
    const r = await pool.query(
      `SELECT * FROM sessions WHERE (host=$1 OR guest=$1) AND status IN ('pending','active')
       ORDER BY created_at DESC LIMIT 1`,
      [c.name]);
    res.json({ ok: true, session: r.rowCount ? sessionOut(r.rows[0]) : null });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// Duel history: finished/declined sessions with scores derived from the
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
    const rows = (names
      ? await pool.query(
          `SELECT * FROM sessions WHERE status IN ('finished','declined','forfeited')
           AND (host = ANY($1) OR guest = ANY($1)) ORDER BY created_at DESC LIMIT 50`, [names])
      : await pool.query(
          `SELECT * FROM sessions WHERE status IN ('finished','declined','forfeited')
           ORDER BY created_at DESC LIMIT 50`)).rows;
    const ids = rows.map(r => r.id);
    const sc = {};
    if (ids.length) {
      const rr = await pool.query(
        `SELECT session_id, user_name, COUNT(*) FILTER (WHERE is_correct) AS ok, COUNT(*) AS tot
         FROM attempts WHERE session_id = ANY($1) GROUP BY session_id, user_name`, [ids]);
      for (const a of rr.rows) {
        (sc[a.session_id] = sc[a.session_id] || {})[a.user_name] = { ok: +a.ok, tot: +a.tot };
      }
    }
    res.json({
      ok: true,
      sessions: rows.map(r => {
        const s = sessionOut(r);
        return {
          ...s,
          scores: {
            [r.host]: (sc[r.id] && sc[r.id][r.host]) || { ok: 0, tot: 0 },
            [r.guest]: (sc[r.id] && sc[r.id][r.guest]) || { ok: 0, tot: 0 },
          },
        };
      }),
    });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

// Change PIN: proves the old one, sets a new one (min 4 chars).
app.post("/api/users/:name/pin", async (req, res) => {
  try {
    const c = await checkPin(req.params.name, req.body.oldPin);
    if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
    const np = String(req.body.newPin || "");
    if (np.length < 4 || np.length > 64) return res.status(400).json({ ok: false, error: "bad-pin" });
    await pool.query("UPDATE users SET pin=$2 WHERE name=$1", [c.name, np]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: "server" }); }
});

app.delete("/api/users/:name", async (req, res) => {
  const c = await checkPin(req.params.name, req.body.pin);
  if (!c.ok) return res.status(c.error === "bad-pin" ? 403 : 404).json({ ok: false, error: c.error });
  await pool.query("DELETE FROM users WHERE name=$1", [c.name]); // cascades status/attempts/friends
  // Keep finished sessions as history; cancel live ones involving this user.
  await pool.query("UPDATE sessions SET status='expired' WHERE status IN ('pending','active') AND (host=$1 OR guest=$1)",
    [c.name]);
  res.json({ ok: true });
});

app.post("/api/sessions", async (req, res) => {
  try {
    const c = await checkPin(req.body.host, req.body.pin);
    if (!c.ok) return res.status(403).json({ ok: false, error: c.error });
    const guest = cleanName(req.body.guest);
    const qids = Array.isArray(req.body.questionIds) ? req.body.questionIds.map(String) : [];
    const n = +req.body.totalQuestions || qids.length;
    if (!guest || guest === c.name) return res.status(400).json({ ok: false, error: "bad-guest" });
    if (!(await getPin(guest))) return res.status(404).json({ ok: false, error: "unknown-guest" });
    if (!qids.length || qids.length < n) return res.status(400).json({ ok: false, error: "bad-questions" });
    // Pair-serialized: two simultaneous challenges between the same two users
    // must merge into ONE session, never two separate games.
    const client = await pool.connect();
    let s, merged = false, expired = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [pairKey(c.name, guest)]);
      const live = (await client.query(
        `SELECT * FROM sessions WHERE status IN ('pending','active')
         AND ((host=$1 AND guest=$2) OR (host=$2 AND guest=$1))
         ORDER BY created_at DESC`, [c.name, guest])).rows;
      const active = live.find(r => r.status === "active");
      if (active) {
        // Already fighting: join the live duel instead of opening a second one.
        s = sessionOut(active);
        merged = true;
      } else {
        const mirror = live.find(r => r.status === "pending" && r.host === guest && r.guest === c.name);
        if (mirror) {
          // Mutual challenge: accept their invite — one shared game, no fork.
          const r = await client.query(
            "UPDATE sessions SET status='active', started_at=now() WHERE id=$1 RETURNING *", [mirror.id]);
          s = sessionOut(r.rows[0]);
          merged = true;
          // My own other outgoing challenges die with the merge (one duel at a time).
          const exp = await client.query(
            `UPDATE sessions SET status='expired' WHERE status='pending' AND host=$1 AND id<>$2
             RETURNING id, host, guest`, [c.name, mirror.id]);
          expired = exp.rows;
        } else {
          // Retire my own stale outgoing challenges, then open the new one.
          const exp = await client.query(
            `UPDATE sessions SET status='expired' WHERE status='pending' AND host=$1
             RETURNING id, host, guest`, [c.name]);
          expired = exp.rows;
          const r = await client.query(
            `INSERT INTO sessions(host, guest, total_questions, status, current_index, question_ids, current_answers, created_at)
             VALUES($1,$2,$3,'pending',0,$4,'{}',$5) RETURNING *`,
            [c.name, guest, n, qids.slice(0, n), Date.now()]);
          s = sessionOut(r.rows[0]);
        }
      }
      await client.query("COMMIT");
    } catch (e) { try { await client.query("ROLLBACK"); } catch (_) {} throw e; }
    finally { client.release(); }
    for (const x of expired) {
      io.to("session:" + x.id).emit("session:update",
        { id: x.id, host: x.host, guest: x.guest, status: "expired" });
      if (x.guest && x.guest !== c.name)
        io.to("user:" + x.guest).emit("invite:expired", { id: x.id });
    }
    io.to("session:" + s.id).emit("session:update", s);
    if (!merged) {
      io.to("user:" + guest).emit("invite:new", s);
    } else {
      // Merged: push directly to both users (the joiner may not be in the room yet).
      io.to("user:" + c.name).emit("session:update", s);
      io.to("user:" + guest).emit("session:update", s);
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
    if (me !== s.host && me !== s.guest) return res.status(403).json({ ok: false, error: "forbidden" });
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
    const isHost = c.name === s.host, isGuest = c.name === s.guest;
    if (!isHost && !isGuest) return res.status(403).json({ ok: false, error: "forbidden" });

    if (action === "accept") {
      if (!isGuest || s.status !== "pending") return res.status(409).json({ ok: false, error: "bad-state" });
      // Pair-serialized accept: re-check state under the lock, refuse a second
      // concurrent duel, and retire every other pending duel I'm in.
      const client = await pool.connect();
      let expired = [];
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [pairKey(s.host, s.guest)]);
        const curR = await client.query("SELECT * FROM sessions WHERE id=$1", [id]);
        const curS = curR.rowCount ? sessionOut(curR.rows[0]) : null;
        if (!curS || curS.status !== "pending" || curS.guest !== c.name) {
          await client.query("ROLLBACK");
          return res.status(409).json({ ok: false, error: "bad-state" });
        }
        const other = await client.query(
          "SELECT id FROM sessions WHERE status='active' AND id<>$2 AND (host=$1 OR guest=$1) LIMIT 1",
          [c.name, id]);
        if (other.rowCount) {
          await client.query("ROLLBACK");
          return res.status(409).json({ ok: false, error: "already-active" });
        }
        const exp = await client.query(
          `UPDATE sessions SET status='expired' WHERE status='pending' AND id<>$2
           AND (host=$1 OR guest=$1) RETURNING id, host, guest`, [c.name, id]);
        expired = exp.rows;
        const r = await client.query(
          "UPDATE sessions SET status='active', started_at=now() WHERE id=$1 RETURNING *", [id]);
        s = sessionOut(r.rows[0]);
        await client.query("COMMIT");
      } catch (e) { try { await client.query("ROLLBACK"); } catch (_) {} throw e; }
      finally { client.release(); }
      for (const x of expired) {
        io.to("session:" + x.id).emit("session:update",
          { id: x.id, host: x.host, guest: x.guest, status: "expired" });
        if (x.guest && x.guest !== c.name)
          io.to("user:" + x.guest).emit("invite:expired", { id: x.id });
      }
    } else if (action === "decline") {
      if (!isGuest || s.status !== "pending") return res.status(409).json({ ok: false, error: "bad-state" });
      const r = await pool.query(
        "UPDATE sessions SET status='declined', finished_at=now() WHERE id=$1 RETURNING *", [id]);
      s = sessionOut(r.rows[0]);
      io.to("user:" + s.host).emit("invite:declined", { id: s.id, by: c.name });
    } else if (action === "forfeit") {
      // Explicit exit or unload mid-duel. Works from pending (cancel) or active.
      // Double-forfeit (both sides at once): loser gets bad-state, client treats as benign.
      if (s.status !== "pending" && s.status !== "active")
        return res.status(409).json({ ok: false, error: "bad-state" });
      const r = await pool.query(
        "UPDATE sessions SET status='forfeited', forfeited_by=$2, finished_at=now() WHERE id=$1 RETURNING *",
        [id, c.name]);
      s = sessionOut(r.rows[0]);
    } else if (action === "answer") {
      if (s.status !== "active") return res.status(409).json({ ok: false, error: "bad-state" });
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
      // ⚠️ Duel race: serialize — second writer for the same question loses.
      const upd = await pool.query(
        `UPDATE sessions SET current_answers = current_answers || $2::jsonb
         WHERE id=$1 AND NOT (current_answers ? $3) RETURNING *`,
        [id, JSON.stringify(entry), c.name]);
      if (!upd.rowCount) return res.json({ ok: false, error: "duplicate" });
      s = sessionOut(upd.rows[0]);
      // Duel answers also count in the ledger (same as Firestore build).
      const now = Date.now(), today = dayKeyOf(now);
      await pool.query(
        "INSERT INTO attempts(user_name, question_id, selected, is_correct, session_id) VALUES($1,$2,$3,$4,$5)",
        [c.name, qid, sel, !!req.body.is_correct, id]);
      await pool.query(
        `UPDATE status SET today_count = CASE WHEN day_key=$2 THEN today_count+1 ELSE 1 END,
         day_key=$2, last_seen=$3 WHERE name=$1`, [c.name, today, now]);
      const tc = (await pool.query("SELECT today_count FROM status WHERE name=$1", [c.name])).rows[0];
      todayCount = tc ? tc.today_count : 0;
      emitPresenceCircle(c.name); // duel answers push today-count instantly too
    } else if (action === "advance") {
      if (!isHost || s.status !== "active") return res.status(409).json({ ok: false, error: "bad-state" });
      const ni = Math.max(0, +req.body.currentIndex || 0);
      const r = await pool.query(
        "UPDATE sessions SET current_index=$2, current_answers='{}' WHERE id=$1 RETURNING *", [id, ni]);
      s = sessionOut(r.rows[0]);
    } else if (action === "finish") {
      if (s.status !== "active") return res.status(409).json({ ok: false, error: "bad-state" });
      const r = await pool.query(
        "UPDATE sessions SET status='finished', finished_at=now() WHERE id=$1 RETURNING *", [id]);
      s = sessionOut(r.rows[0]);
    } else {
      return res.status(400).json({ ok: false, error: "bad-action" });
    }
    io.to("session:" + s.id).emit("session:update", s);
    res.json({ ok: true, session: s, ...(typeof todayCount === "number" ? { todayCount } : {}) });
  } catch (e) { console.error("patch session", e.message); res.status(500).json({ ok: false, error: "server" }); }
});

// ── Socket.IO ──────────────────────────────────────────────────────────────
const userSockets = new Map(); // name -> Set(socket.id)

io.on("connection", (socket) => {
  sweepExpiredInvites(); // spec: sweep on every new connect, not just the timer
  sweepAbandonedSessions(Date.now()); // same for abandoned duels
  let who = null;

  socket.on("identify", async ({ name, pin } = {}) => {
    try {
      const r = await pool.query("SELECT pin FROM users WHERE name=$1", [cleanName(name)]);
      if (!r.rowCount || String(pin || "") !== r.rows[0].pin) {
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
        "SELECT * FROM sessions WHERE guest=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",
        [who])).rows[0];
      if (inv) socket.emit("invite:new", sessionOut(inv));
      const live = (await pool.query(
        `SELECT * FROM sessions WHERE (host=$1 OR guest=$1) AND status IN ('pending','active')
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
      if (c.name !== s.host && c.name !== s.guest) return ack && ack({ ok: false, error: "forbidden" });
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

setInterval(() => { sweepExpiredInvites(); sweepAbandonedSessions(Date.now()); }, 15000);
setInterval(async () => { // refresh online/offline edges even when nobody acts
  try {
    const rows = (await pool.query("SELECT name FROM status WHERE last_seen > 0 LIMIT $1",
      [MAX_PRESENCE * 4])).rows;
    for (const r of rows) emitPresenceCircle(r.name);
  } catch (e) { /* idle */ }
}, ONLINE_WINDOW_MS);

// Generic responses last: no framework fingerprint pages, no stack/SQL leaks.
app.use((req, res) => res.status(404).json({ ok: false, error: "unknown" }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(500).json({ ok: false, error: "server" }));

server.listen(PORT, () => console.log(`satbank-server listening on :${PORT}`));
