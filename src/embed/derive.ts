// Pairwise derive pass over the embedding vector space.
//
// Emits two edge types directly into `edges` (CRR, syncs via CR-SQLite):
//   - STYLE_KIN          practitioner ↔ practitioner   (stored bidirectionally)
//   - VISUALLY_AFFINE    artwork    ↔ artwork          (stored bidirectionally)
//
// Plus one queue-only proposal type (not an edge):
//   - SUGGESTS_CREATED_BY  →  intake_queue row with kind='ai_suggestion'
//     and proposed_edges JSON describing a candidate `CREATED_BY` edge
//     (artwork → practitioner). Curator approves to create the real edge.
//
// First action is `computeCentroids()` — derive must never score against
// stale centroids after a curator approves new CREATED_BY edges.
//
// Incremental and idempotent (public sync: every derived edge is a CRR row
// every fork receives). The pass computes the DESIRED derived set — each edge
// with its deterministic id `<source>--<TYPE>--<target>--embedding-multimodal-v1`
// — and diffs it against the current derived rows in one transaction:
// INSERT only what is new, DELETE only what is no longer wanted, UPDATE only a
// cell that differs from the desired value (signal_id, confidence 'low', no
// charge / event time, live). Unchanged rows are not touched — their
// created_at / valid_from stay — so a run on unchanged vectors writes nothing
// and cr-sqlite emits ZERO changes. Derived edges carry no score (confidence
// is the constant 'low'), so float noise cannot rewrite a cell.
// Removed edges are hard-deleted, as before: a derived edge is a recomputed
// view, not anyone's claim (/history leaves them out), so ending it
// bi-temporally would keep ever more dead rows in the public tables; a delete
// is one tombstone change, and a re-derived edge comes back under the same id.
// Concurrency: the passes (quadratic) run on ONE read snapshot that is ended
// before any write; the result — centroids (local), the pending AI
// suggestions (local), the edge diff (CRR) — is applied in one short BEGIN
// IMMEDIATE transaction, after checking under the write lock that the inputs
// did not change since the read (inputFingerprint); if they did, nothing is
// written and the plan is recomputed (DERIVE_MAX_ATTEMPTS). No read snapshot
// is ever upgraded to a write (SQLITE_BUSY_SNAPSHOT), and a failed run leaves
// everything as it was. A dry run writes nothing at all (centroids in memory).
// The pending ai_suggestion rows (local intake_queue, not synced) are still
// replaced every run:
//   DELETE FROM intake_queue WHERE submitted_by='contributor:embedding-pipeline'
//                                AND status='pending'
//
// Rejected pairs (curator pressed Reject on a SUGGESTS_CREATED_BY proposal)
// are skipped via the `rejected_ai_suggestions` table so we don't keep
// re-proposing the same attribution every run.

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { cosine, invalidateVectorCache, loadAll } from "./vectors.js";
import { embedModel } from "./provider.js";
import { centroidsInMemory, writeCentroids } from "./centroids.js";
import {
  propagateConcepts,
  CONCEPT_DEFAULTS,
  type ConceptStats,
  type ConceptPropagateOptions,
} from "./concept-edges.js";

const SIGNAL_ID = "signal:embedding-multimodal-2026-05";
const CONTRIBUTOR_ID = "contributor:embedding-pipeline";
const CREATED_BY_TAG = "embedding-multimodal-v1";

// Thresholds calibrated from seed/_build/calibration_pairs.json against the
// initial embed pass (n=29 positives, n=29 negatives — see
// `npm run embed:calibrate` for histograms). Override at runtime via env.
//
// τ_attribute: median of positives, rounded up. Optimises for precision
//   (high-quality intake_queue proposals) over recall — false positives
//   waste curator time.
// τ_kin / τ_visual: percentile-based; no ground truth, tune by inspection.
const DEFAULTS = {
  tauAttribute: 0.88,
  tauKin: 0.91,
  tauVisual: 0.84,
  // Per-node mutual-kNN cap on STYLE_KIN / VISUALLY_AFFINE. The threshold τ
  // alone holds a fixed *percentile*, so on a large, tightly-clustered corpus
  // (the cull is heavy in generative fxhash art whose outputs sit near-on-top
  // of each other in embedding space) it still emits tens of thousands of
  // edges — a /field hairball. The cap keeps only each node's k strongest
  // neighbours *that also keep it* (mutual kNN), bounding per-node degree to k
  // and pruning dense hubs while leaving sparse, genuinely-distinct nodes
  // untouched. 0 disables the cap (pure-threshold behaviour). Override via env.
  // kinTopK is higher than visualTopK because mutual-kNN reciprocation is much
  // rarer in the creator-centroid space (hub creators sit in everyone's top-k
  // but their own top-k are other hubs), so a lower k starves STYLE_KIN. 20/10
  // lands ~400 STYLE_KIN + ~4.9k VISUALLY_AFFINE on the May-2026 cull — legible
  // in /field, vs ~94k at pure-threshold. Re-check after any large re-embed.
  kinTopK: 20,
  visualTopK: 10,
};

export interface DeriveOptions {
  tauAttribute?: number;
  tauKin?: number;
  tauVisual?: number;
  kinTopK?: number;
  visualTopK?: number;
  dryRun?: boolean;
  // Skip computing centroids — useful for cheap re-tunes when nothing
  // about CREATED_BY edges changed. Default false (chained from CLI).
  skipCentroids?: boolean;
  // Tier-2 concept propagation knobs (EMBODIES from tag-concepts). Partial
  // override; unset fields fall back to CONCEPT_DEFAULTS.
  concept?: Partial<ConceptPropagateOptions>;
  /** Test hook: called between the read snapshot and the apply transaction. */
  afterRead?: (attempt: number) => void;
}

export interface DeriveStats {
  thresholds: { tau_attribute: number; tau_kin: number; tau_visual: number };
  caps: { kin_top_k: number; visual_top_k: number };
  style_kin: { pairs: number; pairs_pre_cap: number; rows_written: number };
  visually_affine: { pairs: number; pairs_pre_cap: number; rows_written: number };
  suggests_created_by: { proposals: number; rejected_skipped: number };
  unattributed_artworks_scored: number;
  concept_embodies: ConceptStats;
  /** What the run wrote to the derived edges (the diff), and how many derived rows there are now. */
  edges: { desired: number; inserted: number; deleted: number; updated_rows: number; updated_cells: number };
  /** How many read → apply attempts the run took (inputs changed in between → recompute). */
  attempts?: number;
}

/** The values a live derived edge holds (besides its id, timestamps and created_by). */
interface DesiredEdge { id: string; source_id: string; target_id: string; edge_type: string }

// Mutual k-NN cap. Keeps a candidate pair only when EACH endpoint ranks the
// other within its k strongest neighbours — so a node's surviving degree is
// ≤ k and dense hubs (a generative-art cluster where everything is affine to
// everything) collapse to their tightest links instead of a clique. Input
// pairs carry their cosine sim; output is the surviving subset. k ≤ 0 → no-op.
// Deterministic: ties broken by neighbour id so re-runs are byte-identical.
function mutualTopK(
  pairs: Array<{ a: string; b: string; sim: number }>,
  k: number
): Array<{ a: string; b: string; sim: number }> {
  if (k <= 0) return pairs;
  const byNode = new Map<string, Array<{ other: string; sim: number }>>();
  const add = (n: string, other: string, sim: number) => {
    let arr = byNode.get(n);
    if (!arr) {
      arr = [];
      byNode.set(n, arr);
    }
    arr.push({ other, sim });
  };
  for (const p of pairs) {
    add(p.a, p.b, p.sim);
    add(p.b, p.a, p.sim);
  }
  const topk = new Map<string, Set<string>>();
  for (const [n, arr] of byNode) {
    arr.sort((x, y) => y.sim - x.sim || (x.other < y.other ? -1 : 1));
    const keep = new Set<string>();
    const lim = Math.min(k, arr.length);
    for (let i = 0; i < lim; i++) keep.add(arr[i]!.other);
    topk.set(n, keep);
  }
  return pairs.filter((p) => topk.get(p.a)?.has(p.b) && topk.get(p.b)?.has(p.a));
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function edgeId(source: string, edgeType: string, target: string): string {
  return `${source}--${edgeType}--${target}--${CREATED_BY_TAG}`;
}

/**
 * Bring the derived edges to the desired set with the smallest write: insert
 * the new, delete the unwanted, update only differing cells. Rows are matched
 * by id (deterministic), among every row tagged as derived or carrying a
 * derived id.
 */
function applyDerivedEdges(db: DatabaseSync, desired: Map<string, DesiredEdge>, now: string, dry: boolean) {
  const out = { inserted: 0, deleted: 0, updated_rows: 0, updated_cells: 0 };
  const current = db
    .prepare(
      `SELECT id, source_id, target_id, edge_type, signal_id, confidence, charge, created_by, event_time, valid_until, invalidated_by
         FROM edges WHERE created_by = ? OR id LIKE ?`
    )
    .all(CREATED_BY_TAG, `%--${CREATED_BY_TAG}`) as any[];
  const byId = new Map(current.map((r) => [String(r.id), r]));
  const del = db.prepare("DELETE FROM edges WHERE id = ?");
  const ins = db.prepare(
    `INSERT INTO edges (
       id, source_id, target_id, edge_type, signal_id,
       confidence, charge, created_at, created_by,
       event_time, valid_from, valid_until, invalidated_by
     ) VALUES (?, ?, ?, ?, ?, 'low', NULL, ?, ?, NULL, ?, NULL, NULL)`
  );
  for (const [id, r] of byId) {
    if (desired.has(id)) continue;
    out.deleted++;
    if (!dry) del.run(id);
  }
  for (const [id, d] of desired) {
    const r = byId.get(id);
    if (!r) {
      out.inserted++;
      if (!dry) ins.run(id, d.source_id, d.target_id, d.edge_type, SIGNAL_ID, now, CREATED_BY_TAG, now);
      continue;
    }
    const want: Record<string, string | null> = {
      source_id: d.source_id, target_id: d.target_id, edge_type: d.edge_type, signal_id: SIGNAL_ID,
      confidence: "low", charge: null, created_by: CREATED_BY_TAG, event_time: null, valid_until: null, invalidated_by: null,
    };
    const cells = Object.keys(want).filter((k) => (r[k] ?? null) !== want[k]);
    if (!cells.length) continue;
    out.updated_rows++;
    out.updated_cells += cells.length;
    if (!dry) db.prepare(`UPDATE edges SET ${cells.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cells.map((c) => want[c]), id);
  }
  return out;
}

function pairHash(source: string, edgeType: string, target: string): string {
  return createHash("sha256").update(`${source}|${edgeType}|${target}`).digest("hex");
}

interface Plan {
  stats: DeriveStats;
  desired: Map<string, DesiredEdge>;
  suggestions: Array<[string, string, string, string, string, string]>; // insertIntake args
  centroids: Map<string, Float32Array> | null; // to persist (null: skipCentroids)
  now: string;
}

/** Compute everything a run would write — reads only, on the snapshot the caller holds. */
function plan(db: DatabaseSync, opts: DeriveOptions): Plan {
  const tauA = opts.tauAttribute ?? DEFAULTS.tauAttribute;
  const tauK = opts.tauKin ?? DEFAULTS.tauKin;
  const tauV = opts.tauVisual ?? DEFAULTS.tauVisual;
  const kinK = opts.kinTopK ?? DEFAULTS.kinTopK;
  const visualK = opts.visualTopK ?? DEFAULTS.visualTopK;
  const dry = !!opts.dryRun;

  void dry;
  // 1. Vectors as of this snapshot (never the cache), and the centroids
  //    computed from them in memory unless explicitly skipped — persisted
  //    with the rest in the apply transaction (never in a dry run).
  const all = loadAll(db, { fresh: true });
  let centroidByCreator = new Map<string, Float32Array>();
  const identityByNode = new Map<string, Float32Array>();
  for (const [, v] of all) {
    if (v.kind === "style_centroid") centroidByCreator.set(v.node_id, v.vec);
    else if (v.kind === "identity") identityByNode.set(v.node_id, v.vec);
  }
  let centroidsToWrite: Map<string, Float32Array> | null = null;
  if (!opts.skipCentroids) {
    const cs = centroidsInMemory(db, all);
    centroidByCreator = cs.centroids;
    centroidsToWrite = cs.centroids;
    console.log(
      `centroids: ${cs.stats.creators_with_centroid} computed, ` +
        `${cs.stats.creators_skipped_no_artworks} skipped (zero artworks), ` +
        `${cs.stats.artworks_missing_vectors} CREATED_BY targets lacked an artwork vector`
    );
  }

  // Map artwork → set of known creators (for VISUALLY_AFFINE filter and
  // SUGGESTS_CREATED_BY "unattributed?" check). Creators are practitioners
  // or collectives — same filter as centroids.ts.
  const creatorsByArtwork = new Map<string, Set<string>>();
  {
    const rows = db
      .prepare(
        `SELECT source_id, target_id FROM edges
         WHERE edge_type = 'CREATED_BY'
           AND valid_until IS NULL
           AND source_id LIKE 'artwork:%'
           AND (target_id LIKE 'practitioner:%' OR target_id LIKE 'collective:%')`
      )
      .all() as Array<{ source_id: string; target_id: string }>;
    for (const r of rows) {
      if (!creatorsByArtwork.has(r.source_id)) creatorsByArtwork.set(r.source_id, new Set());
      creatorsByArtwork.get(r.source_id)!.add(r.target_id);
    }
  }

  // Rejection cache — skip any proposal whose pair_hash is already rejected.
  const rejected = new Set(
    (
      db.prepare("SELECT pair_hash FROM rejected_ai_suggestions").all() as Array<{ pair_hash: string }>
    ).map((r) => r.pair_hash)
  );

  // 4. Compute three passes.
  const stats: DeriveStats = {
    thresholds: { tau_attribute: tauA, tau_kin: tauK, tau_visual: tauV },
    caps: { kin_top_k: kinK, visual_top_k: visualK },
    style_kin: { pairs: 0, pairs_pre_cap: 0, rows_written: 0 },
    visually_affine: { pairs: 0, pairs_pre_cap: 0, rows_written: 0 },
    suggests_created_by: { proposals: 0, rejected_skipped: 0 },
    unattributed_artworks_scored: 0,
    concept_embodies: {
      concepts_considered: 0,
      gated_too_few_members: 0,
      gated_coherence: 0,
      gated_creators: 0,
      concepts_propagated: 0,
      edges_emitted: 0,
    },
    edges: { desired: 0, inserted: 0, deleted: 0, updated_rows: 0, updated_cells: 0 },
  };
  const conceptOpts: ConceptPropagateOptions = { ...CONCEPT_DEFAULTS, ...(opts.concept ?? {}) };

  const now = nowIso();

  // The desired derived edges, collected by every pass (same argument order
  // as the INSERT they used to run directly), applied as a diff at the end.
  const desired = new Map<string, DesiredEdge>();
  const insertEdge = {
    run(...args: unknown[]) {
      const [id, source, target, type] = args;
      desired.set(String(id), { id: String(id), source_id: String(source), target_id: String(target), edge_type: String(type) });
    },
  };

  // The AI suggestions to queue, collected (written in the apply transaction).
  const suggestions: Plan["suggestions"] = [];

  // ----- STYLE_KIN ---------------------------------------------------------
  // Creator ↔ creator over style centroids (practitioner or collective —
  // sections.ts asks for both prefixes, centroids.ts emits both).
  // Bidirectional rows so BFS / profile-page edge lists don't need to know
  // which types are symmetric.
  const creators = [...centroidByCreator.keys()].sort();
  {
    const kinCandidates: Array<{ a: string; b: string; sim: number }> = [];
    for (let i = 0; i < creators.length; i++) {
      const a = creators[i]!;
      const va = centroidByCreator.get(a)!;
      for (let j = i + 1; j < creators.length; j++) {
        const b = creators[j]!;
        const vb = centroidByCreator.get(b)!;
        const sim = cosine(va, vb);
        if (sim < tauK) continue;
        kinCandidates.push({ a, b, sim });
      }
    }
    stats.style_kin.pairs_pre_cap = kinCandidates.length;
    const kinPairs = mutualTopK(kinCandidates, kinK);
    stats.style_kin.pairs = kinPairs.length;
    {
      // collected in a dry run too: the diff is then reported, not applied
      for (const { a, b } of kinPairs) {
        // Two rows, one per direction.
        insertEdge.run(edgeId(a, "STYLE_KIN", b), a, b, "STYLE_KIN", SIGNAL_ID, now, CREATED_BY_TAG, now);
        insertEdge.run(edgeId(b, "STYLE_KIN", a), b, a, "STYLE_KIN", SIGNAL_ID, now, CREATED_BY_TAG, now);
        stats.style_kin.rows_written += 2;
      }
    }

    // ----- VISUALLY_AFFINE ------------------------------------------------
    // Artwork ↔ artwork. Skip same-creator pairs (they'd surface "the artist
    // makes their own work" which is uninformative). Pairs where both
    // artworks lack a known creator ARE emitted — those are exactly the
    // attribution-candidate use case.
    const arts = [...identityByNode.keys()].filter((id) => id.startsWith("artwork:")).sort();
    const visCandidates: Array<{ a: string; b: string; sim: number }> = [];
    for (let i = 0; i < arts.length; i++) {
      const a = arts[i]!;
      const va = identityByNode.get(a)!;
      const ca = creatorsByArtwork.get(a) ?? new Set<string>();
      for (let j = i + 1; j < arts.length; j++) {
        const b = arts[j]!;
        const vb = identityByNode.get(b)!;
        const sim = cosine(va, vb);
        if (sim < tauV) continue;
        // Skip same-creator pairs (intersection non-empty).
        if (ca.size > 0) {
          const cb = creatorsByArtwork.get(b);
          if (cb) {
            let shared = false;
            for (const x of ca) if (cb.has(x)) { shared = true; break; }
            if (shared) continue;
          }
        }
        visCandidates.push({ a, b, sim });
      }
    }
    stats.visually_affine.pairs_pre_cap = visCandidates.length;
    const visPairs = mutualTopK(visCandidates, visualK);
    stats.visually_affine.pairs = visPairs.length;
    {
      for (const { a, b } of visPairs) {
        insertEdge.run(edgeId(a, "VISUALLY_AFFINE", b), a, b, "VISUALLY_AFFINE", SIGNAL_ID, now, CREATED_BY_TAG, now);
        insertEdge.run(edgeId(b, "VISUALLY_AFFINE", a), b, a, "VISUALLY_AFFINE", SIGNAL_ID, now, CREATED_BY_TAG, now);
        stats.visually_affine.rows_written += 2;
      }
    }

    // ----- CONCEPT EMBODIES (Tier-2, centred kNN-vote) -------------------
    // Propagate tag-concepts to visually-similar untagged artworks. Emits
    // low-confidence EMBODIES (artwork → concept) tagged like the other
    // derived edges, so the DELETE above already cleans them on re-run.
    stats.concept_embodies = propagateConcepts(
      db,
      identityByNode,
      creatorsByArtwork,
      insertEdge,
      edgeId,
      SIGNAL_ID,
      CREATED_BY_TAG,
      now,
      conceptOpts,
      false // the collector writes nothing itself: applyDerivedEdges does (or, dry, reports)
    );

    // ----- SUGGESTS_CREATED_BY (intake_queue) ----------------------------
    // For each unattributed artwork A (no live CREATED_BY edge), score
    // against every creator's style_centroid (practitioner or collective).
    // If sim ≥ τ_attribute, enqueue an ai_suggestion row with the proposed
    // CREATED_BY edge (direction: artwork → creator, matching seed convention).
    let suggestionCounter = 0;
    for (const a of arts) {
      const known = creatorsByArtwork.get(a);
      if (known && known.size > 0) continue; // already attributed
      const va = identityByNode.get(a)!;
      stats.unattributed_artworks_scored++;
      // Find the best-matching creator above threshold.
      let best: { creator: string; sim: number } | null = null;
      for (const [c, vc] of centroidByCreator) {
        const sim = cosine(va, vc);
        if (sim < tauA) continue;
        if (!best || sim > best.sim) best = { creator: c, sim };
      }
      if (!best) continue;
      // Skip if curator has already rejected this exact attribution.
      const hash = pairHash(a, "CREATED_BY", best.creator);
      if (rejected.has(hash)) {
        stats.suggests_created_by.rejected_skipped++;
        continue;
      }
      stats.suggests_created_by.proposals++;
      // URL-safe id: a deterministic short hash over (artwork, creator).
      // The intake_queue id ends up in /api/review/:id/{approve,reject} paths
      // and reviewAction()'s JS string-concatenation; spaces/colons in the
      // node ids would break both.
      const idHash = createHash("sha1").update(`${a}|${best.creator}`).digest("hex").slice(0, 12);
      const id = `intake-ai-${idHash}`;
      suggestionCounter++;
      const proposed = JSON.stringify([
        {
          source_id: a,
          target_id: best.creator,
          edge_type: "CREATED_BY",
          // Carry the similarity through so the review UI can sort / show it.
          similarity: Number(best.sim.toFixed(4)),
        },
      ]);
      suggestions.push([id, SIGNAL_ID, a, CONTRIBUTOR_ID, proposed, now]);
    }
    void suggestionCounter;
  }

  return { stats, desired, suggestions, centroids: centroidsToWrite, now };
}

/**
 * A fingerprint of everything derive reads: live CREATED_BY and attested
 * EMBODIES edges, retired nodes, the current model's vectors (and the stored
 * centroids when they are not recomputed), rejected suggestions. Equal
 * fingerprints = the plan computed on the read snapshot is still right.
 */
function inputFingerprint(db: DatabaseSync, opts: DeriveOptions): string {
  const h = createHash("sha256");
  const feed = (sql: string, ...params: Array<string | number>) => {
    for (const r of db.prepare(sql).iterate(...params) as Iterable<any>) h.update(JSON.stringify(Object.values(r)) + "\n");
    h.update("|");
  };
  feed(`SELECT source_id, target_id FROM edges WHERE edge_type = 'CREATED_BY' AND valid_until IS NULL ORDER BY source_id, target_id`);
  feed(`SELECT source_id, target_id FROM edges WHERE edge_type = 'EMBODIES' AND valid_until IS NULL AND created_by IS NOT ? ORDER BY source_id, target_id`, CREATED_BY_TAG);
  feed(`SELECT id, type FROM nodes WHERE json_extract(metadata, '$.retired') = 1 ORDER BY id`);
  feed(
    `SELECT node_id, kind, dims, text_hash, image_hash, created_at, length(vector) FROM node_embeddings
      WHERE model = ? ${opts.skipCentroids ? "" : "AND kind = 'identity'"} ORDER BY node_id, kind`,
    embedModel()
  );
  feed(`SELECT pair_hash FROM rejected_ai_suggestions ORDER BY pair_hash`);
  return h.digest("hex");
}

/** How many times derive recomputes when its inputs changed between its read and its apply. */
export const DERIVE_MAX_ATTEMPTS = 3;

/**
 * Compute on a coherent read snapshot (one read transaction, ended before
 * any write — the long quadratic passes never hold a write lock and never
 * have to upgrade a stale snapshot), then apply the whole result in ONE
 * short BEGIN IMMEDIATE transaction: the centroids (local), the pending AI
 * suggestions replaced (local), the derived-edge diff (CRR). If the inputs
 * changed since the read (inputFingerprint, checked under the write lock),
 * nothing is written and the plan is recomputed — at most
 * DERIVE_MAX_ATTEMPTS times. A dry run computes and reports the diff only.
 */
export function derive(db: DatabaseSync, opts: DeriveOptions = {}): DeriveStats {
  const dry = !!opts.dryRun;
  for (let attempt = 1; attempt <= DERIVE_MAX_ATTEMPTS; attempt++) {
    // ---- read: one snapshot ----
    db.exec("BEGIN");
    let p: Plan;
    let fp: string;
    try {
      fp = inputFingerprint(db, opts);
      p = plan(db, opts);
      if (dry) p.stats.edges = { ...applyDerivedEdges(db, p.desired, p.now, true), desired: p.desired.size };
    } finally {
      db.exec("COMMIT");
    }
    if (dry) return { ...p.stats, attempts: attempt };
    opts.afterRead?.(attempt);

    // ---- apply: one short write transaction ----
    db.exec("BEGIN IMMEDIATE");
    try {
      if (inputFingerprint(db, opts) !== fp) {
        db.exec("ROLLBACK");
        console.log(`derive: inputs changed since the read (attempt ${attempt}); recomputing`);
        continue;
      }
      if (p.centroids) writeCentroids(db, p.centroids, { inTransaction: true });
      db.prepare("DELETE FROM intake_queue WHERE submitted_by = ? AND status = 'pending'").run(CONTRIBUTOR_ID);
      const ins = db.prepare(
        `INSERT INTO intake_queue (
           id, signal_id, target_node, submitted_by, trust_tier,
           status, kind, proposed_edges, created_at
         ) VALUES (?, ?, ?, ?, 'probationary', 'pending', 'ai_suggestion', ?, ?)`
      );
      for (const args of p.suggestions) ins.run(...args);
      p.stats.edges = { ...applyDerivedEdges(db, p.desired, p.now, false), desired: p.desired.size };
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
    invalidateVectorCache();
    return { ...p.stats, attempts: attempt };
  }
  throw new Error(`derive: the inputs changed during each of ${DERIVE_MAX_ATTEMPTS} attempts; nothing was written — run again`);
}
