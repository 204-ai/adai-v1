// Compares two embedding models over the same nodes, before a model switch
// (src/embed/provider.ts). Each DB holds one model's identity vectors — e.g. a
// snapshot of the live DB, and a copy re-embedded with the new model via
// `EMBED_PROVIDER=openai DB_PATH=copy.db npm run embed:backfill`.
//
//   npx tsx scripts/embed-compare.ts <a.db> <a-model> <b.db> <b-model> [node-id…]
//
// Reports, per node type, how much the top-10 same-type neighbours agree
// between the models, and two ground-truth proxies the graph already holds:
//   same-creator@10  — of an artwork's 10 nearest artworks, the share by one
//                      of its own creators (CREATED_BY): style coherence.
//   embodies@10      — of a concept's 10 nearest artworks, the share that
//                      EMBODY it (curated edges only).
// Then side-by-side top-5 lists for the node ids given (or a few samples).
// Reads only; writes nothing.

import { DatabaseSync } from "node:sqlite";

const [aPath, aModel, bPath, bModel, ...examples] = process.argv.slice(2);
if (!aPath || !aModel || !bPath || !bModel) {
  console.error("usage: npx tsx scripts/embed-compare.ts <a.db> <a-model> <b.db> <b-model> [node-id…]");
  process.exit(2);
}

type Vecs = Map<string, Float32Array>;

function load(path: string, model: string): Vecs {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT ne.node_id, ne.vector FROM node_embeddings ne JOIN nodes n ON n.id = ne.node_id
       WHERE ne.kind = 'identity' AND ne.model = ? AND json_extract(n.metadata,'$.retired') IS NOT 1`
    )
    .all(model) as Array<{ node_id: string; vector: Uint8Array }>;
  db.close();
  const out: Vecs = new Map();
  for (const r of rows) {
    const c = new Uint8Array(r.vector.byteLength);
    c.set(r.vector);
    out.set(r.node_id, new Float32Array(c.buffer));
  }
  return out;
}

const A = load(aPath, aModel);
const B = load(bPath, bModel);
const common = [...A.keys()].filter((id) => B.has(id));
console.log(`${aModel}: ${A.size} vectors · ${bModel}: ${B.size} vectors · common: ${common.length}\n`);

const typeOf = (id: string) => id.slice(0, id.indexOf(":"));
const byType = new Map<string, string[]>();
for (const id of common) {
  const t = typeOf(id);
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t)!.push(id);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function topK(V: Vecs, q: string, pool: string[], k: number): Array<[string, number]> {
  const qv = V.get(q)!;
  const top: Array<[string, number]> = [];
  for (const id of pool) {
    if (id === q) continue;
    const s = dot(qv, V.get(id)!);
    if (top.length < k) {
      top.push([id, s]);
      top.sort((x, y) => y[1] - x[1]);
    } else if (s > top[k - 1]![1]) {
      top[k - 1] = [id, s];
      top.sort((x, y) => y[1] - x[1]);
    }
  }
  return top;
}

// Ground truth from the graph (either DB; the graph is the same).
const g = new DatabaseSync(aPath, { readOnly: true });
const creatorsOf = new Map<string, Set<string>>();
for (const r of g
  .prepare(`SELECT source_id, target_id FROM edges WHERE edge_type='CREATED_BY' AND valid_until IS NULL`)
  .all() as Array<{ source_id: string; target_id: string }>) {
  if (!creatorsOf.has(r.source_id)) creatorsOf.set(r.source_id, new Set());
  creatorsOf.get(r.source_id)!.add(r.target_id);
}
const embodiedBy = new Map<string, Set<string>>(); // concept → artworks
for (const r of g
  .prepare(
    `SELECT source_id, target_id FROM edges WHERE edge_type='EMBODIES' AND valid_until IS NULL
     AND (created_by IS NULL OR created_by <> 'embedding-multimodal-v1')`
  )
  .all() as Array<{ source_id: string; target_id: string }>) {
  if (!embodiedBy.has(r.target_id)) embodiedBy.set(r.target_id, new Set());
  embodiedBy.get(r.target_id)!.add(r.source_id);
}
const names = new Map<string, string>(
  (g.prepare(`SELECT id, name FROM nodes`).all() as Array<{ id: string; name: string }>).map((r) => [r.id, r.name])
);
g.close();

const K = 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const pct = (x: number) => (Number.isNaN(x) ? "  –  " : (100 * x).toFixed(1).padStart(5) + "%");

console.log("type            n   overlap@10   " + `${aModel} | ${bModel}`.padEnd(48) + "metric");
const artworks = byType.get("artwork") ?? [];
for (const [t, ids] of [...byType.entries()].sort((x, y) => y[1].length - x[1].length)) {
  if (ids.length < 12) continue;
  const overlaps: number[] = [];
  const gtA: number[] = [];
  const gtB: number[] = [];
  for (const q of ids) {
    const ta = topK(A, q, ids, K).map(([id]) => id);
    const tb = topK(B, q, ids, K).map(([id]) => id);
    const sb = new Set(tb);
    overlaps.push(ta.filter((id) => sb.has(id)).length / K);
    if (t === "artwork") {
      const cr = creatorsOf.get(q);
      if (cr && cr.size) {
        const share = (list: string[]) =>
          list.filter((id) => [...(creatorsOf.get(id) ?? [])].some((c) => cr.has(c))).length / K;
        gtA.push(share(ta));
        gtB.push(share(tb));
      }
    }
  }
  let metric = "";
  if (t === "artwork") metric = `same-creator@10  ${pct(mean(gtA))} | ${pct(mean(gtB))}  (${gtA.length} credited works)`;
  console.log(`${t.padEnd(14)} ${String(ids.length).padStart(4)}   ${pct(mean(overlaps))}       ${metric}`);
}

// Concepts → artworks, against curated EMBODIES.
const conceptIds = (byType.get("concept") ?? []).filter((c) => (embodiedBy.get(c)?.size ?? 0) >= 3);
if (conceptIds.length) {
  const share = (V: Vecs, c: string) => {
    const gt = embodiedBy.get(c)!;
    return topK(V, c, artworks, K).filter(([id]) => gt.has(id)).length / K;
  };
  const ea = conceptIds.map((c) => share(A, c));
  const eb = conceptIds.map((c) => share(B, c));
  console.log(
    `\nconcept → artworks, embodies@10 (${conceptIds.length} concepts with ≥3 curated works): ${pct(mean(ea))} | ${pct(mean(eb))}`
  );
}

// Side-by-side examples.
const samples = examples.length
  ? examples
  : artworks.filter((id) => creatorsOf.has(id)).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 6)) === 0).slice(0, 6);
for (const q of samples) {
  if (!A.has(q) || !B.has(q)) {
    console.log(`\n${q}: not in both`);
    continue;
  }
  const pool = byType.get(typeOf(q)) ?? common;
  const ta = topK(A, q, pool, 5);
  const tb = topK(B, q, pool, 5);
  console.log(`\n${names.get(q) ?? q}  [${q.slice(0, 80)}]`);
  for (let i = 0; i < 5; i++) {
    const f = (x?: [string, number]) => (x ? `${x[1].toFixed(3)} ${(names.get(x[0]) ?? x[0]).slice(0, 34)}` : "").padEnd(42);
    console.log(`  ${f(ta[i])} | ${f(tb[i])}`);
  }
}
