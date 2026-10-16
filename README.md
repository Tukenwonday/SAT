# My SAT practice
Two-player study app. No login, no passwords — identity is just a typed name.
Question bank + rendering live in `index.html` / `sat_db.json`; all progress,
presence and challenges live on the VPS backend (`backend.js` + `server/`).

## Files
- `index.html` — the whole app (exam UI + all overlays + sounds)
- `backend.js` — online layer: presence, attempts, history, 1v1 challenges, duel chat
- `sync-config.js` — ★ paste your VPS backend URL here
- `sat_db.json` + `fig/` — question bank + figure images. Deploy alongside.
- `server/` — Node + Express + Postgres + Socket.IO backend (see `server/README-DEPLOY.md`)
- `admin.html` — master admin dashboard (talks to the same backend API)

Deploy the static files together (Cloudflare Pages, any static host).
Open the app over `http(s)://` — not `file://` (browser modules won't load).

## Backend setup (VPS, ~15 minutes)
1. Provision the VPS (Node 20+, Postgres, nginx) per `server/README-DEPLOY.md`.
2. Point a hostname at it (a real domain, or free `sslip.io`) and issue a TLS
   cert with certbot — browsers block HTTPS pages from calling plain-HTTP APIs.
3. Set `window.SATBANK_BACKEND.url` in `sync-config.js` to the HTTPS origin.
4. Done — no Auth needed.

## Daily use (2 players)
1. Each player types their name bottom-left → Save. That's the whole login.
2. Top bar shows one pill per player: `Name • N today`, live.
3. Answers save instantly and restore on any device after entering the same name.
4. ⚔️ *Challenge*: pick opponent + 5/10/20 → friend gets a slide-in banner →
   Accept → 3-2-1 countdown → same questions, locked answers, reveal when
   both answer → winner screen.
5. *More → Reset all progress* wipes your whole profile.

## More than 2 players
Nothing extra to set up — the site adapts: one pill per player, invites are
addressed per-player, history shows one column per name. Caveat: presence
pills and history are built for a small group.
