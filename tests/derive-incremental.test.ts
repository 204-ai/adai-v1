// embed:derive is a diff, not delete-then-insert: a run on unchanged vectors
// emits ZERO cr-sqlite changes, and a changed vector changes only the edges
// it is part of (public sync: every derived edge is a CRR row forks receive).

import { it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { freshDb, insertNode, insertCreatedBy, insertIdentityEmbedding } from "./helpers.js";
import { derive } from "../src/embed/derive.js";
import { invalidateVectorCache } from "../src/embed/vectors.js";
import { embedModel } from "../src/embed/provider.js";
import { decodePk } from "../src/utils/privacy-blocks.js";

const D = 768; // loadAll keeps only vectors of the model dimension
function vec(...pairs: Array<[number, number]>): Float32Array {
  const v = new Float32Array(D);
  for (const [i, x] of pairs) v[i] = x;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  for (let i = 0; i < D; i++) v[i]! /= n;
  return v;
}

const OPTS = {
  tauAttribute: 0.99, tauKin: 0.8, tauVisual: 0.8, kinTopK: 0, visualTopK: 0,
  concept: { tauCoherence: -1, minCreators: 1, minMembers: 2, knnK: 2, voteThreshold: 0.5, maxPerConcept: 0 },
};

function setup(): DatabaseSync {
  const db = freshDb();
  // two visual clusters of works by different artists, plus a concept tagged on cluster A
  const works: Array<[string, Float32Array, string]> = [
    ["artwork:a1", vec([0, 1], [1, 0.05]), "practitioner:p1"],
    ["artwork:a2", vec([0, 1], [2, 0.05]), "practitioner:p2"],
    ["artwork:a3", vec([0, 1], [3, 0.05]), "practitioner:p3"],
    ["artwork:b1", vec([4, 1], [5, 0.05]), "practitioner:p4"],
    ["artwork:b2", vec([4, 1], [6, 0.05]), "practitioner:p5"],
    ["artwork:b3", vec([4, 1], [7, 0.05]), "practitioner:p6"],
  ];
  insertNode(db, "concept:grid", "concept", "Grid");
  for (const [id, v, creator] of works) {
    insertNode(db, id, "artwork", id.slice(8));
    if (!db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(creator)) insertNode(db, creator, "practitioner", creator.slice(13));
    insertCreatedBy(db, id, creator);
    insertIdentityEmbedding(db, id, v);
  }
  for (const a of ["artwork:a1", "artwork:a2"]) {
    db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by) VALUES (?, ?, 'concept:grid', 'EMBODIES', 'test')").run(`${a}--EMBODIES--concept:grid--test`, a);
  }
  invalidateVectorCache();
  return db;
}

const version = (db: DatabaseSync) => Number((db.prepare("SELECT crsql_db_version() AS v").get() as any).v);
const derivedRows = (db: DatabaseSync) =>
  db.prepare("SELECT id, created_at, valid_from FROM edges WHERE created_by = 'embedding-multimodal-v1' ORDER BY id").all() as any[];

it("derive twice on unchanged vectors: the second run emits zero crsql_changes and touches no row", () => {
  const db = setup();
  const first = derive(db, OPTS);
  assert.ok(first.edges.inserted > 0, "the first run writes the derived layer");
  assert.ok(first.visually_affine.pairs > 0 && first.style_kin.pairs > 0 && first.concept_embodies.edges_emitted > 0, JSON.stringify(first));
  const rows1 = derivedRows(db);
  const v1 = version(db);
  invalidateVectorCache();
  const second = derive(db, OPTS);
  assert.deepEqual([second.edges.inserted, second.edges.deleted, second.edges.updated_rows], [0, 0, 0]);
  assert.equal(second.edges.desired, first.edges.desired);
  assert.equal(version(db), v1, "no new db_version");
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM crsql_changes WHERE db_version > ?").get(v1) as any).n), 0);
  assert.deepEqual(derivedRows(db), rows1, "created_at / valid_from untouched");
  // never the relations that need evidence of intent
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM edges WHERE edge_type IN ('INFLUENCES', 'RESPONDS_TO')").get() as any).n), 0);
});

it("one vector changes: only the edges it is part of change", () => {
  const db = setup();
  derive(db, OPTS);
  const v1 = version(db);
  // b3 leaves cluster B for a place of its own
  db.prepare("UPDATE node_embeddings SET vector = ? WHERE node_id = 'artwork:b3' AND model = ?")
    .run(new Uint8Array(vec([7, 1]).buffer), embedModel());
  invalidateVectorCache();
  const r = derive(db, OPTS);
  assert.ok(r.edges.deleted > 0, JSON.stringify(r.edges));
  assert.equal(r.edges.updated_rows, 0);
  const changed = db.prepare(`SELECT "table" AS t, pk FROM crsql_changes WHERE db_version > ?`).all(v1) as any[];
  assert.ok(changed.length > 0);
  for (const c of changed) {
    assert.equal(c.t, "edges");
    const id = String(decodePk(c.pk)[0]);
    // b3's own edges, or the style kinship of its artist (p6's centroid is b3's vector)
    assert.ok(id.includes("artwork:b3") || id.includes("practitioner:p6"), id);
  }
});

it("the transition from rows written by the old delete-then-insert: same ids, untouched; a stray cell is corrected alone", () => {
  const db = setup();
  derive(db, OPTS);
  // as old code left it: identical rows, older timestamps; one row with a hand-edited confidence
  db.prepare("UPDATE edges SET created_at = '2026-01-01T00:00:00Z', valid_from = '2026-01-01T00:00:00Z' WHERE created_by = 'embedding-multimodal-v1'").run();
  const one = (db.prepare("SELECT id FROM edges WHERE created_by = 'embedding-multimodal-v1' ORDER BY id LIMIT 1").get() as any).id;
  db.prepare("UPDATE edges SET confidence = 'medium' WHERE id = ?").run(one);
  const v1 = version(db);
  invalidateVectorCache();
  const r = derive(db, OPTS);
  assert.deepEqual([r.edges.inserted, r.edges.deleted, r.edges.updated_rows, r.edges.updated_cells], [0, 0, 1, 1]);
  const changed = db.prepare(`SELECT cid FROM crsql_changes WHERE db_version > ?`).all(v1) as any[];
  assert.deepEqual(changed.map((c) => c.cid), ["confidence"]);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM edges WHERE created_by = 'embedding-multimodal-v1' AND valid_from != '2026-01-01T00:00:00Z'").get() as any).n), 0);
});

it("a dry run reports the diff and writes nothing", () => {
  const db = setup();
  const v0 = version(db);
  const r = derive(db, { ...OPTS, dryRun: true });
  assert.ok(r.edges.inserted > 0);
  assert.equal(version(db), v0);
  assert.equal(derivedRows(db).length, 0);
});
