// CLI: rename a contributor everywhere their name is written. Operator-only.
//
//   npm run contributor:rename -- --from "Irina" --to "aiio"
//   npm run contributor:rename -- --from "Irina" --to "aiio" --dry-run
//
// The contributor row's id is a random `contributor-<hex>` and never changes —
// tokens (keyed by contributor_id) keep working untouched. What DOES carry the
// name, and what this rewrites:
//
//   contributors.name            — the display / lookup name (token mint,
//                                  restore, and list all match on it)
//   signals.submitted_by         — attribution on every contributed signal
//   intake_queue.submitted_by    — review-queue attribution (also what the
//                                  /api/v1/contributions history matches on)
//   edges.created_by             — 'api-<name>' on live-written edges and
//                                  'curator-from-<name>' on curator-approved ones
//   nodes.updated_by             — same two prefixes for node create/patch
//
// Edge IDs that embed the old name (…--api-<old>) are left alone: they're
// opaque primary keys, and rewriting PKs on a CRR is exactly the kind of
// clever that breaks sync. Future edges pick up the new name automatically.
//
// After renaming on prod, update `.tokens.json` (the operator-side restore
// file keys entries by contributor name) or the next `just restore-tokens`
// will refuse with token_belongs_to_other_contributor.
//
// The rename itself is recorded: one admin signal (source_type='api_admin',
// submitted_by=--by, default "operator") holding the contributor id, both
// names and the row counts rewritten, so the old name stays answerable.
//
// Guards: refuses when --from doesn't exist, and when --to already names a
// DIFFERENT contributor (this is a rename, not a merge). Idempotent: re-running
// after success hits the "no such contributor" guard, which is correct.
//
// On Fly: `flyctl ssh console --app adai-basel -C
//   "node /app/dist/cli/rename-contributor.js --from 'Irina' --to 'aiio'"`
// (db path auto-resolves to /data/adai.db via src/utils/db-path.ts).

import { initDb, getDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { ownedBySql } from "../utils/authorship.js";
import { insertAdminSignal } from "../utils/admin-actions.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const from = typeof args.from === "string" ? args.from.trim() : null;
  const to = typeof args.to === "string" ? args.to.trim() : null;
  const dryRun = args["dry-run"] === true;
  const by = typeof args.by === "string" ? args.by.trim() : "operator";

  if (!from || !to) {
    console.error('Usage: npm run contributor:rename -- --from "<old name>" --to "<new name>" [--by "<operator>"] [--dry-run]');
    process.exit(2);
  }
  if (from === to) {
    console.error("Error: --from and --to are identical; nothing to do.");
    process.exit(2);
  }

  const dbPath = resolveCliDbPath();
  console.error(`[contributor:rename] using DB ${dbPath}`);
  initDb(dbPath);
  const db = getDb();

  const fromRow = db.prepare("SELECT id, name, trust_tier FROM contributors WHERE name = ? AND type IS NOT 'form'").get(from) as any;
  if (!fromRow) {
    console.error(`Error: no contributor named "${from}".`);
    process.exit(1);
  }
  const toRow = db.prepare("SELECT id FROM contributors WHERE name = ? AND type IS NOT 'form'").get(to) as any;
  if (toRow && toRow.id !== fromRow.id) {
    console.error(`Error: "${to}" already names a different contributor (${toRow.id}). This is a rename, not a merge — refusing.`);
    process.exit(1);
  }

  const apiOld = `api-${from}`;
  const apiNew = `api-${to}`;
  const curatorOld = `curator-from-${from}`;
  const curatorNew = `curator-from-${to}`;

  // Only what is provably this contributor's (src/utils/authorship.ts): a
  // public-form submission that typed the same name, and its form row, keep
  // the name they were given.
  const owned = new Set((db.prepare(`SELECT s.id FROM signals s WHERE ${ownedBySql("s")}`).all({ owner_id: fromRow.id, owner_name: from }) as any[]).map((r) => String(r.id)));
  const ownedSignals = (db.prepare("SELECT id FROM signals WHERE submitted_by = ?").all(from) as any[]).filter((r) => owned.has(r.id)).map((r) => r.id as string);
  const ownedPrivate = (db.prepare("SELECT signal_id FROM signal_private WHERE submitted_by = ?").all(from) as any[]).filter((r) => owned.has(r.signal_id)).map((r) => r.signal_id as string);
  const ownedQueue = (db.prepare("SELECT id, signal_id FROM intake_queue WHERE submitted_by = ?").all(from) as any[])
    .filter((r) => (r.signal_id ? owned.has(r.signal_id) : !!db.prepare("SELECT 1 FROM node_claims WHERE queue_id = ? AND contributor_id = ?").get(r.id, fromRow.id)))
    .map((r) => r.id as string);
  const counts = {
    signals: ownedSignals.length,
    intake: ownedQueue.length,
    edges_api: (db.prepare("SELECT COUNT(*) AS n FROM edges WHERE created_by = ?").get(apiOld) as any).n,
    edges_curator: (db.prepare("SELECT COUNT(*) AS n FROM edges WHERE created_by = ?").get(curatorOld) as any).n,
    nodes_api: (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE updated_by = ?").get(apiOld) as any).n,
    nodes_curator: (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE updated_by = ?").get(curatorOld) as any).n,
  };

  console.error(`Renaming contributor ${fromRow.id}: "${from}" → "${to}" (trust_tier=${fromRow.trust_tier})`);
  console.error(`  signals.submitted_by:      ${counts.signals}`);
  console.error(`  intake_queue.submitted_by: ${counts.intake}`);
  console.error(`  edges.created_by:          ${counts.edges_api} (api) + ${counts.edges_curator} (curator-from)`);
  console.error(`  nodes.updated_by:          ${counts.nodes_api} (api) + ${counts.nodes_curator} (curator-from)`);

  if (dryRun) {
    console.error("--dry-run: no changes written.");
    return;
  }

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE contributors SET name = ? WHERE id = ?").run(to, fromRow.id);
    const setSig = db.prepare("UPDATE signals SET submitted_by = ? WHERE id = ? AND submitted_by = ?");
    for (const id of ownedSignals) setSig.run(to, id, from);
    // an anonymous signal's real author (local, never in the CRR)
    const setPriv = db.prepare("UPDATE signal_private SET submitted_by = ? WHERE signal_id = ? AND submitted_by = ?");
    for (const id of ownedPrivate) setPriv.run(to, id, from);
    const setQ = db.prepare("UPDATE intake_queue SET submitted_by = ? WHERE id = ? AND submitted_by = ?");
    for (const id of ownedQueue) setQ.run(to, id, from);
    db.prepare("UPDATE edges SET created_by = ? WHERE created_by = ?").run(apiNew, apiOld);
    db.prepare("UPDATE edges SET created_by = ? WHERE created_by = ?").run(curatorNew, curatorOld);
    db.prepare("UPDATE nodes SET updated_by = ? WHERE updated_by = ?").run(apiNew, apiOld);
    db.prepare("UPDATE nodes SET updated_by = ? WHERE updated_by = ?").run(curatorNew, curatorOld);
    // After the rewrite, so an operator renaming themselves keeps --by as given.
    insertAdminSignal(db, {
      by,
      title: `Rename contributor: ${from} → ${to}`,
      content: { action: "rename_contributor", contributor_id: fromRow.id, from, to, rewritten: counts },
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  console.error(`Done. "${to}" is the contributor's name everywhere; tokens were untouched (keyed by id).`);
  console.error(`Reminder: update .tokens.json ("${from}" → "${to}") so 'just restore-tokens' keeps matching.`);
}

main();
