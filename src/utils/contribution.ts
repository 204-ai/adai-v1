// Shared helpers for the /api/v1/* contributor API. Trust-tier gating, queue
// writes, contributor-row touches, deep metadata merging. Centralised so the
// signal / node / edge / image endpoints all agree on how to produce
// `intake_queue` rows that the existing curator UI can materialise.
//
// The queueing model reuses the columns already on `intake_queue`:
//   proposed_nodes  — JSON array of {op, ...} entries
//   proposed_edges  — JSON array of edge specs (matches AI-suggestion shape)
//   kind            — 'human_signal' (so the curator's human-signal tab picks it up)
//
// We don't migrate the schema for a new column; instead, the per-entry shape
// is discriminated by `op`:
//   { op: 'create_node',  type, name, slug, metadata, aliases? }
//   { op: 'patch_node',   node_id, metadata }            // metadata is a merge-patch
//   { op: 'attach_image', node_id, image_url, cdn_image_url, sha256 }
//   { op: 'end_edge',     edge_id, signal_id? }          // valid_until = now; never a delete
//
// Edges queue exactly like AI suggestions do today (see src/embed/derive.ts):
//   { source_id, target_id, edge_type, confidence?, event_time?, supersedes_edge_id? }
//
// The materialiser in src/routes/api.ts → POST /api/review/:id/approve has
// matching switch cases.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isAutoMerge, type AuthedContributor } from "../auth.js";
import { contributionWritten } from "../notify/kick.js";

export type ProposedNodeOp =
  | { op: "create_node"; type: string; name: string; slug: string; metadata?: any; aliases?: Array<{ source: string; external_id: string }> }
  | { op: "patch_node"; node_id: string; metadata: any; signal_id?: string | null }
  | { op: "attach_image"; node_id: string; image_url: string; cdn_image_url: string; sha256: string; signal_id?: string | null }
  | { op: "end_edge"; edge_id: string; signal_id?: string | null };

export interface ProposedEdge {
  source_id: string;
  target_id: string;
  edge_type: string;
  confidence?: string;
  event_time?: string | null;
  supersedes_edge_id?: string | null;
  signal_id?: string | null;
}

// Sanity-check a contributed source_url before it enters the graph. There is
// deliberately NO domain allowlist — that would fight the open-contribution
// model — but the value is later rendered as a link (profile pages, the
// /field footer, the trust-hover tooltip), so it must at least be an absolute
// http(s) URL with a plausible host. Empty/absent is fine (the field is
// optional); anything else malformed is rejected with a reason the caller can
// surface. Shared by POST /api/contribute and POST /api/v1/signals.
export function validateSourceUrl(
  value: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "source_url must be a string" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "source_url must be an absolute URL (https://…)" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "source_url must use http or https" };
  }
  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    return { ok: false, error: "source_url must have a resolvable host" };
  }
  return { ok: true, value: trimmed };
}

export function ensureContributorRow(db: DatabaseSync, contributor: AuthedContributor): void {
  // Keep `contributions` accurate. The contributor row already exists (we
  // joined to it on auth), so increment unconditionally.
  db.prepare("UPDATE contributors SET contributions = contributions + 1 WHERE id = ?").run(contributor.id);
}

// Bump `approved_count` when a contribution lands live, either immediately
// (auto-merge) or later (curator approval). For the curator path the existing
// /api/review approve handler already does this — we only call it from the
// auto-merge path.
export function bumpApprovedCount(db: DatabaseSync, contributorId: string): void {
  db.prepare("UPDATE contributors SET approved_count = approved_count + 1 WHERE id = ?").run(contributorId);
}

// Write a signal row that captures the contributor's intent verbatim. We use
// `signals` as the audit anchor for every /api/v1 write — even when it ends
// up materialising a node or an edge — so the provenance chain stays intact.
export interface CreateSignalArgs {
  contributor: AuthedContributor;
  title: string;
  content: string;             // free text or JSON-stringified payload
  source_url?: string | null;
  source_type?: string;        // 'contribution' (default) | 'api_node' | 'api_edge' | 'api_image'
  consent_scope?: string;
  consent_attribution?: string;
  batch_id?: string | null;    // caller-supplied session/batch handle (signals.batch_id)
  source_origin?: string;      // default 'human_primary'; URL intake writes 'url_intake'
  provenance_chain?: string | null; // JSON: e.g. {draft_id, cid, origin, page_sha256}
}

export function insertSignal(db: DatabaseSync, args: CreateSignalArgs): string {
  const signalId = `signal-${crypto.randomBytes(8).toString("hex")}`;
  const scope = args.consent_scope === "structural_only" ? "structural_only" : "full_commons";
  const attribution =
    args.consent_attribution === "anonymous" || args.consent_attribution === "attributed_with_notification"
      ? args.consent_attribution
      : "attributed";
  db.prepare(
    "INSERT INTO signals (id, title, source_url, source_type, cla_layer, summary, content, submitted_by, confidence, lived_experience, consent_scope, consent_attribution, source_origin, batch_id, provenance_chain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    signalId,
    args.title,
    args.source_url ?? null,
    args.source_type ?? "contribution",
    null,
    null,
    args.content,
    args.contributor.name,
    args.contributor.trust_tier,
    0,
    scope,
    attribution,
    args.source_origin ?? "human_primary",
    args.batch_id ?? null,
    args.provenance_chain ?? null
  );
  // The authenticated author, by id (issue #80): submitted_by is only a name.
  db.prepare("INSERT OR IGNORE INTO signal_authors (signal_id, contributor_id, via) VALUES (?, ?, 'write')").run(signalId, args.contributor.id);
  // Claimants hear about it (issue #81): the listener only schedules a pass,
  // after this write's transaction has had time to commit.
  contributionWritten();
  return signalId;
}

export interface QueueArgs {
  contributor: AuthedContributor;
  signal_id: string;
  target_node?: string | null;
  proposed_nodes?: ProposedNodeOp[];
  proposed_edges?: ProposedEdge[];
}

// Insert a row into intake_queue and return its id and resolved status. Status
// reflects the contributor's trust tier: auto/reviewed → 'approved', anyone
// else → 'pending' (curator must approve).
export function insertIntake(db: DatabaseSync, args: QueueArgs): { intake_id: string; status: "approved" | "pending" } {
  const intakeId = `intake-${crypto.randomBytes(8).toString("hex")}`;
  const status: "approved" | "pending" = isAutoMerge(args.contributor.trust_tier) ? "approved" : "pending";
  const proposedNodes = args.proposed_nodes && args.proposed_nodes.length ? JSON.stringify(args.proposed_nodes) : null;
  const proposedEdges = args.proposed_edges && args.proposed_edges.length ? JSON.stringify(args.proposed_edges) : null;
  db.prepare(
    "INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status, kind, proposed_nodes, proposed_edges) VALUES (?, ?, ?, ?, ?, ?, 'human_signal', ?, ?)"
  ).run(intakeId, args.signal_id, args.target_node ?? null, args.contributor.name, args.contributor.trust_tier, status, proposedNodes, proposedEdges);
  return { intake_id: intakeId, status };
}

// Deep-merge `patch` into `base`. Plain object values are merged recursively;
// arrays / scalars / nulls in `patch` overwrite. Null in `patch` deletes the
// key. Matches the JSON merge-patch semantics curators expect when they
// "edit metadata" — we don't want a one-key patch to clobber the whole blob.
export function mergeMetadata(base: any, patch: any): any {
  if (patch === null || patch === undefined) return base ?? {};
  if (typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: any = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null) {
      delete out[k];
    } else if (typeof v === "object" && !Array.isArray(v)) {
      out[k] = mergeMetadata(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Helpers shared with the curator approve path. The materialise* functions
// execute the heavy lifting once a queued contribution becomes live.

export function materialiseCreateNode(
  db: DatabaseSync,
  op: Extract<ProposedNodeOp, { op: "create_node" }>,
  context: { signalId: string | null; createdBy: string }
): { node_id: string; created: boolean } {
  const nodeId = `${op.type}:${op.slug}`;
  const existing = db.prepare("SELECT id FROM nodes WHERE id = ?").get(nodeId) as any;
  if (existing) {
    // First-write-wins. Don't clobber.
    return { node_id: nodeId, created: false };
  }
  const metadataStr = op.metadata ? JSON.stringify(op.metadata) : null;
  db.prepare(
    "INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(nodeId, op.type, op.name, op.slug, metadataStr, context.createdBy);
  if (op.aliases?.length) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO node_aliases (source, external_id, node_id, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
    );
    for (const a of op.aliases) ins.run(a.source, a.external_id, nodeId);
  }
  return { node_id: nodeId, created: true };
}

// The before-image of a node write. Metadata is overwritten in place, so the
// value a write replaced survives only here: appended to the causing signal's
// processing_trace as {"prior": [{op, node_id, at, updated_by, before}]}.
// `before` maps each top-level metadata key the write touched to its old
// value (null = the key was absent); `updated_by` is the previous writer.
// A signal can anchor several writes (a batch retire), hence the list.
export function recordPrior(
  db: DatabaseSync,
  signalId: string | null | undefined,
  entry: { op: string; node_id: string; updated_by: string | null; before: Record<string, unknown> }
): void {
  if (!signalId) return;
  const row = db.prepare("SELECT processing_trace FROM signals WHERE id = ?").get(signalId) as any;
  if (!row) return;
  let trace: any = {};
  if (row.processing_trace) {
    try { trace = JSON.parse(row.processing_trace); } catch { trace = {}; }
  }
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) trace = {};
  const prior = Array.isArray(trace.prior) ? trace.prior : [];
  prior.push({ op: entry.op, node_id: entry.node_id, at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), updated_by: entry.updated_by, before: entry.before });
  trace.prior = prior;
  db.prepare("UPDATE signals SET processing_trace = ? WHERE id = ?").run(JSON.stringify(trace), signalId);
}

export function priorValues(base: any, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = base && Object.prototype.hasOwnProperty.call(base, k) ? base[k] : null;
  return out;
}

export function materialisePatchNode(
  db: DatabaseSync,
  op: Extract<ProposedNodeOp, { op: "patch_node" }>,
  context: { createdBy: string; signalId?: string | null }
): void {
  const row = db.prepare("SELECT metadata, updated_by FROM nodes WHERE id = ?").get(op.node_id) as any;
  if (!row) return;
  let base: any = {};
  if (row.metadata) {
    try { base = JSON.parse(row.metadata); } catch { base = {}; }
  }
  const keys = op.metadata && typeof op.metadata === "object" && !Array.isArray(op.metadata) ? Object.keys(op.metadata) : [];
  recordPrior(db, context.signalId, { op: "patch_node", node_id: op.node_id, updated_by: row.updated_by ?? null, before: priorValues(base, keys) });
  const merged = mergeMetadata(base, op.metadata);
  db.prepare("UPDATE nodes SET metadata = ?, updated_by = ? WHERE id = ?")
    .run(JSON.stringify(merged), context.createdBy, op.node_id);
}

export function materialiseAttachImage(
  db: DatabaseSync,
  op: Extract<ProposedNodeOp, { op: "attach_image" }>,
  context: { createdBy: string; signalId?: string | null }
): void {
  const row = db.prepare("SELECT metadata, updated_by FROM nodes WHERE id = ?").get(op.node_id) as any;
  if (!row) return;
  let base: any = {};
  if (row.metadata) {
    try { base = JSON.parse(row.metadata); } catch { base = {}; }
  }
  recordPrior(db, context.signalId, {
    op: "attach_image",
    node_id: op.node_id,
    updated_by: row.updated_by ?? null,
    before: priorValues(base, ["cdn_image_url", "image_url", "image_sha256"]),
  });
  // Don't overwrite a provenance image_url if the node already has one — the
  // contributor's upload is mirrored but the upstream source stays authoritative.
  // We always (re)write cdn_image_url to point at the freshly uploaded copy.
  const patch: any = { cdn_image_url: op.cdn_image_url };
  if (!base.image_url) patch.image_url = op.image_url;
  patch.image_sha256 = op.sha256;
  const merged = mergeMetadata(base, patch);
  db.prepare("UPDATE nodes SET metadata = ?, updated_by = ? WHERE id = ?")
    .run(JSON.stringify(merged), context.createdBy, op.node_id);
}

// End a live edge: the relation stops being current (valid_until = now) and
// points at the signal that says so. Nothing is deleted; an edge that is
// already closed stays as it was. Used by URL intake for present-tense
// relations a site no longer shows (REPRESENTS after an artist leaves a
// roster).
export function materialiseEndEdge(
  db: DatabaseSync,
  op: Extract<ProposedNodeOp, { op: "end_edge" }>,
  context: { signalId: string | null }
): { ended: boolean } {
  const r = db
    .prepare("UPDATE edges SET valid_until = strftime('%Y-%m-%dT%H:%M:%SZ','now'), invalidated_by = ? WHERE id = ? AND valid_until IS NULL")
    .run(op.signal_id ?? context.signalId ?? null, op.edge_id);
  return { ended: Number(r.changes) > 0 };
}

// Materialise an edge. Mirrors the loop in the /api/review approve handler
// for ai_suggestion rows, but adds bi-temporal supersession when
// supersedes_edge_id is set.
//
// Edge IDs are deterministic on (source, type, target, created_by) for the
// no-supersession path so duplicate POSTs are idempotent (INSERT OR IGNORE).
// When supersedes_edge_id is set we DELIBERATELY break determinism by
// appending a short random suffix — otherwise the same triple can't be
// re-attested (the new id would collide with the existing row, IGNORE would
// drop the insert, and the supersession UPDATE would mark the existing row
// as superseded by itself).
export function materialiseEdge(
  db: DatabaseSync,
  edge: ProposedEdge,
  context: { signalId: string | null; createdBy: string }
): { edge_id: string; superseded: string | null } {
  const base = `${edge.source_id}--${edge.edge_type}--${edge.target_id}--${context.createdBy}`;
  const edgeId = edge.supersedes_edge_id
    ? `${base}--${crypto.randomBytes(4).toString("hex")}`
    : base;
  db.prepare(
    `INSERT OR IGNORE INTO edges (
       id, source_id, target_id, edge_type, signal_id,
       confidence, charge, created_at, created_by,
       event_time, valid_from, valid_until, invalidated_by
     ) VALUES (?, ?, ?, ?, ?,
               ?, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?,
               ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), NULL, NULL)`
  ).run(
    edgeId,
    edge.source_id,
    edge.target_id,
    edge.edge_type,
    edge.signal_id ?? context.signalId ?? null,
    edge.confidence ?? "medium",
    context.createdBy,
    edge.event_time ?? null
  );

  let superseded: string | null = null;
  if (edge.supersedes_edge_id) {
    if (edge.supersedes_edge_id === edgeId) {
      // Defensive — should never trigger now that we append a suffix.
      return { edge_id: edgeId, superseded: null };
    }
    const old = db.prepare("SELECT id, valid_until FROM edges WHERE id = ?").get(edge.supersedes_edge_id) as any;
    if (old && !old.valid_until) {
      db.prepare(
        "UPDATE edges SET valid_until = strftime('%Y-%m-%dT%H:%M:%SZ','now'), invalidated_by = ? WHERE id = ?"
      ).run(edgeId, edge.supersedes_edge_id);
      superseded = edge.supersedes_edge_id;
    }
  }

  return { edge_id: edgeId, superseded };
}
