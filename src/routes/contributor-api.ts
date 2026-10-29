// /api/v1/* — bearer-token contributor API for AI-mediated edits to the
// A(DAI) graph. Surfaces signals, nodes, edges, and image uploads. Every
// endpoint applies `requireToken` and respects the contributor's trust tier:
//   auto / reviewed  → write directly to live tables
//   probationary     → land in intake_queue as kind='human_signal' with
//                      proposed_nodes / proposed_edges populated; the curator
//                      materialises on approve via /api/review/:id/approve.
//
// See SKILL.md (and /skill.md served from src/routes/pages.ts) for the
// caller-facing description of these endpoints.

import { Router } from "express";
import multer from "multer";
import { getDb } from "../db.js";
import { JSON_HEADERS } from "../templates.js";
import { ownedBySql } from "../utils/authorship.js";
import { requireToken, requireAdmin, isAutoMerge } from "../auth.js";
import { mintToken, revokeTokenByPrefix, listTokens, setTokenNode, setContributorTier, MintError } from "../utils/token-mint.js";
import { slugify, slugForCreate } from "../utils/slug.js";
import {
  insertSignal,
  insertIntake,
  validateSourceUrl,
  ensureContributorRow,
  bumpApprovedCount,
  mergeMetadata,
  existingNodeBySlug,
  materialiseCreateNode,
  materialisePatchNode,
  materialiseAttachImage,
  materialiseEdge,
  type ProposedEdge,
  type ProposedNodeOp,
} from "../utils/contribution.js";
import { uploadImage, isR2Configured } from "../r2.js";
import { mirrorImageFromUrl, ImageFetchError } from "../utils/images.js";
import { sniffImageMime } from "../utils/ssrf.js";
import { getSkillVersion } from "../utils/skill-version.js";
import { embedNodeAsync, embedNodesAsync } from "../embed/server.js";
import { NODE_NOT_RETIRED } from "../utils/visibility.js";
import { normaliseOrgKinds, orgKindsError, ORG_KINDS } from "../utils/org-kinds.js";
import { checkDirection } from "../intake/candidate.js";
import { ensureContributorForEmail, normaliseEmail, revokeInvite, intakeOpen, requestedName } from "../intake/auth.js";
import { sendLoginEmail } from "../intake/mail.js";
import { approveIntakeItem, rejectIntakeItem } from "../utils/review.js";
import { backfillInviteClaims, endClaim, ClaimError } from "../claim/store.js";
import { notifyAfterReview } from "../claim/mail.js";
import {
  AdminActionError,
  revokeSignal,
  retireNode,
  retireBatch,
  listBatches,
} from "../utils/admin-actions.js";

const router = Router();

// Permissive list (advisory, not enforced). Anything outside emits a warning
// in the response but is still accepted, mirroring the schema's permissive
// stance. Keep in sync with CLAUDE.md's "Node types" / "Edge types" sections.
const KNOWN_NODE_TYPES = new Set([
  "practitioner", "artwork", "concept", "scene", "institution", "collective",
  "platform", "publication", "project", "classification_regime", "event", "related",
]);
const CURATED_EDGE_TYPES = new Set([
  "EMBODIES", "CREATED_BY", "PRACTICES", "EXHIBITED_AT", "CLASSIFIED_BY",
  "BELONGS_TO", "COLLABORATES_WITH", "USES_TECHNIQUE", "INFLUENCES", "RESPONDS_TO",
  // Show / gallery relations. A show or fair is modelled as a `project` node;
  // these four connect it to its artists, host, curator, and the gallery's
  // roster (EXHIBITED_AT only spans artwork → institution, so without these a
  // show and its gallery are orphans by construction).
  "PARTICIPATED_IN", "PRESENTED_BY", "CURATED_BY", "REPRESENTS",
  // A work in a collection (museum, private or corporate). EXHIBITED_AT says
  // where it was shown; HELD_BY says who holds it.
  "HELD_BY",
  // A catalogue, book or journal issue (a `publication` node) documenting a
  // show (`project`) or a work (#80 part 4).
  "DOCUMENTS",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12 MB cap, matches the Python uploader
});

// Optional batch handle on every write — stamped on the anchoring signal's
// batch_id column so a whole upload session can be inspected (GET
// /api/v1/batches) and, if it went wrong, rolled back in one admin call
// (POST /api/v1/batches/:batch_id/retire). Conventions in SKILL.md §1.7.
const BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
function parseBatchId(raw: unknown): { ok: boolean; value: string | null } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string" || !BATCH_ID_RE.test(raw)) return { ok: false, value: null };
  return { ok: true, value: raw };
}
const BATCH_ID_HINT = "batch_id must be 1-120 chars: letters/digits then letters, digits, '.', '_', ':', '-'";

// CORS preflight for the API namespace. We allow Authorization here since the
// shared JSON_HEADERS in templates.ts doesn't include it (the rest of the
// site is anonymous read-only).
router.options("/api/v1/*splat", (_req, res) => {
  res
    .set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
    })
    .status(204)
    .end();
});

// ---------- GET /api/v1/whoami --------------------------------------------

router.get("/api/v1/whoami", requireToken, (req, res) => {
  res.set(JSON_HEADERS).json({
    contributor: {
      id: req.contributor!.id,
      name: req.contributor!.name,
      trust_tier: req.contributor!.trust_tier,
    },
    token_label: req.contributor!.token_label,
    token_prefix: req.contributor!.token_prefix,
    scope: req.contributor!.scope,
    r2_configured: isR2Configured(),
    // Current canonical skill version; a caller compares this to the version
    // stamped in its own downloaded SKILL.md to detect a stale copy (§0).
    skill_version: getSkillVersion(),
  });
});

// ---------- GET /api/v1/contributions --------------------------------------
// The contributor's own history — every write they've made through this API
// (and the legacy form), with its review status. Answers "what have I
// contributed, and did it go live?" without a curator having to dig through
// /review. Token-scoped: you only ever see your own rows.
//
// Query params: ?status=pending|approved|rejected  ?batch=<batch_id>  ?limit=N (default 50, max 200)
//
// Caveat: intake_queue is a local-only table, so history reaches back to the
// last volume genesis — long enough for "what did I add this week?", which is
// the question this answers.

router.get("/api/v1/contributions", requireToken, (req, res) => {
  const db = getDb();
  const name = req.contributor!.name;
  const statusFilter = typeof req.query.status === "string" ? req.query.status : null;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50;

  // Ownership is never the queue row's submitter name (anyone can type a
  // name into the public form): the signal must provably be this
  // contributor's (ownedBySql — its authenticated author first), or the row
  // is their own claim request. Only then is signals_full read.
  const OWNED = `((q.signal_id IS NOT NULL AND ${ownedBySql("s")})
    OR (q.signal_id IS NULL AND EXISTS (SELECT 1 FROM node_claims k WHERE k.queue_id = q.id AND k.contributor_id = :owner_id)))`;
  const where: string[] = [OWNED];
  const params: Record<string, string | number> = { owner_id: req.contributor!.id, owner_name: name };
  if (statusFilter) {
    where.push("q.status = :status");
    params.status = statusFilter;
  }
  const batchFilter = typeof req.query.batch === "string" && req.query.batch ? req.query.batch : null;
  if (batchFilter) {
    where.push("s.batch_id = :batch");
    params.batch = batchFilter;
  }

  const rows = db
    .prepare(
      `SELECT q.id AS intake_id, q.signal_id, q.target_node, q.status,
              q.created_at, q.reviewed_at, q.rejection_reason,
              q.proposed_nodes, q.proposed_edges,
              s.title AS title, s.source_type AS source_type, s.batch_id AS batch_id
         FROM intake_queue q
         LEFT JOIN signals_full s ON s.id = q.signal_id
        WHERE ${where.join(" AND ")}
        ORDER BY q.created_at DESC
        LIMIT :limit`
    )
    .all({ ...params, limit }) as Array<{
      intake_id: string;
      signal_id: string | null;
      target_node: string | null;
      status: string;
      created_at: string | null;
      reviewed_at: string | null;
      rejection_reason: string | null;
      proposed_nodes: string | null;
      proposed_edges: string | null;
      title: string | null;
      source_type: string | null;
      batch_id: string | null;
    }>;

  // Derive a human-readable action per row from the signal's source_type +
  // the proposed op, so the caller doesn't have to parse proposed_nodes.
  // (deriveAction is declared below with the admin review endpoints —
  // function declarations hoist.)
  const items = rows.map((r) => {
    const action = deriveAction(r.source_type, r.proposed_nodes);
    return {
      intake_id: r.intake_id,
      action,
      target_node: r.target_node,
      status: r.status,
      created_at: r.created_at,
      reviewed_at: r.reviewed_at,
      ...(r.rejection_reason ? { rejection_reason: r.rejection_reason } : {}),
      signal_id: r.signal_id,
      title: r.title,
      ...(r.batch_id ? { batch_id: r.batch_id } : {}),
    };
  });

  const totals = db
    .prepare(
      `SELECT q.status AS status, COUNT(*) AS n FROM intake_queue q LEFT JOIN signals_full s ON s.id = q.signal_id
        WHERE ${OWNED} GROUP BY q.status`
    )
    .all({ owner_id: req.contributor!.id, owner_name: name }) as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  for (const t of totals) byStatus[t.status] = t.n;

  res.set(JSON_HEADERS).json({
    contributor: {
      id: req.contributor!.id,
      name,
      trust_tier: req.contributor!.trust_tier,
    },
    totals: byStatus,
    returned: items.length,
    items,
  });
});

// ---------- POST /api/v1/signals ------------------------------------------
// JSON: { target_node, title, content, source_url?, consent_scope?, consent_attribution? }

router.post("/api/v1/signals", requireToken, (req, res) => {
  const db = getDb();
  const { target_node, title, content, source_url, consent_scope, consent_attribution, batch_id } = req.body ?? {};
  const batch = parseBatchId(batch_id);
  if (!batch.ok) {
    res.status(400).set(JSON_HEADERS).json({ error: "invalid batch_id", hint: BATCH_ID_HINT });
    return;
  }

  if (!target_node || typeof target_node !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "target_node is required" });
    return;
  }
  if (!title || typeof title !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "title is required" });
    return;
  }
  if (!content || typeof content !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "content is required" });
    return;
  }
  const target = db.prepare("SELECT id FROM nodes WHERE id = ?").get(target_node) as any;
  if (!target) {
    res.status(400).set(JSON_HEADERS).json({ error: "target_node does not exist", target_node });
    return;
  }
  const srcUrl = validateSourceUrl(source_url);
  if (!srcUrl.ok) {
    res.status(400).set(JSON_HEADERS).json({ error: srcUrl.error });
    return;
  }

  const signalId = insertSignal(db, {
    contributor: req.contributor!,
    title,
    content,
    source_url: srcUrl.value,
    source_type: "contribution",
    consent_scope,
    consent_attribution,
    batch_id: batch.value,
    pending: !isAutoMerge(req.contributor!.trust_tier),
  });
  const { intake_id, status } = insertIntake(db, {
    contributor: req.contributor!,
    signal_id: signalId,
    target_node,
  });
  ensureContributorRow(db, req.contributor!, signalId);
  if (status === "approved") bumpApprovedCount(db, req.contributor!.id, signalId);

  res.set(JSON_HEADERS).json({ signal_id: signalId, intake_id, status, target_node });
});

// ---------- POST /api/v1/nodes --------------------------------------------
// JSON: { type, name, slug?, metadata?, aliases?: [{ source, external_id }] }

router.post("/api/v1/nodes", requireToken, (req, res) => {
  const db = getDb();
  const { type, name, slug: providedSlug, metadata, aliases, batch_id } = req.body ?? {};
  const batch = parseBatchId(batch_id);
  if (!batch.ok) {
    res.status(400).set(JSON_HEADERS).json({ error: "invalid batch_id", hint: BATCH_ID_HINT });
    return;
  }

  if (!type || typeof type !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "type is required" });
    return;
  }
  if (!name || typeof name !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "name is required" });
    return;
  }
  if (metadata !== undefined && (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))) {
    res.status(400).set(JSON_HEADERS).json({ error: "metadata must be a JSON object" });
    return;
  }
  if (aliases !== undefined && !Array.isArray(aliases)) {
    res.status(400).set(JSON_HEADERS).json({ error: "aliases must be an array" });
    return;
  }
  const aliasItems: Array<{ source: string; external_id: string }> = [];
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (!a || typeof a.source !== "string" || typeof a.external_id !== "string") {
        res.status(400).set(JSON_HEADERS).json({ error: "each alias needs {source, external_id}" });
        return;
      }
      aliasItems.push({ source: a.source, external_id: a.external_id });
    }
  }

  const warnings: string[] = [];
  if (!KNOWN_NODE_TYPES.has(type)) {
    warnings.push(`unknown node type "${type}" — accepted, but check CLAUDE.md`);
  }

  // Field-status guard (mirrors colorForNode() in graph-field.js): a concept
  // with NO tag_origin renders as a curated *field* in /field. Only admin-scope
  // tokens may mint one. A non-admin concept create is stamped with a tag_origin
  // so it lands as a muted, contributor-origin concept instead of masquerading
  // as a curated field. (fxhash concepts carry tag_origin:"platform-tags";
  // contributor concepts get "contributor".) A curator can later promote it by
  // clearing tag_origin via PATCH — which is itself admin-gated below.
  let effectiveMetadata: Record<string, any> = metadata ?? {};
  if (type === "concept" && req.contributor!.scope !== "admin") {
    effectiveMetadata = { ...effectiveMetadata, tag_origin: "contributor" };
    warnings.push(
      "concept created as a contributor-origin tag, not a curated field — an admin/curator can promote it by clearing tag_origin"
    );
  }

  // What an organisation says it is: values from the fixed list, several allowed.
  if (type === "institution" && effectiveMetadata.kind !== undefined && effectiveMetadata.kind !== null) {
    const k = normaliseOrgKinds(effectiveMetadata.kind);
    if (!k.ok) {
      res.status(400).set(JSON_HEADERS).json({ error: "invalid_kind", message: orgKindsError(k.unknown), allowed: ORG_KINDS });
      return;
    }
    effectiveMetadata = { ...effectiveMetadata, kind: k.kinds };
  }

  // The slug is a URL path segment: an explicit one goes through the same
  // slugifier as a name (a `#` or `,` in it broke the page address).
  let slug: string;
  if (typeof providedSlug === "string" && providedSlug.length > 0) {
    slug = slugify(providedSlug);
    if (slug !== providedSlug) warnings.push(`slug "${providedSlug}" normalised to "${slug}"`);
  } else {
    slug = slugForCreate((id) => !!db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id), type, name);
  }
  if (!slug) {
    res.status(400).set(JSON_HEADERS).json({ error: "invalid_slug", message: "the name (or slug) has no letters or digits to make an address from" });
    return;
  }
  // Server-side dedupe on (type, slug): a legacy node keeps its spaced id
  // (`practitioner:patrick tresset`) with the hyphen form in its slug column,
  // so the exact-id check above misses it — and an explicit slug skips it.
  // The create then resolves to that node (created:false), never a duplicate.
  let computedId = `${type}:${slug}`;
  if (!db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(computedId)) {
    const sameSlug = existingNodeBySlug(db, type, slug);
    if (sameSlug) {
      warnings.push(`a ${type} with slug "${slug}" already exists as ${sameSlug} — no new node was created; use that id`);
      computedId = sameSlug;
    }
  }

  // Signal anchors every contribution. Stash the full payload so the curator
  // can review verbatim.
  const signalId = insertSignal(db, {
    contributor: req.contributor!,
    title: `Create node: ${type}:${name}`,
    content: JSON.stringify({ type, name, slug, metadata: effectiveMetadata, aliases: aliasItems }),
    source_type: "api_node",
    batch_id: batch.value,
    pending: !isAutoMerge(req.contributor!.trust_tier),
  });

  if (isAutoMerge(req.contributor!.trust_tier)) {
    const { created } = materialiseCreateNode(
      db,
      { op: "create_node", type, name, slug, metadata: effectiveMetadata, aliases: aliasItems },
      { signalId, createdBy: `api-${req.contributor!.name}` }
    );
    // Still write an intake row marked approved for audit symmetry.
    const { intake_id } = insertIntake(db, {
      contributor: req.contributor!,
      signal_id: signalId,
      target_node: computedId,
      proposed_nodes: [{ op: "create_node", type, name, slug, metadata: effectiveMetadata, aliases: aliasItems }],
    });
    ensureContributorRow(db, req.contributor!, signalId);
    bumpApprovedCount(db, req.contributor!.id, signalId);
    // Embed the new node in the background; failures are caught by the
    // daily backfill in .github/workflows/embed-derive-daily.yml.
    embedNodeAsync(db, computedId);
    res.set(JSON_HEADERS).json({
      node_id: computedId,
      created,
      status: "approved",
      signal_id: signalId,
      intake_id,
      warnings,
    });
    return;
  }

  // Probationary — queue.
  const { intake_id, status } = insertIntake(db, {
    contributor: req.contributor!,
    signal_id: signalId,
    target_node: computedId,
    proposed_nodes: [{ op: "create_node", type, name, slug, metadata: effectiveMetadata, aliases: aliasItems }],
  });
  ensureContributorRow(db, req.contributor!, signalId);
  res.set(JSON_HEADERS).json({
    node_id: computedId,
    created: false,
    status,
    signal_id: signalId,
    intake_id,
    warnings,
  });
});

// ---------- PATCH /api/v1/nodes/:id ---------------------------------------
// JSON body is treated as a JSON-merge-patch of metadata. null values delete.

router.patch("/api/v1/nodes/:id", requireToken, (req, res) => {
  const db = getDb();
  const nodeId = String(req.params.id);
  const patch = req.body;
  // The body IS the merge-patch, so the batch handle rides as a query param
  // here (?batch_id=...) instead of a body field.
  const batch = parseBatchId(req.query.batch_id);
  if (!batch.ok) {
    res.status(400).set(JSON_HEADERS).json({ error: "invalid batch_id", hint: BATCH_ID_HINT });
    return;
  }

  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    res.status(400).set(JSON_HEADERS).json({ error: "request body must be a JSON object (merge-patch on metadata)" });
    return;
  }
  const existing = db.prepare("SELECT id, type FROM nodes WHERE id = ?").get(nodeId) as any;
  if (!existing) {
    res.status(404).set(JSON_HEADERS).json({ error: "node not found", node_id: nodeId });
    return;
  }

  // Field-status guard (mirror of the create-time stamp): only admins may
  // touch a concept's tag_origin. Clearing it would promote a contributor /
  // folksonomy concept into a curated field — see colorForNode() in
  // graph-field.js. Everything else about a concept stays patchable.
  if (
    existing.type === "concept" &&
    req.contributor!.scope !== "admin" &&
    Object.prototype.hasOwnProperty.call(patch, "tag_origin")
  ) {
    res.status(403).set(JSON_HEADERS).json({
      error: "admin_scope_required",
      hint: "Only an admin/curator can change a concept's field status (tag_origin).",
    });
    return;
  }

  if (existing.type === "institution" && patch.kind !== undefined && patch.kind !== null) {
    const k = normaliseOrgKinds(patch.kind);
    if (!k.ok) {
      res.status(400).set(JSON_HEADERS).json({ error: "invalid_kind", message: orgKindsError(k.unknown), allowed: ORG_KINDS });
      return;
    }
    patch.kind = k.kinds;
  }

  const signalId = insertSignal(db, {
    contributor: req.contributor!,
    title: `Patch node metadata: ${nodeId}`,
    content: JSON.stringify({ node_id: nodeId, patch }),
    source_type: "api_node",
    batch_id: batch.value,
    pending: !isAutoMerge(req.contributor!.trust_tier),
  });

  if (isAutoMerge(req.contributor!.trust_tier)) {
    materialisePatchNode(db, { op: "patch_node", node_id: nodeId, metadata: patch }, { createdBy: `api-${req.contributor!.name}`, signalId });
    const { intake_id } = insertIntake(db, {
      contributor: req.contributor!,
      signal_id: signalId,
      target_node: nodeId,
      proposed_nodes: [{ op: "patch_node", node_id: nodeId, metadata: patch }],
    });
    ensureContributorRow(db, req.contributor!, signalId);
    bumpApprovedCount(db, req.contributor!.id, signalId);
    // Re-embed if the patched metadata changed text-derived content. The
    // (text_hash, image_hash) idempotency check in embedNodeNow makes this
    // a no-op when nothing meaningful shifted.
    embedNodeAsync(db, nodeId);
    res.set(JSON_HEADERS).json({ node_id: nodeId, status: "approved", signal_id: signalId, intake_id });
    return;
  }

  const { intake_id, status } = insertIntake(db, {
    contributor: req.contributor!,
    signal_id: signalId,
    target_node: nodeId,
    proposed_nodes: [{ op: "patch_node", node_id: nodeId, metadata: patch }],
  });
  ensureContributorRow(db, req.contributor!, signalId);
  res.set(JSON_HEADERS).json({ node_id: nodeId, status, signal_id: signalId, intake_id });
});

// ---------- POST /api/v1/edges --------------------------------------------
// JSON: { source_id, target_id, edge_type, confidence?, event_time?, supersedes_edge_id? }

router.post("/api/v1/edges", requireToken, (req, res) => {
  const db = getDb();
  const { source_id, target_id, edge_type, confidence, event_time, supersedes_edge_id, batch_id } = req.body ?? {};
  const batch = parseBatchId(batch_id);
  if (!batch.ok) {
    res.status(400).set(JSON_HEADERS).json({ error: "invalid batch_id", hint: BATCH_ID_HINT });
    return;
  }

  for (const [k, v] of [["source_id", source_id], ["target_id", target_id], ["edge_type", edge_type]] as const) {
    if (!v || typeof v !== "string") {
      res.status(400).set(JSON_HEADERS).json({ error: `${k} is required` });
      return;
    }
  }
  // Existence checks — net new for the contributor API (legacy /api/contribute
  // doesn't validate FKs). Surfacing 400 here catches hallucinated IDs early.
  const src = db.prepare("SELECT id FROM nodes WHERE id = ?").get(source_id) as any;
  if (!src) {
    res.status(400).set(JSON_HEADERS).json({ error: "source_id does not exist", source_id });
    return;
  }
  const dst = db.prepare("SELECT id FROM nodes WHERE id = ?").get(target_id) as any;
  if (!dst) {
    res.status(400).set(JSON_HEADERS).json({ error: "target_id does not exist", target_id });
    return;
  }
  if (supersedes_edge_id) {
    const old = db.prepare("SELECT id FROM edges WHERE id = ?").get(supersedes_edge_id) as any;
    if (!old) {
      res.status(400).set(JSON_HEADERS).json({ error: "supersedes_edge_id does not exist", supersedes_edge_id });
      return;
    }
  }

  const warnings: string[] = [];
  if (!CURATED_EDGE_TYPES.has(edge_type)) {
    warnings.push(`uncurated edge type "${edge_type}" — accepted, but prefer one of: EMBODIES, CREATED_BY, PRACTICES, EXHIBITED_AT, CLASSIFIED_BY, BELONGS_TO, COLLABORATES_WITH, USES_TECHNIQUE, INFLUENCES, RESPONDS_TO, PARTICIPATED_IN, PRESENTED_BY, CURATED_BY, REPRESENTS, HELD_BY, DOCUMENTS`);
  }
  // Direction: a warning here, not a refusal — external callers predate the
  // table. The URL intake refuses (src/intake/candidate.ts).
  try {
    checkDirection({ source: source_id, target: target_id, edge_type }, (ref) => (ref.includes(":") ? ref.slice(0, ref.indexOf(":")) : null));
  } catch (e: any) {
    warnings.push(`direction: ${e?.message ?? e}`);
  }
  if (edge_type === "INFLUENCES" || edge_type === "RESPONDS_TO") {
    // Soft policy: these require human-attested intent (see CLAUDE.md).
    warnings.push(`${edge_type} edges should reflect attested artist intent — make sure source_url anchors a statement, interview, or first-person attestation.`);
  }

  const proposed: ProposedEdge = {
    source_id,
    target_id,
    edge_type,
    confidence: typeof confidence === "string" ? confidence : "medium",
    event_time: typeof event_time === "string" ? event_time : null,
    supersedes_edge_id: typeof supersedes_edge_id === "string" ? supersedes_edge_id : null,
  };

  const signalId = insertSignal(db, {
    contributor: req.contributor!,
    title: `Add edge ${edge_type}: ${source_id} → ${target_id}`,
    content: JSON.stringify(proposed),
    source_type: "api_edge",
    batch_id: batch.value,
    pending: !isAutoMerge(req.contributor!.trust_tier),
  });

  if (isAutoMerge(req.contributor!.trust_tier)) {
    const { edge_id, superseded } = materialiseEdge(
      db,
      { ...proposed, signal_id: signalId },
      { signalId, createdBy: `api-${req.contributor!.name}` }
    );
    const { intake_id } = insertIntake(db, {
      contributor: req.contributor!,
      signal_id: signalId,
      target_node: target_id,
      proposed_edges: [proposed],
    });
    ensureContributorRow(db, req.contributor!, signalId);
    bumpApprovedCount(db, req.contributor!.id, signalId);
    res.set(JSON_HEADERS).json({ edge_id, superseded, status: "approved", signal_id: signalId, intake_id, warnings });
    return;
  }

  const { intake_id, status } = insertIntake(db, {
    contributor: req.contributor!,
    signal_id: signalId,
    target_node: target_id,
    proposed_edges: [proposed],
  });
  ensureContributorRow(db, req.contributor!, signalId);
  res.set(JSON_HEADERS).json({ status, signal_id: signalId, intake_id, warnings });
});

// ---------- POST /api/v1/packages -----------------------------------------
// JSON: { batch_id?, nodes: [{ ref?, type, name, slug?, metadata?, aliases? }],
//         edges: [{ source_id, target_id, edge_type, confidence?, event_time?,
//                   supersedes_edge_id? }] }
//
// New nodes AND the edges between them (or to existing nodes) in ONE write.
// An edge endpoint is a live node id, or a reference to a node of this same
// payload (its `ref`, its `type:slug` id, or its unique `name`). Needed because
// a probationary contributor's POST /nodes only queues, so POST /edges to the
// new node (which must be live) can never be queued.
//
// Everything is validated up front: any problem → 400 listing every bad item,
// nothing written. Writes: probationary → ONE intake_queue row carrying
// proposed_nodes + proposed_edges (approved / rejected together at /review;
// approveIntakeItem creates nodes first, then edges, with dedupe remapping);
// auto / reviewed → applied now through the same materialise* functions, in one
// transaction, plus an approved audit row.

// A probationary package is approved or rejected whole, so it must stay small
// enough for a curator to judge at once; bigger uploads are several packages
// under one batch_id.
const MAX_PACKAGE_NODES = 100;
const MAX_PACKAGE_EDGES = 300;

type PackageProblem = { item: string; index: number; error: string };

router.post("/api/v1/packages", requireToken, (req, res) => {
  const db = getDb();
  const body = req.body ?? {};
  const batch = parseBatchId(body.batch_id);
  if (!batch.ok) {
    res.status(400).set(JSON_HEADERS).json({ error: "invalid batch_id", hint: BATCH_ID_HINT });
    return;
  }
  const rawNodes = body.nodes === undefined ? [] : body.nodes;
  const rawEdges = body.edges === undefined ? [] : body.edges;
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) {
    res.status(400).set(JSON_HEADERS).json({ error: "nodes and edges must be arrays" });
    return;
  }
  if (rawNodes.length + rawEdges.length === 0) {
    res.status(400).set(JSON_HEADERS).json({ error: "empty package: send at least one node or edge" });
    return;
  }
  if (rawNodes.length > MAX_PACKAGE_NODES || rawEdges.length > MAX_PACKAGE_EDGES) {
    res.status(400).set(JSON_HEADERS).json({
      error: "package_too_large",
      message: `a package holds at most ${MAX_PACKAGE_NODES} nodes and ${MAX_PACKAGE_EDGES} edges; split it into several packages (same batch_id)`,
      limits: { nodes: MAX_PACKAGE_NODES, edges: MAX_PACKAGE_EDGES },
      got: { nodes: rawNodes.length, edges: rawEdges.length },
    });
    return;
  }

  const problems: PackageProblem[] = [];
  const warnings: string[] = [];
  const bad = (item: string, index: number, error: string) => problems.push({ item, index, error });
  const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const isRetiredNode = (id: string) =>
    !!db.prepare(`SELECT 1 FROM nodes WHERE id = ? AND NOT (${NODE_NOT_RETIRED})`).get(id);

  // ---- nodes: same validation and slug rules as POST /api/v1/nodes ----------
  type Prepared = { ref: string | null; op: Extract<ProposedNodeOp, { op: "create_node" }>; id: string; existing: string | null };
  const prepared: Prepared[] = [];
  const keyToIndex = new Map<string, number>(); // reference string → prepared index
  const claimed = new Map<string, number>(); // final-ish id → first index (duplicate check)
  rawNodes.forEach((n: any, i: number) => {
    if (!isObj(n)) return bad("node", i, "must be an object");
    const { ref, type, name, slug: providedSlug, metadata, aliases } = n;
    if (ref !== undefined && (typeof ref !== "string" || !ref.trim())) return bad("node", i, "ref must be a non-empty string");
    if (!type || typeof type !== "string") return bad("node", i, "type is required");
    if (!name || typeof name !== "string") return bad("node", i, "name is required");
    if (metadata !== undefined && (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))) return bad("node", i, "metadata must be a JSON object");
    if (aliases !== undefined && !Array.isArray(aliases)) return bad("node", i, "aliases must be an array");
    const aliasItems: Array<{ source: string; external_id: string }> = [];
    for (const a of aliases ?? []) {
      if (!a || typeof a.source !== "string" || typeof a.external_id !== "string") return bad("node", i, "each alias needs {source, external_id}");
      aliasItems.push({ source: a.source, external_id: a.external_id });
    }
    if (!KNOWN_NODE_TYPES.has(type)) warnings.push(`nodes[${i}]: unknown node type "${type}" — accepted, but check CLAUDE.md`);
    let meta: Record<string, any> = metadata ?? {};
    if (type === "concept" && req.contributor!.scope !== "admin") {
      meta = { ...meta, tag_origin: "contributor" };
      warnings.push(`nodes[${i}]: concept created as a contributor-origin tag, not a curated field`);
    }
    if (type === "institution" && meta.kind !== undefined && meta.kind !== null) {
      const k = normaliseOrgKinds(meta.kind);
      if (!k.ok) return bad("node", i, `invalid_kind: ${orgKindsError(k.unknown)}`);
      meta = { ...meta, kind: k.kinds };
    }
    let slug: string;
    if (typeof providedSlug === "string" && providedSlug.length > 0) {
      slug = slugify(providedSlug);
      if (slug !== providedSlug) warnings.push(`nodes[${i}]: slug "${providedSlug}" normalised to "${slug}"`);
    } else {
      slug = slugForCreate((id) => !!db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id), type, name);
    }
    if (!slug) return bad("node", i, "invalid_slug: the name (or slug) has no letters or digits to make an address from");
    const id = `${type}:${slug}`;
    // Resolve through (type, slug) so a legacy spaced id is matched, not duplicated.
    let existing: string | null = null;
    if (db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id)) existing = id;
    else existing = existingNodeBySlug(db, type, slug);
    if (existing && isRetiredNode(existing)) return bad("node", i, `${existing} exists but is retired: give this node another slug, or ask an admin`);
    if (existing) warnings.push(`nodes[${i}]: a ${type} with slug "${slug}" already exists as ${existing} — not created again; edges use that id`);
    const dupe = claimed.get(`${type}:${slug}`);
    if (dupe !== undefined) return bad("node", i, `duplicates nodes[${dupe}] (same type and slug ${id})`);
    claimed.set(`${type}:${slug}`, i);
    prepared.push({ ref: ref === undefined ? null : ref.trim(), op: { op: "create_node", type, name, slug, metadata: meta, aliases: aliasItems }, id, existing });
    const here = prepared.length - 1;
    // `ref`s and ids must be unambiguous; a name works only while it is unique.
    if (ref !== undefined) {
      if (keyToIndex.has(ref.trim())) bad("node", i, `ref "${ref}" is already used by another node of this package`);
      else keyToIndex.set(ref.trim(), here);
    }
  });
  // ids second (an explicit ref wins over an id or name of the same spelling), names last.
  prepared.forEach((p, idx) => { if (!keyToIndex.has(p.id)) keyToIndex.set(p.id, idx); });
  const nameCount = new Map<string, number>();
  prepared.forEach((p) => nameCount.set(p.op.name, (nameCount.get(p.op.name) ?? 0) + 1));
  prepared.forEach((p, idx) => { if (nameCount.get(p.op.name) === 1 && !keyToIndex.has(p.op.name)) keyToIndex.set(p.op.name, idx); });

  // ---- edges ---------------------------------------------------------------
  const proposedEdges: ProposedEdge[] = [];
  const seenEdges = new Set<string>();
  const resolveEnd = (v: unknown, label: string, i: number): string | null => {
    if (!v || typeof v !== "string") { bad("edge", i, `${label} is required`); return null; }
    const li = keyToIndex.get(v);
    if (li !== undefined) { const p = prepared[li]!; return p.existing ?? p.id; }
    if (db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(v)) {
      if (isRetiredNode(v)) { bad("edge", i, `${label} "${v}" is a retired node`); return null; }
      return v;
    }
    bad("edge", i, `${label} "${v}" is neither a live node id nor the ref/id/name of a node in this package`);
    return null;
  };
  rawEdges.forEach((e: any, i: number) => {
    if (!isObj(e)) return bad("edge", i, "must be an object");
    const edge_type = e.edge_type;
    if (!edge_type || typeof edge_type !== "string") return bad("edge", i, "edge_type is required");
    const source_id = resolveEnd(e.source_id ?? e.source, "source_id", i);
    const target_id = resolveEnd(e.target_id ?? e.target, "target_id", i);
    if (e.supersedes_edge_id !== undefined && e.supersedes_edge_id !== null) {
      if (typeof e.supersedes_edge_id !== "string" || !db.prepare("SELECT 1 FROM edges WHERE id = ?").get(e.supersedes_edge_id)) {
        return bad("edge", i, `supersedes_edge_id does not exist: ${String(e.supersedes_edge_id)}`);
      }
    }
    if (!source_id || !target_id) return;
    if (source_id === target_id) return bad("edge", i, "source and target are the same node");
    const key = `${source_id}|${edge_type}|${target_id}`;
    if (seenEdges.has(key) && !e.supersedes_edge_id) {
      warnings.push(`edges[${i}]: duplicate of an earlier edge in this package (${edge_type}) — ignored`);
      return;
    }
    seenEdges.add(key);
    if (!CURATED_EDGE_TYPES.has(edge_type)) warnings.push(`edges[${i}]: uncurated edge type "${edge_type}" — accepted, but prefer a curated one (§1.4)`);
    try {
      checkDirection({ source: source_id, target: target_id, edge_type }, (ref) => (ref.includes(":") ? ref.slice(0, ref.indexOf(":")) : null));
    } catch (err: any) {
      warnings.push(`edges[${i}]: direction: ${err?.message ?? err}`);
    }
    if (edge_type === "INFLUENCES" || edge_type === "RESPONDS_TO") {
      warnings.push(`edges[${i}]: ${edge_type} edges should reflect attested artist intent — make sure a statement, interview or first-person attestation backs it.`);
    }
    proposedEdges.push({
      source_id,
      target_id,
      edge_type,
      confidence: typeof e.confidence === "string" ? e.confidence : "medium",
      event_time: typeof e.event_time === "string" ? e.event_time : null,
      supersedes_edge_id: typeof e.supersedes_edge_id === "string" ? e.supersedes_edge_id : null,
    });
  });

  if (problems.length) {
    res.status(400).set(JSON_HEADERS).json({
      error: "invalid_package",
      message: `${problems.length} problem(s); nothing was written`,
      problems,
    });
    return;
  }

  const contributor = req.contributor!;
  const auto = isAutoMerge(contributor.trust_tier);
  const createOps = prepared.filter((p) => !p.existing).map((p) => p.op);
  const createdByLabel = `api-${contributor.name}`;
  // The item is "about" a node this package creates, never an existing page
  // its edges merely touch (that page's contributions list and claimant
  // notifications read target_node).
  const targetNode = prepared.find((p) => !p.existing)?.id ?? prepared[0]?.existing ?? proposedEdges[0]!.target_id;

  db.exec("BEGIN IMMEDIATE");
  let result: any;
  try {
    const signalId = insertSignal(db, {
      contributor,
      title: `Package: ${createOps.length} node(s), ${proposedEdges.length} edge(s)`,
      content: JSON.stringify({ nodes: createOps, edges: proposedEdges }),
      source_type: "api_package",
      batch_id: batch.value,
      pending: !auto,
    });
    if (auto) {
      const created: string[] = [];
      for (const op of createOps) {
        const r = materialiseCreateNode(db, op, { signalId, createdBy: createdByLabel });
        if (r.created) created.push(r.node_id);
      }
      let edgesWritten = 0;
      for (const e of proposedEdges) {
        materialiseEdge(db, { ...e, signal_id: signalId }, { signalId, createdBy: createdByLabel });
        edgesWritten++;
      }
      const { intake_id } = insertIntake(db, {
        contributor,
        signal_id: signalId,
        target_node: targetNode,
        proposed_nodes: createOps,
        proposed_edges: proposedEdges,
      });
      ensureContributorRow(db, contributor, signalId);
      bumpApprovedCount(db, contributor.id, signalId);
      result = { status: "approved", signal_id: signalId, intake_id, created_nodes: created, edges: edgesWritten };
    } else {
      const { intake_id, status } = insertIntake(db, {
        contributor,
        signal_id: signalId,
        target_node: targetNode,
        proposed_nodes: createOps,
        proposed_edges: proposedEdges,
      });
      ensureContributorRow(db, contributor, signalId);
      result = { status, signal_id: signalId, intake_id, queued_nodes: createOps.length, edges: proposedEdges.length };
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
  if (auto) embedNodesAsync(db, result.created_nodes as string[]);
  res.set(JSON_HEADERS).json({
    ...result,
    // reference → the id the node has (or will have once approved)
    node_ids: Object.fromEntries(prepared.map((p, i) => [p.ref ?? p.id, p.existing ?? p.id])),
    existing_nodes: prepared.filter((p) => p.existing).map((p) => p.existing),
    warnings,
  });
});

// ---------- POST /api/v1/images -------------------------------------------
// multipart/form-data { image, node_id }   — or
// application/json    { node_id, image_base64, mime_type }   — or
// application/json    { node_id, image_url }  (server-side fetch: SSRF guard,
//                                              20 MiB cap, magic-byte sniff)
//
// Bytes are content-addressed and immutable on R2, so the upload runs even
// for probationary contributors (cheap, deduped). The metadata patch that
// attaches the URL to the node respects the trust tier.

router.post(
  "/api/v1/images",
  requireToken,
  upload.single("image"),
  async (req, res) => {
    if (!isR2Configured()) {
      res.status(503).set(JSON_HEADERS).json({ error: "r2_not_configured", hint: "set R2_* env vars (see CLAUDE.md)" });
      return;
    }
    const db = getDb();

    // Two transports: multipart (preferred) or base64-in-JSON.
    let buf: Buffer | null = null;
    let mime = "application/octet-stream";
    let nodeId: string | null = null;
    let batchRaw: unknown;
    let imageUrl: string | null = null;

    if (req.file) {
      buf = req.file.buffer;
      mime = req.file.mimetype || mime;
      nodeId = typeof req.body.node_id === "string" ? req.body.node_id : null;
      batchRaw = req.body.batch_id; // multer exposes text fields on req.body
    } else if (req.is("application/json")) {
      const body = req.body ?? {};
      const b64 = typeof body.image_base64 === "string" ? body.image_base64 : null;
      if (b64) {
        try { buf = Buffer.from(b64, "base64"); } catch { /* handled below */ }
      }
      mime = typeof body.mime_type === "string" ? body.mime_type : mime;
      nodeId = typeof body.node_id === "string" ? body.node_id : null;
      batchRaw = body.batch_id;
      if (!b64 && typeof body.image_url === "string") imageUrl = body.image_url;
    }

    const batch = parseBatchId(batchRaw);
    if (!batch.ok) {
      res.status(400).set(JSON_HEADERS).json({ error: "invalid batch_id", hint: BATCH_ID_HINT });
      return;
    }

    if ((!buf || buf.length === 0) && !imageUrl) {
      res.status(400).set(JSON_HEADERS).json({ error: "no image bytes — send multipart 'image' field, JSON {image_base64}, or JSON {image_url}" });
      return;
    }
    if (!nodeId) {
      res.status(400).set(JSON_HEADERS).json({ error: "node_id is required" });
      return;
    }
    const node = db.prepare("SELECT id, metadata FROM nodes WHERE id = ?").get(nodeId) as any;
    if (!node) {
      res.status(404).set(JSON_HEADERS).json({ error: "node not found", node_id: nodeId });
      return;
    }

    let upresult: Awaited<ReturnType<typeof uploadImage>>;
    let declaredMime: string | null = null;
    if (imageUrl) {
      try {
        upresult = (await mirrorImageFromUrl(imageUrl)).upload;
      } catch (e: any) {
        if (e instanceof ImageFetchError) {
          res.status(e.status).set(JSON_HEADERS).json({ error: e.code, detail: e.message });
          return;
        }
        res.status(502).set(JSON_HEADERS).json({ error: "image_fetch_failed", detail: String(e?.message ?? e) });
        return;
      }
    } else {
      // The stored type and key extension come from the bytes, never from the
      // label the client sent: a JPEG declared text/plain was once stored as
      // .bin and served as garbage. Same rule as the image_url transport.
      const sniffed = sniffImageMime(buf!);
      if (!sniffed) {
        res.status(415).set(JSON_HEADERS).json({ error: "not_an_image", detail: `the bytes are not a JPEG/PNG/GIF/WebP/AVIF image (declared ${mime})` });
        return;
      }
      if (sniffed !== mime) declaredMime = mime;
      mime = sniffed;
      try {
        upresult = await uploadImage(buf!, mime);
      } catch (e: any) {
        res.status(502).set(JSON_HEADERS).json({ error: "r2_upload_failed", detail: String(e?.message ?? e) });
        return;
      }
    }

    const signalId = insertSignal(db, {
      contributor: req.contributor!,
      title: `Upload image to ${nodeId}`,
      content: JSON.stringify({ node_id: nodeId, key: upresult.key, sha256: upresult.sha256, bytes: upresult.bytes, content_type: upresult.content_type, ...(declaredMime ? { declared_type: declaredMime } : {}), ...(imageUrl ? { image_url: imageUrl } : {}) }),
      source_url: imageUrl,
      source_type: "api_image",
      batch_id: batch.value,
      pending: !isAutoMerge(req.contributor!.trust_tier),
    });

    const op: ProposedNodeOp = {
      op: "attach_image",
      node_id: nodeId,
      // image_url keeps upstream provenance when the bytes came from a URL.
      image_url: imageUrl ?? upresult.url,
      cdn_image_url: upresult.url,
      sha256: upresult.sha256,
    };

    if (isAutoMerge(req.contributor!.trust_tier)) {
      materialiseAttachImage(db, op as Extract<ProposedNodeOp, { op: "attach_image" }>, { createdBy: `api-${req.contributor!.name}`, signalId });
      const { intake_id } = insertIntake(db, {
        contributor: req.contributor!,
        signal_id: signalId,
        target_node: nodeId,
        proposed_nodes: [op],
      });
      ensureContributorRow(db, req.contributor!, signalId);
      bumpApprovedCount(db, req.contributor!.id, signalId);
      // Re-embed: artwork identity vectors fuse the image, so a new image
      // changes the embedding. embedNodeNow's image_hash check makes this
      // idempotent if the same bytes were already attached.
      embedNodeAsync(db, nodeId);
      res.set(JSON_HEADERS).json({
        node_id: nodeId,
        upload: upresult,
        status: "approved",
        signal_id: signalId,
        intake_id,
      });
      return;
    }

    const { intake_id, status } = insertIntake(db, {
      contributor: req.contributor!,
      signal_id: signalId,
      target_node: nodeId,
      proposed_nodes: [op],
    });
    ensureContributorRow(db, req.contributor!, signalId);
    res.set(JSON_HEADERS).json({
      node_id: nodeId,
      upload: upresult,
      status,
      signal_id: signalId,
      intake_id,
      note: "image bytes are live on R2 but metadata attachment is queued for curator approval",
    });
  }
);

// Multer error handler (must follow the route).
router.use("/api/v1/images", (err: any, _req: any, res: any, next: any) => {
  if (err) {
    res.status(400).set(JSON_HEADERS).json({ error: "upload_error", detail: String(err?.message ?? err) });
    return;
  }
  next();
});

// ---------- Admin endpoints (scope='admin' required) ----------------------
//
// Admins can mint contributor (write-scope) tokens, revoke any token, and
// list every token. They CANNOT mint other admin tokens via this surface —
// that's deliberately reserved for the operator CLI (`npm run token:issue
// -- --admin`) so the bootstrap door stays narrow. Admin contributors are
// still ordinary contributors; their writes (signal/node/edge/image) attribute
// to them just like anyone else's, and trust_tier still governs auto-merge
// vs queue. Scope and trust_tier are deliberately decoupled.

// ---------- GET /api/v1/beta-signups (admin) ------------------------------
// Read the beta-programme email signups the retired /field "Connect" room
// captured (local beta_signups table; access requests now go through the
// invite-only /contribute sign-in instead). Newest first. Admin-scope
// like the rest of the queue/correction surface — visitor emails aren't for
// write-scope contributors.
router.get("/api/v1/beta-signups", requireAdmin, (req, res) => {
  const db = getDb();
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const items = db
    .prepare(
      "SELECT id, email, role, note, source, created_at FROM beta_signups ORDER BY created_at DESC LIMIT ?"
    )
    .all(limit);
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM beta_signups").get() as any;
  res.set(JSON_HEADERS).json({ total, returned: items.length, items });
});

// ---- URL-intake invites (admin) --------------------------------------------
// The URL intake is invite-only (src/intake/auth.ts). These are the admin
// skill's handle on it: invite, list (with pending access requests), revoke.
// Emails appear only here, behind requireAdmin; they never enter a CRR.

router.post("/api/v1/invites", requireAdmin, async (req, res) => {
  const db = getDb();
  const b = req.body ?? {};
  const email = normaliseEmail(b.email);
  // Left out, the name is the one the access request asked for (issue #72).
  const name = (typeof b.name === "string" ? b.name.trim() : "") || (email ? requestedName(db, email) ?? "" : "");
  const tier = typeof b.tier === "string" ? b.tier : "probationary";
  // `node` (any claimable type) is the newer name for `practitioner`.
  const practitioner = typeof b.node === "string" && b.node ? b.node : typeof b.practitioner === "string" && b.practitioner ? b.practitioner : null;
  if (!email) { res.status(400).set(JSON_HEADERS).json({ error: "email is required" }); return; }
  if (!name) { res.status(400).set(JSON_HEADERS).json({ error: "name is required — it is the public attribution on their contributions (no access request named one)" }); return; }
  if (!["auto", "reviewed", "probationary"].includes(tier)) { res.status(400).set(JSON_HEADERS).json({ error: "tier must be auto | reviewed | probationary" }); return; }
  if (practitioner && !db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(practitioner)) {
    res.status(400).set(JSON_HEADERS).json({ error: `practitioner node '${practitioner}' does not exist` });
    return;
  }
  const c = ensureContributorForEmail(db, { email, name, tier, self_node_id: practitioner ?? undefined, invite: true });
  if (practitioner) backfillInviteClaims(db); // the named node is theirs at once
  let sent = false;
  if (b.send === true) {
    try { await sendLoginEmail(db, email, null, "/contribute"); sent = true; } catch (e: any) { console.error("[invites] send failed:", e?.message ?? e); }
  }
  res.status(201).set(JSON_HEADERS).json({ invited: { email: c.email, contributor_id: c.id, name: c.name, trust_tier: c.trust_tier, self_node_id: c.self_node_id }, link_sent: sent });
});

router.get("/api/v1/invites", requireAdmin, (_req, res) => {
  const db = getDb();
  const invites = db
    .prepare(
      `SELECT e.email, c.name, c.trust_tier, e.self_node_id, e.invited_at, e.revoked_at, e.verified_at,
              (SELECT MAX(last_seen_at) FROM contributor_sessions s WHERE s.contributor_id = c.id) AS last_seen_at,
              (SELECT COUNT(*) FROM drafts d WHERE d.contributor_id = c.id) AS drafts
         FROM contributor_emails e JOIN contributors c ON c.id = e.contributor_id
        ORDER BY e.invited_at DESC`
    )
    .all();
  const requests = db.prepare("SELECT email, display_name, about, node_id, first_at, last_at, count FROM intake_access_requests ORDER BY last_at DESC LIMIT 200").all();
  res.set(JSON_HEADERS).json({ invite_only: !intakeOpen(), invites, requests });
});

// ---- Claims (admin) — docs/CLAIM-SPEC.md ----------------------------------------

router.get("/api/v1/claims", requireAdmin, (req, res) => {
  const db = getDb();
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
  const node = typeof req.query.node === "string" && req.query.node ? req.query.node : null;
  const where: string[] = [];
  const params: string[] = [];
  if (status) { where.push("c.status = ?"); params.push(status); }
  if (node) { where.push("c.node_id = ?"); params.push(node); }
  const rows = db
    .prepare(
      `SELECT c.id, c.node_id, c.status, c.via, c.evidence, c.invited_by, c.queue_id, c.reviewed_by, c.reviewed_at, c.reason, c.created_at,
              k.name AS contributor, (SELECT email FROM contributor_emails e WHERE e.contributor_id = c.contributor_id ORDER BY e.created_at LIMIT 1) AS email
         FROM node_claims c LEFT JOIN contributors k ON k.id = c.contributor_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY c.created_at DESC LIMIT 500`
    )
    .all(...params);
  res.set(JSON_HEADERS).json({ claims: rows });
});

router.post("/api/v1/claims/:id/revoke", requireAdmin, (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) { res.status(400).set(JSON_HEADERS).json({ error: "reason is required" }); return; }
  try {
    const c = endClaim(getDb(), String(req.params.id), { actor: req.contributor!, mode: "revoked", reason });
    res.set(JSON_HEADERS).json({ claim: c });
  } catch (e) {
    if (e instanceof ClaimError) { res.status(e.status).set(JSON_HEADERS).json({ error: e.code, message: e.message }); return; }
    throw e;
  }
});

router.post("/api/v1/invites/revoke", requireAdmin, (req, res) => {
  const email = normaliseEmail(req.body?.email);
  if (!email) { res.status(400).set(JSON_HEADERS).json({ error: "email is required" }); return; }
  if (!revokeInvite(getDb(), email)) { res.status(404).set(JSON_HEADERS).json({ error: "no such invite", email }); return; }
  res.set(JSON_HEADERS).json({ revoked: email, note: "sessions ended; their contributions and drafts stay" });
});

router.get("/api/v1/tokens", requireAdmin, (req, res) => {
  const db = getDb();
  const contributorName = typeof req.query.contributor === "string" ? req.query.contributor : null;
  const activeOnly = String(req.query.active ?? "") === "1" || String(req.query.active ?? "") === "true";
  const rows = listTokens(db, { contributorName, activeOnly });
  res.set(JSON_HEADERS).json({ tokens: rows });
});

router.post("/api/v1/tokens", requireAdmin, (req, res) => {
  const db = getDb();
  const body = req.body ?? {};
  const contributor_name = typeof body.contributor_name === "string" ? body.contributor_name : null;
  const label = typeof body.label === "string" ? body.label : null;
  const tier = typeof body.tier === "string" ? body.tier : undefined;
  const create_if_missing = body.create_if_missing === true;
  const requested_scope = typeof body.scope === "string" ? body.scope : "write";
  const node = typeof body.node === "string" && body.node ? body.node : null;

  if (!contributor_name) {
    res.status(400).set(JSON_HEADERS).json({ error: "contributor_name is required" });
    return;
  }
  // Admin endpoint refuses to mint another admin — only the operator CLI can.
  if (requested_scope !== "write") {
    res.status(403).set(JSON_HEADERS).json({
      error: "admin_mint_forbidden",
      hint: "API admins can only mint write-scope tokens. Use `npm run token:issue -- --admin` on the host to mint another admin.",
    });
    return;
  }

  try {
    const result = mintToken(db, {
      contributorName: contributor_name,
      label,
      scope: "write",
      tier: tier as any,
      createIfMissing: create_if_missing,
      node,
    });
    res.set(JSON_HEADERS).json({
      // The raw token is returned ONCE. The admin client is responsible for
      // delivering it to the contributor over a side channel (the practitioner's
      // chat with their own Claude, a password manager, etc.).
      raw_token: result.raw_token,
      token_prefix: result.token_prefix,
      contributor: {
        id: result.contributor_id,
        name: result.contributor_name,
        trust_tier: result.contributor_trust_tier,
      },
      scope: result.scope,
      label: result.label,
      node: result.node_id,
      contributor_created: result.contributor_created,
      minted_by: { id: req.contributor!.id, name: req.contributor!.name, token_prefix: req.contributor!.token_prefix },
    });
  } catch (e: any) {
    if (e instanceof MintError) {
      res.status(e.status).set(JSON_HEADERS).json({ error: e.code, detail: e.message });
      return;
    }
    throw e;
  }
});

router.post("/api/v1/tokens/:prefix/revoke", requireAdmin, (req, res) => {
  const db = getDb();
  const prefix = String(req.params.prefix);
  try {
    const r = revokeTokenByPrefix(db, prefix);
    res.set(JSON_HEADERS).json({
      token_prefix: r.token_prefix,
      contributor: { id: r.contributor_id, name: r.contributor_name },
      was_already_revoked: r.was_already_revoked,
      revoked_at: r.revoked_at,
      revoked_by: { id: req.contributor!.id, name: req.contributor!.name, token_prefix: req.contributor!.token_prefix },
    });
  } catch (e: any) {
    if (e instanceof MintError) {
      res.status(e.status).set(JSON_HEADERS).json({ error: e.code, detail: e.message });
      return;
    }
    throw e;
  }
});

// PATCH /api/v1/tokens/:prefix {"node": "<node id>" | null} — the node the
// token's contributor stands for (issue #70): bylines of its contributions
// link to it, and its page says it contributes. null clears it.
// {"tier": "auto" | "reviewed" | "probationary"} — the trust tier of the
// token's contributor (all their tokens; takes effect on the next request).
// Either or both, in one transaction.
router.patch("/api/v1/tokens/:prefix", requireAdmin, (req, res) => {
  const db = getDb();
  const body = req.body ?? {};
  const hasNode = "node" in body;
  const hasTier = "tier" in body;
  if (!hasNode && !hasTier) {
    res.status(400).set(JSON_HEADERS).json({ error: "send node (a node id, or null to clear it) and/or tier (auto | reviewed | probationary)" });
    return;
  }
  if (hasNode && body.node !== null && typeof body.node !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "node must be a node id, or null to clear it" });
    return;
  }
  if (hasTier && typeof body.tier !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "tier must be one of auto, reviewed, probationary" });
    return;
  }
  const prefix = String(req.params.prefix);
  db.exec("BEGIN IMMEDIATE");
  try {
    // Both or neither: a bad node id must not leave the tier changed.
    const tierResult = hasTier ? setContributorTier(db, prefix, body.tier) : null;
    const nodeResult = hasNode ? setTokenNode(db, prefix, body.node || null) : null;
    db.exec("COMMIT");
    if (tierResult && tierResult.previous !== tierResult.trust_tier) {
      console.log(`[tokens] ${req.contributor!.name} set ${tierResult.contributor_name}'s tier ${tierResult.previous} → ${tierResult.trust_tier}`);
    }
    res.set(JSON_HEADERS).json({
      ...(nodeResult ?? {}),
      ...(tierResult
        ? { token_prefix: tierResult.token_prefix, contributor_id: tierResult.contributor_id, contributor_name: tierResult.contributor_name, trust_tier: tierResult.trust_tier, previous_tier: tierResult.previous }
        : {}),
      set_by: { id: req.contributor!.id, name: req.contributor!.name, token_prefix: req.contributor!.token_prefix },
    });
  } catch (e: any) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    if (e instanceof MintError) {
      res.status(e.status).set(JSON_HEADERS).json({ error: e.code, detail: e.message });
      return;
    }
    throw e;
  }
});

// ---------- Admin: review queue (JSON twin of the /review web UI) ----------
//
// Same materialisation logic as POST /api/review/:id/approve|reject — both
// call src/utils/review.ts, so the paths can't drift. These exist so an
// admin-scope Claude can curate without a browser: list pending items,
// approve/reject one, or sweep a whole batch/contributor in one call.

function deriveAction(sourceType: string | null, proposedNodes: string | null): string {
  let action = "signal";
  if (sourceType === "api_edge") action = "add_edge";
  else if (sourceType === "api_image") action = "attach_image";
  else if (sourceType === "api_package") action = "package";
  else if (sourceType === "api_node") {
    action = "create_node";
    try {
      const ops = JSON.parse(proposedNodes ?? "[]");
      if (Array.isArray(ops) && ops[0]?.op) action = ops[0].op;
    } catch { /* keep the source_type-derived default */ }
  }
  return action;
}

// GET /api/v1/review?status=pending&contributor=<name>&batch=<id>&kind=<kind>&limit=N&before=<cursor>
// Newest first, ordered by (created_at DESC, id DESC) — created_at has 1 s
// resolution, so id is the deterministic tie-break. `next_before` (present when
// `has_more`) is an opaque cursor "<created_at>|<intake id>": pass it as
// ?before= to get the next, older page.
router.get("/api/v1/review", requireAdmin, (req, res) => {
  const db = getDb();
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : "pending";
  const contributor = typeof req.query.contributor === "string" && req.query.contributor ? req.query.contributor : null;
  const batch = typeof req.query.batch === "string" && req.query.batch ? req.query.batch : null;
  const kind = typeof req.query.kind === "string" && req.query.kind ? req.query.kind : null;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 50;

  const where: string[] = [];
  const params: string[] = [];
  const beforeRaw = typeof req.query.before === "string" && req.query.before ? req.query.before : null;
  if (beforeRaw) {
    const sep = beforeRaw.indexOf("|");
    if (sep <= 0 || sep === beforeRaw.length - 1) {
      res.status(400).set(JSON_HEADERS).json({ error: "invalid_before", message: "before must be the next_before value of a previous page" });
      return;
    }
    where.push("(q.created_at < ? OR (q.created_at = ? AND q.id < ?))");
    params.push(beforeRaw.slice(0, sep), beforeRaw.slice(0, sep), beforeRaw.slice(sep + 1));
  }
  if (status !== "_all") { where.push("q.status = ?"); params.push(status); }
  if (contributor) { where.push("q.submitted_by = ?"); params.push(contributor); }
  if (batch) { where.push("s.batch_id = ?"); params.push(batch); }
  if (kind) { where.push("q.kind = ?"); params.push(kind); }

  const fetched = db
    .prepare(
      `SELECT q.id AS intake_id, q.signal_id, q.target_node, q.submitted_by, q.trust_tier,
              q.status, q.kind, q.created_at, q.reviewed_at, q.rejection_reason,
              q.proposed_nodes, q.proposed_edges,
              s.title AS title, s.source_type AS source_type, s.batch_id AS batch_id
         FROM intake_queue q
         LEFT JOIN signals_full s ON s.id = q.signal_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY q.created_at DESC, q.id DESC
        LIMIT ?`
    )
    .all(...params, limit + 1) as any[];
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  const last = rows[rows.length - 1];

  res.set(JSON_HEADERS).json({
    returned: rows.length,
    has_more: hasMore,
    ...(hasMore && last ? { next_before: `${last.created_at}|${last.intake_id}` } : {}),
    items: rows.map((r) => ({
      intake_id: r.intake_id,
      action: deriveAction(r.source_type, r.proposed_nodes),
      kind: r.kind,
      submitted_by: r.submitted_by,
      trust_tier: r.trust_tier,
      target_node: r.target_node,
      status: r.status,
      created_at: r.created_at,
      reviewed_at: r.reviewed_at,
      ...(r.rejection_reason ? { rejection_reason: r.rejection_reason } : {}),
      signal_id: r.signal_id,
      title: r.title,
      ...(r.batch_id ? { batch_id: r.batch_id } : {}),
    })),
  });
});

// Boolean body flags on the destructive admin endpoints must be REAL JSON
// booleans. A loose check would let a string "false" silently do the more
// destructive thing (cascade staying on, dry_run staying off) — reject
// anything mistyped instead. undefined → fallback; non-boolean → 400.
function readBoolFlag(res: any, value: unknown, name: string, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    res.status(400).set(JSON_HEADERS).json({ error: `${name} must be a boolean (true or false)` });
    return null;
  }
  return value;
}

// POST /api/v1/review/bulk — { action: 'approve'|'reject', reason?, ids?, batch_id?, contributor?, dry_run? }
// Sweeps PENDING items matched by ids ∧ batch ∧ contributor (at least one
// selector required — no blind approve-everything). Caps at 500 per call;
// `remaining` in the response tells the caller to loop.
router.post("/api/v1/review/bulk", requireAdmin, (req, res) => {
  const db = getDb();
  const { action, reason, ids, batch_id, contributor, dry_run } = req.body ?? {};

  if (action !== "approve" && action !== "reject") {
    res.status(400).set(JSON_HEADERS).json({ error: "action must be 'approve' or 'reject'" });
    return;
  }
  if (action === "reject" && (!reason || typeof reason !== "string")) {
    res.status(400).set(JSON_HEADERS).json({ error: "reason is required for reject" });
    return;
  }
  const haveIds = Array.isArray(ids) && ids.length > 0;
  if (haveIds && ids.length > 500) {
    res.status(400).set(JSON_HEADERS).json({ error: "ids capped at 500 per call" });
    return;
  }
  if (!haveIds && !batch_id && !contributor) {
    res.status(400).set(JSON_HEADERS).json({ error: "need at least one selector: ids, batch_id, or contributor" });
    return;
  }
  const dryRun = readBoolFlag(res, dry_run, "dry_run", false);
  if (dryRun === null) return;

  const where: string[] = ["q.status = 'pending'"];
  const params: string[] = [];
  if (haveIds) {
    where.push(`q.id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids.map(String));
  }
  if (typeof batch_id === "string" && batch_id) { where.push("s.batch_id = ?"); params.push(batch_id); }
  if (typeof contributor === "string" && contributor) { where.push("q.submitted_by = ?"); params.push(contributor); }

  const matchSql = `FROM intake_queue q LEFT JOIN signals_full s ON s.id = q.signal_id WHERE ${where.join(" AND ")}`;
  const { count: matched } = db.prepare(`SELECT COUNT(*) AS count ${matchSql}`).get(...params) as any;
  const rows = db
    .prepare(`SELECT q.id ${matchSql} ORDER BY q.created_at ASC LIMIT 500`)
    .all(...params) as Array<{ id: string }>;

  if (dryRun) {
    res.set(JSON_HEADERS).json({ dry_run: true, action, matched: Number(matched), intake_ids: rows.map((r) => r.id) });
    return;
  }

  const reviewedBy = `api-${req.contributor!.name}`;
  const failed: Array<{ intake_id: string; error: string }> = [];
  let processed = 0;
  for (const r of rows) {
    const outcome = action === "approve"
      ? approveIntakeItem(db, r.id, reviewedBy)
      : rejectIntakeItem(db, r.id, String(reason), reviewedBy);
    if (outcome.ok) {
      processed += 1;
      void notifyAfterReview(db, r.id, action === "approve", action === "approve" ? null : String(reason));
    } else failed.push({ intake_id: r.id, error: outcome.error });
  }

  // Failed items are still status='pending' in the DB, so they genuinely
  // remain — count them (matched − processed, not matched − attempted). A
  // caller looping on remaining>0 with the same selector should check
  // `failed` to avoid retrying permanently-broken rows forever.
  res.set(JSON_HEADERS).json({
    action,
    matched: Number(matched),
    processed,
    failed,
    remaining: Math.max(0, Number(matched) - processed),
  });
});

// POST /api/v1/review/:id/approve — JSON twin of the web curator approve.
router.post("/api/v1/review/:id/approve", requireAdmin, (req, res) => {
  const db = getDb();
  const outcome = approveIntakeItem(db, String(req.params.id), `api-${req.contributor!.name}`);
  if (!outcome.ok) {
    res.status(outcome.status).set(JSON_HEADERS).json({ error: outcome.error });
    return;
  }
  res.set(JSON_HEADERS).json({ intake_id: outcome.intake_id, status: "approved" });
  void notifyAfterReview(db, outcome.intake_id, true, null);
});

// POST /api/v1/review/:id/reject — JSON twin of the web curator reject.
router.post("/api/v1/review/:id/reject", requireAdmin, (req, res) => {
  const db = getDb();
  const reason = req.body?.reason;
  if (!reason || typeof reason !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "reason is required" });
    return;
  }
  const outcome = rejectIntakeItem(db, String(req.params.id), reason, `api-${req.contributor!.name}`);
  if (!outcome.ok) {
    res.status(outcome.status).set(JSON_HEADERS).json({ error: outcome.error });
    return;
  }
  res.set(JSON_HEADERS).json({ intake_id: outcome.intake_id, status: "rejected" });
  void notifyAfterReview(db, outcome.intake_id, false, reason);
});

// ---------- Admin: correction primitives ------------------------------------
//
// No DELETE — by design (SKILL.md §5). These are the provenance-preserving
// equivalents: revoke a signal (+cascade its edges), retire a node (hide it
// from listings + supersede its edges), retire a whole batch ("delete and
// start again" for a botched upload session). All anchored by admin signals;
// see src/utils/admin-actions.ts.

function handleAdminError(res: any, e: any): void {
  if (e instanceof AdminActionError) {
    res.status(e.status).set(JSON_HEADERS).json({ error: e.code, detail: e.message });
    return;
  }
  throw e;
}

// POST /api/v1/signals/:id/revoke — { reason, cascade? (default true) }
router.post("/api/v1/signals/:id/revoke", requireAdmin, (req, res) => {
  const db = getDb();
  const reason = req.body?.reason;
  if (!reason || typeof reason !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "reason is required" });
    return;
  }
  const cascade = readBoolFlag(res, req.body?.cascade, "cascade", true);
  if (cascade === null) return;
  try {
    const result = revokeSignal(db, String(req.params.id), {
      reason,
      by: req.contributor!.name,
      cascade,
    });
    res.set(JSON_HEADERS).json(result);
  } catch (e: any) {
    handleAdminError(res, e);
  }
});

// POST /api/v1/nodes/:id/retire — { reason, dry_run? }
router.post("/api/v1/nodes/:id/retire", requireAdmin, (req, res) => {
  const db = getDb();
  const reason = req.body?.reason;
  if (!reason || typeof reason !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "reason is required" });
    return;
  }
  const dryRun = readBoolFlag(res, req.body?.dry_run, "dry_run", false);
  if (dryRun === null) return;
  try {
    const result = retireNode(db, String(req.params.id), {
      reason,
      by: req.contributor!.name,
      dryRun,
    });
    res.set(JSON_HEADERS).json(result);
  } catch (e: any) {
    handleAdminError(res, e);
  }
});

// GET /api/v1/batches?contributor=<name>&limit=N — what batches exist, with
// signal/intake rollups. The admin's map before any bulk decision.
router.get("/api/v1/batches", requireAdmin, (req, res) => {
  const db = getDb();
  const contributor = typeof req.query.contributor === "string" && req.query.contributor ? req.query.contributor : null;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;
  const batches = listBatches(db, { contributor, limit });
  res.set(JSON_HEADERS).json({ returned: batches.length, batches });
});

// POST /api/v1/batches/:batch_id/retire — { reason, dry_run? }
// The rollback. ALWAYS dry_run first; the response is the full plan.
router.post("/api/v1/batches/:batch_id/retire", requireAdmin, (req, res) => {
  const db = getDb();
  const reason = req.body?.reason;
  if (!reason || typeof reason !== "string") {
    res.status(400).set(JSON_HEADERS).json({ error: "reason is required" });
    return;
  }
  const dryRun = readBoolFlag(res, req.body?.dry_run, "dry_run", false);
  if (dryRun === null) return;
  try {
    const result = retireBatch(db, String(req.params.batch_id), {
      reason,
      by: req.contributor!.name,
      dryRun,
    });
    res.set(JSON_HEADERS).json(result);
  } catch (e: any) {
    handleAdminError(res, e);
  }
});

export default router;
