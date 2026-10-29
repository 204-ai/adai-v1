// Shared token mint / revoke helpers. Used by both the operator CLI
// (src/cli/{issue,revoke}-token.ts) and the admin HTTP endpoints under
// /api/v1/tokens. Centralising the logic keeps the two paths in lockstep on
// hash format, prefix length, contributor row touch, and revoke semantics.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type TokenScope = "write" | "admin";
export type TrustTier = "auto" | "reviewed" | "probationary";

export interface MintOptions {
  contributorName: string;
  label?: string | null;
  scope?: TokenScope;            // default 'write'
  tier?: TrustTier;              // only used when create_if_missing creates a new row
  createIfMissing?: boolean;
  /** The node the contributor stands for (issue #70): their bylines link to it. */
  node?: string | null;
}

export interface MintResult {
  raw_token: string;             // returned EXACTLY ONCE
  token_prefix: string;          // adai_ + 8 hex
  contributor_id: string;
  contributor_name: string;
  contributor_trust_tier: string;
  scope: TokenScope;
  label: string | null;
  contributor_created: boolean;
  node_id: string | null;
}

export class MintError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const VALID_TIERS: Set<TrustTier> = new Set(["auto", "reviewed", "probationary"]);
const VALID_SCOPES: Set<TokenScope> = new Set(["write", "admin"]);

export function mintToken(db: DatabaseSync, opts: MintOptions): MintResult {
  const name = opts.contributorName?.trim();
  if (!name) {
    throw new MintError("missing_contributor", "contributor name is required");
  }
  const scope: TokenScope = opts.scope ?? "write";
  if (!VALID_SCOPES.has(scope)) {
    throw new MintError("invalid_scope", `scope must be one of: ${[...VALID_SCOPES].join(", ")}`);
  }

  let row = db.prepare("SELECT id, name, trust_tier FROM contributors WHERE name = ? AND type IS NOT 'form'").get(name) as any;
  let contributorCreated = false;

  if (!row) {
    if (!opts.createIfMissing) {
      throw new MintError("no_such_contributor", `No contributor named "${name}". Pass createIfMissing/--create to mint one.`, 404);
    }
    const tier: TrustTier = (opts.tier ?? "probationary") as TrustTier;
    if (!VALID_TIERS.has(tier)) {
      throw new MintError("invalid_tier", `tier must be one of: ${[...VALID_TIERS].join(", ")}`);
    }
    const id = `contributor-${crypto.randomBytes(8).toString("hex")}`;
    db.prepare(
      "INSERT INTO contributors (id, name, type, trust_tier, contributions, approved_count) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, name, "contributor", tier, 0, 0);
    row = { id, name, trust_tier: tier };
    contributorCreated = true;
  }

  const nodeId = opts.node ? checkTokenNode(db, opts.node) : null;
  const raw = `adai_${crypto.randomBytes(24).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 5 + 8); // 'adai_' + first 8 hex chars

  db.prepare(
    `INSERT INTO contributor_tokens (token_hash, token_prefix, contributor_id, label, scope, node_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(hash, prefix, row.id, opts.label ?? null, scope, nodeId);

  return {
    raw_token: raw,
    token_prefix: prefix,
    contributor_id: row.id,
    contributor_name: row.name,
    contributor_trust_tier: row.trust_tier,
    scope,
    label: opts.label ?? null,
    contributor_created: contributorCreated,
    node_id: nodeId,
  };
}

// --- The node a token stands for (issue #70) ----------------------------
//
// An institution or a collection that posts through a token is a
// contributor AND a node; the token's node_id joins the two, like an
// invite's self_node_id. Bylines of its contributions link to the node
// (contributorNode in src/utils/contributor-node.ts).

function checkTokenNode(db: DatabaseSync, nodeId: string): string {
  const n = db.prepare("SELECT id, metadata FROM nodes WHERE id = ?").get(nodeId) as any;
  if (!n) throw new MintError("no_such_node", `No node with id "${nodeId}".`, 404);
  let retired = false;
  try { retired = JSON.parse(n.metadata ?? "{}")?.retired === true; } catch { /* not retired */ }
  if (retired) throw new MintError("node_retired", `Node "${nodeId}" is retired.`, 409);
  return n.id;
}

/** Set (or, with null, clear) the node a token stands for. */
export function setTokenNode(db: DatabaseSync, prefix: string, nodeId: string | null): { token_prefix: string; contributor_id: string; contributor_name: string; node_id: string | null; previous: string | null } {
  const row = db
    .prepare(
      `SELECT t.token_prefix, t.node_id, c.id AS contributor_id, c.name AS contributor_name
         FROM contributor_tokens t JOIN contributors c ON t.contributor_id = c.id
        WHERE t.token_prefix = ?`
    )
    .get(prefix) as any;
  if (!row) throw new MintError("no_such_token", `No token with prefix "${prefix}".`, 404);
  const next = nodeId === null ? null : checkTokenNode(db, nodeId);
  db.prepare("UPDATE contributor_tokens SET node_id = ? WHERE token_prefix = ?").run(next, prefix);
  return { token_prefix: row.token_prefix, contributor_id: row.contributor_id, contributor_name: row.contributor_name, node_id: next, previous: row.node_id ?? null };
}

/**
 * Change the trust tier of the contributor a token belongs to (the tier is the
 * contributor's, so every token of theirs follows). Admin-only at the HTTP
 * layer; replaces an SSH session to the volume. Public-form rows and the
 * anonymous sentinel have no tier to give.
 */
export function setContributorTier(db: DatabaseSync, prefix: string, tier: string): { token_prefix: string; contributor_id: string; contributor_name: string; trust_tier: TrustTier; previous: string } {
  if (!VALID_TIERS.has(tier as TrustTier)) throw new MintError("invalid_tier", `tier must be one of ${[...VALID_TIERS].join(", ")}`);
  const row = db
    .prepare(
      `SELECT t.token_prefix, c.id AS contributor_id, c.name AS contributor_name, c.trust_tier, c.type
         FROM contributor_tokens t JOIN contributors c ON t.contributor_id = c.id
        WHERE t.token_prefix = ?`
    )
    .get(prefix) as any;
  if (!row) throw new MintError("no_such_token", `No token with prefix "${prefix}".`, 404);
  if (row.type === "form" || row.contributor_id === "contributor:anonymous") {
    throw new MintError("tier_not_settable", "this contributor row has no trust tier to change", 409);
  }
  if (row.trust_tier !== tier) db.prepare("UPDATE contributors SET trust_tier = ? WHERE id = ?").run(tier, row.contributor_id);
  return { token_prefix: row.token_prefix, contributor_id: row.contributor_id, contributor_name: row.contributor_name, trust_tier: tier as TrustTier, previous: row.trust_tier ?? "probationary" };
}

// --- Restore -----------------------------------------------------------
//
// `restoreToken` is the sister of `mintToken` for the disaster-recovery
// path: a pre-supplied raw token (one you already issued and saved) gets
// re-inserted into the table. Useful after a volume wipe — the operator
// keeps the raw tokens in a gitignored `.tokens.json` and the
// `restore-tokens` CLI replays them so existing API clients keep working.
//
// Idempotent: re-running with the same raw token is a no-op (matched by
// sha256(raw)). Contributor row is created if missing (analogue of
// mintToken's createIfMissing). The function does NOT return the raw
// token — the caller already has it.

export interface RestoreOptions {
  rawToken: string;              // pre-existing 'adai_…' bearer; sha256 will be computed
  contributorName: string;
  label?: string | null;
  scope?: TokenScope;            // default 'write'
  tier?: TrustTier;              // used only when contributor must be created
}

export interface RestoreResult {
  token_prefix: string;
  contributor_id: string;
  contributor_name: string;
  contributor_trust_tier: string;
  scope: TokenScope;
  label: string | null;
  contributor_created: boolean;
  token_inserted: boolean;       // false when the (hash) was already present
}

const RAW_TOKEN_RE = /^adai_[0-9a-f]{40,}$/;

export function restoreToken(db: DatabaseSync, opts: RestoreOptions): RestoreResult {
  const name = opts.contributorName?.trim();
  if (!name) {
    throw new MintError("missing_contributor", "contributor name is required");
  }
  const raw = (opts.rawToken ?? "").trim();
  if (!RAW_TOKEN_RE.test(raw)) {
    throw new MintError(
      "invalid_raw_token",
      `raw token must match /^adai_[0-9a-f]{40,}$/ (got "${raw.slice(0, 13)}…")`
    );
  }
  const scope: TokenScope = opts.scope ?? "write";
  if (!VALID_SCOPES.has(scope)) {
    throw new MintError("invalid_scope", `scope must be one of: ${[...VALID_SCOPES].join(", ")}`);
  }

  let row = db.prepare("SELECT id, name, trust_tier FROM contributors WHERE name = ? AND type IS NOT 'form'").get(name) as any;
  let contributorCreated = false;

  if (!row) {
    const tier: TrustTier = (opts.tier ?? "probationary") as TrustTier;
    if (!VALID_TIERS.has(tier)) {
      throw new MintError("invalid_tier", `tier must be one of: ${[...VALID_TIERS].join(", ")}`);
    }
    const id = `contributor-${crypto.randomBytes(8).toString("hex")}`;
    db.prepare(
      "INSERT INTO contributors (id, name, type, trust_tier, contributions, approved_count) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, name, "contributor", tier, 0, 0);
    row = { id, name, trust_tier: tier };
    contributorCreated = true;
  }

  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 5 + 8);

  const existing = db
    .prepare("SELECT contributor_id, scope FROM contributor_tokens WHERE token_hash = ?")
    .get(hash) as any;

  let tokenInserted = false;
  if (existing) {
    // Already restored. Cheap consistency guard: if the existing row points
    // at a different contributor, that's almost certainly a typo in
    // .tokens.json or a misrouted token — refuse rather than silently
    // shadow it. Same scope mismatch: refuse.
    if (existing.contributor_id !== row.id) {
      throw new MintError(
        "token_belongs_to_other_contributor",
        `token ${prefix} is already attached to a different contributor_id (${existing.contributor_id}); refusing to re-bind`
      );
    }
    if (existing.scope !== scope) {
      throw new MintError(
        "token_scope_mismatch",
        `token ${prefix} is already stored with scope='${existing.scope}', refusing to overwrite with '${scope}'`
      );
    }
  } else {
    db.prepare(
      `INSERT INTO contributor_tokens (token_hash, token_prefix, contributor_id, label, scope)
       VALUES (?, ?, ?, ?, ?)`
    ).run(hash, prefix, row.id, opts.label ?? null, scope);
    tokenInserted = true;
  }

  return {
    token_prefix: prefix,
    contributor_id: row.id,
    contributor_name: row.name,
    contributor_trust_tier: row.trust_tier,
    scope,
    label: opts.label ?? null,
    contributor_created: contributorCreated,
    token_inserted: tokenInserted,
  };
}

export interface RevokeResult {
  token_prefix: string;
  contributor_id: string;
  contributor_name: string;
  was_already_revoked: boolean;
  revoked_at: string | null;
}

export function revokeTokenByPrefix(db: DatabaseSync, prefix: string): RevokeResult {
  const row = db
    .prepare(
      `SELECT t.token_hash, t.token_prefix, t.revoked_at, c.id AS contributor_id, c.name AS contributor_name
         FROM contributor_tokens t
         JOIN contributors c ON t.contributor_id = c.id
        WHERE t.token_prefix = ?`
    )
    .get(prefix) as any;
  if (!row) {
    throw new MintError("no_such_token", `No token with prefix "${prefix}".`, 404);
  }
  if (row.revoked_at) {
    return {
      token_prefix: row.token_prefix,
      contributor_id: row.contributor_id,
      contributor_name: row.contributor_name,
      was_already_revoked: true,
      revoked_at: row.revoked_at,
    };
  }
  db.prepare(
    "UPDATE contributor_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE token_hash = ?"
  ).run(row.token_hash);
  const after = db
    .prepare("SELECT revoked_at FROM contributor_tokens WHERE token_hash = ?")
    .get(row.token_hash) as any;
  return {
    token_prefix: row.token_prefix,
    contributor_id: row.contributor_id,
    contributor_name: row.contributor_name,
    was_already_revoked: false,
    revoked_at: after?.revoked_at ?? null,
  };
}

export interface ListedToken {
  token_prefix: string;
  contributor_id: string;
  contributor_name: string;
  contributor_trust_tier: string;
  label: string | null;
  scope: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  node_id: string | null;
}

export function listTokens(
  db: DatabaseSync,
  filter: { contributorName?: string | null; activeOnly?: boolean } = {}
): ListedToken[] {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.contributorName) {
    where.push("c.name = ?");
    params.push(filter.contributorName);
  }
  if (filter.activeOnly) {
    where.push("t.revoked_at IS NULL");
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT t.token_prefix, t.label, t.scope, t.created_at, t.last_used_at, t.revoked_at, t.node_id,
              c.id AS contributor_id, c.name AS contributor_name, c.trust_tier AS contributor_trust_tier
         FROM contributor_tokens t
         JOIN contributors c ON t.contributor_id = c.id
         ${whereSql}
         ORDER BY t.created_at DESC`
    )
    .all(...params) as any[];
}
