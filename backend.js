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
const cleanName = s => String(s || "").trim().slice(0, 20);
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

// Sessions I forfeited (survives reload): the boot rejoin must
// never resurrect them — once exited, you cannot rejoin.
function loadForfeited() {
  try { return JSON.parse(localStorage.getItem("satbank:forfeited") || "{}") || {}; }
  catch (e) { return {}; }
}
function markForfeited(id) {
  if (!id) return;
  try {
    Net._forfeited = Net._forfeited || loadForfeited();
    Net._forfeited[id] = Date.now();
    localStorage.setItem("satbank:forfeited", JSON.stringify(Net._forfeited));
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
  seenOnline: {},    // name -> currently believed around (drives the come-online chime)
  _seenOfflineAt: {}, // name -> ms when continuous-offline began (hysteresis; see _notePresence)
  _presenceSeeded: false, // first payload only records states, never toasts
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
    if (App() && App().S) {
      App().S.answers = (c && c.a && typeof c.a === "object") ? { ...c.a } : {};
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
  // If an active session was found on reload: never resurrect an exited/forfeited match.
  // Stays in solo practice mode without annoying prompts or countdown loops.
  try {
    const live = await api("/api/sessions/live?user=" + encodeURIComponent(name) +
      "&pin=" + encodeURIComponent(getPin(name)));
    if (live && live.session) {
      const s = live.session;
      const isForfeited = (Net._forfeited && Net._forfeited[s.id]) ||
                          (s.forfeitedPlayers && s.forfeitedPlayers.includes(name)) ||
                          s.forfeitedBy === name;
      if (isForfeited || s.status === "active") {
        markForfeited(s.id);
        api("/api/sessions/" + encodeURIComponent(s.id),
          { method: "PATCH", keepalive: true, body: { actor: name, pin: getPin(name), action: "forfeit" } }).catch(() => {});
        if (pendingInvite && pendingInvite.id === s.id) hideInvite();
        clearChallengeState();
        exitBattleView();
      } else if (s.status === "pending" && s.host === name) {
        watchSession(s.id);
        sayChall("Waiting for opponent…");
      } else if (s.status === "pending" && (s.guest === name || (s.players && s.players.includes(name)))) {
        showInvite(s.id, s);
      }
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
  // First payload after boot only seeds states — announcing everyone already
  // online would chime for people who never left.
  if (!Net._presenceSeeded) {
    Net._presenceSeeded = true;
    Net._seenOfflineAt = Net._seenOfflineAt || {};
    for (const p of people) {
      if (p.name === Net.name) continue;
      const on = isOnlinePerson(p, now);
      Net.seenOnline[p.name] = !!on;
      if (!on) Net._seenOfflineAt[p.name] = now;
      else delete Net._seenOfflineAt[p.name];
    }
    return;
  }
  for (const p of people) {
    if (Net._notePresence(p.name, isOnlinePerson(p, now), now)) {
      if (FX()) FX().sound("chime");
      toast(p.name + " is online 🟢");
    }
  }
}

// Come-online edge with hysteresis: a name must read offline CONTINUOUSLY for
// OFFLINE_ARM_MS before it counts as "gone" and re-arms the toast. Transient
// blips (invisible socket reconnects, throttled hidden-tab heartbeats, slow
// pushes) recover silently. Returns true only on a genuine arrival.
// Pure in (name, online, now) + Net.seenOnline/_seenOfflineAt/_presenceSeeded.
const OFFLINE_ARM_MS = 120000; // 2 min continuously offline = actually gone
Net._notePresence = function (name, online, now) {
  if (!name || name === Net.name) return false;
  Net._seenOfflineAt = Net._seenOfflineAt || {};
  if (online) {
    if (Net.seenOnline[name]) { delete Net._seenOfflineAt[name]; return false; }
    const since = Net._seenOfflineAt[name] || 0;
    // Announce when: pre-seed sighting (defensive), brand-new name (no offline
    // record — blips always leave one), or away longer than the arm window.
    const genuine = !Net._presenceSeeded || !since || (now - since >= OFFLINE_ARM_MS);
    Net.seenOnline[name] = true;
    delete Net._seenOfflineAt[name];
    return genuine;
  }
  if (Net.seenOnline[name]) {
    if (!Net._seenOfflineAt[name]) Net._seenOfflineAt[name] = now; // blip watch starts
    else if (now - Net._seenOfflineAt[name] >= OFFLINE_ARM_MS) {
      Net.seenOnline[name] = false; // gone for real; offlineAt kept as proof
    }
  }
  return false;
};

function rosterOrder(people) {
  return people.slice().sort((a, b) =>
    (a.name === Net.name ? -1 : b.name === Net.name ? 1 : String(a.name).localeCompare(String(b.name))));
}
function ensureRosterCss() {
  if (document.getElementById("roster-duel-css")) return;
  const rst = document.createElement("style");
  rst.id = "roster-duel-css";
  rst.textContent =
    ".user .rduel-tag{font-size:10px;font-weight:700;color:#e11d48;background:#ffe4e6;" +
    "border:1px solid #fecdd3;border-radius:999px;padding:1px 6px;margin-left:6px;vertical-align:middle;display:inline-block;letter-spacing:-.2px}" +
    "html[data-theme=\"dark\"] .user .rduel-tag{color:#fda4af;background:rgba(225,29,72,.2);border-color:rgba(225,29,72,.4)}";
  document.head.appendChild(rst);
}

// Presence dropdown component matching mock.html with spring-like drop animation
function paintPresence(people, now) {
  ensureRosterCss();
  Net._people = people;
  const box = $("presence"); if (!box) return;
  if (!$("statusTrigger") || !$("statusPanel")) {
    box.innerHTML = "";
    const btn = document.createElement("button");
    btn.type = "button"; btn.id = "statusTrigger"; btn.className = "trigger";
    btn.innerHTML = '<span id="rostercount"></span>';

    const wrapper = document.createElement("div");
    wrapper.id = "statusPanel"; wrapper.className = "panel-wrapper";
    wrapper.innerHTML = '<div class="panel"><div class="list" id="rosterlist"></div></div>';

    box.appendChild(btn);
    box.appendChild(wrapper);

    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      wrapper.classList.toggle("active");
    });

    if (!Net._rosterWired) {
      Net._rosterWired = true;
      document.addEventListener("click", ev => {
        const p = $("statusPanel");
        if (p && p.classList.contains("active") && !p.contains(ev.target) && ev.target !== $("statusTrigger")) {
          p.classList.remove("active");
        }
      });
    }
  }
  const btn = $("statusTrigger"), panel = $("statusPanel");
  const list = panel.querySelector("#rosterlist");

  const onlineList = people.filter(p => isOnlinePerson(p, now));
  const offlineList = people.filter(p => !isOnlinePerson(p, now));

  // Sort online: current user first, then alphabetical
  onlineList.sort((a, b) =>
    (a.name === Net.name ? -1 : b.name === Net.name ? 1 : String(a.name).localeCompare(String(b.name)))
  );
  // Sort offline: alphabetical
  offlineList.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const onlineCount = onlineList.length;
  const cnt = btn.querySelector("#rostercount");
  if (cnt) cnt.textContent = onlineCount + " Online";
  btn.classList.toggle("is-offline", !onlineCount);

  list.innerHTML = "";

  // 1. Online Users
  onlineList.forEach(p => list.appendChild(rosterRow(p, true)));

  // 2. Divider (if both online and offline users are present)
  if (onlineList.length > 0 && offlineList.length > 0) {
    const divider = document.createElement("div");
    divider.className = "divider";
    list.appendChild(divider);
  }

  // 3. Offline Users
  offlineList.forEach(p => list.appendChild(rosterRow(p, false)));
}

function rosterRow(person, online) {
  const isYou = person.name === Net.name;
  const inDuel = !!(person.duel && person.duel.vs);
  const row = document.createElement("div");
  row.className = "user" + (isYou ? " is-you" : "") + (!online ? " is-offline" : "");
  row.dataset.name = person.name;

  const nm = document.createElement("span");
  nm.className = "name";
  nm.textContent = person.name + (isYou ? " (you)" : "");

  if (inDuel) {
    const badge = document.createElement("span");
    badge.className = "rduel-tag";
    badge.textContent = `vs ${person.duel.vs}`;
    nm.appendChild(badge);
    row.title = `${person.name} is in a live duel against ${person.duel.vs} · Click to view profile`;
  } else {
    row.title = `Click to view ${person.name}'s profile`;
  }

  const score = document.createElement("span");
  score.className = "score count-tick";
  const today = Net.todayCounts[person.name] || 0;
  score.textContent = today;
  score.dataset.v = today;

  row.appendChild(nm);
  row.appendChild(score);

  row.addEventListener("click", ev => {
    ev.stopPropagation();
    const p = $("statusPanel");
    if (p) p.classList.remove("active");
    Net.openProfile(person.name);
  });

  return row;
}

function paintPresenceOffline() {
  const box = $("presence"); if (!box) return;
  box.innerHTML = "";
  const btn = document.createElement("button");
  btn.type = "button"; btn.id = "statusTrigger"; btn.className = "trigger is-offline";
  btn.innerHTML = '<span>Offline</span>';
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
  inp.autocomplete = "current-password";
  inp.title = "Your name PIN — prevents impersonation";
  inp.style.cssText = "padding:5px 8px;font-size:13px;border:1.5px solid #333;border-radius:10px;" +
    "font-family:var(--sans);max-width:70px;";
  inp.addEventListener("keydown", ev => ev.stopPropagation());
  const save = $("namesave");
  save.parentNode.insertBefore(inp, save);
  // Change-PIN button: double-clicking the name reveals it next to Save.
  const key = document.createElement("button");
  key.id = "pinchange";
  key.type = "button";
  key.textContent = "🔑";
  key.title = "Change PIN";
  key.style.cssText = "border:1.5px solid #333;background:#fff;border-radius:10px;" +
    "padding:5px 8px;font-size:13px;cursor:pointer;display:none;";
  save.parentNode.insertBefore(key, save.nextSibling);
  key.addEventListener("click", changePinFlow);
  // Mirror the name box visibility (index.html hides nameinput/namesave when signed in).
  const ni = $("nameinput");
  const sync = () => { inp.style.display = ni.style.display; key.style.display = ni.style.display; };
  new MutationObserver(sync).observe(ni, { attributes: true, attributeFilter: ["style"] });
  sync();
  // Single-click name: open profile. Double-click: edit name + reveal PIN changer.
  const who = $("whoami");
  if (who && !who._wiredProfile) {
    who._wiredProfile = true;
    let whoClickTimer = null;
    who.addEventListener("click", ev => {
      if (whoClickTimer) return;
      whoClickTimer = setTimeout(() => {
        whoClickTimer = null;
        if (Net.name) Net.openProfile(Net.name);
      }, 250);
    });
    if (window.editName) {
      who.removeEventListener("dblclick", window.editName);
      who.addEventListener("dblclick", () => {
        if (whoClickTimer) { clearTimeout(whoClickTimer); whoClickTimer = null; }
        window.editName();
        sync();
      });
    }
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
    S.answers = { ...solved };
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
    const pill = document.querySelector('#statusPanel .user[data-name="' + Net.name + '"] .count-tick') ||
                 document.querySelector('#rosterpanel .roster-row[data-name="' + Net.name + '"] .count-tick');
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
    ".hist-tabs{display:flex;gap:0;margin:12px 0 8px;padding:3px;background:#f2f3f8;border-radius:12px;flex:0 0 auto}" +
    ".hist-tabs button{flex:1;padding:7px 12px;font-size:13.5px;font-weight:700;font-family:var(--sans);" +
    "color:#6d7285;background:transparent;border:none;border-radius:9px;cursor:pointer;" +
    "transition:background .2s,color .2s,box-shadow .2s}" +
    ".hist-tabs button.sel{background:#fff;color:var(--ink);box-shadow:0 2px 6px rgba(16,18,35,.1)}" +
    "html[data-theme='dark'] .hist-tabs{background:#16192b}" +
    "html[data-theme='dark'] .hist-tabs button.sel{background:#2b304f;color:#f8fafc}" +
    ".daynav{display:flex;align-items:center;justify-content:center;gap:12px;margin:12px 0 6px;flex:0 0 auto}" +
    ".daynav button{width:32px;height:32px;border-radius:50%;border:none;background:transparent;" +
    "font-size:18px;font-weight:800;color:var(--ink);cursor:pointer;line-height:1;transition:background .15s}" +
    ".daynav button:hover:not(:disabled){background:#eef0f7}" +
    ".daynav button:disabled{opacity:.25;cursor:default}" +
    ".daynav b{font-size:14px;font-variant-numeric:tabular-nums;min-width:90px;text-align:center}" +
    ".prow{display:flex;align-items:center;padding:9px 6px;border-bottom:1px solid #eef0f6;" +
    "animation:rowin-p1 .25s cubic-bezier(.2,.9,.3,1) backwards}" +
    ".prow:last-child{border-bottom:none}" +
    ".prow:hover{background:#fafbff}" +
    "html[data-theme='dark'] .prow:hover{background:#1e2238}" +
    "@keyframes rowin-p1{0%{opacity:0;transform:translateY(6px)}100%{opacity:1;transform:none}}" +
    ".prow .nm{font-size:14px;font-weight:700;letter-spacing:-.2px}" +
    ".prow .ct{margin-left:auto;font-size:16px;font-weight:800;font-variant-numeric:tabular-nums}" +
    ".prow .ct.zero{color:#c3c7d4}" +
    /* Duels category toggle (2 Players vs 3 Players) */
    ".duels-cat-nav{display:flex;gap:4px;margin:4px 0 10px;padding:3px;background:#f1f3f9;border-radius:10px;flex:0 0 auto}" +
    "html[data-theme='dark'] .duels-cat-nav{background:#16192c}" +
    ".duels-cat-btn{flex:1;padding:6px 10px;font-size:12.5px;font-weight:700;font-family:var(--sans);" +
    "border:none;background:transparent;color:var(--muted);border-radius:8px;cursor:pointer;transition:all .15s ease}" +
    ".duels-cat-btn:hover{color:var(--ink)}" +
    "html[data-theme='dark'] .duels-cat-btn:hover{color:#fff}" +
    ".duels-cat-btn.sel{background:#fff;color:var(--ink);box-shadow:0 1px 4px rgba(16,18,35,.1);font-weight:800}" +
    "html[data-theme='dark'] .duels-cat-btn.sel{background:#262b48;color:#fff}" +
    /* Date grouping headers */
    ".duel-date-group{margin-bottom:12px}" +
    ".duel-date-header{display:flex;align-items:center;gap:10px;margin:12px 4px 6px}" +
    ".duel-date-group:first-child .duel-date-header{margin-top:4px}" +
    ".duel-date-text{font-size:12px;font-weight:800;letter-spacing:.05em;color:var(--muted);font-variant-numeric:tabular-nums}" +
    ".duel-date-line{flex:1;height:1px;background:#eef1f6}" +
    "html[data-theme='dark'] .duel-date-line{background:#232742}" +
    /* Duel match cards */
    ".drow{padding:12px 8px 10px;text-align:center;border-bottom:1px solid #f1f5f9;border-radius:12px;margin-bottom:2px;" +
    "transition:background .15s ease;animation:rowin-p1 .25s cubic-bezier(.2,.9,.3,1) backwards}" +
    ".drow:last-child{border-bottom:none}" +
    ".drow:hover{background:#fafbff}" +
    "html[data-theme='dark'] .drow:hover{background:#1e2238}" +
    "html[data-theme='dark'] .drow{border-color:#232742}" +
    /* 2-Player Duo Grid: scores centered directly over names */
    ".duo-grid{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 8px;gap:10px}" +
    ".duo-col{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-width:0;cursor:pointer}" +
    ".duo-score{font-size:32px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1;letter-spacing:-.5px;text-align:center;display:block;width:100%}" +
    ".duo-score.dim{opacity:.4}" +
    ".duo-name{font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;margin-top:4px;letter-spacing:-.2px;text-align:center;display:block;width:100%}" +
    ".duo-name.dim{opacity:.4}" +
    ".duo-col:hover .duo-name{text-decoration:underline}" +
    ".duo-mid{display:flex;align-items:center;justify-content:center;padding-bottom:18px}" +
    ".duo-vs{font-size:18px;font-weight:700;color:var(--muted);opacity:.35;user-select:none}" +
    /* 3-Player Trio Grid: scores centered directly over names */
    ".trio-grid{display:grid;grid-template-columns:1fr 1fr 1fr;align-items:center;padding:0 4px;gap:8px}" +
    ".trio-col{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-width:0;cursor:pointer}" +
    ".trio-col.col-left,.trio-col.col-mid,.trio-col.col-right{align-items:center;text-align:center}" +
    ".trio-score{font-size:28px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1;letter-spacing:-.5px;text-align:center;display:block;width:100%}" +
    ".trio-score.dim{opacity:.4}" +
    ".trio-name{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;margin-top:4px;letter-spacing:-.2px;text-align:center;display:block;width:100%}" +
    ".trio-name.dim{opacity:.4}" +
    ".trio-col:hover .trio-name{text-decoration:underline}" +
    /* 4-Player Quad Grid: scores centered directly over names */
    ".quad-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;align-items:center;padding:0 2px;gap:6px}" +
    ".quad-col{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-width:0;cursor:pointer}" +
    ".quad-score{font-size:24px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1;letter-spacing:-.5px;text-align:center;display:block;width:100%}" +
    ".quad-score.dim{opacity:.4}" +
    ".quad-name{font-size:11.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;margin-top:4px;letter-spacing:-.2px;text-align:center;display:block;width:100%}" +
    ".quad-name.dim{opacity:.4}" +
    ".quad-col:hover .quad-name{text-decoration:underline}" +
    /* Subtle Questions count */
    ".dsub-qs{font-size:11px;color:var(--muted);opacity:.65;margin-top:5px;font-weight:500;text-align:center;letter-spacing:.02em}" +
    /* Live Duels */
    ".dlive-head{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:.08em;color:#e11d48;padding:4px 6px 4px}" +
    ".dlive-dot{width:6px;height:6px;border-radius:50%;background:#e11d48;animation:pulselive 1.2s infinite ease-in-out}" +
    "@keyframes pulselive{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(1.35)}}" +
    ".dlive-row{background:#fff8f8;border:1px solid #ffe4e6;border-radius:12px;margin-bottom:8px}" +
    "html[data-theme='dark'] .dlive-row{background:#2a1620;border-color:#4a1e2d}" +
    ".dlive-score{color:#e11d48}" +
    ".dmore-spin{padding:10px;text-align:center;font-size:11.5px;color:var(--muted);font-weight:600}" +
    ".dmore-end{padding:8px;text-align:center;font-size:11px;color:#94a3b8;font-weight:500}" +
    ".hempty{padding:28px 10px;text-align:center;font-size:13.5px;font-weight:600;color:var(--muted);line-height:1.6}";
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
  }
  if (!Net.name) { box.innerHTML = "<p>Save your name first (bottom-left), then history will appear here.</p>"; return; }
  if (tab) Net._histTab = tab;
  const cur = Net._histTab || "daily";
  box.innerHTML = `<div class="hist-tabs">` +
    `<button id="hist-tab-daily" class="${cur === "daily" ? "sel" : ""}">Daily</button>` +
    `<button id="hist-tab-duels" class="${cur === "duels" ? "sel" : ""}">Duels</button></div><div id="hist-main"></div>`;
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
    `<b>${esc(String(d.day).slice(5))}</b>` +
    `<button id="day-next"${Net._histDay <= 0 ? " disabled" : ""}>›</button></div>`;
  names.forEach((n, i) => {
    const c = (d.per && d.per[n]) || { tot: 0, ok: 0 };
    h += `<div class="prow" style="animation-delay:${Math.min(i * 35, 210)}ms">` +
      `<span class="nm">${esc(n)}</span><span class="ct${c.tot ? "" : " zero"}">${c.tot}</span></div>`;
  });
  box.innerHTML = h;
  $("day-prev").onclick = () => { Net._histDay++; renderDaily(box); };
  $("day-next").onclick = () => { Net._histDay--; renderDaily(box); };
}

function getDuelPlayerTime(s, p) {
  if (!s || !s.playerTimes || !p) return 0;
  const pt = s.playerTimes[p];
  if (!pt) return 0;
  if (typeof pt === "number") return pt;
  if (typeof pt === "object") {
    if (pt.totalTimeMs != null) return +pt.totalTimeMs || 0;
    if (pt.total_time_ms != null) return +pt.total_time_ms || 0;
    if (pt.timeMs != null) return +pt.timeMs || 0;
    if (Array.isArray(pt.qTimes)) return pt.qTimes.reduce((a, b) => a + (+b || 0), 0);
  }
  return 0;
}

function renderDuelItem(s, quiet, i) {
  const players = (s.players && s.players.length) ? s.players : [s.host, s.guest].filter(Boolean);
  const rowAnim = quiet ? ' style="animation:none"' : ` style="animation-delay:${Math.min((i || 0) * 30, 210)}ms"`;
  if (players.length > 3) {
    const sorted = [...players].sort((a, b) => {
      const sa = (s.scores && s.scores[a]) ? s.scores[a].ok : 0;
      const sb = (s.scores && s.scores[b]) ? s.scores[b].ok : 0;
      if (sb !== sa) return sb - sa;
      const ta = getDuelPlayerTime(s, a);
      const tb = getDuelPlayerTime(s, b);
      if (ta > 0 && tb > 0 && ta !== tb) return ta - tb;
      return 0;
    });
    const winner = sorted[0];
    const topScore = (s.scores && s.scores[winner]) ? s.scores[winner].ok : 0;
    const topTime = getDuelPlayerTime(s, winner);

    const cols = sorted.slice(0, 4).map(p => {
      const sc = (s.scores && s.scores[p]) ? s.scores[p].ok : 0;
      const tm = getDuelPlayerTime(s, p);
      let isDim = false;
      if (sc < topScore) {
        isDim = true;
      } else if (sc === topScore) {
        if (topTime > 0 && tm > 0 && tm !== topTime) {
          isDim = tm > topTime;
        }
      }
      const dim = isDim ? " dim" : "";
      return `<div class="quad-col" onclick="event.stopPropagation();Net.openProfile('${esc(p)}')">` +
        `<span class="quad-score${dim}">${sc}</span>` +
        `<span class="quad-name${dim}">${esc(p)}</span>` +
      `</div>`;
    }).join("");
    return `<div class="drow"${rowAnim}>` +
      `<div class="quad-grid">${cols}</div>` +
      `<div class="dsub-qs">${s.totalQuestions} questions</div></div>`;
  } else if (players.length === 3) {
    const sorted = [...players].sort((a, b) => {
      const sa = (s.scores && s.scores[a]) ? s.scores[a].ok : 0;
      const sb = (s.scores && s.scores[b]) ? s.scores[b].ok : 0;
      if (sb !== sa) return sb - sa;
      const ta = getDuelPlayerTime(s, a);
      const tb = getDuelPlayerTime(s, b);
      if (ta > 0 && tb > 0 && ta !== tb) return ta - tb;
      return 0;
    });
    const winner = sorted[0];
    const topScore = (s.scores && s.scores[winner]) ? s.scores[winner].ok : 0;
    const topTime = getDuelPlayerTime(s, winner);

    const checkDim = p => {
      const sc = (s.scores && s.scores[p]) ? s.scores[p].ok : 0;
      if (sc < topScore) return " dim";
      if (sc === topScore) {
        const tm = getDuelPlayerTime(s, p);
        if (topTime > 0 && tm > 0 && tm !== topTime) {
          return tm > topTime ? " dim" : "";
        }
      }
      return "";
    };

    const p1 = sorted[0], p2 = sorted[1] || sorted[0], p3 = sorted[2] || sorted[1] || sorted[0];
    const s1 = (s.scores && s.scores[p1]) ? s.scores[p1].ok : 0;
    const s2 = (s.scores && s.scores[p2]) ? s.scores[p2].ok : 0;
    const s3 = (s.scores && s.scores[p3]) ? s.scores[p3].ok : 0;
    const dim1 = checkDim(p1);
    const dim2 = checkDim(p2);
    const dim3 = checkDim(p3);

    return `<div class="drow"${rowAnim}>` +
      `<div class="trio-grid">` +
        `<div class="trio-col col-left" onclick="event.stopPropagation();Net.openProfile('${esc(p1)}')">` +
          `<span class="trio-score${dim1}">${s1}</span>` +
          `<span class="trio-name${dim1}">${esc(p1)}</span>` +
        `</div>` +
        `<div class="trio-col col-mid" onclick="event.stopPropagation();Net.openProfile('${esc(p2)}')">` +
          `<span class="trio-score${dim2}">${s2}</span>` +
          `<span class="trio-name${dim2}">${esc(p2)}</span>` +
        `</div>` +
        `<div class="trio-col col-right" onclick="event.stopPropagation();Net.openProfile('${esc(p3)}')">` +
          `<span class="trio-score${dim3}">${s3}</span>` +
          `<span class="trio-name${dim3}">${esc(p3)}</span>` +
        `</div>` +
      `</div>` +
      `<div class="dsub-qs">${s.totalQuestions} questions</div></div>`;
  } else {
    const p1 = s.host || players[0], p2 = s.guest || players[1] || players[0];
    const hs = (s.scores && s.scores[p1]) || { ok: 0, tot: 0 };
    const gs = (s.scores && s.scores[p2]) || { ok: 0, tot: 0 };
    const s1 = hs.ok, s2 = gs.ok;
    const t1 = getDuelPlayerTime(s, p1);
    const t2 = getDuelPlayerTime(s, p2);

    let dim1 = "", dim2 = "";
    if (s1 > s2) {
      dim2 = " dim";
    } else if (s2 > s1) {
      dim1 = " dim";
    } else {
      // Tie-breaker: faster time wins (lower totalTimeMs)
      if (t1 > 0 && t2 > 0 && t1 !== t2) {
        if (t1 < t2) dim2 = " dim";
        else dim1 = " dim";
      }
    }

    return `<div class="drow"${rowAnim}>` +
      `<div class="duo-grid">` +
        `<div class="duo-col col-left" onclick="event.stopPropagation();Net.openProfile('${esc(p1)}')">` +
          `<span class="duo-score${dim1}">${s1}</span>` +
          `<span class="duo-name${dim1}">${esc(p1)}</span>` +
        `</div>` +
        `<div class="duo-mid"><span class="duo-vs">—</span></div>` +
        `<div class="duo-col col-right" onclick="event.stopPropagation();Net.openProfile('${esc(p2)}')">` +
          `<span class="duo-score${dim2}">${s2}</span>` +
          `<span class="duo-name${dim2}">${esc(p2)}</span>` +
        `</div>` +
      `</div>` +
      `<div class="dsub-qs">${s.totalQuestions} questions</div></div>`;
  }
}

function renderLiveDuelsHtml(live) {
  if (!live || !live.length) return "";
  let h = `<div class="dlive-head"><span class="dlive-dot"></span> LIVE DUELS</div>`;
  live.forEach(s => {
    const players = (s.players && s.players.length) ? s.players : [s.host, s.guest].filter(Boolean);
    const qNum = Math.min((s.currentIndex || 0) + 1, s.totalQuestions);
    if (players.length > 3) {
      const cols = players.slice(0, 4).map(p => {
        const sc = (s.scores && s.scores[p]) ? s.scores[p].ok : 0;
        return `<div class="quad-col" onclick="event.stopPropagation();Net.openProfile('${esc(p)}')">` +
          `<span class="quad-score dlive-score">${sc}</span>` +
          `<span class="quad-name">${esc(p)}</span>` +
        `</div>`;
      }).join("");
      h += `<div class="drow dlive-row" id="live-row-${s.id}" style="animation:none">` +
        `<div class="quad-grid" id="live-sc-${s.id}">${cols}</div>` +
        `<div class="dsub-qs" id="live-sub-${s.id}">Question ${qNum} of ${s.totalQuestions} · <b style="color:#e11d48">In Progress</b></div></div>`;
    } else if (players.length === 3) {
      const p1 = players[0], p2 = players[1] || players[0], p3 = players[2] || players[1] || players[0];
      const s1 = (s.scores && s.scores[p1]) ? s.scores[p1].ok : 0;
      const s2 = (s.scores && s.scores[p2]) ? s.scores[p2].ok : 0;
      const s3 = (s.scores && s.scores[p3]) ? s.scores[p3].ok : 0;
      h += `<div class="drow dlive-row" id="live-row-${s.id}" style="animation:none">` +
        `<div class="trio-grid" id="live-sc-${s.id}">` +
          `<div class="trio-col col-left" onclick="event.stopPropagation();Net.openProfile('${esc(p1)}')">` +
            `<span class="trio-score dlive-score">${s1}</span>` +
            `<span class="trio-name">${esc(p1)}</span>` +
          `</div>` +
          `<div class="trio-col col-mid" onclick="event.stopPropagation();Net.openProfile('${esc(p2)}')">` +
            `<span class="trio-score dlive-score">${s2}</span>` +
            `<span class="trio-name">${esc(p2)}</span>` +
          `</div>` +
          `<div class="trio-col col-right" onclick="event.stopPropagation();Net.openProfile('${esc(p3)}')">` +
            `<span class="trio-score dlive-score">${s3}</span>` +
            `<span class="trio-name">${esc(p3)}</span>` +
          `</div>` +
        `</div>` +
        `<div class="dsub-qs" id="live-sub-${s.id}">Question ${qNum} of ${s.totalQuestions} · <b style="color:#e11d48">In Progress</b></div></div>`;
    } else {
      const p1 = s.host, p2 = s.guest;
      const hs = (s.scores && s.scores[p1]) || { ok: 0, tot: 0 };
      const gs = (s.scores && s.scores[p2]) || { ok: 0, tot: 0 };
      h += `<div class="drow dlive-row" id="live-row-${s.id}" style="animation:none">` +
        `<div class="duo-grid" id="live-sc-${s.id}">` +
          `<div class="duo-col col-left" onclick="event.stopPropagation();Net.openProfile('${esc(p1)}')">` +
            `<span class="duo-score dlive-score">${hs.ok}</span>` +
            `<span class="duo-name">${esc(p1)}</span>` +
          `</div>` +
          `<div class="duo-mid"><span class="duo-vs">—</span></div>` +
          `<div class="duo-col col-right" onclick="event.stopPropagation();Net.openProfile('${esc(p2)}')">` +
            `<span class="duo-score dlive-score">${gs.ok}</span>` +
            `<span class="duo-name">${esc(p2)}</span>` +
          `</div>` +
        `</div>` +
        `<div class="dsub-qs" id="live-sub-${s.id}">Question ${qNum} of ${s.totalQuestions} · <b style="color:#e11d48">In Progress</b></div></div>`;
    }
  });
  return h;
}

function renderDuelsContent() {
  const container = $("duels-content");
  if (!container) return;

  const cat = Net._duelsCat || "2p";
  const is2p = (cat === "2p");

  const catLive = (Net._liveSessions || []).filter(s => {
    const n = (s.players && s.players.length) ? s.players.length : 2;
    return is2p ? (n <= 2) : (n > 2);
  });

  const catSessions = (Net._duelSessions || []).filter(s => {
    const n = (s.players && s.players.length) ? s.players.length : 2;
    return is2p ? (n <= 2) : (n > 2);
  });

  if (!catLive.length && !catSessions.length) {
    container.innerHTML = `<p class="hempty">No ${is2p ? "2-player (1v1)" : "3+ player (group)"} duels yet.</p>`;
    return;
  }

  let h = "";
  if (catLive.length) {
    h += `<div id="live-duels-wrap">${renderLiveDuelsHtml(catLive)}</div>`;
  }

  if (catSessions.length) {
    const groups = [];
    const map = new Map();
    for (const s of catSessions) {
      const dk = dayKeyOf(s.createdAt);
      if (!map.has(dk)) {
        const g = { dayKey: dk, displayDate: dk.slice(5), sessions: [] };
        map.set(dk, g);
        groups.push(g);
      }
      map.get(dk).sessions.push(s);
    }

    h += `<div id="duels-list">`;
    groups.forEach(g => {
      h += `<div class="duel-date-group">` +
        `<div class="duel-date-header">` +
          `<span class="duel-date-text">${esc(g.displayDate)}</span>` +
          `<span class="duel-date-line"></span>` +
        `</div>` +
        `<div class="duel-date-matches">` +
          g.sessions.map((s, idx) => renderDuelItem(s, false, idx)).join("") +
        `</div>` +
      `</div>`;
    });
    h += `</div>`;
  }

  h += `<div id="duels-more">` +
    (Net._duelHasMore ? "" : '<div class="dmore-end">All duels loaded</div>') +
  `</div>`;

  container.innerHTML = h;
}

function updateLiveDuelsInPlace(box, live) {
  Net._liveSessions = live || [];
  const cat = Net._duelsCat || "2p";
  const is2p = (cat === "2p");
  const catLive = (Net._liveSessions || []).filter(s => {
    const n = (s.players && s.players.length) ? s.players.length : 2;
    return is2p ? (n <= 2) : (n > 2);
  });

  let wrap = $("live-duels-wrap");
  if (!catLive.length) {
    if (wrap) wrap.remove();
    return;
  }
  const content = $("duels-content");
  if (!wrap) {
    if (content) {
      wrap = document.createElement("div");
      wrap.id = "live-duels-wrap";
      wrap.innerHTML = renderLiveDuelsHtml(catLive);
      content.prepend(wrap);
    }
    return;
  }
  wrap.innerHTML = renderLiveDuelsHtml(catLive);
}

// Duels: live challenges + finished challenges with smooth infinite scroll
async function renderDuels(box) {
  box.innerHTML = '<div class="skel" style="height:100px"></div>';
  Net._duelOffset = 0;
  Net._duelHasMore = true;
  Net._duelLoading = false;
  Net._loadedDuelIds = new Set();
  Net._duelSessions = [];
  Net._liveSessions = [];

  const r = await api("/api/sessions/history?user=" + encodeURIComponent(Net.name) +
    "&pin=" + encodeURIComponent(getPin(Net.name)) + "&scope=friends&limit=15&offset=0");
  if (!r || !r.ok) {
    box.innerHTML = "<p>Couldn't load duels (offline?).</p>";
    return;
  }
  const live = r.live || [];
  const sessions = r.sessions || [];
  const list = sessions.filter(s => s.status === "finished");
  if (!live.length && !list.length) {
    box.innerHTML = "<p class='hempty'>No duels yet — send a ⚔️ challenge!</p>";
    return;
  }

  Net._liveSessions = live;
  list.forEach(s => {
    Net._loadedDuelIds.add(s.id);
    Net._duelSessions.push(s);
  });
  Net._duelOffset = sessions.length;
  Net._duelHasMore = r.hasMore && sessions.length >= 15;

  // Default to 2p unless user has exclusively 3p duels
  if (!Net._duelsCat) {
    const has2p = Net._duelSessions.some(s => ((s.players && s.players.length) ? s.players.length : 2) <= 2) ||
      Net._liveSessions.some(s => ((s.players && s.players.length) ? s.players.length : 2) <= 2);
    const has3p = Net._duelSessions.some(s => ((s.players && s.players.length) ? s.players.length : 2) > 2) ||
      Net._liveSessions.some(s => ((s.players && s.players.length) ? s.players.length : 2) > 2);
    Net._duelsCat = (!has2p && has3p) ? "3p" : "2p";
  }

  box.innerHTML =
    `<div class="duels-cat-nav">` +
      `<button type="button" class="duels-cat-btn ${Net._duelsCat === "2p" ? "sel" : ""}" id="duels-cat-2p">2 Players</button>` +
      `<button type="button" class="duels-cat-btn ${Net._duelsCat === "3p" ? "sel" : ""}" id="duels-cat-3p">3+ Players</button>` +
    `</div>` +
    `<div id="duels-content"></div>`;

  const btn2p = $("duels-cat-2p");
  const btn3p = $("duels-cat-3p");
  if (btn2p) btn2p.onclick = () => {
    Net._duelsCat = "2p";
    btn2p.classList.add("sel");
    if (btn3p) btn3p.classList.remove("sel");
    renderDuelsContent();
  };
  if (btn3p) btn3p.onclick = () => {
    Net._duelsCat = "3p";
    btn3p.classList.add("sel");
    if (btn2p) btn2p.classList.remove("sel");
    renderDuelsContent();
  };

  renderDuelsContent();

  // Smooth throttled infinite scroll
  let ticking = false;
  box.onscroll = () => {
    if (ticking || Net._duelLoading || !Net._duelHasMore) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (Net._duelLoading || !Net._duelHasMore) return;
      const distFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
      if (distFromBottom < 120) {
        loadMoreDuels(box);
      }
    });
  };

  // Auto-refresh ONLY live duel scores while modal is open: NEVER touch finished duels list
  if (!Net._duelsTimer) {
    Net._duelsTimer = setInterval(async () => {
      const ov = $("ov-history");
      if (!ov || !ov.classList.contains("open") || Net._histTab !== "duels") {
        clearInterval(Net._duelsTimer);
        Net._duelsTimer = null;
        return;
      }
      try {
        const liveRes = await api("/api/sessions/history?user=" + encodeURIComponent(Net.name) +
          "&pin=" + encodeURIComponent(getPin(Net.name)) + "&scope=friends&limit=1&offset=0");
        if (liveRes && liveRes.ok) {
          updateLiveDuelsInPlace(box, liveRes.live || []);
        }
      } catch (e) {}
    }, 3500);
  }
}

async function loadMoreDuels(box) {
  if (Net._duelLoading || !Net._duelHasMore) return;
  Net._duelLoading = true;
  const moreEl = $("duels-more");
  if (moreEl) moreEl.innerHTML = '<div class="dmore-spin">Loading older duels…</div>';

  const curOffset = Net._duelOffset || 0;
  const r = await api("/api/sessions/history?user=" + encodeURIComponent(Net.name) +
    "&pin=" + encodeURIComponent(getPin(Net.name)) + "&scope=friends&limit=15&offset=" + curOffset);

  Net._duelLoading = false;
  if (!r || !r.ok) {
    if (moreEl) moreEl.innerHTML = '';
    return;
  }
  const sessions = r.sessions || [];
  Net._duelOffset = curOffset + sessions.length;

  const newFinished = sessions.filter(s => s.status === "finished" && !Net._loadedDuelIds.has(s.id));
  newFinished.forEach(s => {
    Net._loadedDuelIds.add(s.id);
    Net._duelSessions.push(s);
  });

  if (!r.hasMore || sessions.length < 15) {
    Net._duelHasMore = false;
  }

  renderDuelsContent();
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
  const modePick = $("chall-mode-pick");
  if (modePick && !modePick.dataset.wired) {
    modePick.dataset.wired = "1";
    modePick.addEventListener("click", ev => {
      const b = ev.target.closest("button[data-mode]"); if (!b) return;
      Net.challMode = b.dataset.mode || "wait";
      modePick.querySelectorAll("button").forEach(x => x.classList.toggle("sel", x === b));
      if (FX()) FX().sound("tick");
    });
  }
  const reb = $("rush-endbtn");
  if (reb) reb.onclick = () => Net.submitRushTest && Net.submitRushTest();
  const nreb = $("nav-end-rush");
  if (nreb) nreb.onclick = () => {
    $("ov-nav").classList.remove("open");
    Net.submitRushTest && Net.submitRushTest();
  };
  const send = $("challsend");
  if (send) send.onclick = () => createChallenge().catch(() => {});
  const ex = $("challexit");
  if (ex) ex.onclick = () => exitChallenge();
  const ec = $("endclose");
  if (ec) ec.onclick = () => {
    $("ov-challend").classList.remove("open");
    if (FX() && FX().stopCelebration) FX().stopCelebration();
    exitChallenge();
  };
  const ia = $("invite-accept"), idc = $("invite-decline");
  if (ia) ia.onclick = () => acceptChallenge().catch(() => {});
  if (idc) idc.onclick = () => declineChallenge().catch(() => {});
  ensureChatDom();
  wireChatKeys();
}
Net.inChallenge = () => !!(Net.session && Net.session.status === "active" &&
  (!Net.session.forfeitedPlayers || !Net.session.forfeitedPlayers.includes(Net.name)) &&
  Net.session.forfeitedBy !== Net.name &&
  (!Net._forfeited || !Net._forfeited[Net.session.id]));
Net.inRush = () => Net.inChallenge() && !!(Net.session && Net.session.mode === "rush");

Net.openProfile = async function (name) {
  name = cleanName(name);
  if (!name) return;
  const ov = $("ov-profile");
  if (!ov) return;

  // Set initial placeholders
  if ($("prof-name")) $("prof-name").textContent = name;
  if ($("prof-streak-text")) $("prof-streak-text").textContent = "…";
  if ($("prof-winrate")) $("prof-winrate").textContent = "…";
  if ($("prof-sub-winrate")) $("prof-sub-winrate").textContent = "…";
  if ($("prof-won")) $("prof-won").textContent = "…";
  if ($("prof-sub-won")) $("prof-sub-won").textContent = "…";
  if ($("prof-speed")) $("prof-speed").textContent = "…";
  if ($("prof-best-streak")) $("prof-best-streak").textContent = "…";
  if ($("prof-acc")) $("prof-acc").textContent = "…";
  if ($("prof-bar-acc")) $("prof-bar-acc").style.width = "0%";
  if ($("prof-solved")) $("prof-solved").textContent = "…";

  ov.classList.add("open");

  const r = await api("/api/users/" + encodeURIComponent(name) + "/profile");
  if (!r || !r.ok || !r.profile) {
    toast("Couldn't load profile for " + name);
    return;
  }
  const p = r.profile;
  if ($("prof-name")) $("prof-name").textContent = p.name;
  if ($("prof-streak-text")) $("prof-streak-text").textContent = (p.currentStreak || 0) + " Win Streak";
  if ($("prof-winrate")) $("prof-winrate").textContent = p.winRate + "%";
  if ($("prof-sub-winrate")) $("prof-sub-winrate").textContent = (p.wins || 0) + " W · " + (p.losses || 0) + " L";
  if ($("prof-won")) $("prof-won").textContent = p.wins || 0;
  if ($("prof-sub-won")) $("prof-sub-won").textContent = (p.totalDuels || 0) + " played";
  if ($("prof-speed")) $("prof-speed").textContent = p.avgSpeed || "—";
  if ($("prof-best-streak")) $("prof-best-streak").textContent = p.bestStreak || 0;
  if ($("prof-acc")) $("prof-acc").textContent = (p.accuracy || 0) + "%";
  if ($("prof-bar-acc")) $("prof-bar-acc").style.width = Math.min(100, Math.max(0, p.accuracy || 0)) + "%";
  if ($("prof-solved")) $("prof-solved").textContent = p.questionsSolved || 0;
};

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

// Online-users list → opponent cards. Click a card = challenge them.
// The pick mirrors into the hidden #chall-guest value (same contract as the
// old dropdown: otherName() reads .value unchanged).
Net.openChallenge = async function (preset) {
  const list = $("opp-list");
  const hid = $("chall-guest");
  const send = $("challsend");
  Net._selectedGuests = new Set();

  const updateSelectionUI = () => {
    const selArr = Array.from(Net._selectedGuests);
    if (hid) hid.value = selArr[0] || "";
    if (list) {
      list.querySelectorAll(".opp-card").forEach(x => {
        x.classList.toggle("sel", Net._selectedGuests.has(x.dataset.name));
      });
    }
    if (send) {
      send.disabled = selArr.length === 0;
      if (selArr.length === 0) {
        send.textContent = "Select an opponent";
      } else if (selArr.length === 1) {
        send.textContent = "Send 1v1 Duel ⚔️";
      } else if (selArr.length === 2) {
        send.textContent = "Send 1v1v1 Battle (3-Way) ⚔️";
      } else {
        send.textContent = "Send 1v1v1v1 Battle (4-Way) ⚔️";
      }
    }
  };

  const togglePick = (n) => {
    if (!n) return;
    if (Net._selectedGuests.has(n)) {
      if (Net._selectedGuests.size > 1) {
        Net._selectedGuests.delete(n);
      }
    } else {
      if (Net._selectedGuests.size >= 3) {
        toast("Up to 3 opponents can be selected for 1v1v1v1 ⚔️");
        return;
      }
      Net._selectedGuests.add(n);
    }
    updateSelectionUI();
  };

  const paint = (online) => {
    if (!list) return;
    const others = (online || []).filter(n => n && n !== Net.name);
    const known = [...new Set(others)].sort();
    if (preset && !known.includes(preset)) known.unshift(preset);
    list.innerHTML = "";
    if (!known.length) {
      const d = document.createElement("div");
      d.className = "opp-empty";
      d.innerHTML = "No one online right now.<br>Ask them to open the app, then try again.";
      list.appendChild(d);
      Net._selectedGuests.clear();
      updateSelectionUI();
      return;
    }
    // Default pick: explicit preset, else last opponent if present, else first.
    const def = (preset && known.includes(preset)) ? preset
      : (Net.friend && known.includes(Net.friend)) ? Net.friend : known[0];
    if (def && (!Net._selectedGuests.size || !known.some(k => Net._selectedGuests.has(k)))) {
      Net._selectedGuests.clear();
      Net._selectedGuests.add(def);
    }
    known.forEach(n => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opp-card" + (Net._selectedGuests.has(n) ? " sel" : "");
      b.dataset.name = n;
      b.innerHTML = '<span class="ava">' + esc(n.charAt(0).toUpperCase()) + '</span>' +
        '<span class="who"><b>' + esc(n) + '</b><span>online</span></span>' +
        '<span class="tick">✓</span>';
      b.addEventListener("click", () => { togglePick(n); if (FX()) FX().sound("tick"); });
      list.appendChild(b);
    });
    updateSelectionUI();
  };
  if (list) {
    const now = Date.now();
    const local = (Net._people || [])
      .filter(p => p.name && p.name !== Net.name && isOnlinePerson(p, now))
      .map(p => p.name);
    paint(local.length ? local : null);
  }
  $("ov-challenge").classList.add("open");
  const r = await api("/api/users/online?user=" + encodeURIComponent(Net.name || "") +
    "&pin=" + encodeURIComponent(getPin(Net.name || "")) + "&scope=friends");
  if (r && r.ok) paint(r.online);
};

async function pickQuestions(n, guests) {
  const gList = (Array.isArray(guests) ? guests : [guests]).filter(Boolean);
  let pool;
  try {
    const F = App().F, DB = App().DB;
    const filtered = Array.isArray(F) && F.length && F.length !== DB.length;
    pool = (filtered ? F.slice() : DB.map((_, i) => i));
  } catch (e) { pool = Net.db.map((_, i) => i); }
  try {
    const playersToCheck = [Net.name, ...gList].filter(Boolean);
    if (playersToCheck.length > 1) {
      const solvedSets = await Promise.all(playersToCheck.map(p => solvedSetFor(p)));
      const hasAnyHistory = solvedSets.some(s => s && s.size > 0);
      if (hasAnyHistory) {
        // Questions that NONE of the players have answered previously
        const fresh = pool.filter(i => {
          const qid = (Net.db[i] || {}).id;
          return !solvedSets.some(s => s.has(qid));
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
          toast(`Only ${fresh.length} fresh questions for all players — mixed in ${n - fresh.length} repeats 🔁`);
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
  const guests = Net._selectedGuests && Net._selectedGuests.size
    ? Array.from(Net._selectedGuests)
    : [otherName()].filter(Boolean);
  if (!guests.length || guests.every(g => g === Net.name)) {
    toast("Select at least one opponent to challenge.");
    return;
  }
  for (const g of guests) {
    if (!isPersonOnline(g)) {
      const r = await api("/api/users/online?user=" + encodeURIComponent(Net.name) +
        "&pin=" + encodeURIComponent(getPin(Net.name)) + "&scope=friends");
      if (!r || !r.ok || !(r.online || []).includes(g)) {
        toast(`${g} is offline — you can only challenge online players ⚪`);
        return;
      }
    }
  }
  const n = Net.challN || 10;
  toast("Picking fresh questions… ⚔️");
  if (Net._creating) return;
  Net._creating = true;
  try {
    const qids = await pickQuestions(n, guests);
    if (qids.length < n) { toast("Not enough questions in the current filter."); return; }
    const r = await api("/api/sessions", {
      method: "POST",
      body: {
        host: Net.name,
        pin: getPin(Net.name),
        guests,
        guest: guests[0],
        totalQuestions: n,
        questionIds: qids,
        mode: Net.challMode || "wait",
      },
    });
    if (!r || !r.ok) {
      toast(r && r.error === "unknown-guest"
        ? (r.guest || guests.join(", ")) + " hasn't signed in on the backend yet." : "Couldn't send challenge (offline?).");
      return;
    }
    $("ov-challenge").classList.remove("open");
    if (r.merged) {
      toast("Joined " + guests[0] + "'s challenge ⚔️");
    } else {
      if (guests.length === 1) {
        toast("Challenge sent to " + guests[0] + " ⚔️");
        sayChall("Waiting for " + guests[0] + " to accept…");
      } else if (guests.length === 2) {
        toast(`1v1v1 Challenge sent to ${guests.join(" & ")} ⚔️`);
        sayChall(`Waiting for ${guests.join(" & ")} to accept…`);
      } else {
        toast(`1v1v1v1 Challenge sent to ${guests.join(", ")} ⚔️`);
        sayChall(`Waiting for ${guests.join(", ")} to accept…`);
      }
    }
    if (FX()) FX().sound("alert");
    watchSession(r.session.id);
    setTimeout(async () => {
      if (Net.session && Net.session.id === r.session.id && Net.session.status === "pending" &&
          Net._watching === r.session.id) {
        await refreshSession(r.session.id);
        const cur = Net.session;
        if (cur && cur.id === r.session.id && cur.status === "pending") {
          toast("Challenge timed out — opponents didn't respond ⏳");
          clearChallengeState();
        }
      }
    }, 95000);
  } finally {
    Net._creating = false;
  }
}

let pendingInvite = null;
function showInvite(id, s) {
  pendingInvite = { id, ...s, at: Date.now() };
  const others = (s.players || []).filter(p => p !== Net.name && p !== s.host);
  const fromEl = $("invite-from");
  const othersEl = $("invite-others");
  if (fromEl) {
    fromEl.textContent = s.host || "Friend";
    fromEl.title = s.host || "Friend";
  }
  if (othersEl) {
    if (others.length > 0) {
      othersEl.textContent = "(+ " + others.join(", ") + ")";
      othersEl.title = others.join(", ");
      othersEl.style.display = "inline";
    } else {
      othersEl.textContent = "";
      othersEl.title = "";
      othersEl.style.display = "none";
    }
  }
  const nEl = $("invite-n");
  if (nEl) nEl.textContent = s.totalQuestions || (s.questionIds || []).length || 10;
  const mEl = $("invite-mode");
  if (mEl) {
    const isRush = s.mode === "rush";
    mEl.textContent = isRush ? "RUSH" : "WAIT";
    mEl.className = "pill-mode " + (isRush ? "mode-rush" : "mode-wait");
  }
  const b = $("invitebanner");
  if (b) b.classList.add("show");
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

  // If I have forfeited or exited this match, ignore this session completely:
  const amForfeited = (s.forfeitedPlayers && s.forfeitedPlayers.includes(Net.name)) ||
                      s.forfeitedBy === Net.name ||
                      (Net._forfeited && Net._forfeited[s.id]);
  if (amForfeited) {
    if (Net.socket && Net.socket.connected) Net.socket.emit("session:leave", { id: s.id });
    clearChallengeState();
    exitBattleView();
    return;
  }

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
    const foes = (s.players || [s.host, s.guest]).filter(p => p !== Net.name);
    if (was === "active" || was === "pending") {
      toast(s.forfeitedBy ? `${s.forfeitedBy} forfeited — match over 🏳` : "Match abandoned — opponent gone 🏳");
      showForfeitEnd(s, foes.join(", "));
    }
    clearChallengeState();
    return;
  }
  // Check if someone forfeited mid-match while session continues
  if (s.status === "active" && s.forfeitedPlayers && s.forfeitedPlayers.length) {
    if (!Net._announcedForfeits) Net._announcedForfeits = new Set();
    s.forfeitedPlayers.forEach(p => {
      if (!Net._announcedForfeits.has(p)) {
        Net._announcedForfeits.add(p);
        const act = (s.players || [s.host, s.guest]).filter(u => !s.forfeitedPlayers.includes(u));
        if (act.length === 2) {
          const otherFoe = act.find(u => u !== Net.name);
          toast(`${p} left! Switched to 1v1 vs ${otherFoe} ⚔️`);
        } else {
          toast(`${p} forfeited! The battle continues ⚔️`);
        }
      }
    });
  }
  if (s.status === "active" && was !== "active") startCountdown(s);
  else if (s.status === "active") syncBattle(s);
  else if (s.status === "finished") finishSession(s);
  else if (s.status === "pending") {
    const players = s.players || [s.host, s.guest];
    if (players.length > 2) {
      const accepted = s.acceptedBy || [s.host];
      const waiting = players.filter(p => !accepted.includes(p));
      sayChall(waiting.length ? `Waiting for ${waiting.join(", ")}…` : "Starting duel…");
    } else {
      sayChall("Waiting for opponent…");
    }
  }
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
  Net.playerScores = {};
  Net.playerTimes = {};
  Net._announcedForfeits = new Set();
  Net._scoredQuestions = new Set();
  (s.players || [s.host, s.guest]).forEach(p => {
    Net.playerScores[p] = 0;
    Net.playerTimes[p] = [];
  });
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
  if (s.mode === "rush") {
    Net.rushMode = true;
    Net.rushStartTime = Date.now();
    Net.rushLocalAnswers = {};
    Net.rushSubmitted = false;
    Net.myTotalTimeMs = null;
    if (App() && App().goTo && idxs.length) App().goTo(idxs[0]);
    lockWaiting(false);
    paintBattle(s);
    if (FX()) FX().sound("go");
    return;
  }
  Net.qStartMs = Date.now();
  Net.revealed = false;
  Net._myPick = null; Net._reveals = {};
  Net._scoredQuestions = new Set();
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
  if (s.mode === "rush") {
    if (Net.rushSubmitted) {
      const rw = $("ov-rush-waiting");
      if (rw) {
        rw.classList.add("open");
        const waitingFor = (s.players || []).filter(p => !(s.finishedPlayers || []).includes(p) && !(s.forfeitedPlayers || []).includes(p));
        const others = waitingFor.filter(p => p !== Net.name);
        const st = $("rush-wait-status");
        if (st) {
          st.textContent = others.length
            ? `Waiting for ${others.join(", ")} to finish…`
            : (waitingFor.length ? "Waiting for other players to finish…" : "Calculating final scores…");
        }
      }
    }
    paintBattle(s);
    return;
  }
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
  if (mAns && !Net.revealed) lockWaiting(true);

  const players = s.players || [s.host, s.guest];
  const forfeited = s.forfeitedPlayers || [];
  const activePlayers = players.filter(p => !forfeited.includes(p));
  const allAnswered = activePlayers.length > 0 && activePlayers.every(p => {
    const ans = ca[p];
    return ans && (ans.questionIndex === undefined || ans.questionIndex === i);
  });
  if (allAnswered && !Net.revealed) {
    revealDuel(s, ca);
  }
}

function paintBattle(s) {
  if (Net.inRush && Net.inRush()) {
    const idxs = battleIdxs(s);
    const n = s.totalQuestions || idxs.length;
    let pos = 0;
    try { pos = idxs.indexOf(App().idx); } catch (e) {}
    if (pos < 0) pos = 0;
    const players = s.players || [s.host, s.guest];
    const forfeited = s.forfeitedPlayers || [];
    const activePlayers = players.filter(p => !forfeited.includes(p));
    const foes = activePlayers.filter(p => p !== Net.name);
    sayChall(`RUSH · Q${pos + 1}/${n} vs ${foes.join(" & ") || "Friend"}`);
    const pill = $("scorepill");
    if (pill) {
      pill.style.display = "";
      const answeredCount = Object.keys(Net.rushLocalAnswers || {}).length;
      pill.textContent = `Answered ${answeredCount}/${n}`;
    }
    const cb = $("challpill");
    if (cb) cb.style.display = "none";
    const nx = $("nextbtn");
    const reb = $("rush-endbtn");
    if (pos >= n - 1) {
      if (nx) nx.style.display = "none";
      if (reb) reb.style.display = "";
    } else {
      if (nx) nx.style.display = "";
      if (reb) reb.style.display = "none";
    }
    const chb = $("chatbtn");
    if (chb) chb.style.display = "none";
    return;
  }
  const i = s.currentIndex || 0, n = s.totalQuestions || (s.questionIds || []).length;
  const players = s.players || [s.host, s.guest];
  const forfeited = s.forfeitedPlayers || [];
  const activePlayers = players.filter(p => !forfeited.includes(p));
  const pill = $("scorepill");
  if (activePlayers.length <= 2) {
    const foe = activePlayers.find(p => p !== Net.name) || (s.host === Net.name ? s.guest : s.host);
    sayChall(`Q${Math.min(i + 1, n)}/${n} vs ${foe}`);
    if (pill) {
      pill.style.display = "";
      const myScore = Net.playerScores ? (Net.playerScores[Net.name] || 0) : Net.myScore;
      const foeScore = Net.playerScores ? (Net.playerScores[foe] || 0) : Net.frScore;
      const prev = pill.dataset.sc || "0-0";
      pill.dataset.sc = myScore + "-" + foeScore;
      pill.textContent = `You ${myScore} – ${foeScore} ${foe}`;
      if (prev !== pill.dataset.sc && FX()) FX().sound("tada");
    }
  } else {
    const way = activePlayers.length >= 4 ? "4-Way Battle" : "3-Way Battle";
    sayChall(`Q${Math.min(i + 1, n)}/${n} · ${way}`);
    if (pill) {
      pill.style.display = "";
      const scoreStr = activePlayers.map(p => (p === Net.name ? "You" : p) + " " + (Net.playerScores ? (Net.playerScores[p] || 0) : 0)).join(" · ");
      const prev = pill.dataset.sc || "";
      pill.dataset.sc = scoreStr;
      pill.textContent = scoreStr;
      if (prev && prev !== scoreStr && FX()) FX().sound("tada");
    }
  }
  const cb = $("challpill");
  if (cb) cb.style.display = "none";
  try {
    ensureChatDom();
    const nx = $("nextbtn"); if (nx) nx.style.display = "none";
    const reb = $("rush-endbtn"); if (reb) reb.style.display = "none";
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
  if (Net.inRush && Net.inRush()) {
    if (r.idxs.includes(i)) return i;
    return r.idxs[0];
  }
  if (r.idxs.slice(0, r.cur + 1).includes(i)) return i;
  return r.idxs[r.cur];
};

Net.decorate = function () {
  if (!Net.inChallenge()) return;
  const s = Net.session;
  const idxs = battleIdxs(s);
  const back = $("backbtn"), next = $("nextbtn"), nav = $("navpill"), reb = $("rush-endbtn");

  if (Net.inRush && Net.inRush()) {
    let viewPos = -1;
    try { viewPos = idxs.indexOf(App().idx); } catch (e) {}
    if (viewPos < 0) viewPos = 0;
    const n = s.totalQuestions || idxs.length;
    if (back) back.disabled = viewPos <= 0;
    if (viewPos >= n - 1) {
      if (next) next.style.display = "none";
      if (reb) reb.style.display = "";
    } else {
      if (next) { next.style.display = ""; next.disabled = false; }
      if (reb) reb.style.display = "none";
    }
    if (nav) { nav.style.pointerEvents = ""; nav.style.opacity = ""; }
    const wait = $("waitfriend");
    if (wait) wait.classList.remove("show");
    document.querySelectorAll("#opts .opt").forEach(o => o.classList.toggle("locked", !!Net.rushSubmitted));
    const curQid = (s.questionIds || [])[viewPos];
    const pickedLetter = Net.rushLocalAnswers ? Net.rushLocalAnswers[curQid] : null;
    if (pickedLetter) {
      const mine = document.querySelector('#opts .opt[data-k="' + pickedLetter + '"]');
      if (mine) mine.classList.add("picked");
    }
    return;
  }

  const i = s.currentIndex || 0;
  const qid = (s.questionIds || [])[i];
  const cur = idxs.length ? Math.min(i, idxs.length - 1) : i;
  let viewPos = -1;
  try { viewPos = idxs.indexOf(App().idx); } catch (e) {}
  if (viewPos < 0) viewPos = cur;
  const reviewing = viewPos < cur;
  if (back) back.disabled = viewPos <= 0;
  if (next) next.disabled = !reviewing;
  if (reb) reb.style.display = "none";
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
    const players = s.players || [s.host, s.guest];
    if (rev.ca) {
      players.forEach(p => {
        if (p === Net.name) return;
        const ans = rev.ca[p];
        if (ans && ans.selected && ans.selected !== rev.mine) {
          const foeEl = document.querySelector('#opts .opt[data-k="' + ans.selected + '"]');
          if (foeEl) {
            foeEl.classList.add("friendpick");
            if (!foeEl.querySelector('.foetag[data-p="' + p + '"]')) {
              const t = document.createElement("span");
              t.className = "foetag";
              t.dataset.p = p;
              t.textContent = "👤 " + p;
              foeEl.appendChild(t);
            }
          }
        }
      });
    } else if (rev.foe && rev.foe !== rev.mine) {
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

Net.recordRushAnswer = function (qid, letter) {
  if (Net.rushSubmitted) {
    toast("Test submitted — answers are locked 🔒");
    return;
  }
  Net.rushLocalAnswers = Net.rushLocalAnswers || {};
  Net.rushLocalAnswers[qid] = letter;
  if (App() && App().S) {
    App().S.answers[qid] = letter;
    App().S.elim[qid] = (App().S.elim[qid] || []).filter(x => x !== letter);
    if (App().renderQ) App().renderQ();
  }
  if (FX()) FX().sound("tick");
  paintBattle(Net.session);
};

Net.submitRushTest = async function () {
  if (Net.rushSubmitted) return;
  const s = Net.session;
  if (!s || s.status !== "active") return;
  const idxs = battleIdxs(s);
  const n = s.totalQuestions || idxs.length;
  const answers = Net.rushLocalAnswers || {};
  const answeredCount = Object.keys(answers).length;
  const confirmMsg = answeredCount < n
    ? `You answered ${answeredCount} of ${n} questions.\nAre you sure you want to end your test now?`
    : `Submit your test and finish? Once submitted, answers are locked.`;
  if (!confirm(confirmMsg)) return;

  Net.rushSubmitted = true;
  const totalTimeMs = Math.max(1000, Date.now() - (Net.rushStartTime || Date.now()));
  Net.myTotalTimeMs = totalTimeMs;

  const correctMap = {};
  for (const qid of (s.questionIds || [])) {
    const e = Net.byId[qid];
    if (e && answers[qid]) {
      correctMap[qid] = (answers[qid] === e.correct);
    }
  }

  const rw = $("ov-rush-waiting");
  if (rw) {
    rw.classList.add("open");
    const st = $("rush-wait-status");
    if (st) st.textContent = "Waiting for other players to finish…";
  }
  if (App() && App().renderQ) App().renderQ();

  const payload = {
    actor: Net.name,
    pin: getPin(Net.name),
    sessionId: s.id,
    answers,
    totalTimeMs,
    qTimes: {},
    correctMap,
  };

  let done = false;
  if (Net.socket && Net.socket.connected) {
    try {
      const ack = await new Promise(res => {
        let settled = false;
        Net.socket.emit("duel:rush_submit", payload, (a) => { if (!settled) { settled = true; res(a); } });
        setTimeout(() => { if (!settled) { settled = true; res(null); } }, 6000);
      });
      if (ack && ack.ok) {
        done = true;
        if (ack.session) onSession(ack.session);
      }
    } catch (e) {}
  }
  if (!done) {
    const r = await api("/api/sessions/" + encodeURIComponent(s.id), {
      method: "PATCH",
      body: { ...payload, action: "rush_submit" },
    });
    if (r && r.ok) {
      done = true;
      if (r.session) onSession(r.session);
    }
  }
  if (done) {
    toast("Test submitted! 🏁 Waiting for opponents…");
  } else {
    toast("Failed to submit test (offline?) — retrying…");
    const r2 = await api("/api/sessions/" + encodeURIComponent(s.id), {
      method: "PATCH",
      body: { ...payload, action: "rush_submit" },
    }).catch(() => {});
    if (r2 && r2.ok && r2.session) onSession(r2.session);
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

async function revealDuel(s, ca) {
  Net.revealed = true;
  const i = s.currentIndex || 0, n = s.totalQuestions || s.questionIds.length;
  const qid = (s.questionIds || [])[i];
  const players = s.players || [s.host, s.guest];
  const forfeited = s.forfeitedPlayers || [];
  const activePlayers = players.filter(p => !forfeited.includes(p));
  Net.playerScores = Net.playerScores || {};
  Net.playerTimes = Net.playerTimes || {};

  Net._scoredQuestions = Net._scoredQuestions || new Set();
  const alreadyScored = Net._scoredQuestions.has(i);
  if (!alreadyScored) {
    Net._scoredQuestions.add(i);
    players.forEach(p => {
      const doc = ca[p];
      if (doc) {
        if (doc.is_correct) {
          Net.playerScores[p] = (Net.playerScores[p] || 0) + 1;
        }
        Net.playerTimes[p] = Net.playerTimes[p] || [];
        Net.playerTimes[p].push(doc.timeMs || 0);
      }
    });
  }
  Net.myScore = Net.playerScores[Net.name] || 0;
  Net.myTimes = Net.playerTimes[Net.name] || [];
  const firstFoe = activePlayers.find(p => p !== Net.name) || players.find(p => p !== Net.name) || players[0];
  Net.frScore = Net.playerScores[firstFoe] || 0;
  Net.frTimes = Net.playerTimes[firstFoe] || [];

  const mDoc = ca[Net.name] || {};
  (Net._reveals = Net._reveals || {})[i] = { i, qid, mine: mDoc.selected, ca };
  Net._myPick = null;
  if (App() && App().S) { App().S.answers[qid] = mDoc.selected; saveAnswerCache(Net.name); }
  if (App() && App().renderQ) App().renderQ();
  lockWaiting(false);
  const right = $("right");
  if (right) { right.classList.remove("flip-reveal"); void right.offsetWidth; right.classList.add("flip-reveal"); }
  if (FX()) { FX().sound("whoosh"); setTimeout(() => FX() && FX().sound("tada"), 350); }
  paintBattle({ ...s, currentIndex: i });

  const isMeCorrect = !!mDoc.is_correct;
  if (!alreadyScored) {
    if (activePlayers.length <= 2) {
      toast(isMeCorrect ? `Correct! ${Net.myScore}–${Net.frScore} 🎉` :
        `It was ${correctOf(qid)} — ${Net.myScore}–${Net.frScore}`);
    } else {
      toast(isMeCorrect ? `Correct! Score: ${$("scorepill")?.textContent || ""} 🎉` :
        `It was ${correctOf(qid)} · ${$("scorepill")?.textContent || ""}`);
    }
  }

  setTimeout(async () => {
    const curS = Net.session;
    if (!curS || curS.id !== s.id || curS.status !== "active") return;
    if ((curS.currentIndex || 0) !== i) return;
    if (i + 1 >= n) { await closeSession(curS); return; }

    const curPlayers = curS.players || [curS.host, curS.guest];
    const curForfeited = curS.forfeitedPlayers || [];
    const curActive = curPlayers.filter(p => !curForfeited.includes(p));
    const effectiveHost = curActive.includes(curS.host) ? curS.host : curActive[0];

    if (Net.name === effectiveHost) {
      const ar = await api("/api/sessions/" + encodeURIComponent(curS.id),
        { method: "PATCH", body: { actor: Net.name, pin: getPin(Net.name), action: "advance", currentIndex: i + 1 } });
      if (!ar || !ar.ok) refreshSession(curS.id);
    } else {
      setTimeout(async () => {
        const live = Net.session;
        if (!live || live.id !== s.id || (live.currentIndex || 0) !== i || live.status !== "active") return;
        const liveActive = (live.players || [live.host, live.guest]).filter(p => !(live.forfeitedPlayers || []).includes(p));
        const allAns = liveActive.length > 0 && liveActive.every(p => live.currentAnswers && live.currentAnswers[p]);
        if (allAns && liveActive.includes(Net.name)) {
          const ar = await api("/api/sessions/" + encodeURIComponent(live.id),
            { method: "PATCH", body: { actor: Net.name, pin: getPin(Net.name), action: "advance", currentIndex: i + 1 } });
          if (!ar || !ar.ok) refreshSession(live.id);
        }
      }, 1200);
    }
  }, 2600);
}

function correctOf(qid) { const e = Net.byId[qid]; return e ? e.correct : "?"; }

async function closeSession(s) {
  const pTimesObj = {};
  if (Net.playerTimes) {
    for (const p of (s.players || [s.host, s.guest])) {
      const times = Net.playerTimes[p] || [];
      const tot = times.reduce((a, b) => a + b, 0);
      pTimesObj[p] = { totalTimeMs: tot, qTimes: times };
    }
  }
  await api("/api/sessions/" + encodeURIComponent(s.id),
    { method: "PATCH", body: { actor: Net.name, pin: getPin(Net.name), action: "finish", playerTimes: pTimesObj } }).catch(() => {});
}

function finishSession(s) {
  exitBattleView();
  const rw = $("ov-rush-waiting");
  if (rw) rw.classList.remove("open");

  const players = s.players || [s.host, s.guest];
  const forfeited = s.forfeitedPlayers || [];
  const activePlayers = players.filter(p => !forfeited.includes(p));
  const n = s.totalQuestions || (s.questionIds || []).length;

  if (s.mode === "rush") {
    Net.playerScores = {};
    for (const p of players) {
      const pAns = (s.rushAnswers && s.rushAnswers[p]) || (p === Net.name ? Net.rushLocalAnswers : {});
      let corr = 0;
      for (const qid of (s.questionIds || [])) {
        const e = Net.byId[qid];
        if (e && pAns && pAns[qid] === e.correct) corr++;
      }
      Net.playerScores[p] = corr;
    }
    Net.myScore = Net.playerScores[Net.name] || 0;
    const foeName = activePlayers.find(p => p !== Net.name) || (s.host === Net.name ? s.guest : s.host);
    Net.frScore = Net.playerScores[foeName] || 0;

    // Sync my answers into App state for review
    if (Net.rushLocalAnswers && App() && App().S) {
      for (const [qid, letter] of Object.entries(Net.rushLocalAnswers)) {
        App().S.answers[qid] = letter;
        solvedCacheAdd(Net.name, qid);
      }
      saveAnswerCache(Net.name);
    }
  }

  function fmtMs(ms) {
    if (!ms || ms <= 0) return "—";
    const sec = Math.round(ms / 1000);
    const m = Math.floor(sec / 60);
    const secRem = sec % 60;
    return m > 0 ? `${m}m ${secRem}s` : `${secRem}s`;
  }
  function fmtPace(ms, totalQ) {
    if (!ms || ms <= 0 || !totalQ) return "—";
    return (ms / 1000 / totalQ).toFixed(1) + "s";
  }

  const getPlayerTotalTime = p => {
    const pt = (s.playerTimes && s.playerTimes[p]) || null;
    if (pt && typeof pt === "object") return +pt.totalTimeMs || 0;
    if (pt && typeof pt === "number") return pt;
    if (p === Net.name) {
      if (Net.myTotalTimeMs) return Net.myTotalTimeMs;
      if (Net.rushStartTime) return Math.max(1000, Date.now() - Net.rushStartTime);
      if (Net.myTimes && Net.myTimes.length) return Net.myTimes.reduce((a, b) => a + b, 0);
    }
    const foe = activePlayers.find(x => x !== Net.name) || (s.host === Net.name ? s.guest : s.host);
    if (p === foe) {
      if (Net.frTimes && Net.frTimes.length) return Net.frTimes.reduce((a, b) => a + b, 0);
    }
    return 0;
  };

  if (activePlayers.length <= 2) {
    const foe = activePlayers.find(p => p !== Net.name) || (s.host === Net.name ? s.guest : s.host);
    const myTime = getPlayerTotalTime(Net.name);
    const foeTime = getPlayerTotalTime(foe);

    let win = false, tie = false;
    let wonOnTime = false, lostOnTime = false;
    if (Net.myScore > Net.frScore) {
      win = true;
    } else if (Net.myScore < Net.frScore) {
      win = false;
    } else {
      // Tie-breaker: faster total time wins (for BOTH wait and rush)
      if (myTime > 0 && foeTime > 0 && myTime !== foeTime) {
        if (myTime < foeTime) {
          win = true;
          wonOnTime = true;
        } else {
          win = false;
          lostOnTime = true;
        }
      } else {
        tie = true;
      }
    }

    if ($("end-trophy")) $("end-trophy").textContent = win ? "🏆" : tie ? "🤝" : "💪";
    if (wonOnTime) {
      $("end-title").textContent = "You win!";
      if ($("end-sub")) {
        $("end-sub").textContent = `You were ${fmtMs(foeTime - myTime)} faster.`;
        $("end-sub").style.display = "block";
      }
    } else if (lostOnTime) {
      $("end-title").textContent = esc(foe) + " wins!";
      if ($("end-sub")) {
        $("end-sub").textContent = `${esc(foe)} was ${fmtMs(myTime - foeTime)} faster.`;
        $("end-sub").style.display = "block";
      }
    } else {
      $("end-title").textContent = win ? "You win!" : tie ? "Dead even!" : esc(foe) + " wins!";
      if ($("end-sub")) $("end-sub").style.display = "none";
    }

    $("end-grid").innerHTML = `
      <div class="challend-matchup">
        <div class="challend-col">
          <div class="challend-score ${win ? 'is-winner' : ''}">${Net.myScore}</div>
          <div class="challend-player">You</div>
          <div class="challend-stats-box">
            <div class="challend-stat-time">${fmtMs(myTime)}</div>
            <div class="challend-stat-pace">${fmtPace(myTime, n)} avg / Q</div>
          </div>
        </div>
        <div class="challend-vs">VS</div>
        <div class="challend-col">
          <div class="challend-score ${!win && !tie ? 'is-winner' : ''}">${Net.frScore}</div>
          <div class="challend-player">${esc(foe)}</div>
          <div class="challend-stats-box">
            <div class="challend-stat-time">${fmtMs(foeTime)}</div>
            <div class="challend-stat-pace">${fmtPace(foeTime, n)} avg / Q</div>
          </div>
        </div>
      </div>
    `;

    const endTimes = $("end-times");
    if (endTimes) endTimes.innerHTML = "";
  } else {
    // 3-way (1v1v1) podium
    const ranked = [...players].sort((a, b) => {
      const diff = (Net.playerScores[b] || 0) - (Net.playerScores[a] || 0);
      if (diff !== 0) return diff;
      const ta = getPlayerTotalTime(a) || Infinity;
      const tb = getPlayerTotalTime(b) || Infinity;
      return ta - tb;
    });
    const p1 = ranked[0], p2 = ranked[1] || ranked[0], p3 = ranked[2] || ranked[1] || ranked[0];
    const s1 = Net.playerScores[p1] || 0;
    const s2 = Net.playerScores[p2] || 0;
    const s3 = Net.playerScores[p3] || 0;
    const t1 = getPlayerTotalTime(p1), t2 = getPlayerTotalTime(p2), t3 = getPlayerTotalTime(p3);

    const isTieWithP2 = s1 === s2 && t1 === t2;
    const win = p1 === Net.name;
    const tie = isTieWithP2;

    if ($("end-trophy")) $("end-trophy").textContent = win ? (tie ? "🤝" : "🏆") : "💪";
    if (win && s1 === s2 && t1 < t2) {
      $("end-title").textContent = "You win!";
      if ($("end-sub")) {
        $("end-sub").textContent = `You were ${fmtMs(t2 - t1)} faster.`;
        $("end-sub").style.display = "block";
      }
    } else if (!win && s1 === s2 && t1 < t2) {
      $("end-title").textContent = esc(p1) + " wins!";
      if ($("end-sub")) {
        $("end-sub").textContent = `${esc(p1)} was ${fmtMs(t2 - t1)} faster.`;
        $("end-sub").style.display = "block";
      }
    } else {
      $("end-title").textContent = win
        ? (tie ? "Dead even!" : "You win!")
        : (tie ? "Tie: " + [p1, p2].map(esc).join(" & ") : esc(p1) + " wins!");
      if ($("end-sub")) $("end-sub").style.display = "none";
    }

    if (ranked.length >= 4) {
      const p4 = ranked[3] || ranked[2];
      const s4 = Net.playerScores[p4] || 0;
      const t4 = getPlayerTotalTime(p4);
      $("end-grid").innerHTML = `
        <div class="challend-podium four-way">
          <div class="challend-podium-col ${p2 === ranked[0] && tie ? 'winner' : ''}">
            <div class="challend-score ${p2 === ranked[0] && tie ? 'is-winner' : ''}">${s2}</div>
            <div class="challend-player">${p2 === Net.name ? 'You' : esc(p2)}</div>
            <div class="challend-stats-box">
              <div class="challend-stat-time">${fmtMs(t2)}</div>
              <div class="challend-stat-pace">${fmtPace(t2, n)} avg</div>
            </div>
          </div>
          <div class="challend-podium-col winner">
            <div class="challend-score is-winner">${s1}</div>
            <div class="challend-player">${p1 === Net.name ? 'You' : esc(p1)}</div>
            <div class="challend-stats-box">
              <div class="challend-stat-time">${fmtMs(t1)}</div>
              <div class="challend-stat-pace">${fmtPace(t1, n)} avg</div>
            </div>
          </div>
          <div class="challend-podium-col">
            <div class="challend-score">${s3}</div>
            <div class="challend-player">${p3 === Net.name ? 'You' : esc(p3)}</div>
            <div class="challend-stats-box">
              <div class="challend-stat-time">${fmtMs(t3)}</div>
              <div class="challend-stat-pace">${fmtPace(t3, n)} avg</div>
            </div>
          </div>
          <div class="challend-podium-col">
            <div class="challend-score">${s4}</div>
            <div class="challend-player">${p4 === Net.name ? 'You' : esc(p4)}</div>
            <div class="challend-stats-box">
              <div class="challend-stat-time">${fmtMs(t4)}</div>
              <div class="challend-stat-pace">${fmtPace(t4, n)} avg</div>
            </div>
          </div>
        </div>
      `;
    } else {
      $("end-grid").innerHTML = `
        <div class="challend-podium">
          <div class="challend-podium-col ${p2 === ranked[0] && tie ? 'winner' : ''}">
            <div class="challend-score ${p2 === ranked[0] && tie ? 'is-winner' : ''}">${s2}</div>
            <div class="challend-player">${p2 === Net.name ? 'You' : esc(p2)}</div>
            <div class="challend-stats-box">
              <div class="challend-stat-time">${fmtMs(t2)}</div>
              <div class="challend-stat-pace">${fmtPace(t2, n)} avg</div>
            </div>
          </div>
          <div class="challend-podium-col winner">
            <div class="challend-score is-winner">${s1}</div>
            <div class="challend-player">${p1 === Net.name ? 'You' : esc(p1)}</div>
            <div class="challend-stats-box">
              <div class="challend-stat-time">${fmtMs(t1)}</div>
              <div class="challend-stat-pace">${fmtPace(t1, n)} avg</div>
            </div>
          </div>
          <div class="challend-podium-col">
            <div class="challend-score">${s3}</div>
            <div class="challend-player">${p3 === Net.name ? 'You' : esc(p3)}</div>
            <div class="challend-stats-box">
              <div class="challend-stat-time">${fmtMs(t3)}</div>
              <div class="challend-stat-pace">${fmtPace(t3, n)} avg</div>
            </div>
          </div>
        </div>
      `;
    }

    const endTimes = $("end-times");
    if (endTimes) endTimes.innerHTML = "";
  }

  $("ov-challend").classList.add("open");
  if (FX()) {
    const isWin = $("end-title").textContent.includes("You win");
    const isTie = $("end-title").textContent.includes("Dead even") || $("end-title").textContent.includes("Tie");
    if (isWin) {
      FX().sound("fanfare");
      if (FX().celebrate) FX().celebrate();
    } else if (isTie) {
      FX().sound("tie");
    } else {
      FX().sound("neutral");
    }
  }
  if (Net.socket && Net.socket.connected) Net.socket.emit("session:leave", { id: s.id });
  Net.session = null;
  Net._watching = null;
  stopSessPoll();
  sayChallHide();
}

function exitBattleView() {
  Net.rushMode = false;
  Net.rushSubmitted = false;
  Net.rushLocalAnswers = {};
  Net.myTotalTimeMs = null;
  const rw = $("ov-rush-waiting");
  if (rw) rw.classList.remove("open");
  const reb = $("rush-endbtn");
  if (reb) reb.style.display = "none";
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
      (s.players || [s.host, s.guest]).includes(Net.name)) {
    if (!window.confirm("Forfeit the match? It will count as unfinished.")) return;
    const id = s.id;
    markForfeited(id);
    api("/api/sessions/" + encodeURIComponent(id),
      { method: "PATCH", keepalive: true, body: { actor: Net.name, pin: getPin(Net.name), action: "forfeit" } })
      .then(r => { if (!r || r.error === "offline") sendForfeitBeacon(id); })
      .catch(() => sendForfeitBeacon(id));
    if (Net.socket && Net.socket.connected) Net.socket.emit("session:leave", { id });
    toast("Match forfeited 🏳");
  }
  clearChallengeState();
  exitBattleView();
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
  Net._scoredQuestions = new Set();
}
function showForfeitEnd(s, foe) {
  exitBattleView();
  const n = s.totalQuestions || (s.questionIds || []).length;
  const players = s.players || [s.host, s.guest];
  $("end-trophy").textContent = "🏳";
  $("end-title").textContent = s.forfeitedBy ? `${s.forfeitedBy} forfeited` : "Match abandoned";
  $("end-sub").textContent = `Ended after ${Math.min((s.currentIndex || 0) + 1, n)} of ${n} · recorded as unfinished`;
  if (players.length > 2) {
    $("end-grid").innerHTML = players.map(p => {
      const isMe = p === Net.name;
      const sc = Net.playerScores ? (Net.playerScores[p] || 0) : 0;
      const isForfeited = (s.forfeitedPlayers || []).includes(p);
      return `<div class="end-card" style="${isMe ? 'border:2px solid var(--blue);background:rgba(37,99,235,0.08);' : ''}">` +
        `<b>${sc}</b>` +
        `<div style="font-weight:${isMe ? '700' : '500'}">${isMe ? 'you' : esc(p)}${isForfeited ? ' (forfeit)' : ''}</div></div>`;
    }).join("");
  } else {
    $("end-grid").innerHTML =
      `<div class="end-card"><b>${Net.myScore}</b><div>you</div></div>` +
      `<div class="end-card"><b>${Net.frScore}</b><div>${esc(foe)}</div></div>`;
  }
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
