// CLI: issue a contributor or admin bearer token. Runs against the local
// SQLite file. The raw token is printed to stdout ONCE and is unrecoverable
// afterwards. Operator-only — must not be reachable over HTTP.
//
//   npm run token:issue -- --contributor "Casey Reas" --label "claude-laptop"
//   npm run token:issue -- --contributor "New Person" --label "first" --create
//   npm run token:issue -- --contributor "Giovanni" --label "ops" --admin
//
// Flags:
//   --contributor <name>   (required) name as stored in `contributors.name`
//   --label <text>         freeform identifier shown in `npm run token:revoke --list`
//   --create               if the contributor doesn't exist, create them
//   --tier <tier>          on --create: trust_tier (auto|reviewed|probationary;
//                          default probationary)
//   --admin                mint an admin-scope token (can call POST /api/v1/tokens
//                          to mint contributor tokens and revoke any token).
//                          Only the operator can mint admins — the HTTP admin
//                          endpoint refuses scope='admin' in its payload.
//   --node <node id>       the node the contributor stands for (issue #70), e.g.
//                          "institution:the-outlier-collection": bylines of its
//                          contributions link there. Later: PATCH /api/v1/tokens/:prefix
//
// On Fly: prefer `DB_PATH=/data/adai.db node /app/dist/cli/issue-token.js …`
// or just run without DB_PATH — src/utils/db-path.ts will pick /data/adai.db
// automatically when it exists.

import { initDb, getDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { mintToken, MintError, type TokenScope, type TrustTier } from "../utils/token-mint.js";

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
  const contributorName = typeof args.contributor === "string" ? args.contributor : null;
  const label = typeof args.label === "string" ? args.label : null;
  const create = args.create === true;
  const tier = (typeof args.tier === "string" ? args.tier : "probationary") as TrustTier;
  const scope: TokenScope = args.admin === true ? "admin" : "write";
  const node = typeof args.node === "string" ? args.node : null;

  if (!contributorName) {
    console.error("Usage: npm run token:issue -- --contributor <name> [--label <text>] [--create [--tier <tier>]] [--admin] [--node <node id>]");
    process.exit(2);
  }

  const dbPath = resolveCliDbPath();
  console.error(`[token:issue] using DB ${dbPath}`);
  initDb(dbPath);
  const db = getDb();

  let result;
  try {
    result = mintToken(db, {
      contributorName,
      label,
      scope,
      tier,
      createIfMissing: create,
      node,
    });
  } catch (e: any) {
    if (e instanceof MintError) {
      console.error(`Error: ${e.message}`);
      process.exit(e.code === "no_such_contributor" ? 1 : 2);
    }
    throw e;
  }

  if (result.contributor_created) {
    console.error(`Created contributor ${result.contributor_id} (${result.contributor_name}) with trust_tier=${result.contributor_trust_tier}`);
  }
  console.error("");
  console.error(`Issued ${result.scope} token for ${result.contributor_name} (trust_tier=${result.contributor_trust_tier})`);
  console.error(`  prefix: ${result.token_prefix}`);
  if (result.label) console.error(`  label:  ${result.label}`);
  if (result.node_id) console.error(`  node:   ${result.node_id}`);
  console.error("");
  console.error("Raw token (will not be shown again):");
  process.stdout.write(result.raw_token + "\n");
}

main();
