// CLI: revoke a contributor bearer token by its prefix. Soft-delete only —
// the row stays in `contributor_tokens` with `revoked_at` set so the audit
// trail of last_used_at, label, and issued contributor survives.
//
//   npm run token:revoke -- --prefix adai_abc12345
//   npm run token:revoke -- --contributor "Casey Reas" --all
//
// Flags:
//   --prefix <prefix>      revoke the single token matching this prefix
//   --contributor <name>   restrict --all to tokens for this contributor
//   --all                  revoke every non-revoked token (scoped by --contributor
//                          if provided, otherwise GLOBAL — refused unless --force)
//   --force                allow global revoke
//
// Listing:
//   npm run token:revoke -- --list                  all active tokens
//   npm run token:revoke -- --list --contributor X  active tokens for X

import { initDb, getDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { listTokens, revokeTokenByPrefix, MintError } from "../utils/token-mint.js";

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

function printTokens(contributor: string | null): void {
  const db = getDb();
  const rows = listTokens(db, { contributorName: contributor });
  if (rows.length === 0) {
    console.error("No tokens.");
    return;
  }
  for (const r of rows) {
    const state = r.revoked_at ? `REVOKED ${r.revoked_at}` : "active";
    const lu = r.last_used_at ? `last_used=${r.last_used_at}` : "never used";
    const lab = r.label ? `label="${r.label}" ` : "";
    const sc = r.scope === "admin" ? "  [admin] " : " ";
    console.error(`  ${r.token_prefix}…  ${r.contributor_name} (${r.contributor_trust_tier})${sc}${lab}${lu}  [${state}]`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolveCliDbPath();
  console.error(`[token:revoke] using DB ${dbPath}`);
  initDb(dbPath);
  const db = getDb();

  const list = args.list === true;
  const prefix = typeof args.prefix === "string" ? args.prefix : null;
  const contributor = typeof args.contributor === "string" ? args.contributor : null;
  const all = args.all === true;
  const force = args.force === true;

  if (list) {
    printTokens(contributor);
    return;
  }

  if (prefix) {
    try {
      const r = revokeTokenByPrefix(db, prefix);
      if (r.was_already_revoked) {
        console.error(`Token ${r.token_prefix} already revoked at ${r.revoked_at}.`);
      } else {
        console.error(`Revoked ${r.token_prefix} (${r.contributor_name}).`);
      }
    } catch (e: any) {
      if (e instanceof MintError) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      throw e;
    }
    return;
  }

  if (all) {
    if (!contributor && !force) {
      console.error("Refusing global --all revoke without --force. Pass --contributor <name> to scope, or --force to confirm.");
      process.exit(2);
    }
    let res: { changes?: number | bigint };
    if (contributor) {
      const c = db.prepare("SELECT id FROM contributors WHERE name = ? AND type IS NOT 'form'").get(contributor) as any;
      if (!c) {
        console.error(`No contributor named "${contributor}".`);
        process.exit(1);
      }
      res = db
        .prepare(
          "UPDATE contributor_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE contributor_id = ? AND revoked_at IS NULL"
        )
        .run(c.id);
    } else {
      res = db
        .prepare(
          "UPDATE contributor_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE revoked_at IS NULL"
        )
        .run();
    }
    console.error(`Revoked ${Number(res.changes ?? 0)} token(s).`);
    return;
  }

  console.error("Usage:");
  console.error("  npm run token:revoke -- --prefix <prefix>");
  console.error("  npm run token:revoke -- --contributor <name> --all");
  console.error("  npm run token:revoke -- --all --force        (global, dangerous)");
  console.error("  npm run token:revoke -- --list [--contributor <name>]");
  process.exit(2);
}

main();
