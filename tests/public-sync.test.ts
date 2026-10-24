// Public CRDT sync: the CRR tables hold only what the commons publishes
// (src/utils/signal-private.ts), so cr-sqlite's own change stream can be
// served unfiltered (src/routes/sync.ts) and pulled into a fork
// (src/sync/pull.ts).

import { it, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { freshDb, insertNode } from "./helpers.js";
import { initDb } from "../src/db.js";
import syncRoutes, { resetSyncGuards } from "../src/routes/sync.js";
import type { AuthedContributor } from "../src/auth.js";
import { insertIntake, insertSignal, materialiseEdge, materialisePatchNode, recordPrior } from "../src/utils/contribution.js";
import { retireBatch, retireNode, revokeSignal } from "../src/utils/admin-actions.js";
import { nodeHistory } from "../src/utils/history.js";
import { approveIntakeItem, rejectIntakeItem } from "../src/utils/review.js";
import {
  ANONYMOUS, ANONYMOUS_CONTRIBUTOR_ID, backlogTotal, fullSignal, migratePrivacy, priorsOf, privacyBacklog,
} from "../src/utils/signal-private.js";
import { applyChanges, CRR_TABLES, decodeVal, encodeVal, parseCursor, readChanges, type WireChange } from "../src/sync/changes.js";
import { pullFork } from "../src/sync/pull.js";

const WHO: AuthedContributor = { id: "contributor-who", name: "Wanda Writer", trust_tier: "auto", token_label: null, token_prefix: "adai_x", scope: "write" } as any;
const ADMIN = "op";

function seed(db: DatabaseSync, c: AuthedContributor = WHO) {
  db.prepare("INSERT OR IGNORE INTO contributors (id, name, type, trust_tier, contributions, approved_count) VALUES (?, ?, 'contributor', ?, 0, 0)").run(c.id, c.name, c.trust_tier);
}

/** Every value in the change stream, as text (the whole public surface of a fork). */
function streamText(db: DatabaseSync): string {
  const rows = db.prepare(`SELECT "table", quote(pk) AS pk, cid, CASE typeof(val) WHEN 'blob' THEN hex(val) ELSE CAST(val AS TEXT) END AS v, hex(site_id) AS site FROM crsql_changes`).all() as any[];
  return rows.map((r) => `${r.table}|${r.pk}|${r.cid}|${r.v ?? ""}`).join("\n");
}

/** Pull everything from `src` into `dst` in pages, through the wire encoding. */
function pullAll(src: DatabaseSync, dst: DatabaseSync, since = "0", limit = 50): string {
  let cur = since;
  for (;;) {
    const page = readChanges(src, parseCursor(cur)!, limit);
    applyChanges(dst, JSON.parse(JSON.stringify(page.changes)) as WireChange[], null);
    cur = page.next;
    if (!page.more) return cur;
  }
}

const PK: Record<string, string> = { nodes: "id", edges: "id", signals: "id", contributors: "id", node_aliases: "source, external_id" };
function crrDump(db: DatabaseSync): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of CRR_TABLES) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => `quote(${c.name})`).join(" || '|' || ");
    out[t] = (db.prepare(`SELECT ${cols} AS r FROM ${t} ORDER BY ${PK[t]}`).all() as any[]).map((r) => r.r);
  }
  return out;
}

describe("the CRRs hold only what the commons publishes", () => {
  it("(a) a structural_only signal's words never appear in crsql_changes", () => {
    const db = freshDb();
    seed(db);
    insertNode(db, "artwork:w", "artwork", "W");
    insertNode(db, "practitioner:p", "practitioner", "P");
    const sig = insertSignal(db, { contributor: WHO, title: "TITLE-SECRET-a1", content: "WORDS-SECRET-a2", source_url: "https://secret.example/a3", consent_scope: "structural_only", provenance_chain: JSON.stringify({ note: "PROV-SECRET-a4" }) });
    materialiseEdge(db, { source_id: "artwork:w", target_id: "practitioner:p", edge_type: "CREATED_BY" }, { signalId: sig, createdBy: "api-Wanda Writer" });
    const text = streamText(db);
    for (const s of ["TITLE-SECRET-a1", "WORDS-SECRET-a2", "secret.example", "PROV-SECRET-a4"]) assert.ok(!text.includes(s), `${s} leaked`);
    // the relation and the fact of the signal are public
    assert.match(text, /edges\|.*\|edge_type\|CREATED_BY/);
    assert.match(text, /signals\|.*\|consent_scope\|structural_only/);
    // the original is on the operator's side
    const full = fullSignal(db, sig);
    assert.equal(full.title, "TITLE-SECRET-a1");
    assert.equal(full.content, "WORDS-SECRET-a2");
    assert.equal(full.source_url, "https://secret.example/a3");
    // and it may not write node metadata (words in a CRR)
    assert.throws(() => materialisePatchNode(db, { op: "patch_node", node_id: "artwork:w", metadata: { description: "x" } }, { createdBy: "api-x", signalId: sig }), /structural_only/);
  });

  it("(b) revoking emits a change; a fork that pulls again loses the words", () => {
    const src = freshDb();
    seed(src);
    insertNode(src, "artwork:w", "artwork", "W");
    insertNode(src, "practitioner:p", "practitioner", "P");
    const sig = insertSignal(src, { contributor: WHO, title: "Edge by Wanda", content: "REVOKED-WORDS-b1", source_url: "https://src.example/b2" });
    materialiseEdge(src, { source_id: "artwork:w", target_id: "practitioner:p", edge_type: "CREATED_BY" }, { signalId: sig, createdBy: "api-Wanda Writer" });
    const fork = freshDb();
    const c1 = pullAll(src, fork);
    assert.equal((fork.prepare("SELECT content FROM signals WHERE id = ?").get(sig) as any).content, "REVOKED-WORDS-b1");
    const before = Number((src.prepare("SELECT crsql_db_version() AS v").get() as any).v);
    revokeSignal(src, sig, { reason: "wrong", by: ADMIN });
    // the blanking is a change after the fork's cursor
    // (the admin anchor's own cells are new too; the blanked ones are the NULLs among title / content)
    const changed = src.prepare("SELECT cid FROM crsql_changes WHERE \"table\" = 'signals' AND db_version > ? AND cid IN ('content', 'title', 'status') AND (val IS NULL OR val = 'revoked')").all(before) as any[];
    assert.deepEqual(changed.map((r) => r.cid).sort(), ["content", "status", "title"]);
    assert.ok(!streamText(src).includes("REVOKED-WORDS-b1"));
    pullAll(src, fork, c1);
    const f = fork.prepare("SELECT status, title, content, source_url FROM signals WHERE id = ?").get(sig) as any;
    assert.deepEqual({ ...f }, { status: "revoked", title: null, content: null, source_url: null });
    assert.equal((fork.prepare("SELECT COUNT(*) AS n FROM edges WHERE valid_until IS NULL").get() as any).n, 0);
    // nothing is deleted: the operator keeps the original
    assert.equal(fullSignal(src, sig).content, "REVOKED-WORDS-b1");
    assert.deepEqual(crrDump(fork), crrDump(src));
  });

  it("(c) before-images stay out of crsql_changes; /history still shows before → after", () => {
    const db = initDb(":memory:");
    seed(db);
    db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES ('artwork:x', 'artwork', 'X', 'x', ?, 'seed')").run(JSON.stringify({ year: "BEFORE-1999", medium: "OLD-MEDIUM-c1" }));
    const sig = insertSignal(db, { contributor: WHO, title: "Patch", content: "{}" });
    const op = { op: "patch_node" as const, node_id: "artwork:x", metadata: { year: "2001", medium: null } };
    materialisePatchNode(db, op, { createdBy: "api-Wanda Writer", signalId: sig });
    insertIntake(db, { contributor: WHO, signal_id: sig, target_node: "artwork:x", proposed_nodes: [op] });
    retireNode(db, "artwork:x", { reason: "dup", by: ADMIN });
    const text = streamText(db);
    assert.ok(!text.includes("BEFORE-1999") && !text.includes("OLD-MEDIUM-c1"), "a before-image leaked");
    const trace = JSON.parse((db.prepare("SELECT processing_trace FROM signals WHERE id = ?").get(sig) as any).processing_trace);
    assert.deepEqual(Object.keys(trace.prior[0]).sort(), ["at", "node_id", "op"]);
    assert.deepEqual(priorsOf(db, sig)[0]!.before, { year: "BEFORE-1999", medium: "OLD-MEDIUM-c1" });
    const ev = nodeHistory(db, "artwork:x")!.events.filter((e: any) => e.kind === "metadata") as any[];
    const patch = ev.find((e) => e.op === "patch_node");
    assert.deepEqual(patch.changes, [{ key: "year", before: "BEFORE-1999", after: "2001" }, { key: "medium", before: "OLD-MEDIUM-c1", after: null }]);
    assert.ok(ev.some((e) => e.op === "retire_node" && e.before_recorded));
  });

  it("(d) anonymous: no real contributor id or name in crsql_changes", () => {
    const db = freshDb();
    const shy: AuthedContributor = { ...WHO, id: "contributor-shy-d1", name: "Shy Person d2", trust_tier: "auto" } as any;
    seed(db, shy);
    insertNode(db, "artwork:w", "artwork", "W");
    insertNode(db, "practitioner:p", "practitioner", "P");
    const before = (db.prepare("SELECT contributions, approved_count FROM contributors WHERE id = ?").get(shy.id) as any);
    const sig = insertSignal(db, { contributor: shy, title: "A note", content: "an anonymous account", consent_attribution: "anonymous", batch_id: "batch-shy-d3" });
    const { intake_id } = insertIntake(db, { contributor: { ...shy, trust_tier: "probationary" } as any, signal_id: sig, target_node: "artwork:w" });
    approveIntakeItem(db, intake_id, "curator");
    materialiseEdge(db, { source_id: "artwork:w", target_id: "practitioner:p", edge_type: "CREATED_BY", signal_id: sig }, { signalId: sig, createdBy: `api-${shy.name}` });
    // the person exists in the commons (a contributors row of their own); no
    // signal, edge or node may point at them
    const text = streamText(db).split("\n").filter((l) => !l.startsWith("contributors|")).join("\n");
    for (const s of ["contributor-shy-d1", "Shy Person d2", "batch-shy-d3"]) assert.ok(!text.includes(s), `${s} leaked`);
    const crr = db.prepare("SELECT submitted_by, batch_id FROM signals WHERE id = ?").get(sig) as any;
    assert.deepEqual({ ...crr }, { submitted_by: ANONYMOUS, batch_id: null });
    assert.equal((db.prepare("SELECT created_by FROM edges WHERE signal_id = ?").get(sig) as any).created_by, ANONYMOUS);
    // counted on the sentinel, not on the author
    assert.deepEqual({ ...(db.prepare("SELECT contributions, approved_count FROM contributors WHERE id = ?").get(shy.id) as any) }, { ...before });
    assert.equal((db.prepare("SELECT approved_count FROM contributors WHERE id = ?").get(ANONYMOUS_CONTRIBUTOR_ID) as any).approved_count, 1);
    // the author stays known on the operator's side
    assert.equal((db.prepare("SELECT contributor_id FROM signal_authors WHERE signal_id = ?").get(sig) as any).contributor_id, shy.id);
    assert.equal(fullSignal(db, sig).submitted_by, "Shy Person d2");
    assert.equal(fullSignal(db, sig).batch_id, "batch-shy-d3");
  });

  it("a rejected contribution's words leave the CRR", () => {
    const db = freshDb();
    const p: AuthedContributor = { ...WHO, id: "c-p", name: "Probie", trust_tier: "probationary" } as any;
    seed(db, p);
    insertNode(db, "artwork:w", "artwork", "W");
    const sig = insertSignal(db, { contributor: p, title: "SPAM-TITLE", content: "SPAM-WORDS" });
    const { intake_id, status } = insertIntake(db, { contributor: p, signal_id: sig, target_node: "artwork:w" });
    assert.equal(status, "pending");
    rejectIntakeItem(db, intake_id, "spam");
    assert.ok(!streamText(db).includes("SPAM-"));
    assert.equal(fullSignal(db, sig).content, "SPAM-WORDS");
  });

  it("a contribution in review is published only when approved; the curator sees it meanwhile", () => {
    const db = freshDb();
    const p: AuthedContributor = { ...WHO, id: "c-p2", name: "Newcomer", trust_tier: "probationary" } as any;
    seed(db, p);
    const sig = insertSignal(db, { contributor: p, title: "Create node: artwork:Queued", content: JSON.stringify({ name: "IN-REVIEW-WORDS" }), source_type: "api_node", pending: true });
    const { intake_id } = insertIntake(db, { contributor: p, signal_id: sig, target_node: "artwork:queued", proposed_nodes: [{ op: "create_node", type: "artwork", name: "Queued", slug: "queued", metadata: { description: "IN-REVIEW-DESC" } }] });
    assert.ok(!streamText(db).includes("IN-REVIEW"), "pending words in the stream");
    assert.match(fullSignal(db, sig).content, /IN-REVIEW-WORDS/);
    const fork = freshDb();
    const c1 = pullAll(db, fork);
    approveIntakeItem(db, intake_id, "curator");
    const text = streamText(db);
    assert.ok(text.includes("IN-REVIEW-WORDS") && text.includes("IN-REVIEW-DESC"), "approved: published");
    assert.equal(db.prepare("SELECT 1 FROM signal_private WHERE signal_id = ?").get(sig), undefined, "nothing left private");
    pullAll(db, fork, c1);
    assert.deepEqual(crrDump(fork), crrDump(db));
    assert.equal(backlogTotal(privacyBacklog(db)), 0);
  });

  it("crsql_changes covers the five CRRs and nothing local", () => {
    const db = freshDb();
    seed(db);
    insertNode(db, "artwork:w", "artwork", "W");
    db.prepare("INSERT INTO contributor_tokens (token_hash, token_prefix, contributor_id) VALUES ('HASH-SECRET', 'adai_x', 'c')").run();
    db.prepare("INSERT INTO contributor_emails (email, contributor_id) VALUES ('x@example.org', 'c')").run();
    insertSignal(db, { contributor: WHO, title: "t", content: "c", consent_scope: "structural_only" });
    const tables = new Set((db.prepare(`SELECT DISTINCT "table" AS t FROM crsql_changes`).all() as any[]).map((r) => r.t));
    for (const t of tables) assert.ok((CRR_TABLES as readonly string[]).includes(t), t);
    const text = streamText(db);
    assert.ok(!text.includes("HASH-SECRET") && !text.includes("x@example.org"));
  });
});

describe("the change stream and the fork", () => {
  it("values keep their exact SQLite type through the wire encoding", () => {
    for (const [v, back] of [[null, null], ["t", "t"], [3n, 3n], [2n ** 60n, 2n ** 60n], [1.0, 1.0], [1.5, 1.5], [new Uint8Array([0, 255]), new Uint8Array([0, 255])]] as const) {
      const enc = JSON.parse(JSON.stringify(encodeVal(v)));
      assert.deepEqual(decodeVal(enc), back);
    }
    assert.deepEqual(encodeVal(1.0), { r: 1 });
    assert.equal(encodeVal(7n), 7);
  });

  it("(e) end to end over HTTP: fork:pull since=0, then again after a revoke and a retire", async () => {
    const src = initDb(":memory:");
    seed(src);
    for (let i = 0; i < 30; i++) insertNode(src, `artwork:w${i}`, "artwork", `W${i}`, { year: String(1960 + i), description: `work ${i}` });
    insertNode(src, "practitioner:p", "practitioner", "P", { bio: "a bio" });
    const sigs: string[] = [];
    for (let i = 0; i < 30; i++) {
      const s = insertSignal(src, { contributor: WHO, title: `Edge ${i}`, content: `evidence ${i}`, source_url: `https://e.example/${i}`, batch_id: i < 5 ? "batch-five" : null });
      materialiseEdge(src, { source_id: `artwork:w${i}`, target_id: "practitioner:p", edge_type: "CREATED_BY" }, { signalId: s, createdBy: "api-Wanda Writer" });
      sigs.push(s);
    }
    src.prepare("INSERT INTO node_aliases (source, external_id, node_id) VALUES ('handle', 'pee', 'practitioner:p')").run();
    resetSyncGuards();
    const app = express();
    app.use(syncRoutes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const info = await (await fetch(`${base}/api/sync/info`)).json();
      assert.equal(info.site_id.length, 32);
      assert.deepEqual(info.tables, [...CRR_TABLES]);
      assert.equal((await fetch(`${base}/api/sync/changes?since=nope`)).status, 400);
      const gz = await fetch(`${base}/api/sync/changes?since=0`, { headers: { "accept-encoding": "gzip" } });
      assert.equal(gz.headers.get("content-encoding"), "gzip");

      const fork = freshDb();
      const r1 = await pullFork(fork, { from: base, limit: 40 });
      assert.ok(r1.pages > 3, `paged (${r1.pages})`);
      assert.deepEqual(crrDump(fork), crrDump(src));
      assert.equal((fork.prepare("SELECT value FROM settings WHERE key = 'fork_source_site_id'").get() as any).value, info.site_id);

      // more on the source: a revoke, a batch retire, a node retire, a new node
      revokeSignal(src, sigs[10]!, { reason: "wrong", by: ADMIN });
      retireBatch(src, "batch-five", { reason: "bad batch", by: ADMIN });
      retireNode(src, "artwork:w20", { reason: "dup", by: ADMIN });
      insertNode(src, "concept:new", "concept", "New");
      const r2 = await pullFork(fork, { from: base, limit: 40 });
      assert.ok(r2.changes > 0 && r2.changes < r1.changes, "only what is new");
      assert.deepEqual(crrDump(fork), crrDump(src));
      assert.equal((fork.prepare("SELECT content FROM signals WHERE id = ?").get(sigs[10]!) as any).content, null);
      assert.equal((fork.prepare("SELECT COUNT(*) AS n FROM signals WHERE batch_id = 'batch-five' AND status = 'revoked' AND content IS NULL").get() as any).n, 5);
      const r3 = await pullFork(fork, { from: base });
      assert.equal(r3.changes, 0);

      // a fork of another source is refused
      const other = freshDb();
      other.prepare("INSERT INTO settings (key, value) VALUES ('fork_source_site_id', 'ffffffffffffffffffffffffffffffff')").run();
      await assert.rejects(pullFork(other, { from: base }), /fork of site/);
      // so is a database that already holds data of its own
      const busy = freshDb();
      insertNode(busy, "artwork:mine", "artwork", "Mine");
      await assert.rejects(pullFork(busy, { from: base }), /no fork/);
      await pullFork(busy, { from: base, force: true });
      assert.equal((busy.prepare("SELECT COUNT(*) AS n FROM nodes").get() as any).n, (src.prepare("SELECT COUNT(*) AS n FROM nodes").get() as any).n + 1);

      // the stream is not served while the privacy migration has rows left
      src.prepare("UPDATE signals SET processing_trace = ? WHERE id = ?").run(JSON.stringify({ prior: [{ op: "patch_node", node_id: "artwork:w1", before: { year: "x" } }] }), sigs[1]!);
      resetSyncGuards();
      assert.equal((await fetch(`${base}/api/sync/changes?since=0`)).status, 503);
      migratePrivacy(src);
      resetSyncGuards();
      assert.equal((await fetch(`${base}/api/sync/changes?since=0`)).status, 200);
    } finally {
      server.close();
    }
  });

  it("(f) pagination under concurrent writes neither skips nor duplicates", () => {
    const src = freshDb();
    seed(src);
    for (let i = 0; i < 40; i++) insertNode(src, `artwork:a${i}`, "artwork", `A${i}`, { n: i });
    // one big transaction, larger than a page: split by seq
    src.exec("BEGIN");
    for (let i = 0; i < 60; i++) insertNode(src, `concept:c${i}`, "concept", `C${i}`);
    src.exec("COMMIT");
    const fork = freshDb();
    const seen = new Set<string>();
    let cur = "0";
    let pages = 0;
    let split = false;
    for (;;) {
      const page = readChanges(src, parseCursor(cur)!, 37);
      for (const c of page.changes) {
        const key = `${c[0]}|${c[1]}|${c[2]}|${c[4]}|${c[5]}`;
        assert.ok(!seen.has(key), `duplicate ${key}`);
        seen.add(key);
      }
      // whole db_versions per page, except a split transaction
      if (page.next.includes(":")) split = true;
      applyChanges(fork, page.changes, null);
      cur = page.next;
      pages++;
      // writes between pages: cells already delivered change, new rows land
      if (pages === 2) {
        src.prepare("UPDATE nodes SET name = 'renamed' WHERE id = 'artwork:a0'").run();
        insertNode(src, "artwork:late", "artwork", "Late");
      }
      if (pages === 4) src.prepare("UPDATE nodes SET metadata = '{\"n\":99}' WHERE id = 'concept:c59'").run();
      if (!page.more) break;
    }
    assert.ok(split, "a transaction bigger than the page was split");
    assert.deepEqual(crrDump(fork), crrDump(src));
  });

  it("(g) the migration is idempotent and loses nothing", () => {
    const db = freshDb();
    seed(db);
    const p: AuthedContributor = { ...WHO, id: "c-p", name: "Probie", trust_tier: "probationary" } as any;
    seed(db, p);
    insertNode(db, "artwork:x", "artwork", "X", { year: "2000" });
    const raw = (id: string, cols: Record<string, unknown>) => {
      const all = { id, source_type: "contribution", submitted_by: "Wanda Writer", ...cols };
      const keys = Object.keys(all);
      db.prepare(`INSERT INTO signals (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => (all as any)[k]));
    };
    // rows as the code before the move wrote them
    raw("s-struct", { title: "T-struct", content: "C-struct", source_url: "https://s.example/x", consent_scope: "structural_only", processing_trace: JSON.stringify({ argv: ["/home/x"] }) });
    raw("s-revoked", { title: "T-rev", content: "C-rev", status: "revoked" });
    raw("s-anon", { title: "T-anon", content: "C-anon", consent_attribution: "anonymous", batch_id: "b-anon", submitted_by: "Real Name" });
    raw("s-prior", { title: "Patch", content: "{}", processing_trace: JSON.stringify({ prior: [{ op: "patch_node", node_id: "artwork:x", at: "2026-01-01T00:00:00Z", updated_by: "seed", before: { year: "1999" } }] }) });
    raw("s-admin", { source_type: "api_admin", title: "Retire batch: b", content: JSON.stringify({ action: "retire_batch", patches_to_review: [{ op: "patch_node", node_id: "artwork:x", signal_id: "s-prior", before: { year: "1999" } }] }) });
    raw("s-rej", { title: "T-rej", content: "C-rej", submitted_by: "Probie" });
    db.prepare("INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status) VALUES ('q-rej', 's-rej', 'artwork:x', 'Probie', 'probationary', 'rejected')").run();
    const originals = new Map((db.prepare("SELECT * FROM signals").all() as any[]).map((r) => [r.id, { ...r }]));

    const dry = migratePrivacy(db, { dryRun: true });
    assert.deepEqual([dry.priors.signals, dry.words.signals, dry.anonymous.signals, dry.admin_before_images.signals, dry.rejected.signals], [1, 2, 1, 1, 1]);
    assert.ok(backlogTotal(privacyBacklog(db)) > 0, "a dry run writes nothing");
    const v0 = Number((db.prepare("SELECT crsql_db_version() AS v").get() as any).v);

    const r = migratePrivacy(db);
    assert.equal(backlogTotal(r.left!), 0);
    assert.ok(Number((db.prepare("SELECT crsql_db_version() AS v").get() as any).v) > v0, "the blanking is a recorded change");
    for (const s of ["T-struct", "C-struct", "s.example", "/home/x", "C-rev", "T-rev", "Real Name", "b-anon", "1999", "C-rej"]) assert.ok(!streamText(db).includes(s), `${s} still in the stream`);
    // lossless: every original is readable on the operator's side
    for (const [id, o] of originals) {
      const full = fullSignal(db, id);
      for (const c of ["title", "content", "source_url", "submitted_by", "batch_id", "provenance_chain"]) assert.equal(full[c], o[c], `${id}.${c}`);
      if (id !== "s-prior") assert.equal(full.processing_trace, o.processing_trace, `${id}.processing_trace`);
    }
    assert.deepEqual(priorsOf(db, "s-prior").map((e) => [e.before, e.updated_by]), [[{ year: "1999" }, "seed"]]);

    const again = migratePrivacy(db);
    assert.deepEqual([again.priors.signals, again.words.signals, again.anonymous.signals, again.admin_before_images.signals, again.notes.signals, again.rejected.signals], [0, 0, 0, 0, 0, 0]);
    const after2 = new Map((db.prepare("SELECT * FROM signals_full").all() as any[]).map((r) => [r.id, JSON.stringify(r)]));
    migratePrivacy(db);
    for (const [id, j] of after2) assert.equal(JSON.stringify(fullSignal(db, id)), j);
  });

  it("a fork refuses a source with another CRR schema", async () => {
    const fork = freshDb();
    const fakeInfo = { format: "adai-crsql-changes/1", site_id: crypto.randomBytes(16).toString("hex"), db_version: 1, schema: { hash: "0".repeat(64), tables: {} }, tables: [...CRR_TABLES] };
    const f = (async () => new Response(JSON.stringify(fakeInfo), { headers: { "content-type": "application/json" } })) as any;
    await assert.rejects(pullFork(fork, { from: "http://x", fetchImpl: f }), /schema differs/);
  });
});

it("/offline explains forking: the endpoints, fork:pull, pulling again, licences, no embeddings", async () => {
  const { offlinePage } = await import("../src/routes/offline.js");
  const html = offlinePage(null, "https://example.org");
  for (const s of ["/api/sync/info", "/api/sync/changes", "npm run fork:pull -- --from https://example.org", "only when it pulls again", "Apache-2.0", "CC BY-SA 4.0", "LICENSE-DATA", "embed:backfill", "Not published yet"]) assert.ok(html.includes(s), s);
});
