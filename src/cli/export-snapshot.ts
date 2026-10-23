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
// and opened READ-ONLY, without initDb: no schema or migration ever runs on
// it (CRR tables read fine without the cr-sqlite extension). The output is
// written to a temp file and renamed into place; it can never be the source.
// Exit codes: 0 written · 1 failure.

import { DatabaseSync } from "node:sqlite";
import { resolveCliDbPath } from "../utils/db-path.js";
import { buildSnapshot } from "../snapshot/build.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

try {
  const out = arg("out") ?? "adai-snapshot.sqlite";
  const dbPath = resolveCliDbPath();
  console.error(`[snapshot] reading ${dbPath} (read-only)`);
  const src = new DatabaseSync(dbPath, { readOnly: true });
  const r = buildSnapshot(src, out, {
    jsonlDir: arg("jsonl"),
    sourcePath: dbPath,
    source: process.env.ADAI_BASE_URL || "https://adai-basel.fly.dev/",
  });
  src.close();
  console.error(`[snapshot] wrote ${r.path}: ${Object.entries(r.counts).map(([t, n]) => `${t} ${n}`).join(", ")}; ` +
    `left out ${r.dropped.signals} non-public signal(s), ${r.dropped.contributors} contributor(s) never public, ` +
    `${r.dropped.metadata_keys} metadata value(s) outside the public projection, ${r.dropped.aliases} alias(es) not public or duplicates after cleaning`);
} catch (e) {
  console.error(`[snapshot] failed: ${(e as Error).message}`);
  process.exit(1);
}
