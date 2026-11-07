// Backend config — VPS (Node + Express + Postgres + Socket.IO).
// - url: your VPS origin over HTTPS, e.g. "https://51-84-109-28.sslip.io"
//   (sslip.io resolves to the VPS IP; certbot issues a real cert — no domain
//   purchase needed). Plain http://IP and ws:// are BLOCKED by browsers on
//   HTTPS pages (mixed content), so TLS on the VPS is required for direct mode.
// Overrides (no redeploy needed for testing):
// - ?backendUrl=http://localhost:3001 (or localStorage.satbank_backend_url)
//   overrides the url below — handy for local testing without editing this file.
window.SATBANK_BACKEND = {
  url: "https://51-84-109-28.sslip.io",
  enabled: true, // legacy cutover flag; the backend layer is always on
};
