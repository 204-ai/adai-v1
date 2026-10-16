// CLI: keep a draft's undecided cards open for others (issue #77), for a
// draft submitted before Confirm did that itself. Operator-only.
//
//   npm run intake:backfill-open -- --draft drf_… [--dry-run]
//
// The items are worked out exactly as Confirm works them out (leftOpen) and
// dated to the draft's submit. Idempotent: an item already kept is left alone.
//
// On Fly: `flyctl ssh console --app adai-basel -C
//   "node /app/dist/cli/backfill-open-items.js --draft drf_…"`

import { initDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { backfillOpenItems } from "../intake/draft.js";
import { openItemsOf } from "../intake/open-items.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}

function main(): void {
  const draftId = arg("draft");
  const dryRun = process.argv.includes("--dry-run");
  if (!draftId) {
    console.error("Usage: npm run intake:backfill-open -- --draft drf_… [--dry-run]");
    process.exit(2);
  }
  const dbPath = resolveCliDbPath();
  const db = initDb(dbPath);
  console.error(`[backfill-open] using DB ${dbPath}`);
  const before = openItemsOf(db, draftId).length;
  const rows = backfillOpenItems(db, draftId, { dryRun });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[`${r.kind}/${r.reason}`] = (counts[`${r.kind}/${r.reason}`] ?? 0) + 1;
  for (const r of rows) console.log(`${r.cid}\t${r.kind}\t${r.reason}\t${r.label}`);
  const after = dryRun ? before : openItemsOf(db, draftId).length;
  console.error(`[backfill-open] ${draftId}: ${rows.length} open (${JSON.stringify(counts)}); items kept ${before} → ${after}${dryRun ? " (dry run, nothing written)" : ""}`);
}

try {
  main();
} catch (e) {
  console.error(`[backfill-open] ${(e as Error).message}`);
  process.exit(1);
}
