// CLI: fork the commons — pull a source's public cr-sqlite change stream
// into a local database, or bring a fork up to date (src/sync/pull.ts).
//
//   npm run fork:pull -- --from https://adai-basel.fly.dev [--db ./fork.db] [--limit 5000] [--force]
//
// The first run creates the database with the app's own schema (initDb) and
// pulls everything (since=0); later runs pull only what changed. Then:
//   DB_PATH=./fork.db npm run dev
// Embeddings are not part of the stream: run `npm run embed:backfill` with
// your own key (and `embed:derive`) if you want the similarity layer.

import { initDb } from "../db.js";
import { pullFork } from "../sync/pull.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : null;
}

async function main(): Promise<void> {
  const from = arg("--from");
  if (!from || !/^https?:\/\//i.test(from)) {
    console.error("usage: npm run fork:pull -- --from <base url> [--db ./fork.db] [--limit N] [--force]");
    process.exit(2);
  }
  const dbPath = arg("--db") ?? "./fork.db";
  const limit = arg("--limit");
  const db = initDb(dbPath);
  console.error(`[fork] ${from} → ${dbPath}`);
  const t0 = Date.now();
  const r = await pullFork(db, {
    from,
    force: process.argv.includes("--force"),
    limit: limit ? Number(limit) : undefined,
    log: (l) => console.error(`[fork] ${l}`),
  });
  try { db.exec("SELECT crsql_finalize()"); } catch { /* older extension */ }
  db.close();
  console.error(`[fork] done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${r.changes} changes in ${r.pages} pages; cursor ${r.cursor} (source db_version ${r.source_db_version}, site ${r.source_site_id})`);
}

main().catch((e) => {
  console.error(`[fork] ${(e as Error).message}`);
  process.exit(1);
});
