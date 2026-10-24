// Admin-side correction primitives for the /api/v1 surface: revoke a signal,
// retire a node, retire a whole batch, list batches; and for the operator
// CLIs, merge a duplicate node into another and rewrite a node's slug.
//
// NONE of these delete anything. The schema's correction model is:
//   edges   → bi-temporal supersession (valid_until + invalidated_by)
//   signals → status flip ('active' → 'revoked')
//   nodes   → metadata.retired flag (listing surfaces filter it — see
//             src/utils/visibility.ts) + supersession of every live edge
//             touching the node
//
// Every action is anchored by an ADMIN SIGNAL (source_type='api_admin',
// submitted_by=<admin contributor>) whose content records what was corrected
// and why; superseded edges point at it via invalidated_by. So the
// provenance chain answers "who retired this, when, and for what reason"
// the same way it answers every other question about the graph.
//
// Shared between the HTTP endpoints in src/routes/contributor-api.ts and any
// future operator CLI, so the two paths can't drift (the token-mint.ts
// pattern).

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { mergeMetadata, priorValues, recordPrior } from "./contribution.js";
import { keepOldSlug } from "./moved.js";
import { slugify } from "./slug.js";
import { insertSignalRow, priorsOf, stripBeforeImages, withholdSignal } from "./signal-private.js";

export class AdminActionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "AdminActionError";
  }
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

// The audit anchor for every admin correction. Confidence 'high' (it's a
// first-person operator statement), consent full/attributed, origin
// human_primary — the admin is a contributor like anyone else. Exported for
// the operator CLIs that write outside the HTTP surface.
export function insertAdminSignal(
  db: DatabaseSync,
  args: { by: string; title: string; content: unknown; publicView?: { title: string; content: unknown } }
): string {
  const id = `signal-${crypto.randomBytes(8).toString("hex")}`;
  // An admin record never carries before-images in the CRR (a batch
  // retirement's patches_to_review list them), nor a private handle (an
  // anonymous contribution's batch id): the full record is kept in
  // signal_private, the CRR gets its public view.
  const pub = args.publicView ?? { title: args.title, content: args.content };
  const { stripped, had } = stripBeforeImages(pub.content);
  insertSignalRow(db, {
    id, title: pub.title, source_url: null, source_type: "api_admin", cla_layer: null, summary: null,
    content: JSON.stringify(had ? stripped : pub.content),
    submitted_by: args.by, confidence: "high", lived_experience: 0,
    consent_scope: "full_commons", consent_attribution: "attributed", source_origin: "human_primary", batch_id: null,
  });
  const reasons = [...(had || stripBeforeImages(args.content).had ? ["before_images"] : []), ...(args.publicView ? ["private_batch"] : [])];
  if (reasons.length) {
    db.prepare("INSERT INTO signal_private (signal_id, reasons, title, content) VALUES (?, ?, ?, ?)")
      .run(id, reasons.sort().join(","), args.publicView ? args.title : null, JSON.stringify(args.content));
  }
  return id;
}

/** Whether a batch id is private: some signal of it is anonymous (its batch id lives in signal_private only). */
export function batchIsPrivate(db: DatabaseSync, batchId: string): boolean {
  return !!db.prepare("SELECT 1 FROM signal_private WHERE batch_id = ? LIMIT 1").get(batchId);
}

// ---------- revoke a signal -------------------------------------------------

export interface RevokeSignalResult {
  signal_id: string;
  already_revoked: boolean;
  edges_superseded: number;
  admin_signal_id: string | null;
}

/**
 * Flip a signal to status='revoked' and (by default) supersede every live
 * edge anchored to it. Idempotent: revoking an already-revoked signal is a
 * no-op that reports already_revoked.
 */
export function revokeSignal(
  db: DatabaseSync,
  signalId: string,
  opts: { reason: string; by: string; cascade?: boolean }
): RevokeSignalResult {
  const sig = db.prepare("SELECT id, status FROM signals WHERE id = ?").get(signalId) as any;
  if (!sig) throw new AdminActionError(404, "signal_not_found", `no signal with id ${signalId}`);
  if (sig.status === "revoked") {
    return { signal_id: signalId, already_revoked: true, edges_superseded: 0, admin_signal_id: null };
  }
  return withTx(db, () => {
    const anchor = insertAdminSignal(db, {
      by: opts.by,
      title: `Revoke signal: ${signalId}`,
      content: { action: "revoke_signal", signal_id: signalId, reason: opts.reason },
    });
    db.prepare("UPDATE signals SET status = 'revoked' WHERE id = ?").run(signalId);
    // Its words leave the CRR (kept in signal_private): a cell change every
    // fork receives on its next pull.
    withholdSignal(db, signalId, "revoked");
    let edges = 0;
    if (opts.cascade !== false) {
      const r = db
        .prepare(
          `UPDATE edges SET valid_until = ${NOW_SQL}, invalidated_by = ? WHERE signal_id = ? AND valid_until IS NULL`
        )
        .run(anchor, signalId);
      edges = Number(r.changes);
    }
    return { signal_id: signalId, already_revoked: false, edges_superseded: edges, admin_signal_id: anchor };
  });
}

// ---------- retire a node ---------------------------------------------------

export interface RetireNodeResult {
  node_id: string;
  already_retired: boolean;
  dry_run?: boolean;
  edges_superseded: number;
  admin_signal_id: string | null;
}

// Inner worker — no transaction, no anchor creation. Used by retireNode
// (which wraps it in a tx) and retireBatch (which runs many inside one tx,
// sharing a single anchor).
function retireNodeInner(
  db: DatabaseSync,
  nodeId: string,
  opts: { reason: string; by: string; anchor: string }
): { edges_superseded: number } {
  const r = db
    .prepare(
      `UPDATE edges SET valid_until = ${NOW_SQL}, invalidated_by = ?
        WHERE (source_id = ? OR target_id = ?) AND valid_until IS NULL`
    )
    .run(opts.anchor, nodeId, nodeId);
  const row = db.prepare("SELECT metadata, updated_by FROM nodes WHERE id = ?").get(nodeId) as any;
  let base: any = {};
  if (row?.metadata) {
    try { base = JSON.parse(row.metadata); } catch { base = {}; }
  }
  const patch = {
    retired: true,
    retired_at: isoNow(),
    retired_by: opts.by,
    retired_reason: opts.reason,
  };
  recordPrior(db, opts.anchor, { op: "retire_node", node_id: nodeId, updated_by: row?.updated_by ?? null, before: priorValues(base, Object.keys(patch)) });
  const merged = mergeMetadata(base, patch);
  db.prepare("UPDATE nodes SET metadata = ?, updated_by = ? WHERE id = ?")
    .run(JSON.stringify(merged), `api-${opts.by}`, nodeId);
  return { edges_superseded: Number(r.changes) };
}

/**
 * Retire a node: supersede every live edge touching it (either direction)
 * and set metadata.retired so listing surfaces drop it. The row itself
 * stays. Reversal is deliberate manual work: PATCH the metadata
 * ({"retired": null}) and re-attest the edges you want back.
 */
export function retireNode(
  db: DatabaseSync,
  nodeId: string,
  opts: { reason: string; by: string; dryRun?: boolean }
): RetireNodeResult {
  const node = db.prepare("SELECT id, metadata FROM nodes WHERE id = ?").get(nodeId) as any;
  if (!node) throw new AdminActionError(404, "node_not_found", `no node with id ${nodeId}`);
  let meta: any = {};
  if (node.metadata) {
    try { meta = JSON.parse(node.metadata); } catch { meta = {}; }
  }
  if (meta.retired === true) {
    return { node_id: nodeId, already_retired: true, edges_superseded: 0, admin_signal_id: null };
  }
  const { count: liveEdges } = db
    .prepare(
      "SELECT COUNT(*) AS count FROM edges WHERE (source_id = ? OR target_id = ?) AND valid_until IS NULL"
    )
    .get(nodeId, nodeId) as any;

  if (opts.dryRun) {
    return { node_id: nodeId, already_retired: false, dry_run: true, edges_superseded: Number(liveEdges), admin_signal_id: null };
  }

  return withTx(db, () => {
    const anchor = insertAdminSignal(db, {
      by: opts.by,
      title: `Retire node: ${nodeId}`,
      content: { action: "retire_node", node_id: nodeId, reason: opts.reason },
    });
    const { edges_superseded } = retireNodeInner(db, nodeId, { reason: opts.reason, by: opts.by, anchor });
    return { node_id: nodeId, already_retired: false, edges_superseded, admin_signal_id: anchor };
  });
}

// ---------- retire a batch ---------------------------------------------------

export interface BatchRetirePlan {
  batch_id: string;
  signals_total: number;
  signals_active: number;
  edges_to_supersede: number;
  nodes_to_retire: string[];
  nodes_skipped_preexisting: string[];
  patches_to_review: Array<{ op: string; node_id: string; signal_id: string | null; before: Record<string, unknown> | null }>;
  pending_intake_to_reject: number;
}

export interface RetireBatchResult extends BatchRetirePlan {
  dry_run?: boolean;
  retired?: boolean;
  admin_signal_id?: string;
  signals_revoked?: number;
  edges_superseded?: number;
  nodes_retired?: number;
  pending_rejected?: number;
}

// The before-image a patch / image write recorded on its signal (see
// recordPrior in contribution.ts), or null when none was recorded.
function priorFor(db: DatabaseSync, signalId: string | null, op: string, nodeId: string): Record<string, unknown> | null {
  if (!signalId) return null;
  const hit = priorsOf(db, signalId).find((p) => p.op === op && p.node_id === nodeId);
  return hit?.before ?? null;
}

function buildBatchPlan(db: DatabaseSync, batchId: string): BatchRetirePlan & { signalIds: string[] } {
  const signals = db
    .prepare(
      // signals_full: an anonymous signal's batch id is on the private side
      "SELECT id, submitted_by, created_at, status FROM signals_full WHERE batch_id = ? ORDER BY created_at ASC"
    )
    .all(batchId) as Array<{ id: string; submitted_by: string; created_at: string; status: string }>;
  if (signals.length === 0) {
    throw new AdminActionError(404, "batch_not_found", `no signals carry batch_id ${batchId}`);
  }
  const signalIds = signals.map((s) => s.id);
  const batchStart = signals[0]!.created_at;
  const placeholders = signalIds.map(() => "?").join(",");

  const { count: liveEdges } = db
    .prepare(
      `SELECT COUNT(*) AS count FROM edges WHERE valid_until IS NULL AND signal_id IN (${placeholders})`
    )
    .get(...signalIds) as any;

  const intakeRows = db
    .prepare(
      `SELECT id, signal_id, status, proposed_nodes FROM intake_queue WHERE signal_id IN (${placeholders})`
    )
    .all(...signalIds) as Array<{ id: string; signal_id: string | null; status: string; proposed_nodes: string | null }>;

  // Candidate nodes created by this batch: parse create_node ops out of the
  // intake rows (every /api/v1 write leaves one, including auto-merged ones —
  // audit symmetry). Guard against retiring PRE-EXISTING nodes the batch
  // merely collided with (materialiseCreateNode is first-write-wins, so a
  // create on an existing id was a no-op): only retire a node whose
  // created_at is >= the batch's first signal (ISO strings compare
  // lexicographically).
  const createCandidates = new Map<string, string | null>(); // node_id → signal_id
  const patchesToReview: BatchRetirePlan["patches_to_review"] = [];
  for (const row of intakeRows) {
    if (!row.proposed_nodes) continue;
    let ops: any[] = [];
    try { ops = JSON.parse(row.proposed_nodes); } catch { ops = []; }
    for (const op of ops) {
      if (op?.op === "create_node" && op.type && op.slug) {
        createCandidates.set(`${op.type}:${op.slug}`, row.signal_id);
      } else if ((op?.op === "patch_node" || op?.op === "attach_image") && op.node_id) {
        const signalId = op.signal_id ?? row.signal_id;
        patchesToReview.push({ op: op.op, node_id: op.node_id, signal_id: signalId, before: priorFor(db, signalId, op.op, op.node_id) });
      }
    }
  }

  const nodesToRetire: string[] = [];
  const nodesSkipped: string[] = [];
  for (const [nodeId] of createCandidates) {
    const node = db.prepare("SELECT id, created_at, metadata FROM nodes WHERE id = ?").get(nodeId) as any;
    if (!node) continue; // never materialised (rejected / still pending)
    let meta: any = {};
    if (node.metadata) {
      try { meta = JSON.parse(node.metadata); } catch { meta = {}; }
    }
    if (meta.retired === true) continue; // already retired
    if (typeof node.created_at === "string" && node.created_at >= batchStart) {
      nodesToRetire.push(nodeId);
    } else {
      nodesSkipped.push(nodeId); // pre-existing — the batch's create was a no-op
    }
  }

  // Patches that target nodes this plan retires anyway don't need manual
  // review — retirement hides the node wholesale.
  const retireSet = new Set(nodesToRetire);
  const patchesFiltered = patchesToReview.filter((p) => !retireSet.has(p.node_id));

  // The execution's SECOND supersession pass (retireNodeInner on each
  // batch-created node) also catches live edges touching those nodes but
  // anchored OUTSIDE the batch — e.g. a curator-approved edge added after
  // the upload. Count them here so the dry-run's edges_to_supersede equals
  // what the live run will actually report (signal-anchored edges already
  // counted above are excluded to avoid double-counting).
  let nodeTouchingEdges = 0;
  if (nodesToRetire.length > 0) {
    const nodePh = nodesToRetire.map(() => "?").join(",");
    const { count } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM edges
          WHERE valid_until IS NULL
            AND (source_id IN (${nodePh}) OR target_id IN (${nodePh}))
            AND (signal_id IS NULL OR signal_id NOT IN (${placeholders}))`
      )
      .get(...nodesToRetire, ...nodesToRetire, ...signalIds) as any;
    nodeTouchingEdges = Number(count);
  }

  return {
    batch_id: batchId,
    signals_total: signals.length,
    signals_active: signals.filter((s) => s.status === "active").length,
    edges_to_supersede: Number(liveEdges) + nodeTouchingEdges,
    nodes_to_retire: nodesToRetire.sort(),
    nodes_skipped_preexisting: nodesSkipped.sort(),
    patches_to_review: patchesFiltered,
    pending_intake_to_reject: intakeRows.filter((r) => r.status === "pending").length,
    signalIds,
  };
}

/**
 * Retire an entire contribution batch — "delete and start again", the
 * provenance-preserving way:
 *   1. revoke every active signal carrying the batch_id
 *   2. supersede every live edge anchored to those signals
 *   3. retire every node the batch CREATED (guarded so pre-existing nodes
 *      the batch merely touched are never retired)
 *   4. reject every still-pending intake row from the batch
 *
 * Metadata patches / image attachments the batch applied to PRE-EXISTING
 * nodes are not auto-reverted — a later write may have built on them. They're
 * returned in patches_to_review for manual follow-up, each with the values
 * it replaced (`before`, from the signal's processing_trace; null for writes
 * made before before-images were recorded).
 *
 * Always run with dryRun first.
 */
export function retireBatch(
  db: DatabaseSync,
  batchId: string,
  opts: { reason: string; by: string; dryRun?: boolean }
): RetireBatchResult {
  const { signalIds, ...plan } = buildBatchPlan(db, batchId);

  if (opts.dryRun) {
    return { dry_run: true, ...plan };
  }

  const placeholders = signalIds.map(() => "?").join(",");
  return withTx(db, () => {
    const record = {
      action: "retire_batch",
      batch_id: batchId,
      reason: opts.reason,
      signals: plan.signals_total,
      nodes_retired: plan.nodes_to_retire,
      nodes_skipped_preexisting: plan.nodes_skipped_preexisting,
      patches_to_review: plan.patches_to_review,
    };
    // A batch with an anonymous contribution in it has a private handle: the
    // public record names an opaque correction id instead (the operator's
    // audit keeps the batch id, signal_private).
    const correction = batchIsPrivate(db, batchId) ? `correction-${crypto.randomBytes(6).toString("hex")}` : null;
    const anchor = insertAdminSignal(db, {
      by: opts.by,
      title: `Retire batch: ${batchId}`,
      content: record,
      publicView: correction
        ? { title: `Retire batch: ${correction}`, content: { ...record, batch_id: undefined, correction_id: correction } }
        : undefined,
    });

    const active = (db.prepare(`SELECT id FROM signals WHERE id IN (${placeholders}) AND status = 'active'`).all(...signalIds) as any[]).map((r) => r.id as string);
    const revoked = db
      .prepare(`UPDATE signals SET status = 'revoked' WHERE id IN (${placeholders}) AND status = 'active'`)
      .run(...signalIds);
    for (const id of active) withholdSignal(db, id, "revoked");

    const superseded = db
      .prepare(
        `UPDATE edges SET valid_until = ${NOW_SQL}, invalidated_by = ?
          WHERE valid_until IS NULL AND signal_id IN (${placeholders})`
      )
      .run(anchor, ...signalIds);

    let nodeEdgeCount = 0;
    for (const nodeId of plan.nodes_to_retire) {
      const r = retireNodeInner(db, nodeId, { reason: opts.reason, by: opts.by, anchor });
      nodeEdgeCount += r.edges_superseded;
    }

    const rejected = db
      .prepare(
        `UPDATE intake_queue
            SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = ${NOW_SQL}
          WHERE status = 'pending' AND signal_id IN (${placeholders})`
      )
      .run(`batch retired: ${opts.reason}`, `api-${opts.by}`, ...signalIds);

    return {
      ...plan,
      retired: true,
      admin_signal_id: anchor,
      signals_revoked: Number(revoked.changes),
      edges_superseded: Number(superseded.changes) + nodeEdgeCount,
      nodes_retired: plan.nodes_to_retire.length,
      pending_rejected: Number(rejected.changes),
    };
  });
}

// ---------- list batches ------------------------------------------------------

export interface BatchSummary {
  batch_id: string;
  signals: number;
  active_signals: number;
  revoked_signals: number;
  contributors: string[];
  first_at: string | null;
  last_at: string | null;
  intake: Record<string, number>; // pending / approved / rejected counts
}

export function listBatches(
  db: DatabaseSync,
  opts: { contributor?: string | null; limit?: number } = {}
): BatchSummary[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where = ["batch_id IS NOT NULL"];
  const params: Array<string | number> = [];
  if (opts.contributor) {
    where.push("submitted_by = ?");
    params.push(opts.contributor);
  }
  const rows = db
    .prepare(
      `SELECT batch_id,
              COUNT(*) AS signals,
              SUM(CASE WHEN status = 'active'  THEN 1 ELSE 0 END) AS active_signals,
              SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked_signals,
              GROUP_CONCAT(DISTINCT submitted_by) AS contributors,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at
         FROM signals_full
        WHERE ${where.join(" AND ")}
        GROUP BY batch_id
        ORDER BY last_at DESC
        LIMIT ?`
    )
    .all(...params, limit) as any[];

  const intakeRows = db
    .prepare(
      `SELECT s.batch_id AS batch_id, q.status AS status, COUNT(*) AS n
         FROM intake_queue q
         JOIN signals_full s ON s.id = q.signal_id
        WHERE s.batch_id IS NOT NULL
        GROUP BY s.batch_id, q.status`
    )
    .all() as Array<{ batch_id: string; status: string; n: number }>;
  const intakeByBatch = new Map<string, Record<string, number>>();
  for (const r of intakeRows) {
    let m = intakeByBatch.get(r.batch_id);
    if (!m) { m = {}; intakeByBatch.set(r.batch_id, m); }
    m[r.status] = Number(r.n);
  }

  return rows.map((r) => ({
    batch_id: r.batch_id,
    signals: Number(r.signals),
    active_signals: Number(r.active_signals),
    revoked_signals: Number(r.revoked_signals),
    contributors: typeof r.contributors === "string" ? r.contributors.split(",") : [],
    first_at: r.first_at ?? null,
    last_at: r.last_at ?? null,
    intake: intakeByBatch.get(r.batch_id) ?? {},
  }));
}

// ---------- merge a duplicate node (issue #69) -------------------------------

export interface MergeNodesResult {
  from: string;
  into: string;
  dry_run?: boolean;
  /** Live relations of the duplicate, moved onto the kept node (old → new edge id). */
  edges_moved: Array<{ old: string; new: string }>;
  /** Live relations ended without a copy: between the two nodes, or one the kept node already has from the same source. */
  edges_ended: string[];
  /** Metadata keys the kept node lacked, copied from the duplicate. */
  keys_copied: string[];
  /** Keys both have with different values: the kept node's value stays. */
  keys_kept: string[];
  aliases_moved: Array<{ source: string; external_id: string }>;
  /** Pending review items that name the duplicate (left as they are; a curator sees them). */
  pending_mentions: number;
  admin_signal_id: string | null;
}

// Keys that describe the node's own state, never copied across.
const NOT_COPIED = new Set(["retired", "retired_at", "retired_by", "retired_reason", "merged_into", "claimed"]);

/**
 * Merge `fromId` into `intoId`: one page for one person. Every live relation
 * of the duplicate is re-made on the kept node with its original source,
 * contributor, confidence and event time, and the old one is superseded by
 * it (bi-temporally — nothing is deleted). Metadata the kept node lacks is
 * copied (never overwritten; the before-image is kept). The duplicate's
 * external identities (node_aliases) move over, so a later import resolves
 * to the kept node. The duplicate is retired with `merged_into`, and its
 * address 301s to the kept node (src/utils/moved.ts). One admin signal
 * anchors it all.
 *
 * Refused when the two differ in type, either is retired, or the duplicate
 * has a claim — a claimed page is someone's, and that is a person's call.
 */
export function mergeNodes(
  db: DatabaseSync,
  fromId: string,
  intoId: string,
  opts: { reason: string; by: string; dryRun?: boolean }
): MergeNodesResult {
  if (fromId === intoId) throw new AdminActionError(400, "same_node", "a node cannot be merged into itself");
  const get = (id: string) => db.prepare("SELECT id, type, slug, metadata, updated_by FROM nodes WHERE id = ?").get(id) as any;
  const from = get(fromId);
  const into = get(intoId);
  if (!from) throw new AdminActionError(404, "node_not_found", `no node with id ${fromId}`);
  if (!into) throw new AdminActionError(404, "node_not_found", `no node with id ${intoId}`);
  if (from.type !== into.type) throw new AdminActionError(400, "type_mismatch", `${fromId} is ${from.type}, ${intoId} is ${into.type}`);
  const meta = (n: any) => { try { return JSON.parse(n.metadata ?? "{}") ?? {}; } catch { return {}; } };
  const fromMeta = meta(from);
  const intoMeta = meta(into);
  if (fromMeta.retired === true) throw new AdminActionError(409, "already_retired", `${fromId} is retired`);
  if (intoMeta.retired === true) throw new AdminActionError(409, "target_retired", `${intoId} is retired`);
  const claims = db.prepare("SELECT COUNT(*) AS n FROM node_claims WHERE node_id = ? AND status IN ('approved', 'pending')").get(fromId) as any;
  if (Number(claims?.n ?? 0) > 0) throw new AdminActionError(409, "claimed", `${fromId} has a claim; settle it before merging`);

  const edges = db.prepare(
    "SELECT * FROM edges WHERE (source_id = ? OR target_id = ?) AND valid_until IS NULL ORDER BY id"
  ).all(fromId, fromId) as any[];
  const swap = (id: string) => (id === fromId ? intoId : id);
  const plan = edges.map((e) => {
    const source = swap(e.source_id);
    const target = swap(e.target_id);
    if (source === target) return { e, source, target, existing: null as string | null, loop: true };
    const existing = db.prepare(
      "SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = ? AND created_by IS ? AND valid_until IS NULL"
    ).get(source, target, e.edge_type, e.created_by) as any;
    return { e, source, target, existing: existing?.id ?? null, loop: false };
  });
  const keysCopied = Object.keys(fromMeta).filter((k) => !NOT_COPIED.has(k) && !(k in intoMeta));
  const keysKept = Object.keys(fromMeta).filter((k) => !NOT_COPIED.has(k) && k in intoMeta && JSON.stringify(fromMeta[k]) !== JSON.stringify(intoMeta[k]));
  const aliases = db.prepare("SELECT source, external_id FROM node_aliases WHERE node_id = ? ORDER BY source, external_id").all(fromId) as any[];
  const like = `%${JSON.stringify(fromId).slice(1, -1)}%`;
  const pending = db.prepare(
    "SELECT COUNT(*) AS n FROM intake_queue WHERE status = 'pending' AND (target_node = ? OR proposed_nodes LIKE ? OR proposed_edges LIKE ?)"
  ).get(fromId, like, like) as any;

  const result: MergeNodesResult = {
    from: fromId,
    into: intoId,
    edges_moved: [],
    edges_ended: plan.filter((p) => p.loop || p.existing).map((p) => p.e.id),
    keys_copied: keysCopied,
    keys_kept: keysKept,
    aliases_moved: aliases.map((a) => ({ source: a.source, external_id: a.external_id })),
    pending_mentions: Number(pending?.n ?? 0),
    admin_signal_id: null,
  };
  if (opts.dryRun) {
    result.dry_run = true;
    result.edges_moved = plan.filter((p) => !p.loop && !p.existing).map((p) => ({ old: p.e.id, new: "(new)" }));
    return result;
  }

  return withTx(db, () => {
    const anchor = insertAdminSignal(db, {
      by: opts.by,
      title: `Merge node: ${fromId} into ${intoId}`,
      content: {
        action: "merge_node",
        from: fromId,
        into: intoId,
        reason: opts.reason,
        aliases_moved: result.aliases_moved,
        keys_copied: keysCopied,
        keys_kept: keysKept,
      },
    });
    for (const p of plan) {
      if (p.loop || p.existing) {
        db.prepare(`UPDATE edges SET valid_until = ${NOW_SQL}, invalidated_by = ? WHERE id = ?`).run(p.existing ?? anchor, p.e.id);
        continue;
      }
      const newId = `${p.source}--${p.e.edge_type}--${p.target}--${p.e.created_by ?? "unknown"}--merged-${crypto.randomBytes(4).toString("hex")}`;
      db.prepare(
        `INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, confidence, charge, created_at, created_by,
                            event_time, valid_from, valid_until, invalidated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_SQL}, ?, ?, ${NOW_SQL}, NULL, NULL)`
      ).run(newId, p.source, p.target, p.e.edge_type, p.e.signal_id ?? null, p.e.confidence ?? null, p.e.charge ?? null, p.e.created_by ?? null, p.e.event_time ?? null);
      db.prepare(`UPDATE edges SET valid_until = ${NOW_SQL}, invalidated_by = ? WHERE id = ?`).run(newId, p.e.id);
      result.edges_moved.push({ old: p.e.id, new: newId });
    }
    if (keysCopied.length) {
      recordPrior(db, anchor, { op: "merge_node", node_id: intoId, updated_by: into.updated_by ?? null, before: priorValues(intoMeta, keysCopied) });
      const patch: Record<string, unknown> = {};
      for (const k of keysCopied) patch[k] = fromMeta[k];
      db.prepare("UPDATE nodes SET metadata = ?, updated_by = ? WHERE id = ?").run(JSON.stringify(mergeMetadata(intoMeta, patch)), `api-${opts.by}`, intoId);
    }
    db.prepare("UPDATE node_aliases SET node_id = ? WHERE node_id = ?").run(intoId, fromId);
    const retire = { retired: true, retired_at: isoNow(), retired_by: opts.by, retired_reason: opts.reason, merged_into: intoId };
    recordPrior(db, anchor, { op: "retire_node", node_id: fromId, updated_by: from.updated_by ?? null, before: priorValues(fromMeta, Object.keys(retire)) });
    db.prepare("UPDATE nodes SET metadata = ?, updated_by = ? WHERE id = ?").run(JSON.stringify(mergeMetadata(fromMeta, retire)), `api-${opts.by}`, fromId);
    result.admin_signal_id = anchor;
    return result;
  });
}

// ---------- rewrite slugs to the current slugifier (issue #67) ----------------

export interface SlugRename {
  id: string;
  type: string;
  name: string;
  old: string;
  new: string;
}

export interface SlugMigrationResult {
  dry_run?: boolean;
  renamed: SlugRename[];
  /** Slugs whose new form another node of the same type already has: left as they are. */
  collisions: Array<SlugRename & { taken_by: string }>;
  admin_signal_id: string | null;
}

// A source suffix the import pipelines appended to keep same-named works
// apart (`--fxhash-113`, `--va-o239531`, `--superrare-1-0x…-2133`): kept.
const SOURCE_SUFFIX = /--((?:artblocks|fxhash|superrare|va)-[a-z0-9-]+)$/;

/** The slug a node would get today: slugify(name), with its source suffix kept. */
export function currentSlugFor(oldSlug: string, name: string): string {
  const suffix = SOURCE_SUFFIX.exec(oldSlug)?.[1];
  const head = slugify(name);
  return suffix ? `${head}--${suffix}` : head;
}

/**
 * Rewrite every slug with characters outside [a-z0-9-] to the current
 * slugifier's (`currentSlugFor`). Node ids never change — they are opaque
 * keys — only the address does, and the old one keeps working: a
 * node_aliases(source='slug') row 301s it (src/utils/moved.ts). One admin
 * signal anchors the run and holds each old slug as a before-image.
 */
export function migrateSlugs(db: DatabaseSync, opts: { by: string; dryRun?: boolean; only?: string[] }): SlugMigrationResult {
  const rows = db.prepare("SELECT id, type, name, slug, updated_by FROM nodes WHERE slug GLOB '*[^a-z0-9-]*' ORDER BY type, slug").all() as any[];
  const wanted = opts.only ? new Set(opts.only) : null;
  const taken = db.prepare("SELECT id FROM nodes WHERE type = ? AND slug = ? AND id != ?");
  const renamed: SlugRename[] = [];
  const collisions: SlugMigrationResult["collisions"] = [];
  const claimedNew = new Map<string, string>(); // type/slug → id, within this run
  for (const r of rows) {
    if (wanted && !wanted.has(r.id)) continue;
    const next = currentSlugFor(r.slug, r.name ?? r.slug);
    if (!next || next === r.slug) continue;
    const item = { id: r.id, type: r.type, name: r.name, old: r.slug, new: next };
    const other = (taken.get(r.type, next, r.id) as any)?.id ?? claimedNew.get(`${r.type}/${next}`);
    if (other) {
      collisions.push({ ...item, taken_by: other });
      continue;
    }
    claimedNew.set(`${r.type}/${next}`, r.id);
    renamed.push(item);
  }
  if (opts.dryRun || !renamed.length) return { dry_run: opts.dryRun || undefined, renamed, collisions, admin_signal_id: null };
  return withTx(db, () => {
    const anchor = insertAdminSignal(db, {
      by: opts.by,
      title: `Rewrite ${renamed.length} slug${renamed.length === 1 ? "" : "s"} to the current slugifier`,
      content: { action: "migrate_slugs", renamed: renamed.map(({ id, old, new: n }) => ({ id, old, new: n })) },
    });
    const updatedBy = new Map(rows.map((r) => [r.id, r.updated_by ?? null]));
    for (const r of renamed) {
      recordPrior(db, anchor, { op: "rename_slug", node_id: r.id, updated_by: updatedBy.get(r.id) ?? null, before: { slug: r.old } });
      db.prepare("UPDATE nodes SET slug = ? WHERE id = ?").run(r.new, r.id);
      keepOldSlug(db, r.type, r.old, r.id);
    }
    return { renamed, collisions, admin_signal_id: anchor };
  });
}
