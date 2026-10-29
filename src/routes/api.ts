import { Router } from "express";
import crypto from "node:crypto";
import { createGzip } from "node:zlib";
import { getDb } from "../db.js";
import { HTML_HEADERS, JSON_HEADERS, htmlEscape } from "../templates.js";
import { approveIntakeItem, rejectIntakeItem } from "../utils/review.js";
import { mirrorQueuedImages, queuedImageFailures } from "../utils/package-images.js";
import { buildEmbeddingSections } from "../embed/sections.js";
import { YEAR_SQL_FRAGMENT, formatArtworkYear } from "../utils/year.js";
import { NODE_NOT_RETIRED } from "../utils/visibility.js";
import { sourceLabel } from "../utils/source-label.js";
import { validateSourceUrl } from "../utils/contribution.js";
import { rosterFor } from "../utils/roster.js";
import { collapseClaims, claimsOf, CLAIM_COLS } from "../utils/claims.js";
import { requireCurator } from "../intake/auth.js";
import { notifyAfterReview } from "../claim/mail.js";
import { ensureAnonymousContributor, insertSignalRow } from "../utils/signal-private.js";

// SQL fragment that exposes the two metadata keys sourceLabel() reads. Kept
// next to the helper so the projection and the deriver can't drift.
const SOURCE_SQL_FRAGMENT =
  "json_extract(metadata,'$.source_url') AS source_url, " +
  "json_extract(metadata,'$.va_maker_name') AS va_maker_name";

const router = Router();

// Tag stamped on every embedding-derived edge by src/embed/derive.ts
// (CREATED_BY_TAG). The /field streaming loader splits these out of the initial
// payload and lazy-loads them only when the user enters embeddings ('e') mode.
const DERIVED_CREATED_BY = "embedding-multimodal-v1";

// Visible-node clause shared by /api/stats and the /api/graph* family.
// Retired nodes (admin correction — see src/utils/visibility.ts) and the
// reserved 'related' type are filtered from every listing surface.
const VISIBLE_NODES = `type != 'related' AND ${NODE_NOT_RETIRED}`;

// GET /api/stats
router.get("/api/stats", (_req, res) => {
  const db = getDb();
  // total_nodes is PINNED to /api/graph/stream's node WHERE clause — the
  // /field worker stamps its IndexedDB cache on `${total_nodes}:${curated_edges}`
  // and compares it to the stream's `${nodes}:${edges}` meta. Diverge these
  // and the cache never validates (every visit re-streams).
  const { count: totalNodes } = db.prepare(`SELECT COUNT(*) as count FROM nodes WHERE ${VISIBLE_NODES}`).get() as any;
  const { count: totalEdges } = db.prepare("SELECT COUNT(*) as count FROM edges").get() as any;
  const { count: totalSignals } = db.prepare("SELECT COUNT(*) as count FROM signals").get() as any;
  const { count: pendingReviews } = db
    .prepare("SELECT COUNT(*) as count FROM intake_queue WHERE status = 'pending'")
    .get() as any;

  // Split the *live* (valid_until IS NULL) edge count into curated vs the
  // embedding-derived overlay. The /field streaming loader stamps its
  // IndexedDB cache on (nodes, curated_edges) so a nightly re-derive — which
  // only changes derived_edges — doesn't needlessly invalidate the curated
  // graph cache; the derived layer is lazy-loaded and stamped separately.
  //
  // curated_edges MUST be computed with the exact same WHERE clause as
  // /api/graph/stream's edge query (live, non-derived, both endpoints
  // non-'related') — the stamp it forms (`${nodes}:${curated_edges}`) has to
  // equal the stream's meta stamp, or the IndexedDB cache never validates and
  // every visit re-streams. 'related' is reserved/empty today so the related
  // filter is a no-op, but pinning the clauses together keeps it that way.
  //
  // Counted per RELATION, not per claim row: the stream collapses several
  // claims of one (source, type, target) into one edge with a source count
  // (src/utils/claims.ts), so this counts distinct triples.
  const { count: curatedEdges } = db
    .prepare(
      `SELECT COUNT(*) as count FROM (
         SELECT 1 FROM edges e
          WHERE e.valid_until IS NULL
            AND e.created_by IS NOT '${DERIVED_CREATED_BY}'
            AND e.source_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES})
            AND e.target_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES})
          GROUP BY e.source_id, e.target_id, e.edge_type)`
    )
    .get() as any;
  // Pinned to /api/graph/derived's WHERE clause for the same stamp reason.
  const { count: derivedEdges } = db
    .prepare(
      `SELECT COUNT(*) as count FROM edges e
       WHERE e.valid_until IS NULL
         AND e.created_by = '${DERIVED_CREATED_BY}'
         AND e.source_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES})
         AND e.target_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES})`
    )
    .get() as any;

  res.set(JSON_HEADERS).json({
    total_nodes: totalNodes,
    total_edges: totalEdges,
    total_signals: totalSignals,
    pending_reviews: pendingReviews,
    curated_edges: curatedEdges,
    derived_edges: derivedEdges,
  });
});

// GET /api/graph — full graph as D3-compatible JSON
router.get("/api/graph", (req, res) => {
  const db = getDb();
  const typeFilter = (req.query.type as string) || "";

  const NODE_COLS =
    "id, name, type, slug, " +
    "json_extract(metadata,'$.image_url') AS image_url, " +
    "json_extract(metadata,'$.cdn_image_url') AS cdn_image_url, " +
    SOURCE_SQL_FRAGMENT + ", " +
    YEAR_SQL_FRAGMENT;

  let nodeRows: any[];
  if (!typeFilter || typeFilter === "_all") {
    // Include scenes in the default view — they are the primary connective
    // tissue for ~22 practitioners (Paul-canon pass, April 28). Filtering
    // them out makes those practitioners appear orphan when zoomed out.
    nodeRows = db
      .prepare(`SELECT ${NODE_COLS} FROM nodes WHERE ${VISIBLE_NODES} ORDER BY name`)
      .all();
  } else {
    nodeRows = db
      .prepare(`SELECT ${NODE_COLS} FROM nodes WHERE type = ? AND ${NODE_NOT_RETIRED} ORDER BY name`)
      .all(typeFilter);
  }

  let edgeRows: any[];
  if (!typeFilter || typeFilter === "_all") {
    edgeRows = db
      .prepare(
        `SELECT ${CLAIM_COLS}, e.confidence FROM edges e LEFT JOIN signals s ON s.id = e.signal_id WHERE e.valid_until IS NULL AND e.source_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES}) AND e.target_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES}) ORDER BY e.valid_from ASC`
      )
      .all();
  } else {
    edgeRows = db
      .prepare(
        `SELECT ${CLAIM_COLS}, e.confidence FROM edges e LEFT JOIN signals s ON s.id = e.signal_id WHERE e.valid_until IS NULL AND e.source_id IN (SELECT id FROM nodes WHERE type = ? AND ${NODE_NOT_RETIRED}) AND e.target_id IN (SELECT id FROM nodes WHERE type = ? AND ${NODE_NOT_RETIRED}) ORDER BY e.valid_from ASC`
      )
      .all(typeFilter, typeFilter);
  }
  // One edge per relation, with the number of independent sources behind it.
  const collapsed = collapseClaims(edgeRows);

  res.set(JSON_HEADERS).json({
    nodes: nodeRows.map((n: any) => {
      const year = n.type === "artwork" ? formatArtworkYear(n) : null;
      const source = sourceLabel(n);
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        slug: n.slug,
        ...(source ? { source } : {}),
        // Exact upstream page for the label — lets the client link "source:
        // fxhash" to the actual work page, not just https://<host>.
        ...(source && n.source_url ? { source_url: n.source_url } : {}),
        ...(year ? { year } : {}),
        ...(n.cdn_image_url ? { cdn_image_url: n.cdn_image_url } : {}),
        ...(n.image_url ? { image_url: n.image_url } : {}),
      };
    }),
    edges: collapsed.map((e: any) => ({
      source: e.source_id,
      target: e.target_id,
      type: e.edge_type,
      confidence: e.confidence,
      created_by: e.created_by,
      ...(e.origins.length > 1 ? { src: e.origins.length } : {}),
    })),
  });
});

// GET /api/graph/stream — the /field graph as newline-delimited JSON (NDJSON).
//
// Same projection as /api/graph but (a) streamed line-by-line so the client
// can parse + index in a Web Worker as bytes arrive (no 9 MB main-thread
// JSON.parse freeze), and (b) CURATED-ONLY by default — the ~10k derived
// STYLE_KIN / VISUALLY_AFFINE edges are excluded and lazy-loaded via
// /api/graph/derived when the user enters embeddings mode.
//
// Wire format, one JSON object per line:
//   {"meta":{"nodes":N,"edges":M,"stamp":"N:M"}}   ← always first
//   {"n":{id,name,type,slug,year?,cdn_image_url?,image_url?}}
//   {"e":{source,target,type,confidence,created_by}}
//
// stamp = `${nodes}:${curated_edges}` — matches /api/stats so the worker can
// check its IndexedDB cache (via /api/stats) before deciding to stream.
router.get("/api/graph/stream", (req, res) => {
  const db = getDb();
  const NODE_COLS =
    "id, name, type, slug, " +
    "json_extract(metadata,'$.image_url') AS image_url, " +
    "json_extract(metadata,'$.cdn_image_url') AS cdn_image_url, " +
    // tag_origin distinguishes the ~100 fxhash artist-tag concepts (folksonomy)
    // from the ~8 wikidata-anchored base concepts (the real fields). The field
    // view colours them differently — see colorForNode() in graph-field.js.
    "json_extract(metadata,'$.tag_origin') AS tag_origin, " +
    // source_url / va_maker_name feed sourceLabel() → the entity-view footer's
    // real "source: …" attribution (replaces the old graph-stub placeholder).
    SOURCE_SQL_FRAGMENT + ", " +
    YEAR_SQL_FRAGMENT;

  // Node + edge WHERE clauses are PINNED to /api/stats total_nodes /
  // curated_edges — together they form the IndexedDB cache stamp. Change
  // one, change both.
  const nodeRows = db
    .prepare(`SELECT ${NODE_COLS} FROM nodes WHERE ${VISIBLE_NODES} ORDER BY name`)
    .all() as any[];
  // One edge per relation; its claim rows collapse into a source count
  // (distinct evidence origins — src/utils/claims.ts). Pinned to the
  // per-triple count in /api/stats curated_edges.
  const edgeRows = collapseClaims(db
    .prepare(
      `SELECT ${CLAIM_COLS}, e.confidence
       FROM edges e LEFT JOIN signals s ON s.id = e.signal_id
       WHERE e.valid_until IS NULL
         AND e.created_by IS NOT '${DERIVED_CREATED_BY}'
         AND e.source_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES})
         AND e.target_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES})
       ORDER BY e.valid_from ASC`
    )
    .all() as any[]);

  // Per-node "intention" = count of distinct curated edge types touching it.
  // The client's /field layout orders nodes BEFORE edges arrive (artworks by
  // `year`, everything else by intention) — that's what lets the worker
  // render the node constellation progressively (nodes first) while the edges
  // (67% of the payload, only needed on zoom) are still streaming.
  const typesByNode = new Map<string, Set<string>>();
  for (const e of edgeRows) {
    let s = typesByNode.get(e.source_id); if (!s) { s = new Set(); typesByNode.set(e.source_id, s); }
    let t = typesByNode.get(e.target_id); if (!t) { t = new Set(); typesByNode.set(e.target_id, t); }
    s.add(e.edge_type); t.add(e.edge_type);
  }

  // Compress at the app level. Fly's edge does NOT compress chunked/streamed
  // responses, so without this the raw NDJSON ships at ~7 MB (vs ~1 MB gzipped)
  // — 7× the wire transfer, which dominates load time. gzip is a Transform
  // stream, so the response stays chunked/streamed; the worker still parses
  // incrementally. gzip (not brotli) keeps CPU low on the 1-core Fly machine.
  const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  res.set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  let sink: NodeJS.WritableStream = res;
  if (acceptsGzip) {
    res.set("Content-Encoding", "gzip");
    res.set("Vary", "Accept-Encoding");
    const gzip = createGzip();
    gzip.pipe(res);
    sink = gzip;
  }

  // Batch writes (~64 KB) so we don't issue one syscall per row.
  let buf = "";
  const FLUSH_AT = 64 * 1024;
  const push = (obj: unknown) => {
    buf += JSON.stringify(obj) + "\n";
    if (buf.length >= FLUSH_AT) {
      sink.write(buf);
      buf = "";
    }
  };

  push({ meta: { nodes: nodeRows.length, edges: edgeRows.length, stamp: `${nodeRows.length}:${edgeRows.length}` } });
  for (const n of nodeRows) {
    const year = n.type === "artwork" ? formatArtworkYear(n) : null;
    const intention = typesByNode.get(n.id)?.size ?? 0;
    const source = sourceLabel(n);
    push({
      n: {
        id: n.id,
        name: n.name,
        type: n.type,
        slug: n.slug,
        int: intention,
        ...(source ? { source } : {}),
        // Exact upstream page for the label — the entity-view footer links
        // "source: fxhash" to the actual work page, not just https://<host>.
        // Cached clients on the old projection fall back to https://<label>.
        ...(source && n.source_url ? { source_url: n.source_url } : {}),
        ...(year ? { year } : {}),
        // Prefer the R2 cdn; only ship the upstream image_url when there's no
        // cdn (the client falls cdn -> image_url, so the upstream is redundant
        // when a cdn exists — ~4.7k nodes worth of long URLs saved).
        ...(n.cdn_image_url
          ? { cdn_image_url: n.cdn_image_url }
          : n.image_url
            ? { image_url: n.image_url }
            : {}),
        // Only concepts ever carry tag_origin; shipped so the field view can
        // tell a folksonomy tag-concept from a real field at colour time.
        ...(n.tag_origin ? { tag_origin: n.tag_origin } : {}),
      },
    });
  }
  // created_by is omitted — every curated edge carries the same constant
  // ('contributor:migration') and the client filters by type, not provenance.
  // `src` = how many independent sources back the relation; omitted when 1.
  for (const e of edgeRows) {
    push({ e: { source: e.source_id, target: e.target_id, type: e.edge_type, confidence: e.confidence, ...(e.origins.length > 1 ? { src: e.origins.length } : {}) } });
  }
  if (buf) sink.write(buf);
  sink.end();
});

// GET /api/graph/derived — ONLY the embedding-derived edges (STYLE_KIN /
// VISUALLY_AFFINE), as one JSON payload. Lazy-loaded by /field the first time
// the user enters embeddings ('e') mode; merged into the already-indexed graph
// client-side. Small enough (~10k edges) not to need streaming.
router.get("/api/graph/derived", (_req, res) => {
  const db = getDb();
  const edgeRows = db
    .prepare(
      `SELECT e.source_id, e.target_id, e.edge_type, e.confidence, e.created_by
       FROM edges e
       WHERE e.valid_until IS NULL
         AND e.created_by = '${DERIVED_CREATED_BY}'
         AND e.source_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES})
         AND e.target_id IN (SELECT id FROM nodes WHERE ${VISIBLE_NODES})`
    )
    .all() as any[];
  res.set(JSON_HEADERS).json({
    stamp: String(edgeRows.length),
    edges: edgeRows.map((e: any) => ({
      source: e.source_id,
      target: e.target_id,
      type: e.edge_type,
      confidence: e.confidence,
      created_by: e.created_by,
    })),
  });
});

// GET /api/edge/attribution?source=&target=&type= — trust provenance for ONE
// live edge, fetched lazily on hover by /field ("attested by … · … · source ↗").
// Keyed by the (source,target,type) triple because the graph stream ships no
// edge row ids; resolves to the newest live row. Zero cache-stamp impact — no
// stream query changes. Consent is honored the same way the profile pages do:
//   - consent_attribution='anonymous'      → attested_by: "anonymous"
//   - consent_scope='structural_only'      → basis (signal title) + source_url
//     suppressed ("only the edge counts, not the content").
router.get("/api/edge/attribution", (req, res) => {
  const db = getDb();
  const source = String(req.query.source || "");
  const target = String(req.query.target || "");
  const type = String(req.query.type || "");
  if (!source || !target || !type) {
    res.status(400).set(JSON_HEADERS).json({ error: "source, target and type are required" });
    return;
  }
  const row = db
    .prepare(
      `SELECT e.edge_type, e.confidence, e.valid_from, e.event_time, e.created_by,
              s.title, s.submitted_by, s.source_url, s.source_origin,
              s.consent_scope, s.consent_attribution, s.status AS signal_status
       FROM edges e
       LEFT JOIN signals s ON s.id = e.signal_id
       WHERE e.valid_until IS NULL AND e.source_id = ? AND e.target_id = ? AND e.edge_type = ?
       ORDER BY e.valid_from DESC LIMIT 1`
    )
    .get(source, target, type) as any;
  if (!row) {
    res.status(404).set(JSON_HEADERS).json({ error: "no live edge for that triple" });
    return;
  }
  const anonymous = row.consent_attribution === "anonymous";
  const structuralOnly = row.consent_scope === "structural_only";
  // No anchoring signal (canon migration rows) → attribute the writer stamp.
  const attestedBy = row.submitted_by
    ? (anonymous ? "anonymous" : row.submitted_by)
    : (row.created_by === "contributor:migration" ? "A(DAI) canon" : row.created_by);
  res.set(JSON_HEADERS).json({
    edge_type: row.edge_type,
    confidence: row.confidence,
    attested_by: attestedBy,
    basis: structuralOnly ? null : row.title || null,
    date: (row.event_time || row.valid_from || "").slice(0, 10) || null,
    source_url: structuralOnly ? null : row.source_url || null,
    source_origin: row.source_origin || null,
    // Everyone who says it, one entry per independent source.
    sources: claimsOf(db, source, target, type),
  });
});

// GET /api/graph/:slug/component — full connected component reachable from :slug
router.get("/api/graph/:slug/component", (req, res) => {
  const db = getDb();
  const slug = req.params.slug;
  const maxNodes = Math.min(Math.max(parseInt((req.query.max_nodes as string) || "800", 10) || 800, 1), 5000);

  const NODE_COLS =
    "id, name, type, slug, " +
    "json_extract(metadata,'$.image_url') AS image_url, " +
    "json_extract(metadata,'$.cdn_image_url') AS cdn_image_url, " +
    YEAR_SQL_FRAGMENT;

  const start = db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE slug = ?`).get(slug) as any;
  if (!start) {
    res.status(404).set(JSON_HEADERS).json({ error: "not found" });
    return;
  }

  const nodeRows = db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE ${NODE_NOT_RETIRED}`).all() as any[];
  const nodeById = new Map<string, any>();
  for (const n of nodeRows) nodeById.set(n.id, n);
  // The start node always hydrates, even when retired — direct inspection of
  // a husk is allowed; only listings filter it. (Its edges are superseded at
  // retire time, so the BFS goes nowhere either way.)
  nodeById.set(start.id, start);

  const edgeRows = db
    .prepare("SELECT source_id, target_id, edge_type, confidence, created_by FROM edges WHERE valid_until IS NULL")
    .all() as any[];

  const adj = new Map<string, Array<{ other: string; e: any }>>();
  for (const e of edgeRows) {
    if (!adj.has(e.source_id)) adj.set(e.source_id, []);
    if (!adj.has(e.target_id)) adj.set(e.target_id, []);
    adj.get(e.source_id)!.push({ other: e.target_id, e });
    adj.get(e.target_id)!.push({ other: e.source_id, e });
  }

  const visited = new Set<string>([start.id]);
  const queue: string[] = [start.id];
  const edgesOut: any[] = [];
  const seenEdgeKeys = new Set<string>();
  let truncated = false;

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const neighbours = adj.get(cur) || [];
    for (const { other, e } of neighbours) {
      const ek = `${e.source_id}|${e.target_id}|${e.edge_type}`;
      if (!seenEdgeKeys.has(ek)) {
        seenEdgeKeys.add(ek);
        edgesOut.push({ source: e.source_id, target: e.target_id, type: e.edge_type, confidence: e.confidence, created_by: e.created_by });
      }
      if (!visited.has(other)) {
        if (visited.size >= maxNodes) {
          truncated = true;
          continue;
        }
        visited.add(other);
        queue.push(other);
      }
    }
  }

  const nodes: any[] = [];
  for (const id of visited) {
    const n = nodeById.get(id);
    if (n) {
      const year = n.type === "artwork" ? formatArtworkYear(n) : null;
      nodes.push({
        id: n.id,
        name: n.name,
        type: n.type,
        slug: n.slug,
        center: n.id === start.id,
        ...(year ? { year } : {}),
        ...(n.cdn_image_url ? { cdn_image_url: n.cdn_image_url } : {}),
        ...(n.image_url ? { image_url: n.image_url } : {}),
      });
    }
  }

  res.set(JSON_HEADERS).json({ nodes, edges: edgesOut, truncated, start_id: start.id });
});

// GET /api/graph/:slug — ego graph (1-hop)
router.get("/api/graph/:slug", (req, res) => {
  const db = getDb();
  const slug = req.params.slug;

  const NODE_COLS =
    "id, name, type, slug, " +
    "json_extract(metadata,'$.image_url') AS image_url, " +
    "json_extract(metadata,'$.cdn_image_url') AS cdn_image_url, " +
    YEAR_SQL_FRAGMENT;

  const node = db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE slug = ?`).get(slug) as any;
  if (!node) {
    res.status(404).set(JSON_HEADERS).json({ error: "not found" });
    return;
  }

  const projectNode = (n: any, extra: Record<string, unknown> = {}) => {
    const year = n.type === "artwork" ? formatArtworkYear(n) : null;
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      slug: n.slug,
      ...extra,
      ...(year ? { year } : {}),
      ...(n.cdn_image_url ? { cdn_image_url: n.cdn_image_url } : {}),
      ...(n.image_url ? { image_url: n.image_url } : {}),
    };
  };

  const nodes: any[] = [projectNode(node, { center: true })];

  const edgeRows = db
    .prepare("SELECT source_id, target_id, edge_type, confidence, created_by FROM edges WHERE valid_until IS NULL AND (source_id = ? OR target_id = ?)")
    .all(node.id, node.id) as any[];

  const edges: any[] = [];
  for (const e of edgeRows) {
    edges.push({
      source: e.source_id,
      target: e.target_id,
      type: e.edge_type,
      confidence: e.confidence,
      created_by: e.created_by,
    });

    const neighborId = e.source_id === node.id ? e.target_id : e.source_id;
    const nb = db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`).get(neighborId) as any;
    if (nb && !nodes.some((n) => n.id === nb.id)) {
      nodes.push(projectNode(nb));
    }
  }

  res.set(JSON_HEADERS).json({ nodes, edges });
});

// POST /api/contribute — submit a signal
router.post("/api/contribute", (req, res) => {
  const db = getDb();
  const { target_node, title, content, source_url, contributor_name, consent_scope, consent_attribution } = req.body;

  // Optional field, but when present it must be a linkable http(s) URL —
  // it's rendered as an <a href> on profile pages and in the field.
  const srcUrl = validateSourceUrl(source_url);
  if (!srcUrl.ok) {
    res.status(400).set(HTML_HEADERS).send(`<div class='msg msg-err'>${srcUrl.error}</div>`);
    return;
  }

  const signalId = `signal-${crypto.randomBytes(8).toString("hex")}`;
  const intakeId = `intake-${crypto.randomBytes(8).toString("hex")}`;

  // The public form is anonymous by identity: a typed name proves nothing, so
  // it never borrows anyone's trust tier — every submission is probationary
  // and goes to /review — and it never counts on an existing contributor row
  // (approval writes a separate 'form' row: approveIntakeItem).
  const trustTier = "probationary";

  const scope = consent_scope === "structural_only" ? "structural_only" : "full_commons";
  const attribution =
    consent_attribution === "anonymous" || consent_attribution === "attributed_with_notification"
      ? consent_attribution
      : "attributed";

  // Consent splits the row (src/utils/signal-private.ts): structural_only
  // words / an anonymous name never reach the CRR.
  const intakeStatus = "pending";
  // A queued contribution's words are published when a curator approves it.
  insertSignalRow(db, {
    id: signalId, title, source_url: srcUrl.value, source_type: "contribution", cla_layer: null, summary: null, content,
    submitted_by: contributor_name, confidence: trustTier, lived_experience: 0,
    consent_scope: scope, consent_attribution: attribution, source_origin: "human_primary",
  }, attribution === "anonymous" ? ["pending"] : ["pending", "pending_name"]);

  db.prepare(
    "INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(intakeId, signalId, target_node, contributor_name, trustTier, intakeStatus);

  // An anonymous contribution is counted on the anonymous sentinel. An
  // attributed one writes no contributor row or counter while in review: the
  // typed name is held back with the words (signal_private, 'pending_name')
  // and approval writes a row of its own for it (approveIntakeItem).
  if (attribution === "anonymous") {
    db.prepare("UPDATE contributors SET contributions = contributions + 1 WHERE id = ?").run(ensureAnonymousContributor(db));
  }

  const responseHtml = "<div class='msg msg-ok'>Signal submitted successfully. It has been queued for review.</div>";

  res.set(HTML_HEADERS).send(responseHtml);
});

// POST /api/review/:id/approve — thin HTML wrapper over the shared
// approve logic in src/utils/review.ts (also used by the admin JSON
// endpoints in contributor-api.ts).
router.post("/api/review/:id/approve", requireCurator, async (req, res) => {
  const db = getDb();
  await mirrorQueuedImages(db, String(req.params.id)); // queued package images; failures are recorded, never fatal
  const outcome = approveIntakeItem(db, String(req.params.id), req.contributor?.name || "curator");
  if (!outcome.ok) {
    res.status(outcome.status).set(JSON_HEADERS).json({ error: outcome.error });
    return;
  }
  const imageNotes = queuedImageFailures(db, String(req.params.id));
  res.set(HTML_HEADERS).send(`<div class='msg msg-ok'>Approved and is now live.${imageNotes.length ? ` Not attached: ${imageNotes.map((n) => htmlEscape(n)).join("; ")}` : ""}</div>`);
  void notifyAfterReview(db, String(req.params.id), true, null);
});

// POST /api/review/:id/reject — thin HTML wrapper over the shared reject
// logic in src/utils/review.ts.
router.post("/api/review/:id/reject", requireCurator, (req, res) => {
  const db = getDb();
  const reason = req.body?.reason;
  if (!reason) {
    res.status(400).set(JSON_HEADERS).json({ error: "reason is required" });
    return;
  }
  const outcome = rejectIntakeItem(db, String(req.params.id), reason, req.contributor?.name || "curator");
  if (!outcome.ok) {
    res.status(outcome.status).set(JSON_HEADERS).json({ error: outcome.error });
    return;
  }
  res.set(HTML_HEADERS).send("<div class='msg msg-err'>Rejected.</div>");
  void notifyAfterReview(db, String(req.params.id), false, reason);
});

// GET /api/islands — latent k-means cluster id per node. Reads the local
// node_islands table (rewritten each embed:derive run from the identity
// vectors — see src/embed/islands.ts).
//
// ⚠️ Currently UNCONSUMED: /field briefly grouped nodes into contiguous
// island regions of the Shape of Time (June 2026), but feedback sent the
// 30k view back to the artist's structured field-flow layout, so
// graph-field.js no longer fetches this. The endpoint + derive stage are
// kept so a future surface can re-adopt the latent geography cheaply.
// Returns {k:0, n:0} when derive hasn't run yet.
router.get("/api/islands", (_req, res) => {
  const db = getDb();
  let rows: Array<{ node_id: string; island: number }> = [];
  try {
    rows = db
      .prepare("SELECT node_id, island FROM node_islands")
      .all() as Array<{ node_id: string; island: number }>;
  } catch {
    // Table absent (pre-migration boot) — treat as "no islands yet".
    rows = [];
  }
  const islands: Record<string, number> = {};
  let k = 0;
  for (const r of rows) {
    islands[r.node_id] = r.island;
    if (r.island + 1 > k) k = r.island + 1;
  }
  res.set(JSON_HEADERS).json({ k, n: rows.length, islands });
});

// GET /api/neighbours/:type/:slug — embedding-derived sections for a node.
//
// Returns the same "Style kin / Visually affine / Style proximity / Closest
// artworks / AI-suggested attributions" cards that the HTML profile pages
// render (`renderEmbeddingSections` in src/routes/pages.ts), in machine form
// so the /field overlays (1k entity view + 10k zoom strip) can fetch and
// render them client-side.
//
// Slug-only lookup (the type segment is decorative, like the other polymorphic
// endpoints) so the client doesn't need to know about colon-id internals.
function neighboursHandler(req: any, res: any) {
  const db = getDb();
  const slug = req.params.slug;

  const node = db
    .prepare("SELECT id, name, type, slug FROM nodes WHERE slug = ?")
    .get(slug) as
    | { id: string; name: string; type: string; slug: string }
    | undefined;
  if (!node) {
    res.status(404).set(JSON_HEADERS).json({ error: "not found" });
    return;
  }

  const sections = buildEmbeddingSections(db, node);
  res.set(JSON_HEADERS).json({
    node: { id: node.id, name: node.name, type: node.type, slug: node.slug },
    sections,
  });
}

// Polymorphic registration matches the rest of the slug-keyed surface.
router.get("/api/neighbours/:type/:slug", neighboursHandler);

// GET /api/roster/:type/:slug — the artists of an institution or platform,
// read off live edges one step behind its own (src/utils/roster.ts). The
// same list the profile page leads with, for /field and any other client.
// Other node types get an empty roster.
router.get("/api/roster/:type/:slug", (req, res) => {
  const db = getDb();
  const node = db.prepare("SELECT id, name, type, slug FROM nodes WHERE slug = ?").get(req.params.slug) as any;
  if (!node) {
    res.status(404).set(JSON_HEADERS).json({ error: "not found" });
    return;
  }
  const roster = node.type === "institution" || node.type === "platform" ? rosterFor(db, node.id) : [];
  res.set(JSON_HEADERS).json({ node: { id: node.id, name: node.name, type: node.type, slug: node.slug }, derived: true, roster });
});

export default router;
