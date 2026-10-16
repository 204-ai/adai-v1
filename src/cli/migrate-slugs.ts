// CLI: rewrite the slugs that predate the current slugifier (issue #67).
// Operator-only.
//
//   npm run slugs:migrate -- --dry-run          # the list, old → new
//   npm run slugs:migrate -- [--by operator] [--only <node id> …]
//
// Every slug with a character outside [a-z0-9-] gets slugify(name), its
// source suffix (`--fxhash-113`, `--va-o239531`) kept. Node ids never change;
// the old address 301s to the new one (node_aliases source='slug',
// src/utils/moved.ts). A new slug another node of the same type already has
// is left alone and listed. One api_admin signal anchors the run, with each
// old slug as a before-image (migrateSlugs in src/utils/admin-actions.ts).
//
// On Fly: `flyctl ssh console --app adai-basel -C "node /app/dist/cli/migrate-slugs.js --dry-run"`

import { initDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { migrateSlugs } from "../utils/admin-actions.js";

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const byAt = process.argv.indexOf("--by");
  const by = byAt >= 0 && process.argv[byAt + 1] && !process.argv[byAt + 1]!.startsWith("--") ? process.argv[byAt + 1]! : "operator";
  const onlyAt = process.argv.indexOf("--only");
  let only: string[] | undefined;
  if (onlyAt >= 0) {
    const rest = process.argv.slice(onlyAt + 1);
    const end = rest.findIndex((a) => a.startsWith("--"));
    only = end < 0 ? rest : rest.slice(0, end);
  }
  const dbPath = resolveCliDbPath();
  const db = initDb(dbPath);
  console.error(`[slugs] using DB ${dbPath}`);
  const r = migrateSlugs(db, { by, dryRun, only });
  for (const x of r.renamed) console.log(`${x.type}\t${x.old}\t→ ${x.new}`);
  for (const x of r.collisions) console.log(`${x.type}\t${x.old}\t✗ ${x.new} is taken by ${x.taken_by}`);
  console.error(`[slugs] ${r.renamed.length} renamed, ${r.collisions.length} left (new slug taken)${dryRun ? " (dry run, nothing written)" : r.admin_signal_id ? ` — admin signal ${r.admin_signal_id}` : ""}`);
}

try {
  main();
} catch (e) {
  console.error(`[slugs] ${(e as Error).message}`);
  process.exit(1);
}
