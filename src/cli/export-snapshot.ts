// CLI: write the public snapshot of the commons (issue #82, src/snapshot/build.ts)
// — a plain SQLite file with the five public tables, consent applied.
//
//   npm run snapshot:export -- --out ./adai-snapshot.sqlite [--jsonl ./adai-snapshot-jsonl]
//
// On the Fly machine (the nightly publish workflow, .github/workflows/
// snapshot-publish.yml, which is dispatch-only for now):
//   flyctl ssh console --app adai-basel -C "node /app/dist/cli/export-snapshot.js --out /tmp/adai-snapshot.sqlite"
//
// The source is resolved like every CLI (DB_PATH → /data/adai.db → ./adai.db)
// and only read. Exit codes: 0 written · 1 failure.

import { initDb, getDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { buildSnapshot } from "../snapshot/build.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

try {
  const out = arg("out") ?? "adai-snapshot.sqlite";
  const dbPath = resolveCliDbPath();
  console.error(`[snapshot] reading ${dbPath}`);
  initDb(dbPath);
  const r = buildSnapshot(getDb(), out, {
    jsonlDir: arg("jsonl"),
    source: process.env.ADAI_BASE_URL || "https://adai-basel.fly.dev/",
  });
  console.error(`[snapshot] wrote ${r.path}: ${Object.entries(r.counts).map(([t, n]) => `${t} ${n}`).join(", ")}; ` +
    `left out ${r.dropped.signals} non-public signal(s), ${r.dropped.contributors} contributor(s) never public`);
} catch (e) {
  console.error(`[snapshot] failed: ${(e as Error).message}`);
  process.exit(1);
}
