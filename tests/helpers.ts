// Shared helpers for the test suite. The production code path goes through
// initDb / getDb (module-level singleton); tests bypass that to keep
// each test file isolated with its own in-memory DB. The functions under
// test (computeCentroids, mintToken, derive, etc.) take `db: DatabaseSync`
// as a parameter, so they don't care which DB instance they're handed.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPath } from "@shards-lang/crsqlite";
import { embedModel } from "../src/embed/provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

/** Open a fresh in-memory DB with the full schema + migrations applied. */
export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  db.loadExtension(extensionPath);
  const schema = readFileSync(join(PROJECT_ROOT, "db.sql"), "utf-8");
  db.exec(schema);
  // Mirror the migrations runMigrations() in src/db.ts applies — the column
  // already exists in some fresh-from-schema DBs depending on db.sql ordering,
  // so catch the same "duplicate column name" the production path catches.
  try {
    db.exec(
      "ALTER TABLE intake_queue ADD COLUMN kind TEXT NOT NULL DEFAULT 'human_signal'"
    );
  } catch (e: any) {
    if (!String(e?.message ?? e).includes("duplicate column name")) throw e;
  }
  return db;
}

/** Pack a Float32Array into the Uint8Array shape node:sqlite expects. */
export function encodeF32(arr: Float32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Build a unit-norm vector with a single nonzero component at index `axis`. */
export function unitVector(dims: number, axis: number): Float32Array {
  const v = new Float32Array(dims);
  v[axis % dims] = 1;
  return v;
}

/** Insert a minimal node row. Metadata is optional and stored as JSON text. */
export function insertNode(
  db: DatabaseSync,
  id: string,
  type: string,
  name: string,
  metadata: Record<string, any> | null = null
): void {
  db.prepare(
    "INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, 'test')"
  ).run(
    id,
    type,
    name,
    id.split(":").slice(1).join(":"),
    metadata ? JSON.stringify(metadata) : null
  );
}

/** Insert a CREATED_BY edge from artwork → creator. valid_until defaults to NULL (current). */
export function insertCreatedBy(
  db: DatabaseSync,
  source: string,
  target: string,
  opts: { validUntil?: string | null } = {}
): void {
  const id = `${source}--CREATED_BY--${target}--test`;
  const validUntil = opts.validUntil ?? null;
  db.prepare(
    `INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, confidence, charge,
                        created_at, created_by, event_time, valid_from, valid_until, invalidated_by)
     VALUES (?, ?, ?, 'CREATED_BY', NULL, 'low', NULL,
             strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'test',
             NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?, NULL)`
  ).run(id, source, target, validUntil);
}

/** Insert an identity-kind embedding row for a node. */
export function insertIdentityEmbedding(
  db: DatabaseSync,
  nodeId: string,
  vec: Float32Array
): void {
  db.prepare(
    `INSERT INTO node_embeddings (node_id, kind, model, dims, vector, has_image, image_hash, text_hash, created_at)
     VALUES (?, 'identity', ?, ?, ?, 1, 'imghash-' || ?, 'texthash-' || ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
  ).run(nodeId, embedModel(), vec.length, encodeF32(vec), nodeId, nodeId);
}
