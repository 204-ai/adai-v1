// Compute and upsert practitioner / collective style centroids.
//
// For each creator C (a practitioner or a collective), gather all live
// `artwork → C` edges where edge_type = 'CREATED_BY' (filter
// `valid_until IS NULL` — bi-temporal rule from CLAUDE.md), pull the
// corresponding artwork `identity` vectors, mean them, L2-normalise,
// upsert as a `style_centroid` row.
//
// Creators with zero live CREATED_BY edges (bridge practitioners, net-new
// imports not yet attributed) get no centroid row and silently fall out
// of STYLE_KIN and SUGGESTS_CREATED_BY downstream. All callers that look
// up centroids must handle the undefined case.
//
// Collectives are first-class here — the profile-page neighbour query in
// src/embed/sections.ts asks for both `practitioner:` and `collective:`
// prefixes, and node_embeddings has no type restriction.
//
// Idempotent: re-runs INSERT OR REPLACE.

import type { DatabaseSync } from "node:sqlite";
import { encodeBlob, keyFor, loadAll, meanAndNormalise, invalidateVectorCache, type VectorRow, DIMS } from "./vectors.js";

import { embedModel } from "./provider.js";
import { CENTROID_EDGES_SQL } from "./inputs.js";

export interface CentroidStats {
  creators_with_centroid: number;
  creators_skipped_no_artworks: number;
  artworks_missing_vectors: number;
}

/**
 * The centroids, computed in memory from the vectors and live CREATED_BY
 * edges as `db` sees them now (no write) — derive computes them on its read
 * snapshot, and a dry run never touches the table.
 */
export function centroidsInMemory(db: DatabaseSync, vectors?: Map<string, VectorRow>): { centroids: Map<string, Float32Array>; stats: CentroidStats } {
  const vecs = vectors ?? loadAll(db, { fresh: true });

  // Map: creator_id (practitioner or collective) → list of artwork vectors.
  const byCreator = new Map<string, Float32Array[]>();

  // only to creators that exist and are not retired (CENTROID_EDGES_SQL)
  const edges = db.prepare(CENTROID_EDGES_SQL).all() as Array<{ source_id: string; target_id: string }>;

  let missing = 0;
  for (const e of edges) {
    const art = vecs.get(keyFor(e.source_id, "identity"));
    if (!art) {
      missing++;
      continue;
    }
    if (!byCreator.has(e.target_id)) byCreator.set(e.target_id, []);
    byCreator.get(e.target_id)!.push(art.vec);
  }

  const centroids = new Map<string, Float32Array>();
  let skipped = 0;
  for (const [creator, arts] of byCreator) {
    if (arts.length === 0) {
      skipped++;
      continue;
    }
    centroids.set(creator, meanAndNormalise(arts));
  }
  return { centroids, stats: { creators_with_centroid: centroids.size, creators_skipped_no_artworks: skipped, artworks_missing_vectors: missing } };
}

/**
 * Replace the style_centroid rows with `centroids` (local table). The caller
 * owns the transaction when it has one (derive's apply); otherwise one is
 * opened here.
 */
export function writeCentroids(db: DatabaseSync, centroids: Map<string, Float32Array>, opts: { inTransaction?: boolean } = {}): void {
  const insertEmb = db.prepare(
    `INSERT INTO node_embeddings (node_id, kind, model, dims, vector, has_image, image_hash, text_hash, created_at)
     VALUES (?, 'style_centroid', ?, ?, ?, 0, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
  );
  const write = () => {
    // Wipe existing style_centroid rows so re-runs don't leave stale rows
    // for creators who lost all their attributions.
    db.exec("DELETE FROM node_embeddings WHERE kind = 'style_centroid'");
    for (const [creator, c] of centroids) insertEmb.run(creator, embedModel(), DIMS, encodeBlob(c));
  };
  if (opts.inTransaction) write();
  else {
    db.exec("BEGIN");
    try {
      write();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  // Style-centroid rows just changed — drop the cache so a reader straight
  // after reads them fresh.
  invalidateVectorCache();
}

export function computeCentroids(db: DatabaseSync): CentroidStats {
  const { centroids, stats } = centroidsInMemory(db);
  writeCentroids(db, centroids);
  return stats;
}

/**
 * Convenience: load all centroids as a fast lookup map. Useful for derive.
 */
export function loadCentroids(db: DatabaseSync): Map<string, Float32Array> {
  const rows = loadAll(db);
  const out = new Map<string, Float32Array>();
  for (const [k, v] of rows) {
    if (v.kind === "style_centroid") out.set(v.node_id, v.vec);
  }
  return out;
}

export function loadIdentityVectors(db: DatabaseSync): Map<string, VectorRow> {
  const rows = loadAll(db);
  const out = new Map<string, VectorRow>();
  for (const [k, v] of rows) {
    if (v.kind === "identity") out.set(v.node_id, v);
  }
  return out;
}
