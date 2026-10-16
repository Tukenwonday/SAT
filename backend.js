// backend.js — the online layer (Node + Express + Postgres + Socket.IO).
// Owns window.Net unconditionally.
//
// Identity = typed name + PIN (plain-text collision protection, not real security).
// PIN is stored per-name in localStorage; prompted once when unknown.

const BC = (typeof window !== "undefined" && window.SATBANK_BACKEND) || {};
// URL resolution: ?backendUrl=... query param > localStorage > sync-config.js file.
// (So local testing needs no file edit: just open with ?backendUrl=http://localhost:3001)
function baseUrl() {
  try {
    const q = new URLSearchParams(location.search).get("backendUrl");
    if (q) return String(q).replace(/\/+$/, "");
    const ls = localStorage.getItem("satbank_backend_url");
    if (ls) return String(ls).replace(/\/+$/, "");
  } catch (e) {}
  return String(BC.url || "").replace(/\/+$/, "");
}
const BASE = baseUrl();

const $ = id => document.getElementById(id);
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const App = () => window.App;
const FX = () => window.FX;
const toast = (m, ms) => { if (window.toast) window.toast(m, ms); };
const reducedMotion = () =>
  document.documentElement.dataset.motion === "reduced" ||
  (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

function countUp(el, from, to, suffix) {
  if (!el) return;
  suffix = suffix || "";
  if (reducedMotion() || from === to) { el.textContent = to + suffix; return; }
  const t0 = performance.now(), dur = 600;
  const step = t => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * e) + suffix;
    if (k < 1) requestAnimationFrame(step);
    else { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  };
  requestAnimationFrame(step);
}
const dayKeyOf = ms => {
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

// ── transport ──────────────────────────────────────────────────────────────
async function api(path, opts) {
  opts = opts || {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      keepalive: !!opts.keepalive,
      signal: ctrl.signal,
    });
    return await r.json().catch(() => ({ ok: false, error: "bad-json" }));
  } catch (e) { return { ok: false, error: "offline" }; }
  finally { clearTimeout(t); }
}

// ── PIN (per-name, localStorage; prompt once when unknown) ─────────────────
const LS_PIN = name => "satbank:pin:" + name;
function getPin(name) {
  try {
    const v = ($("pininput") && $("pininput").value || "").trim();
    if (v) return v;
    return (localStorage.getItem(LS_PIN(name)) || "").trim();
  } catch (e) { return ""; }
}
function setPin(name, pin) {
  try {
    if (pin) localStorage.setItem(LS_PIN(name), pin);
    if ($("pininput")) $("pininput").value = "";
  } catch (e) {}
}
function ensurePin(name) {
  let pin = getPin(name);
  if (pin) return pin;
  pin = (window.prompt("PIN for \"" + name + "\" (first use: invent one, min 4 chars):") || "").trim();
  return pin;
}

// Sessions I forfeited (survives reload in this tab): the boot rejoin must
// never resurrect them — a lost forfeit write would otherwise countdown-loop.
function loadForfeited() {
  try { return JSON.parse(sessionStorage.getItem("satbank:forfeited") || "{}") || {}; }
  catch (e) { return {}; }
}
function markForfeited(id) {
  if (!id) return;
  try {
    Net._forfeited = Net._forfeited || {};
    Net._forfeited[id] = Date.now();
    sessionStorage.setItem("satbank:forfeited", JSON.stringify(Net._forfeited));
  } catch (e) {}
}
// Beacon forfeit: the only delivery that survives tab close. text/plain blob
// keeps it a CORS-simple request (no preflight); the server parses both.
function sendForfeitBeacon(id) {
  try {
    if (!id || !Net.name) return;
    const body = JSON.stringify({ actor: Net.name, pin: getPin(Net.name), action: "forfeit" });
    navigator.sendBeacon(BASE + "/api/sessions/" + encodeURIComponent(id),
      new Blob([body], { type: "text/plain" }));
  } catch (e) {}
}
// Online state: trust the server-computed flag (server clock, 75s window).
// Client-clock math is the fallback only when the flag is missing.
function isOnlinePerson(p, now) {
  if (!p) return false;
  if (typeof p.online === "boolean") return p.online;
  return ((now || Date.now()) - (p.lastSeen || 0)) < 30000;
}

// ── Net object (public online surface used by index.html) ────────────────────
const Net = {
  on: true,
  backend: true,
  BUILD: "vps-multiuser-v1",
  name: "",
  friend: "",
  db: [], byId: {},
  socket: null,
  sockOk: false,
  beatTimer: null,
  pollTimer: null,
  sessPoll: null,
  invitePoll: null,
  myDayKey: "",
  _lastActionMs: 0,
  _lastMovedIdx: undefined,
  todayCounts: {},
  seenOnline: {},
  _people: [],
  _solvedCache: {},
  session: null,
  qStartMs: 0,
  challN: 10,
  myScore: 0, frScore: 0,
  myTimes: [], frTimes: [],
  revealed: false,
  _myPick: null, _reveals: {}, _bIdx: 0,
  _watching: null,   // session id this client explicitly follows (watch/accept/create)
  _sessSyncMs: 0,    // last time ANY session update was processed (socket or REST)
  _presenceAt: 0,    // last time a presence list arrived
  _beatSentMs: 0,    // last heartbeat sent
  _invitePollHiddenMs: 0,
  _forfeited: {},    // session ids I gave up on (survives reload via sessionStorage)
  _chat: null,       // duel chat: { sid, open, unread, log[] } — ephemeral, never stored
};
window.Net = Net;
window.NetBackend = Net;
Net._forfeited = loadForfeited();

// ── answer cache (instant paint on boot) ─────────────
const LS_ANS = name => "satbank:answers:" + name;
// Clears made while offline, retried at next identify (needs a reload to sync).
const LS_CLR = name => "satbank:pending-clears:" + name;
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
function solvedCacheAdd(name, qid) {
  try {
    Net._solvedCache = Net._solvedCache || {};
    const e = Net._solvedCache[name] || (Net._solvedCache[name] = { set: new Set(), ms: Date.now() });
    e.set.add(qid);
  } catch (err) {}
}
function solvedCacheDel(name, qid) {
  try {
    const e = Net._solvedCache && Net._solvedCache[name];
    if (e && e.set) e.set.delete(qid);
  } catch (err) {}
}
async function solvedSetFor(name) {
  Net._solvedCache = Net._solvedCache || {};
  const now = Date.now();
  const hit = Net._solvedCache[name];
  if (hit && hit.set && now - hit.ms < 5 * 60 * 1000) return hit.set;
  const r = await api("/api/progress/" + encodeURIComponent(name));
  const set = new Set(r && r.answers ? Object.keys(r.answers) : []);
  if (hit && hit.set) hit.set.forEach(qid => set.add(qid));
  Net._solvedCache[name] = { set, ms: now };
  return set;
}

// ── boot ───────────────────────────────────────────────────────────────────
Net.init = async function (db) {
  Net.db = db || [];
  Net.byId = {};
  Net.db.forEach(e => { if (e && e.id) Net.byId[e.id] = e; });
  wireChallengeUI();
  injectPinBox();
  if (!Net._leaveWired) {
    Net._leaveWired = true;
    window.addEventListener("pagehide", () => {
      if (!Net.name) return;
      try {
        const s = Net.session;
        if (s && (s.status === "pending" || s.status === "active") &&
            (s.host === Net.name || s.guest === Net.name)) {
          // Unload forfeit: beacon is the only delivery that survives tab close.
          // Guest holding only an unaccepted invite has no session: nothing to forfeit.
          sendForfeitBeacon(s.id);
          markForfeited(s.id);
        }
      } catch (e) {}
      if (!Net.socket || !Net.socket.connected) {
        // Socket-less clients only: explicit offline write. With a live socket
        // the server's disconnect grace covers tab close without blinking offline.
        api("/api/status/" + encodeURIComponent(Net.name) + "/offline",
          { method: "POST", body: {}, keepalive: true });
      }
      try { Net.socket && Net.socket.disconnect(); } catch (e) {}
    });
    // Leaving mid-duel forfeits (pagehide above fires on confirm). Solo play never nags.
    window.addEventListener("beforeunload", (e) => {
      const s = Net.session;
      if (s && s.status === "active" && (s.host === Net.name || s.guest === Net.name)) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }
  connectSocket();
  let saved = "";
  try { saved = (localStorage.getItem("satbank:name") || "").trim().slice(0, 20); } catch (e) {}
  if (saved) {
    const pin = getPin(saved);
    if (pin) identify(saved, pin, true);
    else { paintPresenceOffline(); syncPinBox(); }
  } else paintPresenceOffline();
};

function connectSocket() {
  if (typeof window.io === "undefined") { startPollFallback(); return; } // CDN missed: REST-only
  try {
    Net.socket = window.io(BASE, { transports: ["websocket", "polling"] });
  } catch (e) { startPollFallback(); return; }
  const so = Net.socket;
  so.on("connect", () => {
    Net.sockOk = true;
    if (Net.name && getPin(Net.name)) so.emit("identify", { name: Net.name, pin: getPin(Net.name) });
    // Reconnect mid-duel: rooms live on the old socket, so rejoin or updates stop arriving.
    if (Net.session && Net.session.id) so.emit("session:join", { id: Net.session.id });
    // Safety net: re-pull any pending invite the push may have missed.
    (async () => {
      if (!Net.name) return;
      try {
        const inv = await api("/api/invites/pending?user=" + encodeURIComponent(Net.name) +
          "&pin=" + encodeURIComponent(getPin(Net.name)));
        if (inv && inv.invite && (!pendingInvite || pendingInvite.id !== inv.invite.id))
          showInvite(inv.invite.id, inv.invite);
      } catch (e) {}
    })();
  });
  so.on("disconnect", () => { Net.sockOk = false; startPollFallback(); });
  so.on("identify:reject", () => {
    toast("Wrong PIN for " + Net.name + " — re-enter your name + PIN.");
    try { localStorage.removeItem(LS_PIN(Net.name)); } catch (e) {}
    Net.sockOk = false;
  });
  so.on("presence:list", people => onPresence(people || []));
  so.on("invite:new", s => showInvite(s.id, s));
  so.on("invite:expired", ({ id } = {}) => {
    if (pendingInvite && pendingInvite.id === id) { hideInvite(); toast("Challenge expired ⏳"); }
    if (Net.session && Net.session.id === id) clearChallengeState();
  });
  so.on("invite:declined", ({ id, by } = {}) => {
    if (Net.session && Net.session.id === id) { toast("Challenge declined."); clearChallengeState(); }
  });
  so.on("session:update", s => onSession(s));
  so.on("chat:new", m => onChatMsg(m));
}
// REST polling when the socket is down (same 30s cadence, no focus-refetch).
function startPollFallback() {
  if (Net.pollTimer || Net.sockOk) return;
  const tick = async () => {
    if (!Net.name || Net.sockOk) return;
    if (document.visibilityState === "hidden") return;
    const r = await api("/api/status?scope=friends&user=" + encodeURIComponent(Net.name) +
      "&pin=" + encodeURIComponent(getPin(Net.name)));
    if (r && r.ok) onPresence(r.people || []);
  };
  Net.pollTimer = setInterval(tick, 30000);
  tick();
}

// ── identify + presence ────────────────────────────────────────────────────
Net.identify = function (name) { // index.html calls identify(name); PIN resolved here
  const pin = ensurePin(String(name || "").trim().slice(0, 20));
  if (!pin) { toast("PIN needed — try saving your name again."); return; }
  identify(name, pin, false);
};
async function identify(name, pin, quiet) {
  name = String(name || "").trim().slice(0, 20);
  if (!name || !pin) return;
  Net.name = name;
  Net._lastActionMs = Date.now();
  try { localStorage.setItem("satbank:name", name); } catch (e) {}
  if (App() && App().S) App().S.name = name;
  try {
    const c = loadAnswerCache(name);
    if (c && c.a && Object.keys(c.a).length && App() && App().S) {
      App().S.answers = { ...c.a };
      if (App().refresh) App().refresh();
    }
  } catch (e) {}
  setPin(name, pin);
  syncPinBox();
  const r = await api("/api/identify", { method: "POST", body: { name, pin } });
  if (!r || !r.ok) {
    if (r && r.error === "bad-pin") {
      try { localStorage.removeItem(LS_PIN(name)); } catch (e) {}
      toast("Wrong PIN for " + name + " — that name is taken. Pick another or retry.");
    } else toast("Backend unreachable — playing solo (offline).");
    paintPresenceOffline();
    return;
  }
  if (r.generatedPin) {
    setPin(name, r.generatedPin);
    toast("Your PIN is " + r.generatedPin + " — save it! Needed on other devices.", 8000);
  }
  Net.myDayKey = r.dayKey || dayKeyOf(Date.now());
  Net.todayCounts[name] = typeof r.todayCount === "number" ? r.todayCount : 0;
  Net._lastMovedIdx = currentIdx();
  await restoreProgress();
  await flushPendingClears(); // offline clears re-sync after restore (restore would resurrect them)
  if (Net.socket && Net.socket.connected)
    Net.socket.emit("identify", { name, pin: getPin(name) });
  else {
    const p = await api("/api/status?scope=friends&user=" + encodeURIComponent(name) +
      "&pin=" + encodeURIComponent(getPin(name)));
    if (p && p.ok) onPresence(p.people || []);
    const inv = await api("/api/invites/pending?user=" + encodeURIComponent(name) +
      "&pin=" + encodeURIComponent(getPin(name)));
    if (inv && inv.invite) showInvite(inv.invite.id, inv.invite);
  }
  // Rejoin a duel that was live across reload (scores restart from zero).
  // Sessions I forfeited are never resurrected: the server gets a cleanup
  // forfeit in case the original write died with the reload. Active sessions
  // ask first — no more surprise 3-2-1 countdown loops.
  try {
    const live = await api("/api/sessions/live?user=" + encodeURIComponent(name) +
      "&pin=" + encodeURIComponent(getPin(name)));
    if (live && live.session) {
      const s = live.session;
      if (Net._forfeited && Net._forfeited[s.id]) {
        try { delete Net._forfeited[s.id]; sessionStorage.setItem("satbank:forfeited", JSON.stringify(Net._forfeited)); } catch (e2) {}
        api("/api/sessions/" + encodeURIComponent(s.id),
          { method: "PATCH", keepalive: true, body: { actor: name, pin: getPin(name), action: "forfeit" } });
      } else if (s.status === "active") {
        const foe = s.host === name ? s.guest : s.host;
        const nq = s.totalQuestions || (s.questionIds || []).length;
        let back = false;
        try { back = window.confirm(`Rejoin your duel vs ${foe}? (Q${(s.currentIndex || 0) + 1} of ${nq})`); } catch (e2) {}
        if (back) watchSession(s.id);
        else {
          markForfeited(s.id);
          api("/api/sessions/" + encodeURIComponent(s.id),
            { method: "PATCH", keepalive: true, body: { actor: name, pin: getPin(name), action: "forfeit" } });
          if (pendingInvite && pendingInvite.id === s.id) hideInvite();
        }
      }
      else if (s.status === "pending" && s.host === name) { watchSession(s.id); sayChall("Waiting for opponent…"); }
      else if (s.status === "pending" && s.guest === name) { showInvite(s.id, s); }
    }
  } catch (e) {}
  startInvitePoll();
  startPresenceWatchdog();
  startHeartbeat();
  if (!quiet) toast("Online as " + name + " ✅");
}

function currentIdx() { try { return App().idx || 0; } catch (err) { return 0; } }

let _moveTimer = null;
Net.moved = function () {
  if (!Net.name) return;
  if (Net.inChallenge()) return; // freeze presence Q during duel (no leaking)
  Net._lastActionMs = Date.now();
  const ci = currentIdx();
  if (Net._lastMovedIdx === ci) return;
  if (_moveTimer) clearTimeout(_moveTimer);
  _moveTimer = setTimeout(async () => {
    Net._lastMovedIdx = ci;
    const pin = getPin(Net.name);
    if (Net.socket && Net.socket.connected)
      Net.socket.emit("presence:move", { name: Net.name, pin, currentIndex: ci });
    else
      api("/api/status/" + encodeURIComponent(Net.name),
        { method: "PUT", body: { pin, currentIndex: ci } });
  }, 1500);
};

function startHeartbeat() {
  if (Net.beatTimer) return;
  Net.beatTimer = setInterval(async () => {
    if (!Net.name) return;
    // Freshness beats write-saving: lastSeen must stay well inside the
    // server's online window (75s). Visible tabs beat every ~25s, hidden ~60s.
    const gap = document.visibilityState === "hidden" ? 60000 : 25000;
    if (Date.now() - (Net._beatSentMs || 0) < gap) return;
    Net._beatSentMs = Date.now();
    api("/api/status/" + encodeURIComponent(Net.name) + "/heartbeat",
      { method: "POST", body: { pin: getPin(Net.name) } });
  }, 10000);
}
// Invite safety net: socket is primary, but polling guarantees delivery
// even when the socket is down. Hidden tabs poll slower — an invite must
// survive the ~90s server TTL to be seen.
function startInvitePoll() {
  if (Net.invitePoll) return;
  Net.invitePoll = setInterval(async () => {
    if (!Net.name) return;
    if (document.visibilityState === "hidden") {
      if (Date.now() - (Net._invitePollHiddenMs || 0) < 30000) return;
      Net._invitePollHiddenMs = Date.now();
    }
    const r = await api("/api/invites/pending?user=" + encodeURIComponent(Net.name) +
      "&pin=" + encodeURIComponent(getPin(Net.name)));
    if (r && r.invite) {
      if (!pendingInvite || pendingInvite.id !== r.invite.id) showInvite(r.invite.id, r.invite);
    } else if (pendingInvite && Date.now() - (pendingInvite.at || 0) > 100000) {
      hideInvite(); // server sweep expired it while the socket was down
    }
  }, 10000);
}
// Presence watchdog: a connected-but-silent socket must not freeze the roster
// (stale lastSeen decays to "0 online" with no recovery). REST-refreshes when
// no push arrived for 45s, whatever the socket claims.
function startPresenceWatchdog() {
  if (Net._presenceWatch) return;
  Net._presenceWatch = setInterval(async () => {
    if (!Net.name || document.visibilityState === "hidden") return;
    if (Date.now() - (Net._presenceAt || 0) < 45000) return;
    await refreshPresence();
  }, 15000);
}
async function refreshPresence() {
  try {
    if (!Net.name) return;
    const r = await api("/api/status?scope=friends&user=" + encodeURIComponent(Net.name) +
      "&pin=" + encodeURIComponent(getPin(Net.name)));
    if (r && r.ok) onPresence(r.people || []);
  } catch (e) {}
}

function onPresence(people) {
  const now = Date.now();
  Net._people = people;
  Net._presenceAt = now;
  const today = dayKeyOf(now);
  for (const p of people) {
    // A counter untouched since before today still holds yesterday's number — show 0.
    Net.todayCounts[p.name] = (p.dayKey === today) ? (p.todayCount || 0) : 0;
  }
  const other = people.filter(p => p.name !== Net.name)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];
  Net.friend = other ? other.name : (Net.friend || "");
  if (Net.friend) { try { localStorage.setItem("satbank:friend", Net.friend); } catch (e) {} }
  paintPresence(people, now);
  for (const p of people) {
    const online = isOnlinePerson(p, now);
    if (p.name !== Net.name && online && !Net.seenOnline[p.name]) {
      Net.seenOnline[p.name] = true;
      if (FX()) FX().sound("chime");
      toast(p.name + " is online 🟢");
    } else if (!online) Net.seenOnline[p.name] = false;
  }
}

function rosterOrder(people) {
  return people.slice().sort((a, b) =>
    (a.name === Net.name ? -1 : b.name === Net.name ? 1 : String(a.name).localeCompare(String(b.name))));
}
// One compact button (online count) + dropdown roster. Pills didn't scale past a few users.
function paintPresence(people, now) {
  Net._people = people;
  const box = $("presence"); if (!box) return;
  if (!$("rosterbtn") || !$("rosterpanel")) {
    box.innerHTML = "";
    const btn = document.createElement("button");
    btn.type = "button"; btn.id = "rosterbtn"; btn.className = "roster-btn";
    btn.innerHTML = '<span class="dot"></span><span id="rostercount"></span>';
    const panel = document.createElement("div");
    panel.id = "rosterpanel"; panel.className = "roster-panel"; panel.style.display = "none";
    box.appendChild(btn); box.appendChild(panel);
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      const p = $("rosterpanel");
      if (p) p.style.display = p.style.display === "none" ? "" : "none";
    });
    if (!Net._rosterWired) {
      Net._rosterWired = true;
      document.addEventListener("click", ev => {
        const p = $("rosterpanel");
        if (p && p.style.display !== "none" && !p.contains(ev.target)) p.style.display = "none";
      });
    }
  }
  const btn = $("rosterbtn"), panel = $("rosterpanel");
  const order = rosterOrder(people);
  const onlineCount = people.filter(p => isOnlinePerson(p, now)).length;
  const cnt = btn.querySelector("#rostercount");
  if (cnt) cnt.textContent = onlineCount + " online";
  btn.classList.toggle("alloff", !onlineCount);
  panel.innerHTML = "";
  const MAXR = 30;
  order.slice(0, MAXR).forEach(p => panel.appendChild(rosterRow(p, isOnlinePerson(p, now))));
  if (order.length > MAXR) {
    const more = document.createElement("div");
    more.className = "roster-more";
    more.textContent = "+" + (order.length - MAXR) + " more";
    panel.appendChild(more);
  }
}
function rosterRow(person, online) {
  const row = document.createElement("div");
  row.className = "roster-row" + (online ? " on" : "");
  row.dataset.name = person.name;
  row.innerHTML = '<span class="dot"></span><span class="rname"></span>' +
    '<span class="rtoday"><b class="count-tick">0</b> today</span>';
  row.querySelector(".rname").textContent = person.name + (person.name === Net.name ? " (you)" : "");
  const tick = row.querySelector(".count-tick");
  const today = Net.todayCounts[person.name] || 0;
  tick.textContent = today;
  tick.dataset.v = today;
  return row;
}
function paintPresenceOffline() {
  const box = $("presence"); if (!box) return;
  box.innerHTML = "";
  const btn = document.createElement("button");
  btn.type = "button"; btn.id = "rosterbtn"; btn.className = "roster-btn alloff";
  btn.innerHTML = '<span class="dot"></span><span>offline</span>';
  box.appendChild(btn);
}

// ── PIN box (injected next to the name box; hidden once signed in) ─────────
function injectPinBox() {
  if ($("pininput") || !$("namebox")) return;
  const inp = document.createElement("input");
  inp.id = "pininput";
  inp.type = "password";
  inp.maxLength = 64;
  inp.placeholder = "PIN";
  inp.autocomplete = "off";
  inp.title = "Your name PIN — prevents impersonation";
  inp.style.cssText = "padding:8px 10px;font-size:14px;border:1.5px solid #333;border-radius:12px;" +
    "font-family:var(--sans);max-width:80px;";
  inp.addEventListener("keydown", ev => ev.stopPropagation());
  const save = $("namesave");
  save.parentNode.insertBefore(inp, save);
  // Change-PIN button: double-clicking the name reveals it next to Save.
  const key = document.createElement("button");
  key.id = "pinchange";
  key.type = "button";
  key.textContent = "🔑";
  key.title = "Change PIN";
  key.style.cssText = "border:1.5px solid #333;background:#fff;border-radius:12px;" +
    "padding:8px 10px;font-size:14px;cursor:pointer;display:none;";
  save.parentNode.insertBefore(key, save.nextSibling);
  key.addEventListener("click", changePinFlow);
  // Mirror the name box visibility (index.html hides nameinput/namesave when signed in).
  const ni = $("nameinput");
  const sync = () => { inp.style.display = ni.style.display; key.style.display = ni.style.display; };
  new MutationObserver(sync).observe(ni, { attributes: true, attributeFilter: ["style"] });
  sync();
  // Double-click name: stock edit-name, plus reveal the PIN changer too.
  const who = $("whoami");
  if (who && window.editName) {
    who.removeEventListener("dblclick", window.editName);
    who.addEventListener("dblclick", () => { window.editName(); sync(); });
  }
}
function syncPinBox() {
  const ni = $("nameinput"), inp = $("pininput"), key = $("pinchange");
  if (ni && inp) inp.style.display = ni.style.display;
  if (ni && key) key.style.display = ni.style.display;
}
async function changePinFlow() {
  if (!Net.name) { toast("Save your name first 👇"); return; }
  const cur = window.prompt(`Current PIN for "${Net.name}":`, getPin(Net.name) || "");
  if (cur === null) return;
  const np = window.prompt("New PIN (min 4 characters):", "");
  if (np === null) return;
  const npin = (np || "").trim();
  if (npin.length < 4) { toast("PIN must be at least 4 characters."); return; }
  const r = await api("/api/users/" + encodeURIComponent(Net.name) + "/pin",
    { method: "POST", body: { oldPin: (cur || "").trim(), newPin: npin } });
  if (r && r.ok) { setPin(Net.name, npin); toast("PIN changed ✅"); }
  else toast(r && r.error === "bad-pin" ? "Wrong current PIN." : "Couldn't change PIN (offline?).");
}

// ── answers / progress / history ───────────────────────────────────────────
async function restoreProgress() {
  const r = await api("/api/progress/" + encodeURIComponent(Net.name));
  if (!r || !r.ok) return;
  const solved = r.answers || {};
  const S = (App() && App().S) ? App().S : null;
  if (S) {
    const next = { ...solved };
    Object.keys(S.answers || {}).forEach(q => { if (!(q in solved)) next[q] = S.answers[q]; });
    S.answers = next;
    if (App().refresh) App().refresh();
  }
  Net._solvedCache[Net.name] = { set: new Set(Object.keys((S && S.answers) || solved)), ms: Date.now() };
  saveAnswerCache(Net.name);
}
Net.fullResync = async function (loud) {
  await restoreProgress();
  if (loud) toast("Progress re-synced ✅");
};

function bumpToday(n) {
  Net.todayCounts[Net.name] = typeof n === "number" ? n : (Net.todayCounts[Net.name] || 0) + 1;
  try {
    const pill = document.querySelector('#rosterpanel .roster-row[data-name="' + Net.name + '"] .count-tick');
    if (pill) {
      const old = pill.dataset.v ? +pill.dataset.v : 0;
      pill.dataset.v = Net.todayCounts[Net.name];
      countUp(pill, old, Net.todayCounts[Net.name], "");
    }
  } catch (e) {}
}

Net.recordAnswer = async function (qid, letter, sessionId) {
  if (!Net.name) return;
  const e = Net.byId[qid];
  const ok = !!e && letter === e.correct;
  Net._lastActionMs = Date.now();
  solvedCacheAdd(Net.name, qid);
  if (!sessionId && App() && App().S) { App().S.answers[qid] = letter; saveAnswerCache(Net.name); }
  const r = await api("/api/answers", {
    method: "POST",
    body: {
      user_name: Net.name, pin: getPin(Net.name),
      question_id: qid, selected: letter, is_correct: ok, session_id: sessionId || null,
    },
  });
  if (r && r.ok && typeof r.todayCount === "number") {
    Net.todayCounts[Net.name] = r.todayCount;
    bumpToday(r.todayCount);
  }
  Net._histCache = null; // daily tab refetches next open
  if (ok && !sessionId && FX()) FX().burst("mini");
};

// Clear one answer EVERYWHERE: local view + caches + the server ledger.
// Duel answers are match records — clearing is blocked mid-duel.
Net.clearAnswer = async function (qid) {
  qid = String(qid || "");
  if (!qid) return;
  if (Net.inChallenge()) { toast("Finish the duel first — duel answers are match records ⚔️"); return; }
  if (App() && App().S) { delete App().S.answers[qid]; if (App().persist) App().persist(); }
  solvedCacheDel(Net.name, qid);
  if (App() && App().renderQ) App().renderQ();
  Net._histCache = null;
  if (!Net.name) return;
  saveAnswerCache(Net.name);
  const r = await api("/api/answers", {
    method: "DELETE",
    body: { user_name: Net.name, pin: getPin(Net.name), question_id: qid },
  });
  if (r && r.ok) {
    if (typeof r.todayCount === "number") {
      Net.todayCounts[Net.name] = r.todayCount;
      bumpToday(r.todayCount);
    }
    toast("Answer cleared 🗑️");
    return;
  }
  // Offline: queue for the next identify (restore would otherwise resurrect it).
  try {
    const k = LS_CLR(Net.name);
    const q = JSON.parse(localStorage.getItem(k) || "[]");
    if (!q.includes(qid)) { q.push(qid); localStorage.setItem(k, JSON.stringify(q)); }
  } catch (e) {}
  toast("Cleared offline — will sync on reload 📴");
};
// Retry queued offline clears (runs after restoreProgress at identify).
async function flushPendingClears() {
  if (!Net.name) return;
  let q = [];
  try { q = JSON.parse(localStorage.getItem(LS_CLR(Net.name)) || "[]") || []; } catch (e) {}
  if (!q.length) return;
  const S = (App() && App().S) ? App().S : null;
  const keep = [];
  for (const qid of q) {
    const r = await api("/api/answers", {
      method: "DELETE",
      body: { user_name: Net.name, pin: getPin(Net.name), question_id: qid },
    });
    if (r && r.ok) {
      if (S) delete S.answers[qid];
      if (typeof r.todayCount === "number") {
        Net.todayCounts[Net.name] = r.todayCount;
        bumpToday(r.todayCount);
      }
    } else keep.push(qid);
  }
  try { localStorage.setItem(LS_CLR(Net.name), JSON.stringify(keep)); } catch (e) {}
  saveAnswerCache(Net.name);
  if (App() && App().refresh) App().refresh();
}

Net.wipeMyData = async function () {
  if (!Net.name) return;
  await api("/api/users/" + encodeURIComponent(Net.name),
    { method: "DELETE", body: { pin: getPin(Net.name) } });
  Net.todayCounts = {};
  try {
    localStorage.removeItem(LS_ANS(Net.name));
    if (Net._solvedCache) delete Net._solvedCache[Net.name];
  } catch (e) {}
  if (App() && App().S) App().S.answers = {};
};

function ensureHistCss() {
  if ($("hist-css")) return;
  const st = document.createElement("style");
  st.id = "hist-css";
  st.textContent =
    ".hist-tabs{display:flex;gap:8px;margin-bottom:12px}" +
    ".hist-tabs button{flex:1;padding:9px;border-radius:12px;border:1.5px solid #d5dbff;background:#fff;font-family:var(--sans);font-size:14px;font-weight:700;cursor:pointer;color:var(--ink)}" +
    ".hist-tabs button.sel{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:transparent}" +
    ".daynav{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:10px}" +
    ".daynav button{border:1.5px solid #333;background:#fff;border-radius:10px;padding:4px 14px;font-size:16px;font-weight:800;cursor:pointer;font-family:var(--sans)}" +
    ".daynav button:disabled{opacity:.3;cursor:default}" +
    ".daynav b{font-size:15px;min-width:120px;text-align:center}" +
    ".accbar{height:8px;border-radius:6px;background:#e9edf4;overflow:hidden;margin-top:4px}" +
    ".accbar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2))}" +
    ".duel-card{display:flex;align-items:center;gap:12px;border:1.5px solid #d5dbff;border-radius:16px;padding:12px 16px;margin-bottom:10px;background:linear-gradient(180deg,#f4f5ff,#e9ecff)}" +
    ".duel-card .who{flex:1;min-width:0}" +
    ".duel-card .who b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".duel-card .meta{font-size:12px;color:var(--muted)}" +
    ".duel-card .tro{font-size:26px;flex:0 0 auto}" +
    ".duel-card .sc{font-size:24px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}" +
    ".duel-card.declined{opacity:.65;background:#f4f6fb}";
  document.head.appendChild(st);
}

Net.renderHistory = async function (tab) {
  const box = $("hist-body");
  if (!box) return;
  ensureHistCss();
  const modal = box.closest(".modal");
  if (modal) {
    const t = modal.querySelector("h2");
    if (t) t.textContent = "History";
    const ps = modal.querySelectorAll("p");
    if (ps && ps[0]) ps[0].textContent = "Solo grind and duel records.";
  }
  if (!Net.name) { box.innerHTML = "<p>Save your name first (bottom-left), then history will appear here.</p>"; return; }
  if (tab) Net._histTab = tab;
  const cur = Net._histTab || "daily";
  box.innerHTML = `<div class="hist-tabs">` +
    `<button id="hist-tab-daily" class="${cur === "daily" ? "sel" : ""}">📅 Daily</button>` +
    `<button id="hist-tab-duels" class="${cur === "duels" ? "sel" : ""}">⚔️ Duels</button></div><div id="hist-main"></div>`;
  $("hist-tab-daily").onclick = () => Net.renderHistory("daily");
  $("hist-tab-duels").onclick = () => Net.renderHistory("duels");
  if (cur === "duels") renderDuels($("hist-main"));
  else renderDaily($("hist-main"));
};

// Daily: one day at a time, flip with ‹ ›. Cached; cleared on every answer.
async function renderDaily(box) {
  box.innerHTML = '<div class="skel" style="height:120px"></div>';
  if (!Net._histCache) {
    const r = await api("/api/history?user=" + encodeURIComponent(Net.name) +
      "&pin=" + encodeURIComponent(getPin(Net.name)) + "&scope=friends");
    if (!r || !r.ok) { box.innerHTML = "<p>Couldn't load history (offline?).</p>"; return; }
    Net._histCache = r;
  }
  const days = Net._histCache.days || [];
  if (!days.length) { box.innerHTML = "<p>No attempts yet — answer some questions first!</p>"; return; }
  if (typeof Net._histDay !== "number") Net._histDay = 0;
  Net._histDay = Math.max(0, Math.min(Net._histDay, days.length - 1));
  const d = days[Net._histDay];
  const names = Net._histCache.names && Net._histCache.names.length ? Net._histCache.names : [Net.name];
  let h = `<div class="daynav"><button id="day-prev"${Net._histDay >= days.length - 1 ? " disabled" : ""}>‹</button>` +
    `<b>${esc(d.day)}</b>` +
    `<button id="day-next"${Net._histDay <= 0 ? " disabled" : ""}>›</button></div>`;
  h += `<table class="hist-table"><tr><th>Player</th><th>Solved</th></tr>`;
  names.forEach((n) => {
    const c = (d.per && d.per[n]) || { tot: 0, ok: 0 };
    h += `<tr class="hrow"><td><b>${esc(n)}</b></td><td>${c.tot}</td></tr>`;
  });
  h += "</table>";
  box.innerHTML = h;
  $("day-prev").onclick = () => { Net._histDay++; renderDaily(box); };
  $("day-next").onclick = () => { Net._histDay--; renderDaily(box); };
}

// Duels: every finished challenge with its final score (from the ledger).
async function renderDuels(box) {
  box.innerHTML = '<div class="skel" style="height:120px"></div>';
  const r = await api("/api/sessions/history?user=" + encodeURIComponent(Net.name) +
    "&pin=" + encodeURIComponent(getPin(Net.name)) + "&scope=friends");
  if (!r || !r.ok) { box.innerHTML = "<p>Couldn't load duels (offline?).</p>"; return; }
  const list = r.sessions || [];
  if (!list.length) { box.innerHTML = "<p>No duels yet — send a ⚔️ challenge!</p>"; return; }
  let h = "";
  list.forEach((s) => {
    const hs = (s.scores && s.scores[s.host]) || { ok: 0, tot: 0 };
    const gs = (s.scores && s.scores[s.guest]) || { ok: 0, tot: 0 };
    const decided = s.status === "finished";
    const forfeited = s.status === "forfeited";
    const tie = decided && hs.ok === gs.ok;
    const foe = s.forfeitedBy || (s.host === Net.name ? s.guest : s.host);
    const title = decided ? (tie ? "Dead even" : ((hs.ok > gs.ok ? s.host : s.guest) + " wins"))
      : forfeited ? (s.forfeitedBy ? `${foe} forfeited` : "Abandoned")
      : `${s.guest} declined`;
    const icon = decided ? (tie ? "🤝" : "🏆") : (forfeited ? "🏳" : "🚫");
    const showScore = decided || forfeited;
    h += `<div class="duel-card${decided ? "" : " declined"}">` +
      `<div class="tro">${icon}</div>` +
      `<div class="who"><b>${esc(s.host)} vs ${esc(s.guest)}</b>` +
      `<div class="meta">${esc(dayKeyOf(s.createdAt))} · ${s.totalQuestions} questions · ${esc(title)}</div></div>` +
      `<div class="sc">${showScore ? hs.ok + "–" + gs.ok : "–"}</div></div>`;
  });
  box.innerHTML = h;
}

// ── challenge mode (live 1v1 duel state machine; VPS transport) ─────────────
function wireChallengeUI() {
  const pick = $("chall-pick");
  if (pick && !pick.dataset.wired) {
    pick.dataset.wired = "1";
    pick.addEventListener("click", ev => {
      const b = ev.target.closest("button[data-n]"); if (!b) return;
      Net.challN = parseInt(b.dataset.n, 10) || 10;
      pick.querySelectorAll("button").forEach(x => x.classList.toggle("sel", x === b));
      if (FX()) FX().sound("tick");
    });
  }
  const send = $("challsend");
  if (send) send.onclick = () => createChallenge().catch(() => {});
  const ex = $("challexit");
  if (ex) ex.onclick = () => exitChallenge();
  const ec = $("endclose");
  if (ec) ec.onclick = () => { $("ov-challend").classList.remove("open"); exitChallenge(); };
  const ia = $("invite-accept"), idc = $("invite-decline");
  if (ia) ia.onclick = () => acceptChallenge().catch(() => {});
  if (idc) idc.onclick = () => declineChallenge().catch(() => {});
  ensureChatDom();
  wireChatKeys();
}
Net.inChallenge = () => !!(Net.session && Net.session.status === "active");

function otherName() {
  const sel = $("chall-guest");
  if (sel && sel.value) return sel.value.trim().slice(0, 20);
  if (Net.friend) return Net.friend;
  try { return localStorage.getItem("satbank:friend") || ""; } catch (e) { return ""; }
}
function isPersonOnline(name) {
  if (!name || !Net._people) return false;
  const p = Net._people.find(x => x.name === name);
  return isOnlinePerson(p, Date.now());
}

// Online-users list → opponent picker. Click a name = challenge them.
Net.openChallenge = async function (preset) {
  const sel = $("chall-guest");
  const send = $("challsend");
  const fill = (online) => {
    if (!sel) return;
    const others = (online || []).filter(n => n && n !== Net.name);
    const known = [...new Set(others)].sort();
    if (preset && !known.includes(preset)) known.unshift(preset);
    if (known.length) {
      sel.innerHTML = known.map(n =>
        `<option value="${esc(n)}"${n === (preset || Net.friend) ? " selected" : ""}>🟢 ${esc(n)} (online)</option>`).join("");
      if (send) { send.disabled = false; send.style.opacity = ""; }
    } else {
      sel.innerHTML = `<option value="">(no one online right now)</option>`;
      if (send) { send.disabled = true; send.style.opacity = "0.5"; }
    }
  };
  if (sel) {
    const now = Date.now();
    const local = (Net._people || [])
      .filter(p => p.name && p.name !== Net.name && isOnlinePerson(p, now))
      .map(p => p.name);
    fill(local.length ? local : null);
  }
  $("ov-challenge").classList.add("open");
  const r = await api("/api/users/online?user=" + encodeURIComponent(Net.name || "") +
    "&pin=" + encodeURIComponent(getPin(Net.name || "")) + "&scope=friends");
  if (r && r.ok) fill(r.online);
};

async function pickQuestions(n, guest) {
  let pool;
  try {
    const F = App().F, DB = App().DB;
    const filtered = Array.isArray(F) && F.length && F.length !== DB.length;
    pool = (filtered ? F.slice() : DB.map((_, i) => i));
  } catch (e) { pool = Net.db.map((_, i) => i); }
  try {
    if (guest && guest !== Net.name) {
      const [mine, theirs] = await Promise.all([solvedSetFor(Net.name), solvedSetFor(guest)]);
      if (mine.size || theirs.size) {
        const fresh = pool.filter(i => {
          const qid = (Net.db[i] || {}).id;
          return !(mine.has(qid) && theirs.has(qid));
        });
        if (fresh.length >= n) {
          pool = fresh;
        } else if (fresh.length > 0) {
          const freshSet = new Set(fresh);
          const rest = pool.filter(i => !freshSet.has(i));
          for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
          }
          pool = fresh.concat(rest);
          toast(`Only ${fresh.length} fresh questions left — mixed in ${n - fresh.length} repeats 🔁`);
        }
      }
    }
  } catch (e) {}
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).map(i => Net.db[i].id);
}

async function createChallenge() {
  if (!Net.name) { toast("Save your name first 👇"); return; }
  let guest = otherName();
  if (!guest || guest === Net.name) { toast("No one is online to challenge right now."); return; }
  if (!isPersonOnline(guest)) {
    // Presence may lag the picker; re-check server-side before refusing.
    const r = await api("/api/users/online?user=" + encodeURIComponent(Net.name) +
      "&pin=" + encodeURIComponent(getPin(Net.name)) + "&scope=friends");
    if (!r || !r.ok || !(r.online || []).includes(guest)) {
      toast(`${guest} is offline — you can only challenge online players ⚪`);
      return;
    }
  }
  const n = Net.challN || 10;
  toast("Picking fresh questions… ⚔️");
  if (Net._creating) return;
  Net._creating = true;
  try {
    const qids = await pickQuestions(n, guest);
    if (qids.length < n) { toast("Not enough questions in the current filter."); return; }
    const r = await api("/api/sessions", {
      method: "POST",
      body: { host: Net.name, pin: getPin(Net.name), guest, totalQuestions: n, questionIds: qids },
    });
    if (!r || !r.ok) {
      toast(r && r.error === "unknown-guest"
        ? guest + " hasn't signed in on the backend yet." : "Couldn't send challenge (offline?).");
      return;
    }
    $("ov-challenge").classList.remove("open");
    if (r.merged) {
      toast("Joined " + guest + "'s challenge ⚔️");
    } else {
      toast("Challenge sent to " + guest + " ⚔️");
      sayChall("Waiting for " + guest + " to accept…");
    }
    if (FX()) FX().sound("alert");
    watchSession(r.session.id);
    // Host-side timeout (server sweep expires independently; this just unblocks UI).
    // Re-check the server first: the accept may have landed while we waited, in
    // which case we join the battle instead of silently abandoning a live duel.
    // Silent clear, never a forfeit confirm: nobody accepted, nothing to forfeit.
    setTimeout(async () => {
      if (Net.session && Net.session.id === r.session.id && Net.session.status === "pending" &&
          Net._watching === r.session.id) {
        await refreshSession(r.session.id);
        const cur = Net.session;
        if (cur && cur.id === r.session.id && cur.status === "pending") {
          toast("Challenge timed out — " + guest + " didn't respond ⏳");
          clearChallengeState();
        }
        // Active → onSession already moved us into the battle.
        // Expired/declined → onSession already cleared us.
      }
    }, 95000);
  } finally {
    Net._creating = false;
  }
}

let pendingInvite = null;
function showInvite(id, s) {
  pendingInvite = { id, ...s, at: Date.now() };
  $("invite-from").textContent = s.host || "Friend";
  $("invite-n").textContent = s.totalQuestions || (s.questionIds || []).length;
  $("invitebanner").classList.add("show");
  if (FX()) FX().sound("alert");
}
function hideInvite() {
  pendingInvite = null;
  const b = $("invitebanner");
  if (b) b.classList.remove("show");
}
async function acceptChallenge() {
  if (!pendingInvite || Net._accepting) return;
  const id = pendingInvite.id;
  hideInvite();
  // One duel at a time: cancel my own pending outgoing challenge first so the
  // two sessions can't strand us in separate games (server expires the rest too).
  const mine = Net.session;
  if (mine && mine.id !== id && mine.status === "pending" && mine.host === Net.name) {
    markForfeited(mine.id);
    await api("/api/sessions/" + encodeURIComponent(mine.id),
      { method: "PATCH", body: { actor: Net.name, pin: getPin(Net.name), action: "forfeit" } }).catch(() => {});
    if (Net.socket && Net.socket.connected) Net.socket.emit("session:leave", { id: mine.id });
  }
  Net._watching = id; // follow the accepted session, not the superseded one
  Net._accepting = true;
  const r = await api("/api/sessions/" + encodeURIComponent(id), {
    method: "PATCH", body: { actor: Net.name, pin: getPin(Net.name), action: "accept" },
  });
  Net._accepting = false;
  if (!r || !r.ok) {
    if (r && r.error === "bad-state") { refreshSession(id); return; } // already accepted elsewhere
    if (r && r.error === "already-active") {
      toast("You're already in another duel — finish it first ⚔️");
      refreshSession(id);
      return;
    }
    toast("Couldn't accept (offline?) — try again.");
    return;
  }
  watchSession(id);
}
async function declineChallenge() {
  if (!pendingInvite || Net._accepting) return;
  Net._accepting = true;
  const id = pendingInvite.id;
  await api("/api/sessions/" + encodeURIComponent(id), {
    method: "PATCH", body: { actor: Net.name, pin: getPin(Net.name), action: "decline" },
  }).catch(() => {});
  Net._accepting = false;
  hideInvite();
  toast("Declined.");
}

// Live session follow: socket room primary, REST sync + backup poll.
// NOTE: always REST-sync once after joining — broadcasts fired before the join
// (e.g. the accept that just happened) are missed by definition. Skipping this
// deadlocks the guest: host enters via the accept broadcast, guest hears nothing.
function watchSession(id) {
  stopSessPoll();
  Net._watching = id;
  if (Net.socket && Net.socket.connected) Net.socket.emit("session:join", { id });
  const syncOnce = async () => {
    const r = await api("/api/sessions/" + encodeURIComponent(id) +
      "?user=" + encodeURIComponent(Net.name) + "&pin=" + encodeURIComponent(getPin(Net.name)));
    if (Net._watching !== id) return; // superseded or cleared while syncing
    if (r && r.ok) onSession(r.session);
  };
  syncOnce();
  Net.sessPoll = setInterval(async () => {
    if (Net._watching !== id) { stopSessPoll(); return; } // superseded: moved to another duel
    // Healthy socket pushes; REST is a watchdog for missed events (10s), and
    // the primary channel when the socket is down (2s).
    if (Net.sockOk && Date.now() - (Net._sessSyncMs || 0) < 10000) return;
    const cur = Net.session;
    if (cur && cur.id === id && cur.status !== "pending" && cur.status !== "active") { stopSessPoll(); return; }
    const r = await api("/api/sessions/" + encodeURIComponent(id) +
      "?user=" + encodeURIComponent(Net.name) + "&pin=" + encodeURIComponent(getPin(Net.name)));
    if (Net._watching !== id) return;
    if (r && r.ok) onSession(r.session);
  }, 2000);
}
function stopSessPoll() {
  if (Net.sessPoll) { clearInterval(Net.sessPoll); Net.sessPoll = null; }
}
// Re-pull session state after a rejected write (double-tap / host-guest race):
// the server is the truth, we just resync instead of erroring.
async function refreshSession(id) {
  if (!id || !Net.name) return;
  const r = await api("/api/sessions/" + encodeURIComponent(id) +
    "?user=" + encodeURIComponent(Net.name) + "&pin=" + encodeURIComponent(getPin(Net.name)));
  if (r && r.ok && r.session) onSession(r.session);
}
function onSession(s) {
  if (!s || !s.id) return;
  const cur = Net.session ? Net.session.id : null;
  // _watching (explicit follow: create/accept/rejoin) wins; otherwise only the
  // current session passes. Stale room events for a superseded session must
  // never tear down a newer duel (accept/create race).
  if (Net._watching ? s.id !== Net._watching : (cur && s.id !== cur)) return;
  Net._sessSyncMs = Date.now();
  if (pendingInvite && pendingInvite.id === s.id && s.status !== "pending") hideInvite();
  const was = Net.session ? Net.session.status : null;
  Net.session = s;
  if (s.status === "declined" || s.status === "expired") {
    if (was === "active" || was === "pending" || !was) {
      if (pendingInvite && pendingInvite.id === s.id) hideInvite();
      else toast(s.status === "expired" ? "Challenge expired ⏳" : "Challenge declined.");
    }
    clearChallengeState();
    return;
  }
  if (s.status === "forfeited") {
    const foe = s.forfeitedBy && s.forfeitedBy !== Net.name ? s.forfeitedBy
      : (s.host === Net.name ? s.guest : s.host);
    if (was === "active" || was === "pending") {
      // forfeitedBy null = abandoned-session sweep, not someone quitting.
      toast(s.forfeitedBy ? `${foe} forfeited — match over 🏳` : "Match abandoned — opponent gone 🏳");
      showForfeitEnd(s, foe);
    }
    clearChallengeState();
    return;
  }
  if (s.status === "active" && was !== "active") startCountdown(s);
  else if (s.status === "active") syncBattle(s);
  else if (s.status === "finished") finishSession(s);
  else if (s.status === "pending") sayChall("Waiting for opponent…");
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
  Net._myPick = null; Net._reveals = {};
  Net._bIdx = s.currentIndex || 0;
  try { // rejoining mid-duel (or late join): land on the live question, not Q1
    const want = idxs[Net._bIdx];
    if (typeof want === "number" && App() && App().goTo) App().goTo(want);
  } catch (e) {}
  lockWaiting(false);
  paintBattle(s);
  if (FX()) FX().sound("go");
}
function syncBattle(s) {
  const i = s.currentIndex || 0;
  if (Net._bIdx !== i) {
    Net._bIdx = i;
    Net.revealed = false;
    Net.qStartMs = Date.now();
    Net._myPick = null;
    lockWaiting(false);
  }
  const idxs = battleIdxs(s);
  const want = idxs[Math.min(i, idxs.length - 1)];
  try {
    if (App() && App().setChallenge && typeof want === "number") {
      const F = App().F || [];
      if (!F.length || !F.includes(want)) App().setChallenge(idxs, true);
      if (App().idx !== want && App().goTo) App().goTo(want);
    }
  } catch (e) {}
  Net.qStartMs = Net.qStartMs || Date.now();
  paintBattle(s);
  const ca = s.currentAnswers || {};
  const mAns = ca[Net.name];
  const foeName = s.host === Net.name ? s.guest : s.host;
  const fAns = ca[foeName];
  if (mAns && !Net.revealed) lockWaiting(true);
  if (mAns && fAns && !Net.revealed && (mAns.questionIndex === undefined || mAns.questionIndex === i)) {
    revealDuel(s, mAns, fAns);
  }
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
  const cb = $("challpill");
  if (cb) cb.style.display = "none";
  // Duel-only chat button takes Next's slot (Next returns on match end).
  try {
    ensureChatDom();
    const nx = $("nextbtn"); if (nx) nx.style.display = "none";
    const chb = $("chatbtn"); if (chb) chb.style.display = "";
  } catch (e) {}
}
function lockWaiting(on) {
  document.querySelectorAll("#opts .opt").forEach(o => o.classList.toggle("locked", !!on));
  const w = $("waitfriend");
  if (w) w.classList.toggle("show", !!on);
}

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

Net.decorate = function () {
  if (!Net.inChallenge()) return;
  const s = Net.session;
  const i = s.currentIndex || 0;
  const qid = (s.questionIds || [])[i];
  const idxs = battleIdxs(s);
  const cur = idxs.length ? Math.min(i, idxs.length - 1) : i;
  let viewPos = -1;
  try { viewPos = idxs.indexOf(App().idx); } catch (e) {}
  if (viewPos < 0) viewPos = cur;
  const reviewing = viewPos < cur;
  const back = $("backbtn"), next = $("nextbtn"), nav = $("navpill");
  if (back) back.disabled = viewPos <= 0;
  if (next) next.disabled = !reviewing;
  if (nav) { nav.style.pointerEvents = ""; nav.style.opacity = ""; }
  const wait = $("waitfriend");
  const revMap = Net._reveals || {};
  const vQid = (s.questionIds || [])[viewPos];
  const rev = (revMap[viewPos] && revMap[viewPos].qid === vQid) ? revMap[viewPos] : null;
  const pick = (!reviewing && !rev && Net._myPick && Net._myPick.i === i && Net._myPick.qid === qid)
    ? Net._myPick.letter : null;
  const ca = (s.currentAnswers || {})[Net.name];
  const echoed = !reviewing && !!(ca && (ca.questionIndex === undefined || ca.questionIndex === i));
  const shouldLock = !!(reviewing || rev || pick || echoed);
  document.querySelectorAll("#opts .opt").forEach(o => o.classList.toggle("locked", shouldLock));
  if (rev) {
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

// NOTE: the ledger write happens server-side on answer, so there is exactly
// one insert per duel answer. Do NOT call recordAnswer here — no double insert.
Net.answerChallenge = async function (qid, letter) {
  const s = Net.session;
  if (!s || s.status !== "active") return;
  const i = s.currentIndex || 0;
  if (qid !== (s.questionIds || [])[i]) {
    toast("Reviewing — hop back to the live question to answer ⚔️");
    return;
  }
  if (Net._myPick && Net._myPick.i === i) return;
  const echo = s.currentAnswers && s.currentAnswers[Net.name];
  if (echo && (echo.questionIndex === undefined || echo.questionIndex === i)) return;
  const e = Net.byId[qid];
  const ok = !!e && letter === e.correct;
  const timeMs = Date.now() - (Net.qStartMs || Date.now());
  Net._myPick = { i, qid, letter };
  if (App() && App().renderQ) App().renderQ();
  if (FX()) FX().sound("tick");
  solvedCacheAdd(Net.name, qid);
  const payload = {
    actor: Net.name, pin: getPin(Net.name), sessionId: s.id,
    questionIndex: i, selected: letter, is_correct: ok, timeMs,
  };
  let done = false, tc = null;
  if (Net.socket && Net.socket.connected) {
    try {
      const ack = await new Promise(res => {
        let settled = false;
        Net.socket.emit("duel:answer", payload, (a) => { if (!settled) { settled = true; res(a); } });
        setTimeout(() => { if (!settled) { settled = true; res(null); } }, 6000);
      });
      if (ack && ack.ok) { done = true; if (typeof ack.todayCount === "number") tc = ack.todayCount; }
      else if (ack && ack.error === "duplicate") { done = true; }
    } catch (err) {}
  }
  if (!done) {
    const r = await api("/api/sessions/" + encodeURIComponent(s.id),
      { method: "PATCH", body: { ...payload, action: "answer" } });
    if (r && r.ok) { done = true; if (typeof r.todayCount === "number") tc = r.todayCount; }
    else if (r && r.error === "duplicate") done = true;
    else if (r && r.error === "bad-state") { refreshSession(s.id); return; } // moved on already: resync
  }
  if (!done) {
    Net._myPick = null;
    lockWaiting(false);
    toast("Couldn't send answer (offline?)");
    if (App() && App().renderQ) App().renderQ();
    return;
  }
  if (tc !== null) { Net.todayCounts[Net.name] = tc; bumpToday(tc); }
  else bumpToday();
  Net._histCache = null;
};

async function revealDuel(s, mDoc, fDoc) {
  Net.revealed = true;
  const i = s.currentIndex || 0, n = s.totalQuestions || s.questionIds.length;
  const qid = (s.questionIds || [])[i];
  if (mDoc.is_correct) { Net.myScore++; Net.myTimes.push(mDoc.timeMs || 0); }
  else Net.myTimes.push(mDoc.timeMs || 0);
  if (fDoc.is_correct) { Net.frScore++; Net.frTimes.push(fDoc.timeMs || 0); }
  else Net.frTimes.push(fDoc.timeMs || 0);
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
  setTimeout(async () => {
    if (!Net.session || Net.session.id !== s.id) return;
    if ((s.currentIndex || 0) !== i) return;
    if (i + 1 >= n) { await closeSession(s); return; }
    if (Net.name === s.host) {
      const ar = await api("/api/sessions/" + encodeURIComponent(s.id),
        { method: "PATCH", body: { actor: Net.name, pin: getPin(Net.name), action: "advance", currentIndex: i + 1 } });
      if (!ar || !ar.ok) refreshSession(s.id);
    } else {
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
  await api("/api/sessions/" + encodeURIComponent(s.id),
    { method: "PATCH", body: { actor: Net.name, pin: getPin(Net.name), action: "finish" } }).catch(() => {});
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
  if (Net.socket && Net.socket.connected) Net.socket.emit("session:leave", { id: s.id });
  Net.session = null;
  Net._watching = null;
  stopSessPoll();
  sayChallHide();
}

function exitBattleView() {
  try {
    if (Net._myPick && App() && App().S) {
      App().S.answers[Net._myPick.qid] = Net._myPick.letter;
      saveAnswerCache(Net.name);
    }
    if (App().setChallenge) App().setChallenge(null);
  } catch (e) {}
  Net._myPick = null; Net._reveals = {}; Net.revealed = false;
  lockWaiting(false);
  sayChallHide();
  resetChatUI(); // duel chat is ephemeral: panel, button, log and unread all go
  const cb = $("challpill"); if (cb) cb.style.display = "none";
  const sp = $("scorepill"); if (sp) sp.style.display = "none";
  const nav = $("navpill");
  if (nav) { nav.style.pointerEvents = ""; nav.style.opacity = ""; }
  if (App() && App().renderQ) App().renderQ();
  // Fresh presence, not a repaint of duel-frozen data — this is the moment the
  // roster used to decay to "0 online".
  try { refreshPresence(); } catch (e) {}
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
  const s = Net.session;
  if (s && (s.status === "pending" || s.status === "active") &&
      (s.host === Net.name || s.guest === Net.name)) {
    if (!window.confirm("Forfeit the match? It will count as unfinished.")) return;
    const id = s.id;
    markForfeited(id);
    // Awaited + keepalive: an immediate refresh must not strand the session as
    // active (the old fire-and-forget lost the race with reload → rejoin loop).
    api("/api/sessions/" + encodeURIComponent(id),
      { method: "PATCH", keepalive: true, body: { actor: Net.name, pin: getPin(Net.name), action: "forfeit" } })
      .then(r => { if (!r || r.error === "offline") sendForfeitBeacon(id); })
      .catch(() => sendForfeitBeacon(id));
    if (Net.socket && Net.socket.connected) Net.socket.emit("session:leave", { id });
    toast("Match forfeited 🏳");
  }
  clearChallengeState();
}
// Silent teardown: expired/declined/forfeited arrivals, invite timeouts, end-of-match.
// Never confirms, never writes — the match is already over server-side.
function clearChallengeState() {
  Net.session = null;
  Net._watching = null;
  Net._sessSyncMs = 0;
  stopSessPoll();
  exitBattleView();
  Net.revealed = false;
}
// Forfeit end screen for the opponent (partial scores stand, marked unfinished).
function showForfeitEnd(s, foe) {
  exitBattleView();
  const n = s.totalQuestions || (s.questionIds || []).length;
  $("end-trophy").textContent = "🏳";
  $("end-title").textContent = s.forfeitedBy ? foe + " forfeited" : "Match abandoned";
  $("end-sub").textContent = `${Net.myScore}–${Net.frScore} after ${Math.min((s.currentIndex || 0) + 1, n)} of ${n} · recorded as unfinished`;
  $("end-grid").innerHTML =
    `<div class="end-card"><b>${Net.myScore}</b><div>you</div></div>` +
    `<div class="end-card"><b>${Net.frScore}</b><div>${esc(foe)}</div></div>`;
  $("ov-challend").classList.add("open");
  if (FX()) FX().sound("neutral");
  sayChallHide();
}

// ── duel chat (ephemeral, duels only) ─────────────────────────────────────
// Transport is socket-first with a broadcast-only REST fallback; NOTHING is
// ever written to the database, so there is nothing to clean up: a reload
// mid-duel loses chat, and match end drops it via resetChatUI (exitBattleView).
// Opening: chat button in the nav row (takes Next's slot all duel long), or
// Enter from anywhere during a duel (except while typing). Arrival: soft blip
// + unread dot above the icon, never a toast/banner.
function ensureChatCss() {
  if ($("chat-css")) return;
  const st = document.createElement("style");
  st.id = "chat-css";
  st.textContent =
    // Nav chat button: plain black-icon button standing in for Next during duels.
    "#chatbtn{display:none;position:relative;background:#fff;border:2px solid #111;border-radius:12px;" +
    "padding:7px 11px;cursor:pointer;font-family:var(--sans);line-height:0;" +
    "transition:transform .15s var(--ease-premium)}" +
    "#chatbtn:hover{transform:translateY(-1px)}" +
    "#chatbtn:active{transform:scale(.93)}" +
    "#chatbtn svg{display:block}" +
    // Unread dot floats above the icon; opening the panel (Esc) clears it until
    // the next arrival.
    "#chatdot{display:none;position:absolute;top:-7px;right:-4px;width:12px;height:12px;" +
    "border-radius:50%;background:#ff5d5d;border:2px solid #111;animation:chatdot-pulse 1.1s infinite}" +
    "#chatbtn.hasunread #chatdot{display:block}" +
    "@keyframes chatdot-pulse{0%,100%{transform:scale(1)}50%{transform:scale(.72)}}" +
    // Duel chrome cleanup: the solo progress bar looks broken mid-duel.
    "#banner.duel + #progbar{display:none}" +
    // Neo-brutalist panel: thick black borders + hard offset shadows, site palette kept.
    "#chatpanel{position:fixed;right:14px;bottom:86px;width:min(330px,calc(100vw - 28px));" +
    "max-height:min(420px,calc(100dvh - 220px));display:flex;flex-direction:column;z-index:340;" +
    "background:#fff;border:2.5px solid #111;border-radius:18px;overflow:hidden;" +
    "box-shadow:7px 7px 0 #111;" +
    "opacity:0;visibility:hidden;transform:translateY(18px);" +
    "transition:opacity .3s var(--ease-premium),transform .3s var(--ease-premium),visibility .3s}" +
    "#chatpanel.open{opacity:1;visibility:visible;transform:none}" +
    "#chatlog{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:9px;min-height:120px;background:#fff}" +
    ".chat-msg{max-width:82%;padding:8px 12px;border:2px solid #111;border-radius:13px;" +
    "font-size:14px;line-height:1.35;font-family:var(--sans);color:var(--ink);word-wrap:break-word;" +
    "box-shadow:3px 3px 0 #111;animation:chatpop .28s var(--ease-premium)}" +
    "@keyframes chatpop{0%{transform:scale(.85) translateY(6px);opacity:0}100%{transform:none;opacity:1}}" +
    ".chat-msg.mine{align-self:flex-end;background:var(--accent);color:#fff}" +
    ".chat-msg.foe{align-self:flex-start;background:#eef1fb}" +
    "#chatrow{display:flex;gap:8px;padding:10px;border-top:2.5px solid #111;background:#f8f9ff}" +
    "#chatinput{flex:1;border:2px solid #111;border-radius:12px;padding:9px 12px;font-size:14px;" +
    "font-family:var(--sans);outline:none;min-width:0;background:#fff}" +
    "#chatinput:focus{box-shadow:3px 3px 0 var(--accent)}" +
    "#chatsend{border:2px solid #111;border-radius:12px;padding:0 15px;font-size:16px;cursor:pointer;" +
    "color:#fff;background:#111;font-family:var(--sans);box-shadow:3px 3px 0 rgba(17,17,17,.25)}" +
    "#chatsend:active{transform:translate(2px,2px);box-shadow:none}";
  document.head.appendChild(st);
}
function ensureChatDom() {
  ensureChatCss();
  // The button lives in the nav row, in Next's slot (Next is hidden all duel).
  const nav = $("navbtns"), next = $("nextbtn");
  if (nav && next && !$("chatbtn")) {
    const b = document.createElement("button");
    b.type = "button"; b.id = "chatbtn"; b.title = "Duel chat (Enter)";
    b.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#111" ' +
      'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7' +
      'a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
      '<span id="chatdot"></span>';
    b.style.display = "none";
    b.addEventListener("click", ev => { ev.stopPropagation(); toggleChat(); });
    nav.insertBefore(b, next);
  }
  if (!$("chatpanel")) {
    const p = document.createElement("div");
    p.id = "chatpanel";
    p.innerHTML = '<div id="chatlog"></div>' +
      '<div id="chatrow"><input id="chatinput" maxlength="200" placeholder="Message… (Enter to send)" autocomplete="off">' +
      '<button id="chatsend" title="Send">➤</button></div>';
    document.body.appendChild(p);
    $("chatsend").addEventListener("click", () => doSendChat().catch(() => {}));
    $("chatinput").addEventListener("keydown", ev => {
      ev.stopPropagation(); // keep global duel keys (incl. Enter-to-open) out of the input
      if (ev.key === "Enter") { ev.preventDefault(); doSendChat().catch(() => {}); }
      else if (ev.key === "Escape") { toggleChat(false); }
    });
  }
}
// Global duel keys: Enter (from anywhere except editable fields) opens chat,
// Esc closes it. Answering via Enter was removed (mouse/Space) so no conflict.
function wireChatKeys() {
  if (Net._chatKeysWired) return;
  Net._chatKeysWired = true;
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") {
      if (Net._chat && Net._chat.open) { toggleChat(false); ev.stopPropagation(); }
      return;
    }
    if (ev.key !== "Enter") return;
    const t = ev.target || {};
    const tag = ((t.tagName || "") + "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return;
    if (!Net.inChallenge || !Net.inChallenge()) return;
    if (Net._chat && Net._chat.open) return;
    ev.preventDefault();
    ev.stopPropagation();
    toggleChat(true);
  });
}
function chatState() {
  Net._chat = Net._chat || { sid: null, open: false, unread: 0, log: [] };
  const s = Net.session;
  if (Net._chat.sid !== (s && s.id)) {
    Net._chat.sid = s && s.id;
    Net._chat.log = [];
    Net._chat.unread = 0;
  }
  return Net._chat;
}
function toggleChat(force) {
  if (!Net.inChallenge || !Net.inChallenge()) return;
  ensureChatDom();
  const st = chatState();
  st.open = (typeof force === "boolean") ? force : !st.open;
  const p = $("chatpanel"), b = $("chatbtn");
  if (p) { p.classList.toggle("open", st.open); if (st.open) renderChatLog(); }
  if (st.open) {
    st.unread = 0;
    if (b) b.classList.remove("hasunread");
    const inp = $("chatinput");
    if (inp) setTimeout(() => { try { inp.focus(); } catch (e) {} }, 80);
  } else if (b) b.classList.toggle("hasunread", st.unread > 0);
}
Net.toggleChat = toggleChat;
function renderChatLog() {
  const box = $("chatlog");
  if (!box) return;
  const st = chatState();
  box.innerHTML = "";
  // No name labels: side + color already say who is who (mine right/blue).
  for (const m of st.log) {
    const d = document.createElement("div");
    d.className = "chat-msg " + (m.from === Net.name ? "mine" : "foe");
    d.textContent = m.text; // textContent: no HTML injection possible
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}
function pushChatMsg(from, text) {
  const st = chatState();
  st.log.push({ from, text, at: Date.now() });
  if (st.log.length > 100) st.log.splice(0, st.log.length - 100);
  if (st.open) renderChatLog();
  else {
    st.unread++;
    const b = $("chatbtn");
    if (b) b.classList.add("hasunread");
  }
}
function onChatMsg(m) {
  try {
    if (!m || typeof m.text !== "string") return;
    const s = Net.session;
    // Duels only, this duel only, foe only — own echoes and strangers dropped.
    if (!s || s.status !== "active" || m.sessionId !== s.id) return;
    const foe = s.host === Net.name ? s.guest : s.host;
    if (m.from !== foe) return;
    pushChatMsg(m.from, String(m.text).slice(0, 200));
    if (FX()) FX().sound("msg"); // blip only — never a toast/banner mid-duel
  } catch (e) {}
}
async function doSendChat() {
  const inp = $("chatinput");
  const text = ((inp && inp.value) || "").trim().slice(0, 200);
  if (!text) return;
  const s = Net.session;
  if (!s || s.status !== "active" || !Net.inChallenge()) { toast("Chat lives inside duels only ⚔️"); return; }
  if (inp) inp.value = "";
  const payload = { sessionId: s.id, actor: Net.name, pin: getPin(Net.name), text };
  let done = false, slow = false;
  if (Net.socket && Net.socket.connected) {
    try {
      const ack = await new Promise(res => {
        let settled = false;
        Net.socket.emit("chat:send", payload, a => { if (!settled) { settled = true; res(a); } });
        setTimeout(() => { if (!settled) { settled = true; res(null); } }, 4000);
      });
      if (ack && ack.ok) done = true;
      else if (ack && ack.error === "too-fast") slow = true;
    } catch (e) {}
  }
  if (!done && !slow) {
    const r = await api("/api/sessions/" + encodeURIComponent(s.id) + "/chat",
      { method: "POST", body: { actor: Net.name, pin: getPin(Net.name), text } });
    if (r && r.ok) done = true;
    else if (r && r.error === "too-fast") slow = true;
  }
  if (slow) { toast("Slow down a touch 🐢"); if (inp) inp.value = text; return; }
  if (!done) { toast("Couldn't send (offline?)"); if (inp) inp.value = text; return; }
  pushChatMsg(Net.name, text);
}
Net.sendChat = doSendChat;
// Ephemeral teardown: panel, button, log and unread all go with the duel.
function resetChatUI() {
  Net._chat = { sid: null, open: false, unread: 0, log: [] };
  const p = $("chatpanel"), b = $("chatbtn"), inp = $("chatinput");
  if (p) p.classList.remove("open");
  if (b) { b.classList.remove("hasunread"); b.style.display = "none"; }
  const nx = $("nextbtn"); if (nx) nx.style.display = ""; // Next returns with solo mode
  if (inp && document.activeElement === inp) { try { inp.blur(); } catch (e) {} }
}

Net.exitChallenge = exitChallenge;
