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

export interface CentroidStats {
  creators_with_centroid: number;
  creators_skipped_no_artworks: number;
  artworks_missing_vectors: number;
}

export function computeCentroids(db: DatabaseSync): CentroidStats {
  const vectors = loadAll(db);

  // Map: creator_id (practitioner or collective) → list of artwork vectors.
  const byCreator = new Map<string, Float32Array[]>();

  const edges = db
    .prepare(
      `SELECT source_id, target_id FROM edges
       WHERE edge_type = 'CREATED_BY'
         AND valid_until IS NULL
         AND source_id LIKE 'artwork:%'
         AND (target_id LIKE 'practitioner:%' OR target_id LIKE 'collective:%')`
    )
    .all() as Array<{ source_id: string; target_id: string }>;

  let missing = 0;
  for (const e of edges) {
    const art = vectors.get(keyFor(e.source_id, "identity"));
    if (!art) {
      missing++;
      continue;
    }
    if (!byCreator.has(e.target_id)) byCreator.set(e.target_id, []);
    byCreator.get(e.target_id)!.push(art.vec);
  }

  // Wipe existing style_centroid rows so re-runs don't leave stale rows
  // for creators who lost all their attributions. (Idempotency over
  // node identity, not just hash.)
  db.exec("DELETE FROM node_embeddings WHERE kind = 'style_centroid'");

  const insertEmb = db.prepare(
    `INSERT INTO node_embeddings (node_id, kind, model, dims, vector, has_image, image_hash, text_hash, created_at)
     VALUES (?, 'style_centroid', ?, ?, ?, 0, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
  );

  let wrote = 0;
  let skipped = 0;

  db.exec("BEGIN");
  try {
    for (const [creator, arts] of byCreator) {
      if (arts.length === 0) {
        skipped++;
        continue;
      }
      const centroid = meanAndNormalise(arts);
      insertEmb.run(creator, embedModel(), DIMS, encodeBlob(centroid));
      wrote++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  // Style-centroid rows just changed — drop the cache so the derive pass that
  // runs straight after reads them fresh (not the pre-write snapshot).
  invalidateVectorCache();

  return {
    creators_with_centroid: wrote,
    creators_skipped_no_artworks: skipped,
    artworks_missing_vectors: missing,
  };
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
