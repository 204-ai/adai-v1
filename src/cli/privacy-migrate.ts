// CLI: bring an existing database to the public-sync rule — the CRR tables
// hold only what the commons publishes (src/utils/signal-private.ts).
// Operator-only. Idempotent: a second run finds nothing.
//
//   npm run privacy:migrate -- --dry-run      # what would move, nothing written
//   npm run privacy:migrate                   # move it (one transaction)
//
// What moves, original first into the LOCAL tables (verified), then the CRR
// cell is blanked by an UPDATE — so cr-sqlite records the change and every
// fork loses the value on its next pull:
//   - before-images in processing_trace.prior → signal_priors
//   - structural_only and revoked signals' words → signal_private
//   - anonymous signals' submitted_by / batch_id / provenance → signal_private
//   - admin records carrying before-images (retire_batch) → signal_private
//   - rejected contributions, contributions still in review (published when
//     approved) and never-published notes / objections' words → signal_private
//
// On Fly: `flyctl ssh console --app adai-basel -C "node /app/dist/cli/privacy-migrate.js --dry-run"`

import { initDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { migratePrivacy, privacyBacklog } from "../utils/signal-private.js";

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const json = process.argv.includes("--json");
  const dbPath = resolveCliDbPath();
  const db = initDb(dbPath);
  console.error(`[privacy] using DB ${dbPath}`);
  const before = privacyBacklog(db);
  console.error(`[privacy] backlog: ${JSON.stringify(before)}`);
  const r = migratePrivacy(db, { dryRun });
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const id of r.priors.ids) console.log(`priors\t${id}`);
    for (const x of r.words.ids) console.log(`words\t${x.id}\t${x.reason}\t${x.cols.join(",")}`);
    for (const id of r.anonymous.ids) console.log(`anonymous\t${id}`);
    for (const id of r.admin_before_images.ids) console.log(`admin_before_images\t${id}`);
    for (const x of r.notes.ids) console.log(`notes\t${x.id}\t${x.reason}`);
    for (const id of r.rejected.ids) console.log(`rejected\t${id}`);
    for (const id of r.pending.ids) console.log(`pending\t${id}`);
    for (const id of r.private_batches.ids) console.log(`private_batch\t${id}`);
    for (const id of r.anonymous_graph) console.log(`ANONYMOUS_GRAPH (not moved — clean by hand)\t${id}`);
  }
  console.error(
    `[privacy] ${r.priors.signals} signals / ${r.priors.entries} before-images, ${r.words.signals} withheld words, ` +
      `${r.anonymous.signals} anonymous, ${r.admin_before_images.signals} admin records, ${r.notes.signals} notes, ${r.rejected.signals} rejected, ${r.pending.signals} pending review, ${r.private_batches.signals} private batch records` +
      (dryRun ? " (dry run, nothing written)" : ` — moved; left: ${JSON.stringify(r.left)}`)
  );
  if (r.legacy_anonymous_blocks) {
    console.error(`[privacy] ⚠️ ${r.legacy_anonymous_blocks} legacy anonymous contribution(s) recorded as privacy blocks: /api/sync stays closed until ` +
      "`npm run privacy:audit-stream -- --clear` finds nothing of their authors in the change stream (docs/PUBLIC-SYNC.md).");
    process.exitCode = 3;
  }
  if (r.anonymous_graph.length) {
    console.error(`[privacy] ⚠️ ${r.anonymous_graph.length} rows still attribute anonymous contributions to their author (legacy edges.created_by / edge ids / nodes.updated_by). ` +
      "The migration does not rewrite them; /api/sync stays closed until they are cleaned by hand (docs/PUBLIC-SYNC.md).");
    process.exitCode = 3;
  }
}

try {
  main();
} catch (e) {
  console.error(`[privacy] ${(e as Error).message}`);
  process.exit(1);
}
