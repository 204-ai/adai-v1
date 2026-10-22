// Content-addressed vector import: reuse identity vectors computed elsewhere
// (another environment's DB, a local run, a pulled prod copy) instead of
// paying the provider to embed the same content again.
//
// A vector is a function of (model, embed text, image bytes), and every row
// records all three: `model`, `text_hash` (sha256 of buildText's output) and
// `image_hash` (sha256 of the image bytes). R2 keys are content-addressed too
// (`images/<sha[:2]>/<sha>.<ext>`), so the node's current image hash is read
// off its cdn_image_url with no download. A source row is imported only when
// it is of the current model and its hashes match what the target node would
// be embedded from right now; anything else is left for `embed:backfill`.
//
//   npm run embed:import -- --from=/path/other.db [--dry-run]
//   then: npm run embed:backfill   (the rest)  →  npm run embed:derive

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { buildText } from "./server.js";
import { embedModel } from "./provider.js";
import { DIMS, invalidateVectorCache } from "./vectors.js";

export interface ImportStats {
  model: string;
  source_rows: number;
  imported: number;
  already_current: number;
  no_such_node: number;
  text_changed: number;
  image_changed: number;
}

const CDN_KEY = /\/images\/[0-9a-f]{2}\/([0-9a-f]{64})\.[a-z0-9]+(?:$|[?#])/i;

/** The sha256 the node's image would hash to, when its preferred URL is an R2 key. */
export function cdnImageHash(metadata: Record<string, any>): string | null {
  const url = [metadata.cdn_image_url, metadata.image_url, metadata.image].find(
    (u) => typeof u === "string" && /^https?:\/\//.test(u)
  ) as string | undefined;
  if (!url) return null;
  const m = CDN_KEY.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

export function importVectors(db: DatabaseSync, sourcePath: string, opts: { dryRun?: boolean } = {}): ImportStats {
  const model = embedModel();
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  const rows = src
    .prepare(
      `SELECT node_id, dims, vector, has_image, image_hash, text_hash FROM node_embeddings
       WHERE kind = 'identity' AND model = ? AND dims = ?`
    )
    .all(model, DIMS) as Array<{
      node_id: string;
      dims: number;
      vector: Uint8Array;
      has_image: number;
      image_hash: string | null;
      text_hash: string | null;
    }>;
  src.close();

  const stats: ImportStats = {
    model,
    source_rows: rows.length,
    imported: 0,
    already_current: 0,
    no_such_node: 0,
    text_changed: 0,
    image_changed: 0,
  };

  const getNode = db.prepare(
    `SELECT id, type, name, metadata FROM nodes WHERE id = ? AND json_extract(metadata,'$.retired') IS NOT 1`
  );
  const getRow = db.prepare(
    `SELECT model, text_hash, image_hash FROM node_embeddings WHERE node_id = ? AND kind = 'identity'`
  );
  const upsert = db.prepare(
    `INSERT INTO node_embeddings (node_id, kind, model, dims, vector, has_image, image_hash, text_hash, created_at)
     VALUES (?, 'identity', ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(node_id, kind) DO UPDATE SET
       model = excluded.model, dims = excluded.dims, vector = excluded.vector,
       has_image = excluded.has_image, image_hash = excluded.image_hash,
       text_hash = excluded.text_hash, created_at = excluded.created_at`
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) {
      const node = getNode.get(r.node_id) as { id: string; type: string; name: string; metadata: string } | undefined;
      if (!node) {
        stats.no_such_node++;
        continue;
      }
      const text = buildText(node);
      const textHash = text ? crypto.createHash("sha256").update(text).digest("hex") : null;
      if (textHash !== (r.text_hash || null)) {
        stats.text_changed++;
        continue;
      }
      // An image-bearing vector must be of the node's current image. (A
      // text-only vector stands: the image was unusable to the provider, or
      // the node has none; an image added later re-embeds on write.)
      if (r.image_hash) {
        let md: Record<string, any> = {};
        try {
          md = JSON.parse(node.metadata || "{}");
        } catch {}
        const current = cdnImageHash(md);
        if (current && current !== r.image_hash.toLowerCase()) {
          stats.image_changed++;
          continue;
        }
      }
      const existing = getRow.get(r.node_id) as { model: string; text_hash: string | null; image_hash: string | null } | undefined;
      if (existing && existing.model === model && existing.text_hash === r.text_hash && existing.image_hash === r.image_hash) {
        stats.already_current++;
        continue;
      }
      if (!opts.dryRun) upsert.run(r.node_id, model, r.dims, r.vector, r.has_image, r.image_hash, r.text_hash);
      stats.imported++;
    }
    db.exec(opts.dryRun ? "ROLLBACK" : "COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  invalidateVectorCache();
  return stats;
}
