// firebase-config.js — ★ PASTE YOUR FIREBASE CONFIG HERE ★
// 1. Go to Firebase console → your project → Project settings → "Your apps" (web </>).
// 2. Copy the firebaseConfig object and paste its fields below.
// Loaded before net.js. No login/Auth used — identity is just a typed name.
//
// These keys are PUBLIC by design (they ship in every Firebase web app).
// Security comes from firestore.rules, not from hiding these values.
window.SATBANK_SYNC = {
  apiKey: "AIzaSyB_Ojn_BfQ5O-ib6DjsAAVSEOvSqLjuzmM",
  authDomain: "sat-practice-47885.firebaseapp.com",
  projectId: "sat-practice-47885",
  appId: "1:754814873619:web:8bfc1a8f1317b19fd50fe6",
};

// VPS backend (Node + Express + Postgres + Socket.IO) — the USE_BACKEND flag.
// - url: your VPS origin, e.g. "https://sat.example.com". Empty = disabled.
// - enabled: set true at cutover. Kept in this file so rollback = flip + redeploy.
// Overrides (no redeploy needed for testing):
// - ?backend=1 forces VPS mode, ?backend=0 forces Firestore mode.
// - ?backendUrl=http://localhost:3001 (or localStorage.satbank_backend_url)
//   overrides the url below — handy for local testing without editing this file.
// - localStorage.satbank_backend = "1" / "0" does the same persistently.
// Parallel-run dual-write (answers also forwarded to Firestore, best effort):
// - localStorage.satbank_dualwrite = "1".
window.SATBANK_BACKEND = {
  url: "https://satbank.netlify.app",
  enabled: true,
};
