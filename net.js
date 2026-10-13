// net.js — name-based online layer (no login, no passwords, no room codes).
// Identity = a name the user types. Only two users. Everything except the
// name + UI prefs lives in Firestore. Loaded as <script type="module">.
// If Firebase is unconfigured/offline, the app keeps working solo with
// in-memory answers (legacy local answer keys are never touched).
//
// Firestore structure (see firestore.rules):
//   status/{name}                         { currentQuestionId, currentIndex, lastSeen }
//   attempts/{autoId}                     { user_name, question_id, selected, is_correct, answered_at, session_id }
//   sessions/{sessionId}                  { host, guest, totalQuestions, status, currentIndex, questionIds, startedAt }
//   sessions/{sessionId}/answers/{key}    { user_name, questionIndex, selected, is_correct, timeMs }

const FB_VER = "10.12.2";
const FB = "https://www.gstatic.com/firebasejs/" + FB_VER + "/";
const CFG = (typeof window !== "undefined" && window.SATBANK_FIREBASE) || {};
export const ONLINE = !!(CFG.apiKey && !/PASTE/i.test(String(CFG.apiKey || "")));

const $ = id => document.getElementById(id);
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const App = () => window.App;
const FX = () => window.FX;
const toast = (m, ms) => { if (window.toast) window.toast(m, ms); };
const reducedMotion = () =>
  document.documentElement.dataset.motion === "reduced" ||
  (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

// Smoothly count a number element from old → new (jumps when reduced motion).
function countUp(el, from, to, suffix) {
  if (!el) return;
  suffix = suffix || "";
  if (reducedMotion() || from === to) { el.textContent = to + suffix; return; }
  const t0 = performance.now(), dur = 600;
  const step = t => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
    el.textContent = Math.round(from + (to - from) * e) + suffix;
    if (k < 1) requestAnimationFrame(step);
    else { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  };
  requestAnimationFrame(step);
}
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKeyOf = ms => {
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

const Net = {
  on: ONLINE,
  BUILD: "name-duo-v2",
  name: "",           // my typed name
  friend: "",         // other status-doc name (discovered live)
  db: [], byId: {},
  fb: null,           // lazily-loaded firebase modules {auth-less: firestore only}
  unsubs: [],
  beatTimer: null,
  myDayKey: "",       // current YYYY-MM-DD
  _lastActionMs: 0,   // timestamp of latest user action
  todayCounts: {},    // name -> count
  seenOnline: {},     // name -> bool (for friend-online chime)
  // challenge state
  session: null,      // active session doc data + id
  sessUnsubs: [],
  qStartMs: 0,
  challN: 10,
  myScore: 0, frScore: 0,
  myTimes: [], frTimes: [],
  revealed: false,
};
window.Net = Net;

// ── lazy Firebase SDK (Firestore only — no Auth needed) ──
async function fb() {
  if (Net.fb) return Net.fb;
  const [appM, fsM] = await Promise.all([
    import(FB + "firebase-app.js"),
    import(FB + "firebase-firestore.js"),
  ]);
  const app = appM.initializeApp(CFG);
  const db = fsM.getFirestore(app);
  try { await fsM.enableIndexedDbPersistence(db); } catch (e) { /* multi-tab: memory cache fine */ }
  Net.fb = { ...appM, ...fsM, db };
  return Net.fb;
}

// ── BOOT ──
Net.init = async function (db) {
  Net.db = db || [];
  Net.byId = {};
  Net.db.forEach(e => { if (e && e.id) Net.byId[e.id] = e; });
  wireChallengeUI();
  if (!Net._leaveWired) {
    Net._leaveWired = true;
    window.addEventListener("pagehide", signalOffline); // instant offline on tab close
    document.addEventListener("visibilitychange", handleVisibilityChange); // pause heartbeat on background tabs
  }
  if (!ONLINE) { paintPresenceOffline(); return; }
  // Auto-identify from saved name (spec: page load restores identity).
  let saved = "";
  try { saved = (localStorage.getItem("satbank:name") || "").trim().slice(0, 20); } catch (e) {}
  if (saved) identify(saved, true);
};

function clearUnsubs() {
  for (const u of Net.unsubs) { try { u(); } catch (e) {} }
  Net.unsubs = [];
  stopHeartbeat();
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") {
    stopHeartbeat();
  } else if (document.visibilityState === "visible") {
    if (Net.name && ONLINE) {
      startHeartbeat();
      heartbeat(); // ping immediately on return
    }
  }
}

function startHeartbeat() {
  stopHeartbeat();
  Net.beatTimer = setInterval(heartbeat, 30000); // C: 15s -> 30s (stale threshold already 30s)
}

function stopHeartbeat() {
  if (Net.beatTimer) { clearInterval(Net.beatTimer); Net.beatTimer = null; }
}

// ── 1. NAME BOX + 3. LIVE STATUS ──
Net.identify = async function (name) { identify(name, false); };
async function identify(name, quiet) {
  name = String(name || "").trim().slice(0, 20);
  if (!name) return;
  clearUnsubs();
  Net.name = name;
  Net._lastActionMs = Date.now();
  try { localStorage.setItem("satbank:name", name); } catch (e) {}
  if (App() && App().S) App().S.name = name;
  // D: instant paint from answer cache (also covers offline boot).
  try {
    const c = loadAnswerCache(name);
    if (c && c.a && Object.keys(c.a).length && App() && App().S) {
      App().S.answers = { ...c.a };
      Net._lastSyncMs = c.ms || 0;
      if (App().refresh) App().refresh();
    }
  } catch (e) {}
  if (!ONLINE) return;
  try {
    const f = await fb();
    const todayKey = dayKeyOf(Date.now());
    Net.myDayKey = todayKey;

    // Check my status doc to preserve existing today's count if day matches
    const myRef = f.doc(f.db, "status", name);
    const mySnap = await f.getDoc(myRef).catch(() => null);
    const cur = mySnap && mySnap.exists ? mySnap.data() || {} : {};
    const initToday = (cur.dayKey === todayKey && typeof cur.todayCount === "number") ? cur.todayCount : 0;
    Net.todayCounts[name] = initToday;

    // Create/update my status doc with presence and today's count
    // C: currentQuestionId dropped (Q-number recomputed from currentIndex).
    Net._lastMovedIdx = currentIdx();
    await f.setDoc(myRef, {
      currentIndex: currentIdx(),
      lastSeen: Date.now(),
      dayKey: todayKey,
      todayCount: initToday,
    }, { merge: true });

    // Restore my progress from Firestore attempts
    await restoreProgress();

    // Live listeners: presence (only status docs — ~2 docs) + invites
    listenPresence();
    listenInvites();
    startHeartbeat();
    if (!quiet) toast("Online as " + name + " ✅");
  } catch (e) { console.warn("[net] identify failed", e); }
}

function currentQid() {
  try { const e = App().DB[App().idx]; return e ? e.id : ""; } catch (err) { return ""; }
}
function currentIdx() { try { return App().idx || 0; } catch (err) { return 0; } }

// C: throttled presence — writes at most once per 1.5s pause, only when the
// index actually changed, index-only (no currentQuestionId string).
let _moveTimer = null;
Net.moved = function () {
  if (!Net.name || !ONLINE) return;
  if (Net.inChallenge()) return; // FIX #2: freeze presence Q during duel (no leaking)
  Net._lastActionMs = Date.now();
  const ci = currentIdx();
  if (Net._lastMovedIdx === ci) return; // unchanged → no write
  if (_moveTimer) clearTimeout(_moveTimer);
  _moveTimer = setTimeout(async () => {
    Net._lastMovedIdx = ci;
    try {
      const f = await fb();
      await f.setDoc(f.doc(f.db, "status", Net.name), {
        currentIndex: ci,
        lastSeen: Date.now(),
      }, { merge: true });
    } catch (e) { /* offline: heartbeat will retry */ }
  }, 1500);
};

async function heartbeat() {
  if (!Net.name || !ONLINE) return;
  if (document.visibilityState === "hidden") return;
  // If user was active within last 45s, status doc was already updated
  if (Date.now() - (Net._lastActionMs || 0) < 45000) return;
  try {
    const f = await fb();
    await f.setDoc(f.doc(f.db, "status", Net.name), { lastSeen: Date.now() }, { merge: true });
  } catch (e) { /* offline */ }
}

// Instant "went offline": tab-close REST write with keepalive
function signalOffline() {
  if (!Net.name || !ONLINE) return;
  try {
    const pid = CFG.projectId, key = CFG.apiKey;
    if (!pid || !key) return;
    const docName = "projects/" + pid + "/databases/(default)/documents/status/" + encodeURIComponent(Net.name);
    const url = "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(pid) +
      "/databases/(default)/documents:commit?key=" + encodeURIComponent(key);
    const body = JSON.stringify({
      writes: [{
        update: { name: docName, fields: { lastSeen: { integerValue: "0" } } },
        updateMask: { fieldPaths: ["lastSeen"] },
      }],
    });
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
      .catch(() => {});
  } catch (e) { /* best-effort only */ }
}

// ── 2. TOP BAR presence + 5. TODAY'S COUNT ──
function listenPresence() {
  fb().then(f => {
    const un = f.onSnapshot(f.collection(f.db, "status"), snap => {
      const now = Date.now();
      const todayKey = dayKeyOf(now);
      const people = [];
      snap.forEach(d => {
        const data = d.data() || {};
        const p = { name: d.id, ...data };
        people.push(p);
        // Track today's count directly from status doc
        const count = (p.dayKey === todayKey && typeof p.todayCount === "number") ? p.todayCount : 0;
        Net.todayCounts[p.name] = count;
      });
      // Default opponent = the most recently seen other player
      const other = people.find(p => p.name !== Net.name);
      Net.friend = other ? other.name : (Net.friend || "");
      if (Net.friend) { try { localStorage.setItem("satbank:friend", Net.friend); } catch (e) {} }
      paintPresence(people, now);
      // Friend-came-online chime (edge trigger).
      for (const p of people) {
        const online = now - (p.lastSeen || 0) < 30000;
        if (p.name !== Net.name && online && !Net.seenOnline[p.name]) {
          Net.seenOnline[p.name] = true;
          if (FX()) FX().sound("chime");
          toast(p.name + " is online 🟢");
        } else if (!online) Net.seenOnline[p.name] = false;
      }
    }, () => paintPresenceOffline());
    Net.unsubs.push(un);
  }).catch(() => paintPresenceOffline());
}

function qNumLabel(person) {
  // "Q50" from currentIndex (1-based) or currentQuestionId fallback.
  if (person && typeof person.currentIndex === "number") return "Q" + (person.currentIndex + 1);
  if (person && person.currentQuestionId && Net.byId[person.currentQuestionId]) {
    const i = Net.db.findIndex(e => e.id === person.currentQuestionId);
    if (i >= 0) return "Q" + (i + 1);
  }
  return "Q–";
}

// One pill per player (self first, then others A–Z). Adapts to any headcount:
// 2 players → you + friend; 3+ → a pill each, wrapping in the top bar.
function paintPresence(people, now) {
  Net._people = people;
  const box = $("presence"); if (!box) return;
  const order = people.slice().sort((a, b) =>
    (a.name === Net.name ? -1 : b.name === Net.name ? 1 : String(a.name).localeCompare(String(b.name))));
  const seen = new Set();
  for (const p of order) {
    seen.add(p.name);
    paintPill(box, p, now - (p.lastSeen || 0) < 30000);
  }
  // Drop pills for names that vanished (bar stays truthful as players come/go).
  box.querySelectorAll(".pres-pill").forEach(el => {
    if (!seen.has(el.dataset.name)) el.remove();
  });
}

function findPill(box, name) {
  const pills = box.querySelectorAll(".pres-pill");
  for (const el of pills) if (el.dataset.name === name) return el;
  return null;
}

function paintPill(box, person, online) {
  const name = person.name;
  let pill = findPill(box, name);
  if (!pill) {
    pill = document.createElement("span");
    pill.className = "pres-pill off";
    pill.dataset.name = name;
    pill.innerHTML =
      '<span class="pname"></span>' +
      '<span class="pq-badge"></span>' +
      '<span class="ptoday-badge"><span class="count-tick">0</span><span class="ptoday-lbl">today</span></span>';
    box.appendChild(pill);
  }
  pill.classList.toggle("on", online);
  pill.classList.toggle("off", !online);
  const pname = pill.querySelector(".pname");
  if (pname) pname.textContent = name;
  const qb = pill.querySelector(".pq-badge");
  // FIX #2: in challenge mode hide which DB question anyone is on
  // (no Q-number leaking while dueling).
  if (qb) {
    if (Net.inChallenge()) { qb.textContent = ""; qb.style.display = "none"; }
    else { qb.style.display = ""; qb.textContent = qNumLabel(person); }
  }
  const tick = pill.querySelector(".count-tick");
  if (tick) {
    const today = Net.todayCounts[name] || 0;
    const old = tick.dataset.v ? +tick.dataset.v : 0;
    tick.dataset.v = today;
    countUp(tick, old, today, "");
  }
}

function paintPresenceOffline() {
  // No connection yet: single gray pill so the bar never looks broken.
  const box = $("presence"); if (!box) return;
  box.innerHTML = "";
  const pill = document.createElement("span");
  pill.className = "pres-pill off";
  pill.innerHTML = '<span class="pname">' + esc(Net.name || "you") + '</span><span class="pq-badge">offline</span>';
  box.appendChild(pill);
}

// ── 4. ANSWER SAVING → Firestore attempts ──
async function restoreProgress() {
  const f = await fb();
  const S = App().S;
  const seed = { ...(S.answers || {}) }; // D cache paint (may hold offline answers)
  const seedMs = Net._lastSyncMs || 0;
  // A fast path: 1-doc progress summary (1 read, no scan).
  try {
    const pSnap = await f.getDoc(f.doc(f.db, "progress", Net.name)).catch(() => null);
    if (pSnap && pSnap.exists()) {
      const d = pSnap.data() || {};
      const solved = (d.solved && typeof d.solved === "object") ? d.solved : {};
      const progMs = d.updatedAt || 0;
      // Newest side wins conflicts (coarse whole-cache clock).
      S.answers = (seedMs > progMs) ? { ...solved, ...seed } : { ...seed, ...solved };
      try {
        Net._solvedCache = Net._solvedCache || {};
        Net._solvedCache[Net.name] = { set: new Set(Object.keys(S.answers)), ms: Date.now() };
      } catch (e) {}
      Net._lastSyncMs = Date.now();
      saveAnswerCache(Net.name);
      // Heal the summary when the merge added anything (offline/other-device answers).
      try {
        const missing = Object.keys(S.answers).filter(k => !(k in solved));
        if (missing.length) {
          const add = {};
          missing.forEach(k => { add[k] = S.answers[k]; });
          await f.setDoc(f.doc(f.db, "progress", Net.name),
            { solved: add, updatedAt: Date.now() }, { merge: true });
        }
      } catch (e) {}
      if (App().refresh) App().refresh();
      // A: weekly background full re-sync (repairs any ledger/summary drift).
      try {
        const lastFull = +(localStorage.getItem("satbank:fullsync:" + Net.name) || 0);
        if (Date.now() - lastFull > 7 * 864e5) fullResync(false);
      } catch (e) {}
      return;
    }
  } catch (e) {}
  // Slow path — runs ONCE per user (auto-backfill), then never again:
  // full ledger scan + write the progress summary.
  const q = f.query(f.collection(f.db, "attempts"), f.where("user_name", "==", Net.name));
  const snap = await f.getDocs(q).catch(() => null);
  if (!snap) return;
  const latest = {}; // question_id -> {selected, ms}
  snap.forEach(dd => {
    const a = dd.data() || {};
    if (!a.question_id || !/^[A-D]$/.test(a.selected || "")) return;
    const ms = a.answered_at && a.answered_at.toMillis ? a.answered_at.toMillis() : 0;
    if (!latest[a.question_id] || ms >= (latest[a.question_id].ms || 0))
      latest[a.question_id] = { selected: a.selected, ms };
  });
  S.answers = { ...seed };
  for (const [qid, v] of Object.entries(latest)) S.answers[qid] = v.selected;
  try {
    Net._solvedCache = Net._solvedCache || {};
    Net._solvedCache[Net.name] = { set: new Set(Object.keys(S.answers)), ms: Date.now() };
    await f.setDoc(f.doc(f.db, "progress", Net.name),
      { solved: S.answers, updatedAt: Date.now() }, { merge: true });
    try { localStorage.setItem("satbank:fullsync:" + Net.name, String(Date.now())); } catch (e) {}
  } catch (e) {}
  Net._lastSyncMs = Date.now();
  saveAnswerCache(Net.name);
  if (App().refresh) App().refresh();
}

// A: background full re-sync from the attempts ledger (repairs any drift).
// Runs weekly automatically; run Net.fullResync(true) in console anytime.
async function fullResync(loud) {
  try {
    const f = await fb();
    if (!Net.name || !ONLINE) return;
    const q = f.query(f.collection(f.db, "attempts"), f.where("user_name", "==", Net.name));
    const snap = await f.getDocs(q).catch(() => null);
    if (!snap) return;
    const latest = {};
    snap.forEach(d => {
      const a = d.data() || {};
      if (!a.question_id || !/^[A-D]$/.test(a.selected || "")) return;
      const ms = a.answered_at && a.answered_at.toMillis ? a.answered_at.toMillis() : 0;
      if (!latest[a.question_id] || ms >= (latest[a.question_id].ms || 0))
        latest[a.question_id] = { selected: a.selected, ms };
    });
    const S = App().S;
    S.answers = { ...(S.answers || {}) };
    for (const [qid, v] of Object.entries(latest)) S.answers[qid] = v.selected;
    Net._solvedCache = Net._solvedCache || {};
    Net._solvedCache[Net.name] = { set: new Set(Object.keys(S.answers)), ms: Date.now() };
    await f.setDoc(f.doc(f.db, "progress", Net.name),
      { solved: S.answers, updatedAt: Date.now() }, { merge: true }).catch(() => {});
    try { localStorage.setItem("satbank:fullsync:" + Net.name, String(Date.now())); } catch (e) {}
    Net._lastSyncMs = Date.now();
    saveAnswerCache(Net.name);
    if (App().refresh) App().refresh();
    if (loud) toast("Progress re-synced ✅");
  } catch (e) {}
}
Net.fullResync = fullResync;

function attemptMs(a) {
  if (a.answered_at && a.answered_at.toMillis) {
    try { return a.answered_at.toMillis(); } catch (e) { return 0; }
  }
  return a._localMs || 0;
}

function animateTick(pill) {
  if (!pill) return;
  const name = pill.dataset.name;
  const span = pill.querySelector(".count-tick");
  if (!span) return;
  const target = Net.todayCounts[name] || 0;
  const cur = span.dataset.v ? +span.dataset.v : 0;
  span.dataset.v = target;
  countUp(span, cur, target, "");
}

// Solo answer → attempts (session_id null). Called AFTER local paint.
Net.recordAnswer = async function (qid, letter, sessionId) {
  if (!Net.name) return; // no name yet → in-memory only (solo untouched)
  const e = Net.byId[qid];
  const ok = !!e && letter === e.correct;
  Net._lastActionMs = Date.now();
  // Solo only: paint immediately. Challenge answers stay OUT of S.answers
  // until the joint reveal (revealDuel), so nothing leaks early.
  // D: solved-set cache updates for both (invisible, no leak); answer cache
  // only for solo (saving a pre-reveal pick would leak it on next reload).
  solvedCacheAdd(Net.name, qid);
  if (!sessionId && App() && App().S) { App().S.answers[qid] = letter; saveAnswerCache(Net.name); }
  if (!ONLINE) return;
  try {
    const f = await fb();
    // 1. Append-only ledger
    await f.addDoc(f.collection(f.db, "attempts"), {
      user_name: Net.name,
      question_id: qid,
      selected: letter,
      is_correct: ok,
      answered_at: f.serverTimestamp(),
      session_id: sessionId || null,
    });

    // 2+3. A+C: ONE batch for status/{name} + progress/{name}
    // (2 billed writes, 1 round trip). set+merge works whether or not the
    // docs exist yet, so the old update-then-catch dance is gone.
    const todayKey = dayKeyOf(Date.now());
    const batch = f.writeBatch(f.db);
    const sRef = f.doc(f.db, "status", Net.name);
    let statusData;
    if (Net.myDayKey === todayKey) {
      statusData = { todayCount: f.increment(1), lastSeen: Date.now() };
    } else {
      Net.myDayKey = todayKey;
      statusData = { dayKey: todayKey, todayCount: 1, lastSeen: Date.now() };
    }
    batch.set(sRef, statusData, { merge: true });
    batch.set(f.doc(f.db, "progress", Net.name),
      { solved: { [qid]: letter }, updatedAt: Date.now() }, { merge: true });
    try {
      await batch.commit();
    } catch (e1) {
      // progress rules not published yet? Status must still land on its own.
      try { await f.setDoc(sRef, statusData, { merge: true }); } catch (e2) {}
    }

    // Solo correct-answer burst (ding plays in the click handler).
    if (ok && !sessionId && FX()) FX().burst("mini");
  } catch (err) { /* offline: in-memory + localStorage cache hold the view; weekly re-sync heals */ }
};

// Full profile wipe: deletes ALL my attempts (batched, 400 at a time) plus
// my status doc — history, today counts and presence all reset.
Net.wipeMyData = async function () {
  if (!Net.name || !ONLINE) return;
  const f = await fb();
  for (;;) {
    const q = f.query(f.collection(f.db, "attempts"),
      f.where("user_name", "==", Net.name), f.limit(400));
    const snap = await f.getDocs(q);
    if (snap.empty) break;
    const batch = f.writeBatch(f.db);
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 400) break;
  }
  await f.deleteDoc(f.doc(f.db, "status", Net.name)).catch(() => {});
  await f.deleteDoc(f.doc(f.db, "progress", Net.name)).catch(() => {});
  Net.todayCounts = {};
  try {
    localStorage.removeItem(LS_ANS(Net.name));
    if (Net._solvedCache) delete Net._solvedCache[Net.name];
  } catch (e) {}
  if (App() && App().S) App().S.answers = {};
};

// ── 6. HISTORY PAGE (grouped client-side by date) ──
Net.renderHistory = async function () {
  const box = $("hist-body");
  if (!box) return;
  if (!Net.name) { box.innerHTML = "<p>Save your name first (bottom-left), then history will appear here.</p>"; return; }
  box.innerHTML = '<div class="skel" style="height:120px"></div>';
  try {
    const f = await fb();
    // Pull all attempts and group by day. Columns adapt: every name ever
    // seen (self first) gets a column — 2 players or 10.
    const snap = await f.getDocs(f.collection(f.db, "attempts")).catch(() => null);
    const rows = [];
    if (snap) snap.forEach(d => rows.push(d.data() || {}));
    const nameSet = {};
    rows.forEach(a => { if (a.user_name) nameSet[a.user_name] = 1; });
    if (Net.name) nameSet[Net.name] = 1;
    const names = Object.keys(nameSet).sort((a, b) =>
      (a === Net.name ? -1 : b === Net.name ? 1 : a.localeCompare(b)));
    const byDay = {}; // day -> name -> {tot, ok}
    for (const a of rows) {
      if (!a.user_name) continue;
      const ms = attemptMs(a);
      if (!ms) continue;
      const day = dayKeyOf(ms);
      byDay[day] = byDay[day] || {};
      const cell = byDay[day][a.user_name] = byDay[day][a.user_name] || { tot: 0, ok: 0 };
      cell.tot++; if (a.is_correct) cell.ok++;
    }
    const days = Object.keys(byDay).sort().reverse().slice(0, 30);
    if (!days.length) { box.innerHTML = "<p>No attempts yet — answer some questions first!</p>"; return; }
    let h = `<table class="hist-table"><tr><th>Date</th>` +
      names.map(n => `<th>${esc(n)} ✓</th>`).join("") + `</tr>`;
    days.forEach((d, i) => {
      h += `<tr class="hrow" style="animation-delay:${Math.min(i * 40, 400)}ms"><td><b>${esc(d)}</b></td>` +
        names.map(n => {
          const c = byDay[d][n] || { tot: 0, ok: 0 };
          return `<td>${c.ok}/${c.tot}</td>`;
        }).join("") + `</tr>`;
    });
    h += "</table>";
    box.innerHTML = h;
  } catch (e) { box.innerHTML = "<p>Couldn't load history (offline?).</p>"; }
};

// ── 7. CHALLENGE MODE (live 1v1) ──
function wireChallengeUI() {
  const pick = $("chall-pick");
  if (pick) pick.addEventListener("click", ev => {
    const b = ev.target.closest("button[data-n]"); if (!b) return;
    Net.challN = parseInt(b.dataset.n, 10) || 10;
    pick.querySelectorAll("button").forEach(x => x.classList.toggle("sel", x === b));
    if (FX()) FX().sound("tick");
  });
  const send = $("challsend");
  if (send) send.onclick = () => createChallenge().catch(() => {});
  const ex = $("challexit");
  if (ex) ex.onclick = () => exitChallenge();
  const ec = $("endclose");
  if (ec) ec.onclick = () => { $("ov-challend").classList.remove("open"); exitChallenge(); };
  const ia = $("invite-accept"), idc = $("invite-decline");
  if (ia) ia.onclick = () => acceptChallenge().catch(() => {});
  if (idc) idc.onclick = () => declineChallenge().catch(() => {});
}

Net.inChallenge = () => !!(Net.session && Net.session.status === "active");

function otherName() {
  const sel = $("chall-guest"); // opponent picker (lists everyone online)
  if (sel && sel.value) return sel.value.trim().slice(0, 20);
  if (Net.friend) return Net.friend;
  try { return localStorage.getItem("satbank:friend") || ""; } catch (e) { return ""; }
}

function isPersonOnline(name) {
  if (!name || !Net._people) return false;
  const p = Net._people.find(x => x.name === name);
  if (!p) return false;
  return (Date.now() - (p.lastSeen || 0)) < 30000;
}

// Fill the opponent dropdown (only players currently online, self excluded) and open.
Net.openChallenge = function () {
  const sel = $("chall-guest");
  const send = $("challsend");
  if (sel) {
    const now = Date.now();
    const onlineOthers = (Net._people || [])
      .filter(p => p.name && p.name !== Net.name && (now - (p.lastSeen || 0) < 30000))
      .map(p => p.name);
    const known = [...new Set(onlineOthers)].sort();
    if (known.length) {
      sel.innerHTML = known.map(n => `<option value="${esc(n)}"${n === Net.friend ? " selected" : ""}>🟢 ${esc(n)} (online)</option>`).join("");
      if (send) { send.disabled = false; send.style.opacity = ""; }
    } else {
      sel.innerHTML = `<option value="">(no one online right now)</option>`;
      if (send) { send.disabled = true; send.style.opacity = "0.5"; }
    }
  }
  $("ov-challenge").classList.add("open");
};

// D: memory-cached solved sets (5-min TTL). recordAnswer() adds to the
// cache immediately, so a duel started right after answering sees it.
async function solvedSetFor(name, maxAgeMs) {
  Net._solvedCache = Net._solvedCache || {};
  const now = Date.now();
  const ttl = (typeof maxAgeMs === "number") ? maxAgeMs : 5 * 60 * 1000;
  const hit = Net._solvedCache[name];
  if (hit && hit.set && (ttl === 0 || now - hit.ms < ttl)) return hit.set;
  const f = await fb();
  // A: prefer the 1-doc progress summary (1 read instead of a full scan).
  try {
    const pSnap = await f.getDoc(f.doc(f.db, "progress", name)).catch(() => null);
    if (pSnap && pSnap.exists()) {
      const d = pSnap.data() || {};
      if (d.solved && typeof d.solved === "object" && Object.keys(d.solved).length) {
        const set = new Set(Object.keys(d.solved));
        if (hit && hit.set) hit.set.forEach(qid => set.add(qid)); // answers since the read
        Net._solvedCache[name] = { set, ms: now };
        return set;
      }
    }
  } catch (e) {}
  // Fallback: full ledger scan (pre-backfill users / old-version friend).
  const q = f.query(f.collection(f.db, "attempts"), f.where("user_name", "==", name));
  const snap = await f.getDocs(q).catch(() => null);
  const set = (hit && hit.set) ? hit.set : new Set();
  if (snap) snap.forEach(d => {
    const a = d.data() || {};
    if (a.question_id) set.add(a.question_id);
  });
  Net._solvedCache[name] = { set, ms: now };
  return set;
}
function solvedCacheAdd(name, qid) {
  try {
    Net._solvedCache = Net._solvedCache || {};
    const e = Net._solvedCache[name] || (Net._solvedCache[name] = { set: new Set(), ms: Date.now() });
    e.set.add(qid);
  } catch (err) {}
}

// D: localStorage answer cache — instant paint on boot, survives reload.
// Shape: { v:1, ms, a:{qid:letter} }. Network merge always wins conflicts.
const LS_ANS = name => "satbank:answers:" + name;
function loadAnswerCache(name) {
  try {
    const o = JSON.parse(localStorage.getItem(LS_ANS(name)) || "null");
    if (o && o.a && typeof o.a === "object") return o;
  } catch (e) {}
  return null;
}
function saveAnswerCache(name) {
  try {
    const a = (App() && App().S && App().S.answers) || {};
    localStorage.setItem(LS_ANS(name), JSON.stringify({ v: 1, ms: Date.now(), a }));
  } catch (e) {}
}

// FIX #4: pick N questions, excluding anything solved by BOTH players.
// Duel answers count in attempts (recordAnswer with session_id) + solo
// answers, so both feed this filter. Honors current Filters first.
async function pickQuestions(n, guest) {
  let pool = [];
  try {
    const F = App().F, DB = App().DB;
    const filtered = Array.isArray(F) && F.length && F.length !== DB.length;
    pool = (filtered ? F.slice() : DB.map((_, i) => i));
  } catch (e) { pool = Net.db.map((_, i) => i); }
  try {
    if (guest && guest !== Net.name && ONLINE) {
      const [mine, theirs] = await Promise.all([solvedSetFor(Net.name), solvedSetFor(guest)]);
      if (mine.size || theirs.size) {
        const fresh = pool.filter(i => {
          const qid = (Net.db[i] || {}).id;
          return !(mine.has(qid) && theirs.has(qid));
        });
        if (fresh.length >= n) {
          pool = fresh;
        } else if (fresh.length > 0) {
          // Not enough fresh: fresh first, then random repeats to fill.
          const freshSet = new Set(fresh);
          const rest = pool.filter(i => !freshSet.has(i));
          for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
          }
          pool = fresh.concat(rest);
          toast(`Only ${fresh.length} fresh questions left — mixed in ${n - fresh.length} repeats 🔁`);
        }
        // fresh empty → keep full pool so the duel can still start.
      }
    }
  } catch (e) { /* offline: fall back to unfiltered pool */ }
  // shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const idxs = pool.slice(0, n);
  return idxs.map(i => Net.db[i].id);
}

async function createChallenge() {
  if (!Net.name) { toast("Save your name first 👇"); return; }
  if (!ONLINE) { toast("Offline — connect Firebase to challenge."); return; }
  let guest = otherName();
  if (!guest || guest === Net.name) {
    toast("No one is online to challenge right now.");
    return;
  }
  // Only allow challenging if the player is currently online
  if (!isPersonOnline(guest)) {
    toast(`${guest} is offline — you can only challenge online players ⚪`);
    return;
  }
  const n = Net.challN || 10;
  toast("Picking fresh questions… ⚔️");
  const qids = await pickQuestions(n, guest);
  if (qids.length < n) { toast("Not enough questions in the current filter."); return; }
  const f = await fb();
  const ref = await f.addDoc(f.collection(f.db, "sessions"), {
    host: Net.name, guest,
    totalQuestions: n,
    status: "pending",
    currentIndex: 0,
    questionIds: qids,
    currentAnswers: {},
    startedAt: null,
    createdAt: Date.now(),
  });
  $("ov-challenge").classList.remove("open");
  toast("Challenge sent to " + guest + " ⚔️");
  if (FX()) FX().sound("alert");
  // Host watches its own outgoing challenge for accept/decline.
  watchSession(ref.id);
  sayChall("Waiting for " + guest + " to accept…");

  // Auto-expire host waiting state after 60s if not accepted
  setTimeout(async () => {
    if (Net.session && Net.session.id === ref.id && Net.session.status === "pending") {
      toast("Challenge timed out — " + guest + " didn't respond ⏳");
      try {
        const fbInst = await fb();
        await fbInst.updateDoc(fbInst.doc(fbInst.db, "sessions", ref.id), { status: "expired" });
      } catch (e) {}
      exitChallenge();
    }
  }, 60000);
}

function listenInvites() {
  // Incoming pending challenges addressed to me.
  fb().then(f => {
    // Single-field filter (no composite index needed) + client-side pending pick.
    const q = f.query(f.collection(f.db, "sessions"), f.where("guest", "==", Net.name));
    const un = f.onSnapshot(q, snap => {
      const now = Date.now();
      let inv = null, invId = null;
      snap.forEach(d => {
        const s = d.data() || {};
        if (s.status !== "pending") return;
        // Auto-expire invites older than 60s so you never get stale invites when coming back online
        const age = now - (s.createdAt || 0);
        if (age > 60000) {
          f.updateDoc(d.ref, { status: "expired" }).catch(() => {});
          return;
        }
        if (!inv || (s.createdAt || 0) > (inv.createdAt || 0)) { inv = s; invId = d.id; }
      });
      if (inv) showInvite(invId, inv);
      else hideInvite();
    }, () => {});
    Net.unsubs.push(un);
  }).catch(() => {});
}

let pendingInvite = null;
function showInvite(id, s) {
  pendingInvite = { id, ...s };
  $("invite-from").textContent = s.host || "Friend";
  $("invite-n").textContent = s.totalQuestions || s.questionIds.length;
  $("invitebanner").classList.add("show");
  if (FX()) FX().sound("alert");
}
function hideInvite() {
  pendingInvite = null;
  const b = $("invitebanner");
  if (b) b.classList.remove("show");
}

async function acceptChallenge() {
  if (!pendingInvite) return;
  const id = pendingInvite.id; // capture BEFORE hideInvite() clears it
  const f = await fb();
  hideInvite();
  let ok = true;
  await f.updateDoc(f.doc(f.db, "sessions", id), {
    status: "active", startedAt: f.serverTimestamp(),
  }).catch(() => { ok = false; });
  if (!ok) { toast("Couldn't accept (offline?) — try again."); return; }
  watchSession(id);
}
async function declineChallenge() {
  if (!pendingInvite) return;
  const f = await fb();
  await f.updateDoc(f.doc(f.db, "sessions", pendingInvite.id), { status: "finished", declined: true }).catch(() => {});
  hideInvite();
  toast("Declined.");
}

// Both sides listen to the session doc in real time (spec §7).
function watchSession(id) {
  clearSessUnsubs();
  fb().then(f => {
    const un = f.onSnapshot(f.doc(f.db, "sessions", id), snap => {
      if (!snap.exists()) { exitChallenge(); return; }
      const s = { id: snap.id, ...snap.data() };
      const was = Net.session ? Net.session.status : null;
      Net.session = s;
      if (s.status === "declined" || (s.status === "finished" && s.declined) || s.status === "expired") {
        toast(s.status === "expired" ? "Challenge expired ⏳" : "Challenge declined.");
        exitChallenge(); return;
      }
      if (s.status === "active" && was !== "active") startCountdown(s);
      else if (s.status === "active") syncBattle(s);
      else if (s.status === "finished" && !s.declined) finishSession(s);
      else if (s.status === "pending") sayChall("Waiting for opponent…");
    }, () => {});
    Net.sessUnsubs.push(un);
  }).catch(() => {});
}
function clearSessUnsubs() {
  for (const u of Net.sessUnsubs) { try { u(); } catch (e) {} }
  Net.sessUnsubs = [];
}

function sayChall(t) {
  const ban = $("banner");
  const txt = $("banner-text") || ban;
  if (ban) {
    ban.classList.add("duel");
    ban.classList.add("swap");
    setTimeout(() => { if (ban) ban.classList.remove("swap"); }, 350);
  }
  if (txt) txt.textContent = t || "CHALLENGE";
  const ex = $("challexit");
  if (ex) ex.style.display = "inline-flex";
}

// 3-2-1 countdown with rising tones, then both enter the battle.
function startCountdown(s) {
  const ov = $("countdown"), num = $("countnum");
  ov.classList.add("show");
  Net.myScore = 0; Net.frScore = 0; Net.myTimes = []; Net.frTimes = [];
  Net.revealed = false;
  Net._bIdx = 0;
  Net.qStartMs = Date.now();
  let i = 3;
  if (FX()) FX().sound("go");
  const tick = () => {
    if (!Net.session || Net.session.id !== s.id) { ov.classList.remove("show"); return; }
    if (i <= 0) {
      ov.classList.remove("show");
      enterBattle(s);
      return;
    }
    num.textContent = i;
    // restart zoom animation each beat
    num.style.animation = "none"; void num.offsetWidth; num.style.animation = "";
    if (FX()) FX().sound("count", 3 - i);
    i--;
    setTimeout(tick, 900);
  };
  tick();
}

function battleIdxs(s) {
  return (s.questionIds || []).map(qid => Net.db.findIndex(e => e && e.id === qid)).filter(i => i >= 0);
}

function enterBattle(s) {
  const idxs = battleIdxs(s);
  if (App().setChallenge) App().setChallenge(idxs, true);
  Net.qStartMs = Date.now();
  Net.revealed = false;
  Net._myPick = null; Net._reveals = {}; // per-duel reveal map (pos -> {mine, foe, qid})
  Net._bIdx = s.currentIndex || 0;
  lockWaiting(false);
  paintBattle(s);
  if (FX()) FX().sound("go");
}

function syncBattle(s) {
  const i = s.currentIndex || 0;
  // New question → reset reveal/lock state and restart the per-question timer.
  if (Net._bIdx !== i) {
    Net._bIdx = i;
    Net.revealed = false;
    Net.qStartMs = Date.now();
    Net._myPick = null;
    // NOTE: _reveals map is kept (past questions stay reviewable with markers).
    lockWaiting(false);
  }
  const idxs = battleIdxs(s);
  const want = idxs[Math.min(i, idxs.length - 1)];
  try {
    // Ensure battle view is on (guest may join mid-match), then follow the host's index.
    if (App() && App().setChallenge && typeof want === "number") {
      const F = App().F || [];
      if (!F.length || !F.includes(want)) App().setChallenge(idxs, true);
      if (App().idx !== want && App().goTo) App().goTo(want);
    }
  } catch (e) {}
  Net.qStartMs = Net.qStartMs || Date.now();
  paintBattle(s);

  // Check embedded duel answers on the session doc
  const ca = s.currentAnswers || {};
  const mAns = ca[Net.name];
  const foeName = s.host === Net.name ? s.guest : s.host;
  const fAns = ca[foeName];

  if (mAns && !Net.revealed) {
    lockWaiting(true);
  }
  if (mAns && fAns && !Net.revealed && (mAns.questionIndex === undefined || mAns.questionIndex === i)) {
    revealDuel(s, mAns, fAns);
  }
}

function isChallengeView() {
  // Battle reuses the main panes via App.setChallenge; true while a session is active.
  return !!(Net.session && Net.session.status === "active");
}

function paintBattle(s) {
  const i = s.currentIndex || 0, n = s.totalQuestions || (s.questionIds || []).length;
  sayChall(`⚔️ Q${Math.min(i + 1, n)}/${n} vs ${s.host === Net.name ? s.guest : s.host}`);
  const pill = $("scorepill");
  if (pill) {
    pill.style.display = "";
    const prev = pill.dataset.sc || "0-0";
    pill.dataset.sc = Net.myScore + "-" + Net.frScore;
    pill.textContent = `You ${Net.myScore} – ${Net.frScore} ${s.host === Net.name ? s.guest : s.host}`;
    if (prev !== pill.dataset.sc && FX()) FX().sound("tada");
  }
  // FIX #3: challpill (⚔️ 2/20) duplicated navpill (Question 2 of 20) +
  // banner — keep it hidden during duels. Banner stays the single source.
  const cb = $("challpill");
  if (cb) cb.style.display = "none";
  // FIX #2: hide presence Q-numbers immediately when the duel paints.
  try { document.querySelectorAll(".pq-badge").forEach(el => { el.style.display = "none"; }); } catch (e) {}
}

function lockWaiting(on) {
  document.querySelectorAll("#opts .opt").forEach(o => o.classList.toggle("locked", !!on));
  const w = $("waitfriend");
  if (w) w.classList.toggle("show", !!on);
}

// Duel review range: played questions 0..current are viewable (read-only
// past, answerable live). renderQ() clamps into this range — Back reviews,
// Next returns toward live, anything past live snaps back. Question advances
// still pull everyone to live via goTo in syncBattle.
Net.duelRange = function () {
  const s = Net.session;
  if (!s || s.status !== "active") return null;
  const idxs = battleIdxs(s);
  if (!idxs.length) return null;
  return { idxs, cur: Math.min(s.currentIndex || 0, idxs.length - 1) };
};
Net.battleIndex = function () {
  const r = Net.duelRange();
  return r ? r.idxs[r.cur] : undefined;
};
Net.clampNav = function (i) {
  const r = Net.duelRange();
  if (!r) return i;
  if (r.idxs.slice(0, r.cur + 1).includes(i)) return i;
  return r.idxs[r.cur];
};

// Duel decor, applied after every render: Back steps through played questions
// (read-only), Next returns toward live, navigator is duel-limited. Past
// questions show their reveal (own paint + friend marker); live keeps the
// neutral locked pick until the joint reveal. Solo rendering is untouched.
Net.decorate = function () {
  if (!Net.inChallenge()) return;
  const s = Net.session;
  const i = s.currentIndex || 0;
  const qid = (s.questionIds || [])[i];
  const idxs = battleIdxs(s);
  const cur = idxs.length ? Math.min(i, idxs.length - 1) : i;
  // Viewed duel position (may lag live while reviewing).
  let viewPos = -1;
  try { viewPos = idxs.indexOf(App().idx); } catch (e) {}
  if (viewPos < 0) viewPos = cur;
  const reviewing = viewPos < cur;
  const back = $("backbtn"), next = $("nextbtn"), nav = $("navpill");
  if (back) back.disabled = viewPos <= 0;
  if (next) next.disabled = !reviewing; // Next only walks back to live
  if (nav) { nav.style.pointerEvents = ""; nav.style.opacity = ""; }
  const wait = $("waitfriend");
  const revMap = Net._reveals || {};
  const vQid = (s.questionIds || [])[viewPos];
  const rev = (revMap[viewPos] && revMap[viewPos].qid === vQid) ? revMap[viewPos] : null;
  const pick = (!reviewing && !rev && Net._myPick && Net._myPick.i === i && Net._myPick.qid === qid)
    ? Net._myPick.letter : null;
  // FIX #1: only lock options AFTER answering. Before answering they must
  // stay clickable. (Old code added .locked unconditionally + CSS
  // pointer-events:none blocked every click.)
  const ca = (s.currentAnswers || {})[Net.name];
  const echoed = !reviewing && !!(ca && (ca.questionIndex === undefined || ca.questionIndex === i));
  // Past questions are always locked (review-only, answers can't change).
  const shouldLock = !!(reviewing || rev || pick || echoed);
  document.querySelectorAll("#opts .opt").forEach(o => o.classList.toggle("locked", shouldLock));
  if (rev) {
    // Revealed: own correctness paints via the normal render; friend's pick
    // gets a marker (skipped when both picked the same option).
    if (rev.foe !== rev.mine) {
      const foeEl = document.querySelector('#opts .opt[data-k="' + rev.foe + '"]');
      if (foeEl) {
        foeEl.classList.add("friendpick");
        if (!foeEl.querySelector(".foetag")) {
          const t = document.createElement("span");
          t.className = "foetag"; t.textContent = "👤 friend";
          foeEl.appendChild(t);
        }
      }
    }
    if (wait) wait.classList.remove("show");
  } else if (pick) {
    const mine = document.querySelector('#opts .opt[data-k="' + pick + '"]');
    if (mine) mine.classList.add("picked");
    if (wait) wait.classList.add("show");
  } else {
    if (wait) wait.classList.remove("show");
  }
};

// In-challenge answer: locks input, hides correctness, reveals for BOTH at
// once when the friend's answer lands (see revealDuel). Never paints the
// correct answer early — the pick stays neutral until the joint reveal.
Net.answerChallenge = async function (qid, letter) {
  const s = Net.session;
  if (!s || s.status !== "active") return;
  const i = s.currentIndex || 0;
  // Review guard: only the live question is answerable. Past questions are
  // read-only (their options render locked by decorate()).
  if (qid !== (s.questionIds || [])[i]) {
    toast("Reviewing — hop back to the live question to answer ⚔️");
    return;
  }
  if (Net._myPick && Net._myPick.i === i) return; // already answered — locked
  const echo = s.currentAnswers && s.currentAnswers[Net.name];
  if (echo && (echo.questionIndex === undefined || echo.questionIndex === i)) return;
  const e = Net.byId[qid];
  const ok = !!e && letter === e.correct;
  const timeMs = Date.now() - (Net.qStartMs || Date.now());
  Net._myPick = { i, qid, letter }; // neutral pick; correctness hidden
  if (App() && App().renderQ) App().renderQ(); // decorate() paints picked+locked
  if (FX()) FX().sound("tick");
  try {
    const f = await fb();
    await f.updateDoc(f.doc(f.db, "sessions", s.id), {
      [`currentAnswers.${Net.name}`]: {
        user_name: Net.name, questionIndex: i, selected: letter, is_correct: ok, timeMs,
      }
    });
  } catch (err) {
    Net._myPick = null;
    lockWaiting(false);
    toast("Couldn't send answer (offline?)");
    if (App() && App().renderQ) App().renderQ();
    return;
  }
  // Every challenge answer also counts in attempts with session_id set
  // (recordAnswer keeps it out of the visible answers until reveal).
  Net.recordAnswer(qid, letter, s.id);
};

async function revealDuel(s, mDoc, fDoc) {
  Net.revealed = true;
  const i = s.currentIndex || 0, n = s.totalQuestions || s.questionIds.length;
  const qid = (s.questionIds || [])[i];
  // Score: "You X – Friend Y" with counter animation.
  if (mDoc.is_correct) { Net.myScore++; Net.myTimes.push(mDoc.timeMs || 0); }
  else Net.myTimes.push(mDoc.timeMs || 0);
  if (fDoc.is_correct) { Net.frScore++; Net.frTimes.push(fDoc.timeMs || 0); }
  else Net.frTimes.push(fDoc.timeMs || 0);
  // SIMULTANEOUS reveal for both: own correctness paints now (same data on
  // both screens), friend's pick marked by decorate(). Nothing showed before.
  (Net._reveals = Net._reveals || {})[i] = { i, qid, mine: mDoc.selected, foe: fDoc.selected };
  Net._myPick = null;
  if (App() && App().S) { App().S.answers[qid] = mDoc.selected; saveAnswerCache(Net.name); }
  if (App() && App().renderQ) App().renderQ();
  lockWaiting(false);
  const right = $("right");
  if (right) { right.classList.remove("flip-reveal"); void right.offsetWidth; right.classList.add("flip-reveal"); }
  if (FX()) { FX().sound("whoosh"); setTimeout(() => FX() && FX().sound("tada"), 350); }
  paintBattle({ ...s, currentIndex: i });
  toast(mDoc.is_correct ? `Correct! ${Net.myScore}–${Net.frScore} 🎉` :
    `It was ${correctOf(s.questionIds[i])} — ${Net.myScore}–${Net.frScore}`);
  // Advance after a beat so both can see the reveal. Host writes, guest follows.
  setTimeout(async () => {
    if (!Net.session || Net.session.id !== s.id) return;
    if ((s.currentIndex || 0) !== i) return; // already advanced
    if (i + 1 >= n) { await closeSession(s); return; }
    if (Net.name === s.host) {
      try {
        const f = await fb();
        await f.updateDoc(f.doc(f.db, "sessions", s.id), {
          currentIndex: i + 1,
          currentAnswers: {}, // reset embedded answers for next question
        });
      } catch (e) {}
    } else {
      // guest nudges forward locally if host is slow (host write wins on race)
      setTimeout(() => {
        if (Net.session && Net.session.currentIndex === i) syncBattle({ ...Net.session });
      }, 2500);
    }
    Net.qStartMs = Date.now();
    Net.revealed = false;
  }, 2600);
}

function correctOf(qid) { const e = Net.byId[qid]; return e ? e.correct : "?"; }

async function closeSession(s) {
  try {
    const f = await fb();
    await f.updateDoc(f.doc(f.db, "sessions", s.id), { status: "finished", finishedAt: Date.now() }).catch(() => {});
  } catch (e) {}
}

function finishSession(s) {
  exitBattleView();
  const foe = s.host === Net.name ? s.guest : s.host;
  const n = s.totalQuestions || (s.questionIds || []).length;
  const win = Net.myScore > Net.frScore, tie = Net.myScore === Net.frScore;
  $("end-trophy").textContent = win ? "🏆" : tie ? "🤝" : "💪";
  $("end-title").textContent = win ? "You win!" : tie ? "Dead even!" : foe + " wins!";
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length / 100) / 10 + "s" : "—";
  $("end-sub").textContent = `${Net.myScore}–${Net.frScore} over ${n} · avg you ${avg(Net.myTimes)} / them ${avg(Net.frTimes)}`;
  $("end-grid").innerHTML =
    `<div class="end-card"><b>${Net.myScore}</b><div>you</div></div>` +
    `<div class="end-card"><b>${Net.frScore}</b><div>${esc(foe)}</div></div>`;
  $("ov-challend").classList.add("open");
  if (FX()) {
    if (win) { FX().sound("fanfare"); FX().burst("perfect"); }
    else if (tie) FX().sound("tada");
    else FX().sound("neutral");
  }
  Net.session = null;
  clearSessUnsubs();
  sayChallHide();
}

function exitBattleView() {
  try {
    // FIX #4A: carry any unrevealed duel pick into solo view instantly.
    // (Firestore already has it via recordAnswer; revealed answers were
    // already merged in revealDuel. Without this an early exit would hide
    // your last pick until next reload.)
    if (Net._myPick && App() && App().S) {
      App().S.answers[Net._myPick.qid] = Net._myPick.letter;
      saveAnswerCache(Net.name);
    }
    if (App().setChallenge) App().setChallenge(null);
  } catch (e) {}
  Net._myPick = null; Net._reveals = {}; Net.revealed = false;
  lockWaiting(false);
  sayChallHide();
  const cb = $("challpill"); if (cb) cb.style.display = "none";
  const sp = $("scorepill"); if (sp) sp.style.display = "none";
  // FIX #2 restore: show presence Q-numbers again after the duel.
  try {
    document.querySelectorAll(".pq-badge").forEach(el => { el.style.display = ""; });
    if (Net._people) paintPresence(Net._people, Date.now());
  } catch (e) {}
  // Undo the duel nav lock (decorate() disables these mid-battle).
  const nav = $("navpill");
  if (nav) { nav.style.pointerEvents = ""; nav.style.opacity = ""; }
  if (App() && App().renderQ) App().renderQ(); // repaint unlocked solo view
}
function sayChallHide() {
  const ban = $("banner");
  if (ban && !$("ov-challend").classList.contains("open")) {
    ban.classList.remove("duel");
  }
  const txt = $("banner-text");
  if (txt && (!ban || !ban.classList.contains("duel"))) {
    txt.textContent = "THIS IS A PRACTICE TEST";
  }
  const ex = $("challexit");
  if (ex && (!ban || !ban.classList.contains("duel"))) {
    ex.style.display = "none";
  }
  const sp = $("scorepill");
  if (sp && (!ban || !ban.classList.contains("duel"))) {
    sp.style.display = "none";
  }
}
function exitChallenge() {
  Net.session = null;
  clearSessUnsubs();
  exitBattleView();
  Net.revealed = false;
}

Net.exitChallenge = exitChallenge;
