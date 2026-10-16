// CLI: merge a duplicate node into the one that stays (issue #69). Operator-only.
//
//   npm run node:merge -- --from "practitioner:williamapan" --into "practitioner:william mapan" \
//     --reason "same person (#69)" [--by operator] [--dry-run]
//
// Moves the duplicate's live relations (each keeps its source, contributor,
// confidence and event time; the old one is superseded, never deleted),
// copies metadata the kept node lacks (never overwrites; before-image kept),
// moves its external identities (node_aliases) so a later import resolves to
// the kept node, retires it with metadata.merged_into, and makes its address
// 301 to the kept node. One api_admin signal anchors it (mergeNodes in
// src/utils/admin-actions.ts). Refuses a claimed duplicate.
//
// On Fly: `flyctl ssh console --app adai-basel -C
//   "node /app/dist/cli/merge-nodes.js --from '…' --into '…' --reason '…' --dry-run"`

import { initDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { mergeNodes, AdminActionError } from "../utils/admin-actions.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}

function main(): void {
  const from = arg("from");
  const into = arg("into");
  const reason = arg("reason");
  const by = arg("by") || "operator";
  const dryRun = process.argv.includes("--dry-run");
  if (!from || !into || !reason) {
    console.error('Usage: npm run node:merge -- --from <node id> --into <node id> --reason "…" [--by operator] [--dry-run]');
    process.exit(2);
  }
  const dbPath = resolveCliDbPath();
  const db = initDb(dbPath);
  console.error(`[merge] using DB ${dbPath}`);
  const r = mergeNodes(db, from, into, { reason, by, dryRun });
  console.log(JSON.stringify(r, null, 2));
  console.error(
    `[merge] ${from} → ${into}: ${r.edges_moved.length} relation(s) moved, ${r.edges_ended.length} ended, ` +
    `${r.keys_copied.length} key(s) copied, ${r.keys_kept.length} kept as they were, ${r.aliases_moved.length} alias(es) moved` +
    (r.pending_mentions ? `, ${r.pending_mentions} pending review item(s) name the duplicate` : "") +
    (dryRun ? " (dry run, nothing written)" : ` — admin signal ${r.admin_signal_id}`)
  );
}

try {
  main();
} catch (e) {
  console.error(`[merge] ${e instanceof AdminActionError ? `${e.code}: ` : ""}${(e as Error).message}`);
  process.exit(1);
}
