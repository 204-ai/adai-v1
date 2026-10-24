// Tier-2 concept propagation: low-confidence EMBODIES edges for untagged
// artworks that are visually close to a tag-concept's attested members.
//
// WHY kNN-vote on a MEAN-CENTERED space, not centroid-cosine on raw vectors:
// generative-art embeddings are anisotropic (every vector points roughly the
// same way — they ARE all colourful abstract patterns), so raw cosine sits in
// a compressed high band and a few artworks near the global centroid match
// *every* concept. Mean-centering removes that common component; a local
// kNN-vote ("what fraction of my nearest neighbours carry this tag?") is then
// immune to the residual global-centroid pull. Validated against real fxhash
// tags + the live embeddings before this code existed (see PR notes): naive
// centroid-cosine matched everything-to-everything; centred kNN-vote gave tight,
// plausible propagation (pixel → untagged pixel-art creatures; grid/glitch → 0).
//
// Two gates keep junk tag-concepts from propagating:
//   - coherence  : mean centred member→centroid cosine ≥ τ_coh. Umbrella tags
//                  ("art", "generative", "p5js") score near zero and drop out.
//   - creators   : ≥ minCreators distinct creators among members. Kills
//                  single-artist tag series that look coherent but aren't a
//                  shared concept (e.g. one artist's handle used as a tag).
//
// Output edges are EMBODIES tagged created_by='embedding-multimodal-v1',
// confidence 'low' — recomputed every derive run and applied as a diff with
// STYLE_KIN / VISUALLY_AFFINE (derive.ts applyDerivedEdges: only new rows
// inserted, only unwanted ones deleted), rendered dashed in /field, never
// written into the committed seed/*.json canon. Propagation only targets NON-members, so it
// never collides with an attested (confidence 1.0) EMBODIES.

import type { DatabaseSync } from "node:sqlite";

export interface ConceptPropagateOptions {
  tauCoherence: number; // min centred member→centroid cosine
  minCreators: number; // min distinct creators among a concept's members
  minMembers: number; // min attested members for a concept to be considered
  knnK: number; // neighbours inspected per artwork
  voteThreshold: number; // min fraction of an artwork's kNN that are members
  maxPerConcept: number; // cap proposals per concept (0 = uncapped)
}

export const CONCEPT_DEFAULTS: ConceptPropagateOptions = {
  tauCoherence: 0.15,
  minCreators: 8,
  minMembers: 15,
  knnK: 30,
  voteThreshold: 0.3,
  maxPerConcept: 200,
};

export interface ConceptStats {
  concepts_considered: number;
  gated_too_few_members: number;
  gated_coherence: number;
  gated_creators: number;
  concepts_propagated: number;
  edges_emitted: number;
}

interface InsertEdgeStmt {
  run(...args: unknown[]): unknown;
}

// dot product of two equal-length vectors
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a));
}

/**
 * Propagate tag-concepts across the centred artwork embedding space.
 * Called from derive() inside its transaction; hands each EMBODIES edge to
 * derive's collector (`insertEdge.run(id, source, target, type, …)`), which
 * applies the whole derived set as a diff.
 */
export function propagateConcepts(
  db: DatabaseSync,
  identityByNode: Map<string, Float32Array>,
  creatorsByArtwork: Map<string, Set<string>>,
  insertEdge: InsertEdgeStmt,
  edgeId: (source: string, edgeType: string, target: string) => string,
  signalId: string,
  createdByTag: string,
  now: string,
  opts: ConceptPropagateOptions,
  dry: boolean
): ConceptStats {
  const stats: ConceptStats = {
    concepts_considered: 0,
    gated_too_few_members: 0,
    gated_coherence: 0,
    gated_creators: 0,
    concepts_propagated: 0,
    edges_emitted: 0,
  };

  // 1. Attested EMBODIES members per concept (exclude our own derived rows so
  //    a re-run never bootstraps off last run's guesses).
  const memberRows = db
    .prepare(
      `SELECT source_id, target_id FROM edges
       WHERE edge_type = 'EMBODIES'
         AND valid_until IS NULL
         AND created_by != ?
         AND source_id LIKE 'artwork:%'
         AND target_id LIKE 'concept:%'`
    )
    .all(createdByTag) as Array<{ source_id: string; target_id: string }>;

  const membersByConcept = new Map<string, Set<string>>();
  for (const r of memberRows) {
    if (!identityByNode.has(r.source_id)) continue;
    if (!membersByConcept.has(r.target_id)) membersByConcept.set(r.target_id, new Set());
    membersByConcept.get(r.target_id)!.add(r.source_id);
  }
  if (membersByConcept.size === 0) return stats;

  // 2. Centre artwork vectors: subtract the global mean, renormalise.
  const arts = [...identityByNode.keys()].filter((id) => id.startsWith("artwork:")).sort();
  const N = arts.length;
  if (N === 0) return stats;
  const D = identityByNode.get(arts[0]!)!.length;
  const mean = new Float32Array(D);
  for (const a of arts) {
    const v = identityByNode.get(a)!;
    for (let i = 0; i < D; i++) mean[i]! += v[i]!;
  }
  for (let i = 0; i < D; i++) mean[i]! /= N;

  const centred = new Map<string, Float32Array>();
  const idx = new Map<string, number>();
  const mat: Float32Array[] = [];
  for (let k = 0; k < N; k++) {
    const a = arts[k]!;
    const v = identityByNode.get(a)!;
    const c = new Float32Array(D);
    for (let i = 0; i < D; i++) c[i]! = v[i]! - mean[i]!;
    const n = norm(c) || 1;
    for (let i = 0; i < D; i++) c[i]! /= n;
    centred.set(a, c);
    idx.set(a, k);
    mat.push(c);
  }

  // 3. Per-artwork k-nearest neighbours in the centred space (cosine = dot,
  //    rows are unit-norm). O(N^2); same order of cost as VISUALLY_AFFINE.
  const K = opts.knnK;
  const knn: number[][] = new Array(N);
  for (let i = 0; i < N; i++) {
    const vi = mat[i]!;
    // maintain top-K by sim
    const top: Array<{ j: number; s: number }> = [];
    let minTop = Infinity;
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const s = dot(vi, mat[j]!);
      if (top.length < K) {
        top.push({ j, s });
        if (top.length === K) {
          minTop = Math.min(...top.map((t) => t.s));
        }
      } else if (s > minTop) {
        // replace current min
        let mIdx = 0;
        for (let t = 1; t < top.length; t++) if (top[t]!.s < top[mIdx]!.s) mIdx = t;
        top[mIdx] = { j, s };
        minTop = Math.min(...top.map((t) => t.s));
      }
    }
    knn[i] = top.map((t) => t.j);
  }

  // 4. Per concept: gate, then kNN-vote propagate to non-members.
  for (const [concept, members] of membersByConcept) {
    stats.concepts_considered++;
    if (members.size < opts.minMembers) {
      stats.gated_too_few_members++;
      continue;
    }
    // coherence (centred member → centroid)
    const centroid = new Float32Array(D);
    for (const m of members) {
      const c = centred.get(m)!;
      for (let i = 0; i < D; i++) centroid[i]! += c[i]!;
    }
    const cn = norm(centroid) || 1;
    for (let i = 0; i < D; i++) centroid[i]! /= cn;
    let coh = 0;
    for (const m of members) coh += dot(centred.get(m)!, centroid);
    coh /= members.size;
    if (coh < opts.tauCoherence) {
      stats.gated_coherence++;
      continue;
    }
    // creator diversity
    const creators = new Set<string>();
    for (const m of members) {
      const cs = creatorsByArtwork.get(m);
      if (cs) for (const x of cs) creators.add(x);
    }
    if (creators.size < opts.minCreators) {
      stats.gated_creators++;
      continue;
    }

    // propagate: non-members whose kNN vote ≥ threshold
    const memberIdx = new Set<number>();
    for (const m of members) {
      const k = idx.get(m);
      if (k !== undefined) memberIdx.add(k);
    }
    const candidates: Array<{ art: string; frac: number }> = [];
    for (let i = 0; i < N; i++) {
      if (memberIdx.has(i)) continue;
      const neigh = knn[i]!;
      let hit = 0;
      for (const j of neigh) if (memberIdx.has(j)) hit++;
      const frac = neigh.length ? hit / neigh.length : 0;
      if (frac >= opts.voteThreshold) candidates.push({ art: arts[i]!, frac });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.frac - a.frac || (a.art < b.art ? -1 : 1));
    const emit = opts.maxPerConcept > 0 ? candidates.slice(0, opts.maxPerConcept) : candidates;
    stats.concepts_propagated++;
    if (!dry) {
      for (const { art } of emit) {
        insertEdge.run(
          edgeId(art, "EMBODIES", concept),
          art,
          concept,
          "EMBODIES",
          signalId,
          now,
          createdByTag,
          now
        );
        stats.edges_emitted++;
      }
    } else {
      stats.edges_emitted += emit.length;
    }
  }

  return stats;
}
