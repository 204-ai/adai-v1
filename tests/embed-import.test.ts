// Content-addressed vector import (src/embed/import.ts): a vector moves only
// when it is of the current model and its text + image hashes are what the
// target node would be embedded from now.

import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importVectors, cdnImageHash } from "../src/embed/import.js";
import { buildText } from "../src/embed/server.js";
import { DIMS } from "../src/embed/vectors.js";
import { freshDb, insertNode, encodeF32, unitVector } from "./helpers.js";

const saved = { EMBED_PROVIDER: process.env.EMBED_PROVIDER, EMBED_MODEL: process.env.EMBED_MODEL };
const dirs: string[] = [];
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const cdn = (sha: string) => `https://pub-x.r2.dev/images/${sha.slice(0, 2)}/${sha}.png`;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function sourceDb(rows: Array<{ id: string; model?: string; text_hash: string | null; image_hash?: string | null }>): string {
  const dir = mkdtempSync(join(tmpdir(), "embimp-"));
  dirs.push(dir);
  const path = join(dir, "src.db");
  const s = new DatabaseSync(path);
  s.exec(`CREATE TABLE node_embeddings (node_id TEXT, kind TEXT, model TEXT, dims INTEGER, vector BLOB,
          has_image INTEGER, image_hash TEXT, text_hash TEXT, created_at TEXT, PRIMARY KEY (node_id, kind))`);
  const ins = s.prepare(`INSERT INTO node_embeddings VALUES (?, 'identity', ?, ?, ?, ?, ?, ?, 'now')`);
  rows.forEach((r, i) =>
    ins.run(r.id, r.model ?? "google/embeddinggemma-2", DIMS, encodeF32(unitVector(DIMS, i + 1)), r.image_hash ? 1 : 0, r.image_hash ?? null, r.text_hash)
  );
  s.close();
  return path;
}

it("cdnImageHash reads the sha off a content-addressed R2 url", () => {
  assert.equal(cdnImageHash({ cdn_image_url: cdn(SHA_A), image_url: "https://elsewhere/x.jpg" }), SHA_A);
  assert.equal(cdnImageHash({ image_url: "https://elsewhere/x.jpg" }), null);
  assert.equal(cdnImageHash({}), null);
});

it("imports matching vectors only, and is idempotent", () => {
  process.env.EMBED_PROVIDER = "openai";
  delete process.env.EMBED_MODEL;
  const db = freshDb();
  insertNode(db, "concept:noise", "concept", "Noise", { description: "static" });
  insertNode(db, "concept:moved", "concept", "Moved", { description: "now different" });
  insertNode(db, "artwork:a", "artwork", "A", { description: "a", cdn_image_url: cdn(SHA_A) });
  insertNode(db, "artwork:b", "artwork", "B", { description: "b", cdn_image_url: cdn(SHA_B) });
  const th = (id: string) => {
    const n = db.prepare("SELECT type, name, metadata FROM nodes WHERE id = ?").get(id) as any;
    return sha(buildText(n)!);
  };
  // An old-model row for noise, to be replaced.
  db.prepare(
    `INSERT INTO node_embeddings (node_id, kind, model, dims, vector, has_image, image_hash, text_hash)
     VALUES ('concept:noise', 'identity', 'gemini-embedding-2', ?, ?, 0, NULL, 'python-era')`
  ).run(DIMS, encodeF32(unitVector(DIMS, 0)));

  const path = sourceDb([
    { id: "concept:noise", text_hash: th("concept:noise") },
    { id: "concept:moved", text_hash: sha("old text") }, // text changed since
    { id: "artwork:a", text_hash: th("artwork:a"), image_hash: SHA_A },
    { id: "artwork:b", text_hash: th("artwork:b"), image_hash: SHA_A }, // image changed since
    { id: "concept:gone", text_hash: sha("x") }, // node not here
    { id: "concept:other", model: "other-model", text_hash: sha("y") }, // another model: never read
  ]);

  const dry = importVectors(db, path, { dryRun: true });
  assert.equal(dry.imported, 2);
  assert.equal(
    (db.prepare("SELECT model FROM node_embeddings WHERE node_id='concept:noise'").get() as any).model,
    "gemini-embedding-2",
    "dry run writes nothing"
  );

  const s = importVectors(db, path);
  assert.deepEqual(
    { imported: s.imported, text_changed: s.text_changed, image_changed: s.image_changed, no_such_node: s.no_such_node },
    { imported: 2, text_changed: 1, image_changed: 1, no_such_node: 1 }
  );
  const models = db.prepare("SELECT node_id, model FROM node_embeddings WHERE kind='identity' ORDER BY node_id").all() as any[];
  assert.deepEqual(models.map((r) => `${r.node_id}=${r.model}`), [
    "artwork:a=google/embeddinggemma-2",
    "concept:noise=google/embeddinggemma-2",
  ]);

  const again = importVectors(db, path);
  assert.equal(again.imported, 0);
  assert.equal(again.already_current, 2);
});
