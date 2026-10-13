// tools/seed_answerkey.mjs — ONE-TIME seed of the hidden answer key.
// The answerkey collection is unreadable by clients (see firestore.rules);
// rules use it only to verify submitted answers.
//
// Usage:
//   cd tools
//   npm install            (installs firebase-admin, dev machine only)
//   node seed_answerkey.mjs <serviceAccountKey.json> [--force]
//
// The service-account key stays on YOUR machine. Never commit it, never
// put it in the repo or the frontend. Delete it after seeding.
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const W = { Easy: 1, Medium: 2, Hard: 3 };

async function main() {
  const keyPath = process.argv[2];
  const force = process.argv.includes("--force");
  if (!keyPath || keyPath.startsWith("--")) {
    console.error("usage: node seed_answerkey.mjs <serviceAccountKey.json> [--force]");
    process.exit(2);
  }
  const db = JSON.parse(readFileSync(join(HERE, "..", "sat_db.json"), "utf8"));
  console.log(`loaded ${db.length} questions from sat_db.json`);

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(keyPath, "utf8"))) });
  const fs = admin.firestore();
  const col = fs.collection("answerkey");

  const probe = await col.limit(1).get();
  if (!probe.empty && !force) {
    console.error(`answerkey already has docs — aborting (pass --force to overwrite).`);
    process.exit(1);
  }

  const docs = [];
  for (const e of db) {
    if (!e.id || !/^[A-D]$/.test(e.correct)) {
      console.warn(`skip ${e.id || "?"}: bad correct value`);
      continue;
    }
    docs.push({ id: String(e.id).toLowerCase(), c: e.correct, w: W[e.difficulty] || 2 });
  }

  let n = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = fs.batch();
    for (const d of docs.slice(i, i + 400)) {
      batch.set(col.doc(d.id), { c: d.c, w: d.w });
    }
    await batch.commit();
    n += Math.min(400, docs.length - i);
    console.log(`wrote ${n}/${docs.length}`);
  }
  console.log(`done. Verify in Firebase console: answerkey count should be ${docs.length}.`);
  console.log("You can now delete the service-account key file.");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
