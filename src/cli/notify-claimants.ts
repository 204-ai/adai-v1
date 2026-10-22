// CLI: tell claimants what was added about their pages (issue #81).
//
// The daily pass: run by .github/workflows/notify-digest.yml against the
// live Fly volume, after the curator digest:
//   flyctl ssh console --app adai-basel -C "node /app/dist/cli/notify-claimants.js"
// (the server runs the `immediate` pass itself, src/index.ts).
//
// Local preview:
//   npm run notify:claimants -- --dry-run
//
// Flags:
//   --dry-run           find events and print the emails; send nothing, mark nothing
//                       delivered (found events are still recorded).
//   --immediate         only contributors whose setting is `immediate`.
//
// Any email that fails exits 1 (after the others were tried); transient
// failures are retried by later passes, up to MAX_ATTEMPTS per email. A
// batch whose first attempt is older than ~23 h and still unresolved is never
// resent automatically: it is counted "to reconcile by hand" (exit 1) —
// claimant_batches.state = 'reconcile'.
// Mail goes through src/utils/mail.ts: stdout without RESEND_API_KEY, and
// staging's mail switch decides who gets real mail there.
// Exit codes: 0 success · 1 failure (a run error, or any email not sent).

import fs from "node:fs";
import { initDb, getDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { runClaimantNotifications } from "../notify/claimants.js";

async function main(): Promise<void> {
  try {
    if (fs.existsSync(".env")) process.loadEnvFile();
  } catch {
    /* no .env — fine */
  }
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const mode = argv.includes("--immediate") ? "immediate" : "daily";

  const dbPath = resolveCliDbPath();
  console.error(`[notify:claimants] using DB ${dbPath}`);
  initDb(dbPath);
  const r = await runClaimantNotifications(getDb(), { mode, dryRun });
  if (dryRun) {
    for (const m of r.emails) console.log(`\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`);
  }
  console.error(
    `[notify:claimants] ${mode}${dryRun ? " (dry run)" : ""}: ${r.found} new event(s); ` +
      `${dryRun ? r.emails.length : r.sent} email(s), ${r.events} event(s) delivered, ${r.skipped} skipped, ` +
      `${r.suppressed} suppressed, ${r.failed} failed, ${r.reconcile} to reconcile by hand`
  );
  // A failed email, or one left for a person (an unresolved send older than
  // Resend's 24 h idempotency window: check Resend's log before resending).
  if (r.failed || r.reconcile) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[notify:claimants] failed: ${(e as Error).message}`);
  process.exit(1);
});
