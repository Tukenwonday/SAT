# SAT Practice — Online Setup (Firebase)

Two-player study app. No login, no passwords — identity is just a typed name.
Question bank + rendering live in `index.html` / `sat_db.json`; all progress,
presence and challenges live in Firestore (`net.js`).

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app (exam UI + all overlays + sounds). |
| `net.js` | Online layer: presence, attempts, history, 1v1 challenges. |
| `firebase-config.js` | ★ **Paste your Firebase web config here** (see step 4). |
| `firestore.rules` | Minimal rules for a private group (no Auth). Publish these. |
| `sat_db.json` + `fig/` | Question bank + figure images. Deploy alongside. |

Deploy all of these together (Firebase Hosting, Netlify, any static host).
Open the app over `http(s)://` — not `file://` (browser modules won't load).

## Firebase setup (fresh project, ~5 minutes)

1. **Create the project**
   - Go to https://console.firebase.google.com → *Add project*.
   - Name it anything (e.g. `sat-practice`). Disable Gemini/Analytics if offered.

2. **Create the database — pick Firestore**
   - Left menu → *Build → Firestore Database* → *Create database*.
   - If Firebase shows you a choice: **Firestore** ✅ — NOT *Realtime Database* ❌
     (the app's code only talks to Firestore; Realtime Database will not work).
   - Choose *Start in production mode*, pick the region closest to you.
   - Collections are created automatically on first write — nothing to pre-create.

3. **Register the web app + get the config**
   - Project *Overview* → `</>` *Add app* → nickname `web` → *Register app*.
   - Copy the `firebaseConfig` object (apiKey, authDomain, projectId, appId).

4. **Paste the config**
   - Open `firebase-config.js` and replace the four values with yours:
     ```js
     window.SATBANK_FIREBASE = {
       apiKey: "…",
       authDomain: "….firebaseapp.com",
       projectId: "…",
       appId: "1:…:web:…",
     };
     ```
   - These keys are public by design. Protection comes from the rules below.

5. **Publish the security rules**
   - Firestore → *Rules* tab → replace everything with the contents of
     `firestore.rules` → *Publish*.
   - These rules allow anyone with your config to read/write `status`,
     `attempts` and `sessions`. That is intentional for a private 2-person
     group — **do not share the URL publicly**, and do not reuse these rules
     for a public app.

6. **Done — no Auth, no Functions, no indexes needed.**
   - The app uses Firestore only. If it shows "offline", the config didn't
     load (check the file sits next to `index.html` and you redeployed).

## Daily use (2 players)

1. Each player types their name bottom-left → *Save*. That's the whole login.
2. Top bar shows one pill per player: `Name • Q# • N today`, live.
   Green pulsing dot = online (heartbeat every 12s); gray = closed or away
   (instant on tab close, 30s-stale backup for crashes).
3. Answers save to `attempts` instantly and restore on any device after
   entering the same name. 📊 *History* groups both players by day.
4. ⚔️ *Challenge*: pick opponent + 5/10/20 → friend gets a slide-in banner →
   *Accept* → 3-2-1 countdown → same questions, locked answers, reveal when
   both answer → winner screen. Every duel answer also counts in history.
5. *More → Reset all progress* wipes your whole profile: name, every answer,
   history and presence (cannot be undone).

## More than 2 players

Nothing extra to set up — the site adapts on its own:

- **Top bar:** one pill is rendered per `status/{name}` document, self first,
  then A–Z, wrapping as needed. A 3rd/4th name just appears.
- **Challenges:** the Challenge modal lists every other online player in the
  *Opponent* dropdown (default: most recently seen). Invites are addressed
  per-player (`guest == name`), so two duels can run side by side.
- **History:** one column per name ever seen in `attempts`, self first.
- **Rules:** unchanged — they already allow any named player.

Caveat: presence pills and history are built for a small group. Past ~8
regulars the top bar gets crowded and history reads get heavy — fine for
friends, not for a classroom.
