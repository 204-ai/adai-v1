// CLI: the operator's stream audit for legacy anonymous contributions
// (src/utils/privacy-blocks.ts). Scans what a fork would receive —
// crsql_changes, tombstones included — for each uncleared privacy block's
// author labels and author-bearing ids. Lists what it finds; with --clear,
// clears a block that has no finding (the only way one is cleared).
//
//   npm run privacy:audit-stream               # report (findings stored)
//   npm run privacy:audit-stream -- --clear    # clear the blocks with nothing found
//   npm run privacy:audit-stream -- --resolve <signal id> --reason "…" [--by <operator>]
//       # a block the audit cannot clear for want of evidence (no author label,
//       # no author-bearing id): the operator's explicit, logged decision.
//       # Refused while the audit finds anything concrete.
//
// Exit 0 when no block is left uncleared, 3 otherwise.
// On Fly: `flyctl ssh console --app adai-basel -C "node /app/dist/cli/privacy-audit-stream.js"`

import { initDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { auditPrivacyStream, resolvePrivacyBlock } from "../utils/privacy-blocks.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : null;
}

function main(): void {
  const clear = process.argv.includes("--clear");
  const dbPath = resolveCliDbPath();
  const db = initDb(dbPath);
  console.error(`[audit] using DB ${dbPath}`);
  const resolve = arg("--resolve");
  if (resolve) {
    resolvePrivacyBlock(db, resolve, { reason: arg("--reason") ?? "", by: arg("--by") ?? "operator" });
    console.error(`[audit] ${resolve}: resolved by decision (logged in privacy_blocks.resolution)`);
  }
  const results = auditPrivacyStream(db, { clear });
  for (const r of results) {
    console.log(`${r.signal_id}\t${r.cleared ? "CLEARED" : r.findings.length ? `${r.findings.length} finding(s)` : "clean (run with --clear)"}`);
    for (const f of r.findings) console.log(`  ${f}`);
  }
  const left = results.filter((r) => !r.cleared).length;
  console.error(`[audit] ${results.length} block(s) audited, ${results.filter((r) => r.cleared).length} cleared, ${left} left`);
  if (left) process.exitCode = 3;
}

try {
  main();
} catch (e) {
  console.error(`[audit] ${(e as Error).message}`);
  process.exit(1);
}
