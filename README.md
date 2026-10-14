# My SAT practice
Two-player study app. No login, no passwords — identity is just a typed name.
Question bank + rendering live in `index.html` / `sat_db.json`; all progress,
presence and challenges live on the remote sync layer (`net.js`).

## Files
- `index.html` — the whole app (exam UI + all overlays + sounds)
- `net.js` — online layer: presence, attempts, history, 1v1 challenges
- `sync-config.js` — ★ paste your remote sync project values here
- `firestore.rules` equivalent → `server.rules` — minimal rules for a private group. Publish these.
- `sat_db.json` + `fig/` — question bank + figure images. Deploy alongside.

Deploy all of these together (Firebase Hosting, Netlify, any static host).
Open the app over `http(s)://` — not `file://` (browser modules won't load).

## Remote sync setup (fresh project, ~5 minutes)
1. Create a project at your cloud provider's console and add a web app.
2. Provision a database — collections are created automatically on first write.
3. Copy the web config (apiKey, authDomain, projectId, appId).
4. Paste those four values into `sync-config.js`.
5. Publish the contents of `server.rules` to your database rules tab.
6. Done — no Auth, no Functions, no indexes needed.

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
