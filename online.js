// online.js — Duo Mode: Google Auth, cloud sync, rooms, daily challenges, ranks.
// Loaded as <script type="module">. Never throws at import time: if Firebase
// is unconfigured or unreachable, `window.Duo` stays minimal and the app
// runs solo exactly as before.
import {
  CHALLENGE_SIZE, rankFor, weightFor, gainFor, hebronDayKey, shiftDayKey,
  streakFromSealedDays, toCloudEntry, isAnswerLetter, mergeAnswerMaps,
  duoIdFor, inviteIdFor, isEmailish,
} from "./duo-lib.js";

const FB_VER = "10.12.2";
const FB = "https://www.gstatic.com/firebasejs/" + FB_VER + "/";
const CFG = (typeof window !== "undefined" && window.SATBANK_FIREBASE) || {};
export const ONLINE = !!(CFG.apiKey && !/PASTE/i.test(String(CFG.apiKey || "")));

const $ = id => document.getElementById(id);
// NB: quotes escaped too — friend-controlled strings (nicknames) land in HTML.
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const nowSec = () => Math.floor(Date.now() / 1000);

// ── Rank badge art: original geometric marks, Valorant-inspired palette ──
const RANK_COLORS = {
  Iron: "#6e6e6e", Bronze: "#b0703c", Silver: "#c7ccd4", Gold: "#e9b949",
  Platinum: "#35b5ac", Diamond: "#5fc4f5", Ascendant: "#37c871",
  Immortal: "#b45cf0", Radiant: "#fff3c4",
};
// Distinct polygon per rank (drawn in a 48x48 box), tier = small pips.
const RANK_SHAPES = {
  Iron: '<rect x="10" y="12" width="28" height="6"/><rect x="10" y="21" width="28" height="6"/><rect x="10" y="30" width="28" height="6"/>',
  Bronze: '<path d="M8 14 L24 24 L8 34 L14 24 Z"/><path d="M20 14 L36 24 L20 34 L26 24 Z"/>',
  Silver: '<path d="M6 12 L24 24 L6 36 L12 24 Z"/><path d="M24 12 L42 24 L24 36 L30 24 Z"/>',
  Gold: '<path d="M24 6 L34 24 L24 42 L14 24 Z"/><circle cx="24" cy="24" r="4"/>',
  Platinum: '<path d="M24 6 L39 15 L39 33 L24 42 L9 33 L9 15 Z"/><path d="M24 14 L32 19 L32 29 L24 34 L16 29 L16 19 Z"/>',
  Diamond: '<path d="M24 4 L40 24 L24 44 L8 24 Z"/><path d="M24 14 L32 24 L24 34 L16 24 Z"/>',
  Ascendant: '<path d="M24 4 L40 30 L8 30 Z"/><path d="M24 22 L34 38 L14 38 Z"/>',
  Immortal: '<path d="M24 4 C34 14 40 22 40 30 A16 16 0 0 1 8 30 C8 22 14 14 24 4 Z"/><circle cx="24" cy="30" r="5"/>',
  Radiant: '<path d="M24 2 L28 20 L46 24 L28 28 L24 46 L20 28 L2 24 L20 20 Z"/><circle cx="24" cy="24" r="5"/>',
};
export function badgeSVG(rank, tier, size) {
  size = size || 44;
  const c = RANK_COLORS[rank] || "#999";
  const shape = RANK_SHAPES[rank] || RANK_SHAPES.Iron;
  let pips = "";
  for (let i = 0; i < (tier || 0); i++) {
    pips += `<circle cx="${18 + i * 12}" cy="52" r="3.2" fill="${c}"/>`;
  }
  const h = tier ? 58 : 48;
  return `<svg width="${size}" height="${Math.round(size * h / 48)}" viewBox="0 0 48 ${h}">` +
    `<g fill="${c}">${shape}</g>${pips}</svg>`;
}

// ── Module state ──
const Duo = {
  on: ONLINE,
  user: null,            // {uid, name, photo}
  db: null, byId: {},    // question bank (set in init)
  duo: null,             // {id, members} — one permanent duo, no codes
  inbox: null,           // incoming invite {id, fromUid, fromName, ...} | null
  outbox: null,          // outgoing invite (tracked via users doc marker) | null
  lastNudgeSeen: 0, lastNudgeSent: 0,
  dayKey: null,
  prog: null,            // my progress doc {qids, answers, sealed?}
  friendUid: null, friendProg: null,
  challengeOn: false,
  histCache: { key: "", rows: [], rr: {}, sealed: {} },
  unsubs: [],
  lastPushedRev: 0, lastAppliedRev: -1, appliedMetaRev: -1,
  metaTimer: null, beatTimer: null,
  fb: null, // {auth, db, fns...} lazily loaded
};
window.Duo = Duo;
Duo.BUILD = "duo2-pair-fx1"; // bump on every deploy; visible in console + Duo panel

// ── lazy Firebase SDK load (only when configured) ──
async function fb() {
  if (Duo.fb) return Duo.fb;
  const [appM, authM, fsM] = await Promise.all([
    import(FB + "firebase-app.js"),
    import(FB + "firebase-auth.js"),
    import(FB + "firebase-firestore.js"),
  ]);
  const app = appM.initializeApp(CFG);
  const auth = authM.getAuth(app);
  const db = fsM.getFirestore(app);
  try { await fsM.enableIndexedDbPersistence(db); }
  catch (e) { /* multi-tab or unsupported: memory cache still works */ }
  Duo.fb = { ...appM, ...authM, ...fsM, auth, db };
  return Duo.fb;
}
const docRef = (f, ...p) => f.doc(f.db, ...p);

// ── App bridge (index.html exposes window.App) ──
const App = () => window.App;

// ════════════════ AUTH ════════════════
async function refreshAuthUI() {
  const btn = $("authbtn"), chip = $("authchip");
  if (!btn) return;
  if (!ONLINE) { btn.style.display = "none"; if (chip) chip.style.display = "none"; return; }
  if (Duo.user) {
    btn.style.display = "none";
    if (chip) {
      chip.style.display = "";
      chip.innerHTML =
        (Duo.user.photo ? `<img src="${esc(Duo.user.photo)}" alt="">` : `<span class="av">?</span>`) +
        `<span>${esc(Duo.user.name || "Player")}</span><span id="syncdot" class="sync" title="sync status"></span>`;
      chip.title = "Signed in — click for Duo panel / sign out";
    }
  } else {
    btn.style.display = "";
    if (chip) chip.style.display = "none";
  }
}

async function signIn() {
  if (!ONLINE) { openPanel(); return; } // unconfigured copy: show the setup note
  const f = await fb();
  const prov = new f.GoogleAuthProvider();
  try {
    await f.signInWithPopup(f.auth, prov);
  } catch (e) {
    if (e && e.code === "auth/popup-blocked") {
      await f.signInWithRedirect(f.auth, prov);
    } else {
      say("auth", friendlyErr(e));
      throw e;
    }
  }
}

async function signOut() {
  // Tear down locally; onAuthStateChanged(null) completes the swap to the
  // local profile. Cloud + both namespaces stay untouched.
  clearUnsubs();
  Duo.duo = null; Duo.prog = null; Duo.friendUid = null; Duo.friendProg = null;
  Duo.inbox = null; Duo.outbox = null; Duo.lastNudgeSeen = 0;
  Duo.challengeOn = false;
  if (App() && App().setChallenge) App().setChallenge(null);
  const f = await fb().catch(() => null);
  if (f) { try { await f.signOut(f.auth); } catch (e) { /* noop */ } }
}

function watchAuth() {
  fb().then(f => {
    f.onAuthStateChanged(f.auth, async (u) => {
      clearUnsubs();
      const newUid = u ? u.uid : null;
      const changed = ((Duo.user && Duo.user.uid) || null) !== newUid;
      // Identity-scoped reset: nothing from the previous profile survives.
      Duo.duo = null; Duo.prog = null; Duo.friendUid = null; Duo.friendProg = null;
      Duo.inbox = null; Duo.outbox = null; Duo.lastNudgeSeen = 0;
      Duo.challengeOn = false; Duo.dayKey = null;
      Duo.histCache = { key: "", rows: [], rr: {}, sealed: {} };
      Duo.lastPushedRev = 0; Duo.lastAppliedRev = -1; Duo.appliedMetaRev = -1;
      lastMetaJSON = "";
      if (App() && App().setChallenge) App().setChallenge(null);
      if (u) {
        // Capture the signed-out backlog BEFORE swapping namespaces, so
        // pre-login practice is merged up (never stranded, never mixed).
        let backlog = null;
        if (!Duo.user && App() && App().nsLocal) {
          try {
            const raw = JSON.parse(localStorage.getItem(App().nsLocal) || "null");
            backlog = (raw && raw.answers) || null;
          } catch (e) { backlog = null; }
        }
        Duo.user = { uid: u.uid, name: u.displayName || "Player", photo: u.photoURL || "", email: u.email || "" };
        if (changed && App() && App().swapProfile) App().swapProfile(u.uid);
        await firstSync(backlog); // idempotent union merge (pull + push)
        listenCloud();            // cloud -> local
        await restoreDuo();       // rejoin duo + pick up invites if any
      } else {
        Duo.user = null;
        if (changed && App() && App().swapProfile) App().swapProfile(null);
      }
      await refreshAuthUI();
      renderPanel();
    });
  }).catch(() => { setSync("off"); refreshAuthUI(); });
}

// ════════════════ SYNC ENGINE ════════════════
function localAnswersAsCloud() {
  // S.answers: {qid: letter} -> normalized cloud entries (t:0 = oldest)
  const S = App().S, out = {};
  for (const [qid, letter] of Object.entries(S.answers || {})) {
    if (!isAnswerLetter(letter)) continue;
    const e = Duo.byId[qid];
    out[qid] = toCloudEntry(letter, e ? e.correct : "", 0);
  }
  return out;
}

// Merge one cloud doc into the active local profile.
// Union of answers (cloud wins conflicts); newer meta wins by metaRev.
// Returns true when the visible UI changed.
function applyCloudDoc(d) {
  d = d || {};
  const S = App().S;
  const beforeJ = JSON.stringify(S.answers || {});
  const merged = mergeAnswerMaps(d.answers || {}, localAnswersAsCloud());
  S.answers = {};
  for (const [qid, en] of Object.entries(merged)) S.answers[qid] = en.a;
  let changed = JSON.stringify(S.answers) !== beforeJ;
  if (d.meta && typeof d.meta.metaRev === "number" && d.meta.metaRev > Duo.appliedMetaRev) {
    Duo.appliedMetaRev = d.meta.metaRev;
    for (const k of ["marked", "elim", "notes", "fDom", "fDif", "order", "currentIndex", "name"]) {
      if (d.meta[k] !== undefined && JSON.stringify(S[k]) !== JSON.stringify(d.meta[k])) {
        S[k] = d.meta[k]; changed = true;
      }
    }
    lastMetaJSON = JSON.stringify(collectMeta());
  }
  return changed;
}
function metaSansRev(m) {
  if (!m) return "";
  const c = { ...m };
  delete c.metaRev;
  return JSON.stringify(c);
}

// Idempotent sign-in sync: PULL cloud into local first (other devices may be
// newer), then PUSH the union of current-local + pre-login backlog for qids
// missing in cloud, plus meta when it differs. Safe to re-run any time:
// it only ever adds missing qids and never overwrites newer progress.
async function firstSync(preLoginLetters) {
  const f = await fb();
  const ref = docRef(f, "users", Duo.user.uid);
  const snap = await f.getDoc(ref).catch(() => null);
  const cloud = (snap && snap.exists() && snap.data()) || {};
  applyCloudDoc(cloud); // pull
  if (cloud.meta && typeof cloud.meta.metaRev === "number") {
    Duo.appliedMetaRev = Math.max(Duo.appliedMetaRev, cloud.meta.metaRev);
  }
  const local = localAnswersAsCloud();
  if (preLoginLetters) {
    for (const [qid, letter] of Object.entries(preLoginLetters)) {
      if (isAnswerLetter(letter) && !local[qid]) {
        const e = Duo.byId[qid];
        local[qid] = toCloudEntry(letter, e ? e.correct : "", 0);
      }
    }
  }
  const cloudAnswers = cloud.answers || {};
  const missing = {};
  for (const [qid, e] of Object.entries(local)) {
    if (!cloudAnswers[qid]) missing[qid] = e;
  }
  const curMeta = collectMeta();
  const metaDiffers = metaSansRev(cloud.meta) !== metaSansRev(curMeta);
  const rev = (cloud.rev || 0) + 1;
  Duo.lastPushedRev = rev;
  const profile = { name: Duo.user.name, photo: Duo.user.photo };
  if (!snap || !snap.exists()) {
    await f.setDoc(ref, {
      profile,
      answers: mergeAnswerMaps(cloudAnswers, local),
      meta: curMeta, rev, updatedAt: Date.now(),
    });
    Duo.appliedMetaRev = curMeta.metaRev;
  } else {
    const inc = { profile, rev, updatedAt: Date.now() };
    for (const qid of Object.keys(missing)) inc["answers." + qid] = missing[qid];
    if (metaDiffers) { inc.meta = curMeta; Duo.appliedMetaRev = curMeta.metaRev; }
    if (Object.keys(inc).length > 3) {
      await f.updateDoc(ref, inc).catch(async () => { await f.setDoc(ref, inc, { merge: true }); });
    } else {
      await f.updateDoc(ref, { profile, rev, updatedAt: inc.updatedAt })
        .catch(async () => { await f.setDoc(ref, { profile, rev, updatedAt: inc.updatedAt }, { merge: true }); });
    }
  }
  Duo.lastAppliedRev = rev;
  lastMetaJSON = JSON.stringify(collectMeta());
  if (App().persist) App().persist();
  if (App().refresh) App().refresh();
  setSync("synced");
}

// Per-answer write-through (called from the answer hook in index.html).
Duo.recordAnswer = async function (qid, letter) {
  if (!Duo.user || !ONLINE) return;
  try {
    const f = await fb();
    const e = Duo.byId[qid];
    const entry = toCloudEntry(letter, e ? e.correct : "", nowSec());
    const rev = ++Duo.lastPushedRev;
    await f.setDoc(docRef(f, "users", Duo.user.uid),
      { answers: { [qid]: entry }, rev, updatedAt: Date.now() }, { merge: true });
    setSync("synced");
  } catch (err) { setSync("off"); }
  // Challenge ledger (first-answer-wins enforced by rules; silent if sealed).
  if (Duo.challengeOn && Duo.prog && (Duo.prog.qids || []).includes(qid)
      && !(Duo.prog.answers || {})[qid]) {
    submitChallengeAnswer(qid, letter);
  }
};

function collectMeta() {
  const S = App().S;
  return {
    marked: S.marked || [], elim: S.elim || {}, notes: S.notes || {},
    fDom: S.fDom || [], fDif: S.fDif || [], order: S.order || null,
    currentIndex: S.currentIndex || 0, name: S.name || "",
    metaRev: (Duo.appliedMetaRev + 1) || 1,
  };
}
let lastMetaJSON = "";
async function pushMeta() {
  if (!Duo.user || !ONLINE) return;
  const m = collectMeta();
  m.metaRev = Duo.appliedMetaRev + 1;
  const j = JSON.stringify(m);
  if (j === lastMetaJSON) return;
  lastMetaJSON = j;
  try {
    const f = await fb();
    const rev = ++Duo.lastPushedRev;
    Duo.appliedMetaRev = m.metaRev;
    await f.setDoc(docRef(f, "users", Duo.user.uid),
      { meta: m, profile: { name: Duo.user.name, photo: Duo.user.photo }, rev, updatedAt: Date.now() },
      { merge: true });
    setSync("synced");
  } catch (e) { setSync("off"); }
}

// Cloud -> local (rev-guarded; deep-compare meta to avoid UI churn).
function listenCloud() {
  fb().then(f => {
    const un = f.onSnapshot(docRef(f, "users", Duo.user.uid), { includeMetadataChanges: true },
      (snap) => {
        if (!snap.exists()) return;
        if (snap.metadata.hasPendingWrites) { setSync("syncing"); return; }
        const d = snap.data() || {};
        if ((d.rev || 0) === Duo.lastPushedRev || (d.rev || 0) === Duo.lastAppliedRev) {
          setSync(snap.metadata.fromCache ? "off" : "synced");
          return;
        }
        Duo.lastAppliedRev = d.rev || 0;
        const changed = applyCloudDoc(d);
        if (changed && App().persist) App().persist();
        if (changed && App().refresh) App().refresh();
        setSync(snap.metadata.fromCache ? "off" : "synced");
      },
      () => setSync("off"));
    Duo.unsubs.push(un);
  }).catch(() => setSync("off"));
}

// ════════════════ SYNC PILL ════════════════
function setSync(st) {
  Duo.syncState = st;
  const dot = $("syncdot"), pill = $("syncpill");
  const label = st === "synced" ? "Synced" : st === "syncing" ? "Syncing…" : "Offline";
  if (dot) { dot.className = "sync " + st; dot.title = label; }
  if (pill) { pill.className = "syncpill " + st; pill.textContent = ONLINE ? label : "Local only"; }
}
Duo.setSync = setSync;
window.addEventListener("online", () => setSync(Duo.user ? "syncing" : "off"));
window.addEventListener("offline", () => setSync("off"));

// ════════════════ PAIRING (no codes — Gmail invites + one permanent duo) ════════════════
function clearUnsubs() {
  for (const u of Duo.unsubs) { try { u(); } catch (e) { /* noop */ } }
  Duo.unsubs = [];
  if (Duo.metaTimer) { clearInterval(Duo.metaTimer); Duo.metaTimer = null; }
  if (Duo.beatTimer) { clearInterval(Duo.beatTimer); Duo.beatTimer = null; }
}
function stopDuo() {
  clearUnsubs();
  Duo.duo = null; Duo.prog = null; Duo.friendUid = null; Duo.friendProg = null;
  Duo.inbox = null; Duo.outbox = null;
  Duo.challengeOn = false;
  if (App() && App().setChallenge) App().setChallenge(null);
  if (Duo.user) listenCloud(); // keep personal sync alive
  if (Duo.user) {
    Duo.metaTimer = setInterval(pushMeta, 8000);
  }
}

async function restoreDuo() {
  Duo.metaTimer = setInterval(pushMeta, 8000);
  listenInbox();
  listenOutboxMine();
  const f = await fb();
  const snap = await f.getDoc(docRef(f, "users", Duo.user.uid)).catch(() => null);
  const duo = snap && snap.exists() && snap.data().duo;
  if (duo && duo.id) { subscribeDuo(duo.id); openToday(); }
  else renderPanel();
}

// ── invites: deterministic ids ("to_" + email), direct reads, no listing ──
Duo.sendInvite = async function (email) {
  email = String(email || "").trim().toLowerCase();
  if (!isEmailish(email)) { say("invite", "That doesn't look like an email address."); return; }
  if (Duo.user.email && email === Duo.user.email.toLowerCase()) {
    say("invite", "That's your own address — invite your friend instead."); return;
  }
  if (Duo.duo) { say("invite", "You're already paired."); return; }
  const f = await fb();
  const iid = inviteIdFor(email);
  let snap = null;
  try { snap = await f.getDoc(docRef(f, "invites", iid)); }
  catch (e) { say("invite", "Can't reach the server (offline?)."); return; }
  if (snap.exists()) {
    const d = snap.data() || {};
    if (d.fromUid !== Duo.user.uid) {
      say("invite", "That address already has an invite from someone else."); return;
    }
    if (d.status === "pending") {
      say("invite", "Invite already sent — waiting for them to join.");
    } else if (d.status === "accepted") {
      if (d.duoId) { await ensurePointer(d.duoId); subscribeDuo(d.duoId); openToday(); }
      else say("invite", "They accepted — setting up your duo…");
    } else { // declined -> resend
      try {
        await f.updateDoc(docRef(f, "invites", iid), {
          status: "pending", at: Date.now(),
          fromName: Duo.user.name, fromPhoto: Duo.user.photo,
        });
        say("invite", "Invite re-sent to " + email + ".");
      } catch (e) { say("invite", friendlyErr(e, "Couldn't resend the invite.")); return; }
    }
  } else {
    try {
      await f.setDoc(docRef(f, "invites", iid), {
        fromUid: Duo.user.uid, fromName: Duo.user.name, fromPhoto: Duo.user.photo,
        toEmail: email, status: "pending", at: Date.now(),
      });
      say("invite", "Invite sent to " + email + " — it will pop up in their app.");
    } catch (e) { say("invite", friendlyErr(e, "Couldn't send the invite.")); return; }
  }
  try {
    await f.setDoc(docRef(f, "users", Duo.user.uid),
      { inviteOut: { id: iid, to: email } }, { merge: true });
  } catch (e) { /* noop */ }
  listenOutboxMine();
  renderPanel();
};

Duo.acceptInvite = async function () {
  if (!Duo.inbox || Duo.inbox.status !== "pending") return;
  const f = await fb();
  const iid = Duo.inbox.id;
  const other = Duo.inbox.fromUid;
  const otherName = Duo.inbox.fromName || "Friend";
  const duoId = duoIdFor(Duo.user.uid, other);
  // Step 1: mark accepted. Duo creation is gated on the COMMITTED accepted
  // state (rules can't see same-batch writes), so this is a separate write.
  // Both steps are idempotent — double-taps and second devices are safe.
  try {
    await f.updateDoc(docRef(f, "invites", iid), { status: "accepted", duoId });
  } catch (e) {
    try {
      const s = await f.getDoc(docRef(f, "invites", iid));
      if (!s.exists() || (s.data() || {}).status !== "accepted") throw e;
    } catch (e2) { say("invite", friendlyErr(e, "Couldn't join — try again.")); return; }
  }
  // Step 2: ensure the duo (deterministic id collapses races).
  try { await ensureDuo(duoId, iid, other); }
  catch (e) { say("invite", "Almost paired — tap Join once more."); return; }
  Duo.inbox = null;
  try {
    await f.setDoc(docRef(f, "users", Duo.user.uid),
      { duo: { id: duoId, withUid: other, withName: otherName } }, { merge: true });
  } catch (e) { /* noop */ }
  subscribeDuo(duoId);
  openToday();
};

Duo.declineInvite = async function () {
  if (!Duo.inbox) return;
  try {
    const f = await fb();
    await f.updateDoc(docRef(f, "invites", Duo.inbox.id), { status: "declined" });
  } catch (e) { /* noop */ }
  Duo.inbox = null;
  renderPanel();
};

Duo.cancelInvite = async function () {
  if (!Duo.outbox) return;
  try {
    const f = await fb();
    await f.deleteDoc(docRef(f, "invites", Duo.outbox.id));
    await f.setDoc(docRef(f, "users", Duo.user.uid), { inviteOut: {} }, { merge: true });
  } catch (e) { /* noop */ }
  Duo.outbox = null;
  renderPanel();
};

// Create the duo doc if missing (recipient side; deterministic id).
async function ensureDuo(duoId, iid, otherUid) {
  const f = await fb();
  const ref = docRef(f, "duos", duoId);
  let snap = null;
  try { snap = await f.getDoc(ref); } catch (e) { throw e; }
  if (snap.exists()) return snap.data();
  const me = { nickname: Duo.user.name, photo: Duo.user.photo, lastActive: Date.now() };
  const otherRow = {
    nickname: (Duo.inbox && Duo.inbox.fromName) || "Friend",
    photo: (Duo.inbox && Duo.inbox.fromPhoto) || "",
    lastActive: 0,
  };
  const data = {
    members: { [Duo.user.uid]: me, [otherUid]: otherRow },
    createdAt: Date.now(), createdBy: Duo.user.uid, viaInvite: iid,
  };
  await f.setDoc(ref, data);
  return data;
}

// Point my profile at an existing duo (sender side after accept).
async function ensurePointer(duoId) {
  const f = await fb();
  let snap = null;
  try { snap = await f.getDoc(docRef(f, "duos", duoId)); } catch (e) { return; }
  if (!snap.exists()) return;
  const m = (snap.data() && snap.data().members) || {};
  const other = Object.keys(m).find(u => u !== Duo.user.uid);
  if (!other) return;
  try {
    await f.setDoc(docRef(f, "users", Duo.user.uid), {
      duo: { id: duoId, withUid: other, withName: (m[other] && m[other].nickname) || "Friend" },
    }, { merge: true });
  } catch (e) { /* noop */ }
}

// Inbox: my address's invite doc, watched live for the side-toast.
function listenInbox() {
  if (!Duo.user || !Duo.user.email) return;
  fb().then(f => {
    const iid = inviteIdFor(Duo.user.email);
    const un = f.onSnapshot(docRef(f, "invites", iid), (snap) => {
      const was = Duo.inbox && Duo.inbox.status;
      Duo.inbox = snap.exists() ? { id: iid, ...snap.data() } : null;
      if (Duo.inbox && Duo.inbox.status === "pending" && was !== "pending" && !Duo.duo) {
        inviteToast(Duo.inbox);
      }
      renderPanel();
    }, () => {});
    Duo.unsubs.push(un);
  });
}

// Outbox: my sent invite, watched so acceptance pairs me automatically.
function listenOutboxMine() {
  fb().then(async (f) => {
    let out = null;
    try {
      const usnap = await f.getDoc(docRef(f, "users", Duo.user.uid));
      out = usnap && usnap.exists() && usnap.data().inviteOut;
    } catch (e) { /* noop */ }
    if (!out || !out.id || Duo.duo) { return; }
    const un = f.onSnapshot(docRef(f, "invites", out.id), async (snap) => {
      Duo.outbox = snap.exists() ? { id: out.id, ...snap.data() } : null;
      if (Duo.outbox && Duo.outbox.status === "accepted" && Duo.outbox.duoId) {
        const did = Duo.outbox.duoId;
        Duo.outbox = null;
        try {
          await f.setDoc(docRef(f, "users", Duo.user.uid), { inviteOut: {} }, { merge: true });
        } catch (e) { /* noop */ }
        await ensurePointer(did);
        subscribeDuo(did);
        openToday();
        return;
      }
      renderPanel();
    }, () => {});
    Duo.unsubs.push(un);
  });
}

function subscribeDuo(id) {
  fb().then(f => {
    clearUnsubs();
    listenCloud();
    listenInbox();
    listenOutboxMine();
    Duo.metaTimer = setInterval(pushMeta, 8000);
    const un = f.onSnapshot(docRef(f, "duos", id), (snap) => {
      if (!snap.exists()) { stopDuo(); renderPanel(); return; }
      Duo.duo = { id, members: snap.data().members || {} };
      const others = Object.keys(Duo.duo.members).filter(u => u !== Duo.user.uid);
      const nu = others[0] || null;
      if (nu !== Duo.friendUid) {
        Duo.friendUid = nu; Duo.friendProg = null;
        if (nu) listenFriend(id, nu);
      }
      // ensure today's set exactly once per duo-day (openToday is idempotent;
      // heartbeats re-fire this snapshot, so the guard prevents loops)
      const dk = hebronDayKey();
      if (Duo._openDay !== id + "|" + dk) {
        Duo._openDay = id + "|" + dk;
        openToday();
      }
      renderPanel();
    }, () => say("duo", "Lost connection to your duo."));
    Duo.unsubs.push(un);
    listenNudges(id);
    // presence heartbeat (also refreshes my name/photo for my friend)
    const beat = async () => {
      try {
        await f.updateDoc(docRef(f, "duos", id), {
          ["members." + Duo.user.uid + ".lastActive"]: Date.now(),
          ["members." + Duo.user.uid + ".nickname"]: Duo.user.name,
          ["members." + Duo.user.uid + ".photo"]: Duo.user.photo,
        });
      } catch (e) { /* noop */ }
    };
    beat();
    Duo.beatTimer = setInterval(beat, 60000);
  });
}
Duo.subscribeDuo = subscribeDuo;

Duo.unpair = async function () {
  // Unpair = abandon the duo doc and clear my pointer (rules deny removal;
  // docs are tiny). Re-pair any time with a fresh invite.
  const f = await fb().catch(() => null);
  if (f && Duo.user) {
    try { await f.setDoc(docRef(f, "users", Duo.user.uid), { duo: {} }, { merge: true }); } catch (e) { /* noop */ }
  }
  stopDuo();
  renderPanel();
};

// ── pokes: instant in-app nudges, no servers ──
function listenNudges(id) {
  fb().then(f => {
    let q = null;
    try {
      q = f.query(f.collection(f.db, "duos", id, "nudges"),
        f.orderBy("at", "desc"), f.limit(5));
    } catch (e) { return; }
    const un = f.onSnapshot(q, (snap) => {
      let newest = null;
      snap.forEach(d => {
        const v = d.data() || {};
        if (!newest || (v.at || 0) > newest.at) newest = { nid: d.id, ...v };
      });
      if (newest && newest.fromUid !== Duo.user.uid
          && (newest.at || 0) > Duo.lastNudgeSeen
          && Date.now() - (newest.at || 0) < 15 * 60e3) {
        Duo.lastNudgeSeen = newest.at;
        const m = (Duo.duo && Duo.duo.members && Duo.duo.members[newest.fromUid]) || {};
        nudgeToast(m.nickname || "Your friend");
      }
    }, () => {});
    Duo.unsubs.push(un);
  });
}

Duo.nudge = async function () {
  if (!Duo.duo || !Duo.friendUid) return;
  if (Date.now() - (Duo.lastNudgeSent || 0) < 60e3) {
    say("duo", "Nudge sent — give them a minute!"); return;
  }
  try {
    const f = await fb();
    await f.addDoc(f.collection(f.db, "duos", Duo.duo.id, "nudges"),
      { fromUid: Duo.user.uid, at: Date.now() });
    Duo.lastNudgeSent = Date.now();
    say("duo", "Nudged! 🔔");
  } catch (e) { say("duo", "Couldn't send the nudge (offline?)."); }
};

// ── side toasts (slide in from the right; container + CSS injected) ──
function toastBox() {
  let box = $("duo-toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "duo-toasts";
    document.body.appendChild(box);
    if (!$("duo-toast-css")) {
      const st = document.createElement("style");
      st.id = "duo-toast-css";
      st.textContent =
        "#duo-toasts{position:fixed;top:70px;right:14px;z-index:400;display:flex;" +
        "flex-direction:column;gap:10px;max-width:min(340px,90vw)}" +
        ".duo-toast{background:#fff;border:1.5px solid #111;border-radius:12px;" +
        "padding:14px 16px;box-shadow:0 8px 28px rgba(0,0,0,.25);" +
        "transform:translateX(120%);transition:transform .28s ease;font-size:14px}" +
        ".duo-toast.in{transform:none}" +
        ".duo-toast .dt-row{display:flex;gap:10px;align-items:center;margin-bottom:10px}" +
        ".duo-toast img{width:38px;height:38px;border-radius:50%}" +
        ".duo-toast .av{display:inline-flex;width:38px;height:38px;border-radius:50%;" +
        "background:var(--blue,#2e5be6);color:#fff;align-items:center;justify-content:center;font-weight:700}" +
        ".duo-toast .mrow{display:flex;gap:10px;justify-content:flex-end;margin-top:4px}";
      document.head.appendChild(st);
    }
  }
  return box;
}
function showToast(html, ms) {
  const box = toastBox();
  const el = document.createElement("div");
  el.className = "duo-toast";
  el.innerHTML = html;
  box.appendChild(el);
  const raf = (typeof requestAnimationFrame === "function")
    ? requestAnimationFrame : (fn => setTimeout(fn, 30));
  raf(() => el.classList.add("in"));
  const kill = () => { el.classList.remove("in"); setTimeout(() => el.remove(), 320); };
  el.querySelectorAll("[data-x]").forEach(b => { b.onclick = kill; });
  if (ms) setTimeout(kill, ms);
  return { el, kill };
}
function inviteToast(inv) {
  if (!inv || inviteToast._for === inv.id) return;
  inviteToast._for = inv.id;
  const t = showToast(
    `<div class="dt-row">${inv.fromPhoto ? `<img src="${esc(inv.fromPhoto)}" alt="">` : `<span class="av">?</span>`}` +
    `<div><b>${esc(inv.fromName || "Someone")}</b> invited you to Duo!<br>` +
    `<span class="duo-sub">Daily SAT challenges, head-to-head.</span></div></div>` +
    `<div class="mrow"><button class="btn-blue" data-a="join">Join</button>` +
    `<button class="btn-ghost" data-a="no">Decline</button></div>`);
  const j = t.el.querySelector('[data-a="join"]'), n = t.el.querySelector('[data-a="no"]');
  if (j) j.onclick = async () => { t.kill(); inviteToast._for = null; openPanel(); await Duo.acceptInvite(); };
  if (n) n.onclick = async () => { t.kill(); inviteToast._for = null; await Duo.declineInvite(); };
}
function nudgeToast(name) {
  const fx = (typeof window !== "undefined") && window.FX;
  if (fx) fx.sound("nudge");
  const t = showToast(
    `<div class="dt-row"><span style="font-size:24px">🔔</span>` +
    `<div><b>${esc(name)}</b> nudged you — today's set is waiting!</div></div>` +
    `<div class="mrow"><button class="btn-blue" data-a="play">Play</button>` +
    `<button class="btn-ghost" data-a="x">Later</button></div>`, 25000);
  const p = t.el.querySelector('[data-a="play"]'), x = t.el.querySelector('[data-a="x"]');
  if (p) p.onclick = () => { t.kill(); openPanel(); Duo.startChallenge(); };
  if (x) x.onclick = () => t.kill();
}
function openPanel() {
  const o = $("ov-duo");
  if (o) { o.classList.add("open"); renderPanel(); }
}

// ── presence helpers ──
function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - (ts || 0)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " min ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function isOnline(m) {
  return !!(m && m.lastActive && Date.now() - m.lastActive < 120e3);
}

// ════════════════ DAILY CHALLENGE ════════════════
function solvedSet() {
  const S = App().S;
  const s = new Set(Object.keys(S.answers || {}));
  return s;
}

// Deterministic pick: seeded by room+uid+day; stratified 5+5 with difficulty mix.
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pickDailySet(solved) {
  const rnd = mulberry(hashSeed(Duo.duo.id + "|" + Duo.user.uid + "|" + Duo.dayKey));
  const pool = [];
  Duo.db.forEach((e, i) => { if (e && e.id && !solved.has(e.id)) pool.push(i); });
  const isRW = i => (Duo.db[i].test || "").toLowerCase().includes("reading");
  const isMath = i => (Duo.db[i].test || "").toLowerCase().includes("math");
  let rw = pool.filter(isRW), math = pool.filter(isMath);
  const rest = pool.filter(i => !isRW(i) && !isMath(i));
  // fallbacks keep the 5+5 shape whenever the bank allows it
  while (rw.length < 5 && rest.length) rw.push(rest.shift());
  while (math.length < 5 && rest.length) math.push(rest.shift());
  const take = (arr, n) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
    // difficulty round-robin: E, M, H, M, E... for a fair mix
    const order = { Easy: 0, Medium: 1, Hard: 2 };
    a.sort((x, y) => (order[Duo.db[x].difficulty] ?? 1) - (order[Duo.db[y].difficulty] ?? 1));
    const out = [];
    const buckets = [[], [], []];
    for (const i of a) buckets[order[Duo.db[i].difficulty] ?? 1].push(i);
    const seq = [1, 0, 2, 1, 1, 0, 2, 1, 0, 1];
    for (const b of seq) { if (out.length >= n) break; if (buckets[b].length) out.push(buckets[b].shift()); }
    for (const b of buckets) for (const i of b) { if (out.length < n) out.push(i); }
    return out.slice(0, n);
  };
  let qids = take(rw, 5).concat(take(math, 5)).map(i => Duo.db[i].id);
  if (qids.length < CHALLENGE_SIZE) {
    // bank exhausted for this profile: top up with oldest-solved (documented fallback)
    const extra = [];
    for (const qid of Object.keys(App().S.answers || {})) {
      if (!qids.includes(qid) && Duo.byId[qid]) extra.push(qid);
      if (qids.length + extra.length >= CHALLENGE_SIZE) break;
    }
    qids = qids.concat(extra);
  }
  return qids.slice(0, CHALLENGE_SIZE);
}

Duo.openToday = openToday;
async function openToday() {
  if (!Duo.duo) return;
  const f = await fb();
  Duo.dayKey = hebronDayKey();
  Duo.notes.today = "";
  const ref = docRef(f, "duos", Duo.duo.id, "days", Duo.dayKey, "progress", Duo.user.uid);
  let snap;
  try { snap = await f.getDoc(ref); } catch (e) { say("today", "Offline — showing last synced state."); return; }
  if (snap.exists()) {
    Duo.prog = snap.data();
  } else {
    // deterministic generation: concurrent tabs produce identical sets, so the
    // create race is harmless (same qids either way).
    const qids = pickDailySet(solvedSet());
    Duo.prog = { qids, answers: {}, createdAt: Date.now() };
    try { await f.setDoc(ref, Duo.prog); }
    catch (e) {
      const r = await f.getDoc(ref).catch(() => null);
      if (r && r.exists()) Duo.prog = r.data();
      else { say("today", "Couldn't create today's set."); return; }
    }
  }
  listenMine();
  renderPanel();
}

function progRef(uid) {
  return fb().then(f => docRef(f, "duos", Duo.duo.id, "days", Duo.dayKey, "progress", uid || Duo.user.uid));
}
function listenMine() {
  fb().then(f => {
    const un = f.onSnapshot(docRef(f, "duos", Duo.duo.id, "days", Duo.dayKey, "progress", Duo.user.uid),
      (snap) => {
        if (!snap.exists()) return;
        const wasSealed = !!(Duo.prog && Duo.prog.sealed);
        Duo.prog = snap.data();
        if (!!Duo.prog.sealed !== wasSealed) Duo.histCache.fresh = false; // ranks change only on seal
        updateChallengeUI();
        renderPanel();
      });
    Duo.unsubs.push(un);
  });
}
function listenFriend(id, uid) {
  fb().then(f => {
    const dayKey = Duo.dayKey || hebronDayKey();
    const un = f.onSnapshot(docRef(f, "duos", id, "days", dayKey, "progress", uid),
      (snap) => {
        const wasSealed = !!(Duo.friendProg && Duo.friendProg.sealed);
        Duo.friendProg = snap.exists() ? snap.data() : null;
        if (!!(Duo.friendProg && Duo.friendProg.sealed) !== wasSealed) Duo.histCache.fresh = false;
        updateChallengeUI();
        renderPanel();
      });
    Duo.unsubs.push(un);
  });
}

async function submitChallengeAnswer(qid, letter) {
  try {
    const f = await fb();
    const e = Duo.byId[qid];
    const ref = await progRef();
    await f.updateDoc(ref, {
      ["answers." + qid]: { ans: letter, ok: letter === (e ? e.correct : letter) },
    }).catch(async () => {
      // doc vanished mid-flight (shouldn't happen): recreate-merge
      await f.setDoc(ref, { answers: { [qid]: { ans: letter, ok: letter === (e ? e.correct : letter) } } }, { merge: true });
    });
  } catch (err) { /* rules deny re-answers (first-answer-wins) or offline queues it */ }
}

Duo.startChallenge = function () {
  if (!Duo.prog || !(Duo.prog.qids || []).length) return;
  const idxs = Duo.prog.qids.map(qid => Duo.db.findIndex(e => e && e.id === qid)).filter(i => i >= 0);
  Duo.challengeOn = true;
  if (App() && App().setChallenge) App().setChallenge(idxs, true);
  const fx = (typeof window !== "undefined") && window.FX;
  if (fx) { fx.burst("mini"); fx.sound("go"); }
  updateChallengeUI();
  renderPanel();
};
Duo.exitChallenge = function () {
  Duo.challengeOn = false;
  if (App() && App().setChallenge) App().setChallenge(null);
  renderPanel();
};

async function maybeSeal() {
  if (!Duo.prog || Duo.prog.sealed) return;
  const n = Object.keys(Duo.prog.answers || {}).length;
  if (n < CHALLENGE_SIZE) return;
  try {
    const f = await fb();
    await f.updateDoc(await progRef(), { sealed: { at: Date.now() } });
  } catch (e) { /* already sealed or offline: snapshot will confirm */ }
}
Duo.maybeSeal = maybeSeal;

function resultOf(prog) {
  if (!prog || !prog.sealed) return null;
  const entries = [];
  for (const qid of prog.qids || []) {
    const a = (prog.answers || {})[qid];
    if (!a) return null;
    const e = Duo.byId[qid];
    entries.push({ qid, ok: !!a.ok, w: weightFor(e ? e.difficulty : "") });
  }
  const score = entries.filter(x => x.ok).length;
  return { score, total: entries.length, gain: gainFor(entries), entries };
}
Duo.resultOf = resultOf;

// ════════════════ HISTORY / RANKS (derived, session-cached) ════════════════
Duo.refreshHistory = async function () {
  if (!Duo.duo) return Duo.histCache;
  const today = hebronDayKey();
  if (Duo.histCache.key === Duo.duo.id + "|" + today && Duo.histCache.fresh) return Duo.histCache;
  const f = await fb();
  const daysCol = f.collection(f.db, "duos", Duo.duo.id, "days");
  let snaps;
  try {
    snaps = await f.getDocs(f.query(daysCol, f.orderBy(f.documentId(), "desc"), f.limit(90)));
  } catch (e) { return Duo.histCache; }
  const uids = Object.keys(Duo.duo.members || {});
  const rows = [], sealedByUid = {}, rr = {};
  for (const u of uids) { sealedByUid[u] = []; rr[u] = 0; }
  await Promise.all(snaps.docs.map(async (d) => {
    const day = d.id;
    const progs = {};
    await Promise.all(uids.map(async (u) => {
      try {
        const s = await f.getDoc(docRef(f, "duos", Duo.duo.id, "days", day, "progress", u));
        if (s.exists()) progs[u] = s.data();
      } catch (e) { /* skip */ }
    }));
    const row = { day, score: {} };
    for (const u of uids) {
      const r = resultOf(progs[u]);
      if (r) { row.score[u] = r; rr[u] += r.gain; sealedByUid[u].push(day); }
    }
    if (Object.keys(row.score).length) rows.push(row);
  }));
  rows.sort((a, b) => (a.day < b.day ? 1 : -1));
  const streak = {};
  for (const u of uids) streak[u] = streakFromSealedDays(sealedByUid[u], today);
  Duo.histCache = { key: Duo.duo.id + "|" + today, fresh: true, scanned: true, rows, rr, streak };
  return Duo.histCache;
};

// ════════════════ PANEL UI ════════════════
function say(area, msg) {
  Duo.notes[area] = msg || "";
  const el = $("duo-msg-" + area);
  if (el) { el.textContent = msg || ""; el.style.display = msg ? "" : "none"; }
  else if (msg) { console.warn("[duo:" + area + "]", msg); }
}
Duo.say = say;
Duo.notes = {};

// Never show backend internals to players: map technical failures to plain
// language. Raw details go to the console for debugging only.
function friendlyErr(e, fallback) {
  try { console.warn("[duo]", (e && (e.code || e.message)) || e); } catch (_) {}
  const code = (e && e.code) || "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request")
    return "Sign-in window was closed — try again.";
  if (code === "auth/popup-blocked")
    return "Your browser blocked the sign-in popup — allow it and retry.";
  if (code.indexOf("auth/") === 0) return "Sign-in didn't work — try again.";
  if (code === "permission-denied") return "Couldn't save that — check your connection and retry.";
  if (code === "unavailable" || code === "deadline-exceeded" || code === "failed-precondition")
    return "You're offline — it'll sync when you reconnect.";
  if (code === "unauthenticated") return "Your session expired — sign in again.";
  return fallback || "Something hiccuped — try again.";
}
function noteHTML(area) {
  const m = Duo.notes[area];
  return `<div class="duo-msg" id="duo-msg-${area}"${m ? "" : ' style="display:none"'}>${esc(m || "")}</div>`;
}

function memberCard(uid, m, hist) {
  const r = rankFor((hist && hist.rr && hist.rr[uid]) || 0);
  const st = (hist && hist.streak && hist.streak[uid]) || 0;
  const on = isOnline(m);
  const presence = on
    ? '<span style="color:#1a7f37">● online now</span>'
    : "○ last seen " + timeAgo(m && m.lastActive);
  return `<div class="duo-member">` +
    (m && m.photo ? `<img src="${esc(m.photo)}" alt="">` : `<span class="av">?</span>`) +
    `<div><b>${esc((m && (m.nickname || "Player")) || "…")}</b>` +
    `<div class="duo-sub">${presence} · 🔥 ${st}-day streak</div></div>` +
    `<div class="duo-rank">${badgeSVG(r.rank, r.tier, 40)}<div>${esc(r.rank)}${r.tier ? " " + r.tier : ""}<br><span class="duo-sub">${r.rr} RR</span></div></div></div>`;
}

async function renderPanel() {
  const box = $("duo-body");
  if (!box) return;
  if (!ONLINE) {
    box.innerHTML = `<p class="duo-note">Online mode isn't set up in this copy of the app yet. Solo practice works as usual.</p>`;
    return;
  }
  if (!Duo.user) {
    box.innerHTML = `<p class="duo-note">Sign in with Google to sync progress across devices and play daily challenges with your friend.</p>
      <div class="mrow"><button class="btn-blue" id="duo-signin">Sign in with Google</button></div>
      <div class="duo-msg" id="duo-msg-auth" style="display:none"></div>`;
    const b = $("duo-signin");
    if (b) b.onclick = () => signIn().catch(() => {});
    return;
  }
  const hist = Duo.duo ? await Duo.refreshHistory().catch(() => Duo.histCache) : Duo.histCache;
  const me = Duo.user.uid, fr = Duo.friendUid;
  const myR = rankFor((hist.rr && hist.rr[me]) || 0);
  const frR = fr ? rankFor((hist.rr && hist.rr[fr]) || 0) : null;
  const gap = frR ? (frR.rr - myR.rr) : 0;

  let h = `<div class="duo-me">${memberCard(me, { nickname: Duo.user.name, photo: Duo.user.photo, lastActive: Date.now() }, { rr: { [me]: myR.rr }, streak: { [me]: (hist.streak || {})[me] || 0 } })}` +
    `<div class="mrow"><button class="btn-ghost" id="duo-signout">Sign out (${esc(Duo.user.name)})</button></div></div>`;

  if (!Duo.duo) {
    // ── pairing view: invite by Gmail, no codes ──
    h += `<h3>Pair with your friend</h3>
      <p class="duo-note">One duo, two players — no codes. Send an invite to their Gmail; it slides in on their screen with a Join button.</p>
      <div class="duo-join"><input type="text" id="duo-email" placeholder="friend@gmail.com" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn-blue" id="duo-send">Invite</button></div>
      ${noteHTML("invite")}`;
    if (Duo.outbox) {
      const o = Duo.outbox;
      h += `<p class="duo-note">Invite to <b>${esc(o.toEmail || "")}</b>: ` +
        (o.status === "pending" ? "waiting for them to join…" :
         o.status === "declined" ? "declined — send again below." : esc(o.status || "")) + `</p>` +
        (o.status === "accepted"
          ? ``
          : `<div class="mrow"><button class="btn-ghost" id="duo-cancel">Cancel invite</button></div>`);
    }
    if (Duo.inbox && Duo.inbox.status === "pending") {
      const iv = Duo.inbox;
      h += `<h3>Incoming invite</h3><div class="duo-member">` +
        (iv.fromPhoto ? `<img src="${esc(iv.fromPhoto)}" alt="">` : `<span class="av">?</span>`) +
        `<div><b>${esc(iv.fromName || "Someone")}</b> invited you to Duo!</div></div>` +
        `<div class="mrow"><button class="btn-blue" id="duo-accept">Join</button>` +
        `<button class="btn-ghost" id="duo-decline">Decline</button></div>`;
    }
  } else {
    const m = Duo.duo.members || {};
    h += `<h3>Your duo</h3>`;
    for (const uid of Object.keys(m)) h += memberCard(uid, m[uid], hist);
    if (fr) h += `<div class="mrow"><button class="btn-ghost" id="duo-nudge">🔔 Nudge friend</button></div>`;
    if (frR) {
      h += `<p class="duo-gap">${gap === 0 ? "Dead even. ⚔️" : gap > 0
        ? `You're <b>${gap} RR</b> behind — catch up!`
        : `You're <b>${-gap} RR</b> ahead — hold it!`}</p>`;
    } else {
      h += `<p class="duo-note">Your friend hasn't opened the app yet — the Nudge button above will ping them.</p>`;
    }
    // today
    const p = Duo.prog, fp = Duo.friendProg;
    const mine = p ? Object.keys(p.answers || {}).length : 0;
    const theirs = fp ? Object.keys(fp.answers || {}).length : 0;
    const myRes = resultOf(p), frRes = resultOf(fp);
    h += `<h3>Today (${esc(Duo.dayKey || hebronDayKey())})</h3>`;
    if (!p) {
      h += `<div class="mrow"><button class="btn-blue" id="duo-today">Get today's set</button></div>`;
    } else {
      h += `<p>You: <b>${mine}/${CHALLENGE_SIZE}</b>${myRes ? ` — ${myRes.score}/${myRes.total} (+${myRes.gain} RR) ✅` : ""}` +
        (fr ? `<br>Friend: <b>${theirs}/${CHALLENGE_SIZE}</b>${frRes ? ` — ${frRes.score}/${frRes.total} (+${frRes.gain} RR) ✅` : ""}` : "") + `</p>`;
      h += `<div class="mrow">` +
        (!Duo.challengeOn ? `<button class="btn-blue" id="duo-start">${p.sealed ? "Review set" : "Start / resume"}</button>` : `<button class="btn-ghost" id="duo-exit">Exit challenge</button>`) +
        (myRes && frRes ? `<button class="btn-ghost" id="duo-compare">Compare</button>` : ``) +
        `</div>`;
    }
    h += noteHTML("today");
    // history
    if (hist.rows && hist.rows.length) {
      h += `<h3>Recent days</h3><div class="duo-hist">`;
      for (const r of hist.rows.slice(0, 14)) {
        const ms = r.score[me], fs = fr && r.score[fr];
        h += `<div class="duo-hrow"><span>${esc(r.day)}</span><span>you ${ms ? `${ms.score}/${ms.total} (+${ms.gain})` : "—"}</span><span>${fr ? `friend ${fs ? `${fs.score}/${fs.total} (+${fs.gain})` : "—"}` : ""}</span></div>`;
      }
      h += `</div>`;
    }
    h += `<div class="mrow"><button class="btn-ghost" id="duo-unpair">Unpair</button></div>`;
  }
  h += noteHTML("duo");
  h += `<p class="duo-note" style="text-align:center;opacity:.65">duo build ${esc(Duo.BUILD || "?")}</p>`;
  box.innerHTML = h;
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on("duo-signout", () => signOut());
  on("duo-send", () => { const i = $("duo-email"); Duo.sendInvite(i ? i.value : "").catch(() => {}); });
  on("duo-cancel", () => Duo.cancelInvite());
  on("duo-accept", () => Duo.acceptInvite().catch(() => {}));
  on("duo-decline", () => Duo.declineInvite());
  on("duo-nudge", () => Duo.nudge());
  on("duo-today", () => openToday());
  on("duo-start", () => Duo.startChallenge());
  on("duo-exit", () => Duo.exitChallenge());
  on("duo-unpair", () => Duo.unpair());
  on("duo-compare", () => showCompare());
  const em = $("duo-email");
  if (em) em.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); Duo.sendInvite(em.value).catch(() => {}); }
  });
}

function progLine(prog) {
  if (!prog) return "—";
  const n = Object.keys(prog.answers || {}).length;
  const r = resultOf(prog);
  return `${n}/${CHALLENGE_SIZE}` + (r ? ` · ${r.score}/${r.total} (+${r.gain} RR)` : "");
}

function updateChallengeUI() {
  const pill = $("challpill");
  if (pill) {
    if (Duo.challengeOn && Duo.prog) {
      const mine = Object.keys(Duo.prog.answers || {}).length;
      const theirs = Duo.friendProg ? Object.keys(Duo.friendProg.answers || {}).length : null;
      pill.style.display = "";
      pill.textContent = `DUO ${mine}/${CHALLENGE_SIZE}` + (theirs === null ? "" : ` · friend ${theirs}/${CHALLENGE_SIZE}`);
    } else pill.style.display = "none";
  }
  maybeSeal().then(() => {
    const r = resultOf(Duo.prog);
    if (r && Duo.challengeOn && Duo.user) {
      // completion notice once per seal
      if (!updateChallengeUI._celebrated) {
        updateChallengeUI._celebrated = true;
        say("today", `Done! ${r.score}/${r.total} — +${r.gain} RR ${r.score === r.total ? "🏆 perfect!" : ""}`);
        const fx = (typeof window !== "undefined") && window.FX;
        if (fx) {
          const perfect = r.score === r.total;
          fx.burst(perfect ? "perfect" : "seal");
          fx.sound("seal");
          // Rank-up check: histCache still holds PRE-seal totals here (the
          // rescan happens in renderPanel afterwards), so new = old + gain.
          const old = (Duo.histCache && Duo.histCache.scanned)
            ? (((Duo.histCache.rr || {})[Duo.user.uid]) || 0) : null;
          if (old !== null) {
            const before = rankFor(old), after = rankFor(old + r.gain);
            const up = after.rank !== before.rank || ((after.tier || 0) > (before.tier || 0));
            if (up) {
              setTimeout(() => {
                try {
                  fx.rankUp(after.rank, after.tier,
                    `+${r.gain} RR · ${old + r.gain} total`,
                    badgeSVG(after.rank, after.tier, 76),
                    [RANK_COLORS[after.rank] || "#e9b949", "#ffffff", "#e9b949"]);
                } catch (e) {}
              }, 1000);
            }
          }
        }
      }
    } else if (!r) updateChallengeUI._celebrated = false;
  }).catch(() => {});
  const b = App() && App().banner;
  if (b) b(Duo.challengeOn && Duo.prog
    ? `DUO DAILY CHALLENGE — ${progLine(Duo.prog)}` + (Duo.friendUid ? ` · friend ${progLine(Duo.friendProg)}` : "")
    : null);
}

// Compare modal: per-question picks for both sealed sets.
function showCompare() {
  const ov = $("ov-compare"), grid = $("comparegrid");
  if (!ov || !grid) return;
  const p = Duo.prog, fp = Duo.friendProg;
  if (!resultOf(p) || !resultOf(fp)) return;
  let h = "";
  (p.qids || []).forEach((qid, i) => {
    const a = (p.answers || {})[qid] || {}, b = (fp.answers || {})[qid] || {};
    const e = Duo.byId[qid];
    const okM = a.ok ? "✓" : "✗", okF = b.ok ? "✓" : "✗";
    h += `<button class="sr-row" data-q="${esc(qid)}"><span class="n">${i + 1}</span>` +
      `<span class="snip">you <b>${esc(a.ans || "—")}</b> ${okM} · friend <b>${esc(b.ans || "—")}</b> ${okF} · correct <b>${esc(e ? e.correct : "?")}</b>` +
      `<br><span class="tag">${esc(e ? (e.skill || e.domain || "") : "")}</span></span></button>`;
  });
  grid.innerHTML = h || "<p>No overlap.</p>";
  ov.classList.add("open");
  grid.onclick = (ev) => {
    const r = ev.target.closest("[data-q]");
    if (!r || !App().jumpToQid) return;
    ov.classList.remove("open");
    App().jumpToQid(r.dataset.q);
  };
}

// ════════════════ BOOT ════════════════
Duo.init = async function (db) {
  Duo.db = db || [];
  Duo.byId = {};
  Duo.db.forEach(e => { if (e && e.id) Duo.byId[e.id] = e; });
  const ab = $("authbtn"), chip = $("authchip"), dbtn = $("duobtn");
  if (ab) ab.onclick = () => signIn().catch(() => {});
  if (chip) chip.onclick = () => { const o = $("ov-duo"); if (o) { o.classList.add("open"); renderPanel(); } };
  if (dbtn) dbtn.onclick = () => { const o = $("ov-duo"); if (o) { o.classList.add("open"); renderPanel(); } };
  const dc = $("duoclose");
  if (dc) dc.onclick = () => $("ov-duo").classList.remove("open");
  const cc = $("compareclose");
  if (cc) cc.onclick = () => $("ov-compare").classList.remove("open");
  setSync(ONLINE ? "off" : "off");
  const pill = $("syncpill");
  if (pill && !ONLINE) { pill.className = "syncpill off"; pill.textContent = "Local only"; }
  if (!ONLINE) { renderPanel(); return; }
  watchAuth();
  // presence ticker: refresh "online / last seen" while the panel is open
  setInterval(() => {
    const o = $("ov-duo");
    if (o && o.classList.contains("open")) renderPanel();
  }, 30000);
  window.addEventListener("beforeunload", () => { pushMeta(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pushMeta(); });
};
