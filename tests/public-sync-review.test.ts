// Public sync, review fixes: anonymous counters over HTTP, legacy anonymous
// graph attribution closes the gate, private batch handles, withheld hosts in
// the attribution endpoint, anonymous edge ids, page byte budgets, client IP,
// conflicts in the migration, the public form's pending names.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import type { Request } from "express";
import { initDb } from "../src/db.js";
import { freshDb, insertNode } from "./helpers.js";
import contributorApi from "../src/routes/contributor-api.js";
import api from "../src/routes/api.js";
import syncRoutes, { resetSyncGuards } from "../src/routes/sync.js";
import { mintToken } from "../src/utils/token-mint.js";
import { insertSignal, materialiseEdge } from "../src/utils/contribution.js";
import { retireBatch } from "../src/utils/admin-actions.js";
import { approveIntakeItem, rejectIntakeItem } from "../src/utils/review.js";
import { anonymousGraphAttribution, backlogTotal, fullSignal, migratePrivacy, privacyBacklog, PrivacyConflictError, withholdSignal } from "../src/utils/signal-private.js";
import { applyChanges, parseCursor, readChanges } from "../src/sync/changes.js";
import { clientIp } from "../src/intake/auth.js";
import type { AuthedContributor } from "../src/auth.js";

function streamText(db: DatabaseSync): string {
  const rows = db.prepare(`SELECT "table", hex(pk) AS pk, cid, CAST(val AS TEXT) AS v FROM crsql_changes`).all() as any[];
  return rows.map((r) => `${r.table}|${r.pk}|${r.cid}|${r.v ?? ""}`).join("\n");
}

/** The contributors row's cells as the change stream has them: [cid, col_version, db_version]. */
function contributorClock(db: DatabaseSync, name: string): string {
  const pk = (db.prepare(`SELECT pk FROM crsql_changes WHERE "table" = 'contributors' AND cid = 'name' AND val = ?`).get(name) as any)?.pk;
  assert.ok(pk, `no contributors row for ${name}`);
  return JSON.stringify(db.prepare(`SELECT cid, col_version, db_version FROM crsql_changes WHERE "table" = 'contributors' AND pk = ? ORDER BY cid`).all(pk));
}

async function serve(...routers: any[]) {
  const app = express();
  app.use(express.json());
  for (const r of routers) app.use(r);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
}

it("anonymous /api/v1/signals (auto and probationary): the real contributor's counters and their change versions do not move", async () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  const auto = mintToken(db, { contributorName: "Auto Author", createIfMissing: true, tier: "auto" } as any);
  const prob = mintToken(db, { contributorName: "Probie Author", createIfMissing: true, tier: "probationary" } as any);
  const { server, base } = await serve(contributorApi);
  try {
    for (const [tok, name] of [[auto, "Auto Author"], [prob, "Probie Author"]] as const) {
      const counters = () => JSON.stringify(db.prepare("SELECT contributions, approved_count FROM contributors WHERE name = ?").get(name));
      const c0 = counters();
      const k0 = contributorClock(db, name);
      const r = await fetch(`${base}/api/v1/signals`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok.raw_token}`, "content-type": "application/json" },
        body: JSON.stringify({ target_node: "artwork:w", title: "a memory", content: "words", consent_attribution: "anonymous", batch_id: `b-${name.split(" ")[0]}` }),
      });
      assert.equal(r.status, 200);
      const j = await r.json() as any;
      if (j.status === "pending") approveIntakeItem(db, j.intake_id, "curator");
      assert.equal(counters(), c0, `${name}: counters`);
      assert.equal(contributorClock(db, name), k0, `${name}: change versions`);
      const text = streamText(db).split("\n").filter((l) => !l.startsWith("contributors|")).join("\n");
      assert.ok(!text.includes(name) && !text.includes(`b-${name.split(" ")[0]}`), `${name} leaked`);
    }
    const sentinel = db.prepare("SELECT contributions, approved_count FROM contributors WHERE id = 'contributor:anonymous'").get() as any;
    assert.deepEqual({ ...sentinel }, { contributions: 2, approved_count: 2 });
  } finally {
    server.close();
  }
});

it("legacy anonymous graph attribution keeps sync closed; the migration reports it and does not pretend to fix it", async () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  insertNode(db, "practitioner:p", "practitioner", "P");
  // as the code before labelled anonymous writes: an anonymous signal, its
  // edge named after the author, superseded by a later edge
  db.prepare("INSERT INTO signals (id, title, content, submitted_by, consent_attribution) VALUES ('s-anon', 't', 'c', 'Hidden Name', 'anonymous')").run();
  const old = "artwork:w--CREATED_BY--practitioner:p--api-Hidden Name";
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, created_by) VALUES (?, 'artwork:w', 'practitioner:p', 'CREATED_BY', 's-anon', 'api-Hidden Name')").run(old);
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, created_by, invalidated_by) VALUES ('later', 'artwork:w', 'practitioner:p', 'CREATED_BY', NULL, 'x', ?)").run(old);
  const r = migratePrivacy(db);
  assert.equal(r.anonymous.signals, 1, "the signal itself is moved");
  assert.deepEqual(r.anonymous_graph.sort(), [`edges:${old}`, "edges:later"]);
  assert.equal(privacyBacklog(db).anonymous_graph, 2);
  resetSyncGuards();
  const { server, base } = await serve(syncRoutes);
  try {
    for (const path of ["/api/sync/info", "/api/sync/changes?since=0"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as any).error, "anonymous_graph_attribution");
    }
  } finally {
    server.close();
  }
  // new anonymous writes never trip it
  const db2 = freshDb();
  insertNode(db2, "artwork:w", "artwork", "W");
  insertNode(db2, "practitioner:p", "practitioner", "P");
  db2.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES ('c', 'Shy', 'auto')").run();
  const who = { id: "c", name: "Shy", trust_tier: "auto", scope: "write" } as AuthedContributor;
  const s = insertSignal(db2, { contributor: who, title: "t", content: "c", consent_attribution: "anonymous" });
  materialiseEdge(db2, { source_id: "artwork:w", target_id: "practitioner:p", edge_type: "CREATED_BY" }, { signalId: s, createdBy: "api-Shy" });
  assert.deepEqual(anonymousGraphAttribution(db2), []);
});

it("anonymous edges: one row per attesting signal, idempotent, naming no one", () => {
  const db = freshDb();
  insertNode(db, "artwork:w", "artwork", "W");
  insertNode(db, "practitioner:p", "practitioner", "P");
  db.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES ('c1', 'One', 'auto'), ('c2', 'Two', 'auto')").run();
  const ids: string[] = [];
  for (const [id, name] of [["c1", "One"], ["c2", "Two"]]) {
    const s = insertSignal(db, { contributor: { id, name, trust_tier: "auto", scope: "write" } as any, title: "t", content: "c", consent_attribution: "anonymous" });
    const e = { source_id: "artwork:w", target_id: "practitioner:p", edge_type: "CREATED_BY" };
    ids.push(materialiseEdge(db, e, { signalId: s, createdBy: `api-${name}` }).edge_id);
    assert.equal(materialiseEdge(db, e, { signalId: s, createdBy: `api-${name}` }).edge_id, ids[ids.length - 1], "idempotent per signal");
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM edges").get() as any).n, 2);
  assert.ok(ids.every((id) => !id.includes("One") && !id.includes("Two") && id.includes("--anonymous--signal-")));
});

it("retiring a batch with an anonymous contribution never republishes its handle; legacy records are migrated", () => {
  const db = freshDb();
  insertNode(db, "artwork:w", "artwork", "W");
  db.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES ('c', 'Shy', 'auto')").run();
  const who = { id: "c", name: "Shy", trust_tier: "auto", scope: "write" } as AuthedContributor;
  insertSignal(db, { contributor: who, title: "t", content: "c", consent_attribution: "anonymous", batch_id: "SECRET-BATCH-h1" });
  const r = retireBatch(db, "SECRET-BATCH-h1", { reason: "bad", by: "op" });
  assert.ok(!streamText(db).includes("SECRET-BATCH-h1"), "batch handle in the stream");
  const pub = db.prepare("SELECT title, content FROM signals WHERE id = ?").get(r.admin_signal_id!) as any;
  assert.match(pub.title, /^Retire batch: correction-[0-9a-f]+$/);
  assert.equal(JSON.parse(pub.content).batch_id, undefined);
  assert.equal(JSON.parse(fullSignal(db, r.admin_signal_id!).content).batch_id, "SECRET-BATCH-h1", "the operator keeps it");
  assert.equal(fullSignal(db, r.admin_signal_id!).title, "Retire batch: SECRET-BATCH-h1");

  // a retirement record written before this change
  const legacy = freshDb();
  legacy.prepare("INSERT INTO signals (id, title, content, submitted_by, consent_attribution, batch_id) VALUES ('s-a', 't', 'c', 'Shy', 'anonymous', 'SECRET-BATCH-h2')").run();
  legacy.prepare("INSERT INTO signals (id, title, content, source_type, submitted_by) VALUES ('s-r', 'Retire batch: SECRET-BATCH-h2', ?, 'api_admin', 'op')")
    .run(JSON.stringify({ action: "retire_batch", batch_id: "SECRET-BATCH-h2", reason: "x", patches_to_review: [{ op: "patch_node", node_id: "n", before: { k: "OLD-h3" } }] }));
  assert.equal(privacyBacklog(legacy).private_batches, 1);
  const m = migratePrivacy(legacy);
  assert.deepEqual(m.private_batches.ids, ["s-r"]);
  const text = streamText(legacy);
  assert.ok(!text.includes("SECRET-BATCH-h2") && !text.includes("OLD-h3"));
  const full = JSON.parse(fullSignal(legacy, "s-r").content);
  assert.equal(full.batch_id, "SECRET-BATCH-h2");
  assert.deepEqual(full.patches_to_review[0].before, { k: "OLD-h3" });
  assert.equal(backlogTotal(privacyBacklog(legacy)), 0);
  assert.equal(migratePrivacy(legacy).private_batches.signals, 0, "idempotent");
});

it("GET /api/edge/attribution serialises nothing derived from a withheld source URL", async () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  insertNode(db, "practitioner:p", "practitioner", "P");
  db.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES ('c', 'Wanda', 'auto')").run();
  const who = { id: "c", name: "Wanda", trust_tier: "auto", scope: "write" } as AuthedContributor;
  for (const [scope, url] of [["structural_only", "https://withheld-host.example/page"], ["full_commons", "https://open-host.example/p"]] as const) {
    const s = insertSignal(db, { contributor: who, title: "evidence", content: "c", source_url: url, consent_scope: scope });
    materialiseEdge(db, { source_id: "artwork:w", target_id: "practitioner:p", edge_type: "CREATED_BY" }, { signalId: s, createdBy: `api-Wanda-${scope}` });
  }
  const { server, base } = await serve(api);
  try {
    const body = await (await fetch(`${base}/api/edge/attribution?source=artwork:w&target=practitioner:p&type=CREATED_BY`)).text();
    assert.ok(!body.includes("withheld-host"), body);
    const j = JSON.parse(body);
    assert.equal(j.sources.length, 2, "still counted as its own source");
    assert.deepEqual(j.sources.map((s: any) => s.label).sort(), ["open-host.example", "withheld source"]);
    assert.ok(j.sources.every((s: any) => /^source-\d+$/.test(s.id) && !("key" in s)));
  } finally {
    server.close();
  }
});

it("pages keep a byte budget (an oversized cell gets a page of its own) and the cursor stays exact", () => {
  const src = freshDb();
  for (let i = 0; i < 30; i++) insertNode(src, `artwork:a${i}`, "artwork", `A${i}`, { d: "x".repeat(200) });
  insertNode(src, "artwork:big", "artwork", "Big", { d: "y".repeat(20_000) });
  src.exec("BEGIN");
  for (let i = 0; i < 20; i++) insertNode(src, `concept:c${i}`, "concept", `C${i}`, { d: "z".repeat(300) });
  src.exec("COMMIT");
  const fork = freshDb();
  let cur = "0";
  let pages = 0;
  let oversized = 0;
  for (;;) {
    const page = readChanges(src, parseCursor(cur)!, 10_000, 4_000);
    const bytes = page.changes.reduce((n, c) => n + JSON.stringify(c).length + 1, 0);
    if (bytes > 4_000) { assert.equal(page.count, 1, "only a single cell may exceed the budget"); oversized++; }
    assert.ok(page.count >= 1 || !page.more);
    applyChanges(fork, page.changes, null);
    cur = page.next;
    pages++;
    if (!page.more) break;
  }
  assert.equal(oversized, 1);
  assert.ok(pages > 10);
  const dump = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT * FROM nodes ORDER BY id").all());
  assert.equal(dump(fork), dump(src));
});

it("clientIp: Fly-Client-IP, else the last X-Forwarded-For hop — never the client's own first value", () => {
  const req = (h: Record<string, string>) => ({ header: (k: string) => h[k.toLowerCase()], socket: { remoteAddress: "10.0.0.1" } }) as unknown as Request;
  assert.equal(clientIp(req({ "fly-client-ip": "1.2.3.4", "x-forwarded-for": "6.6.6.6, 1.2.3.4" })), "1.2.3.4");
  assert.equal(clientIp(req({ "x-forwarded-for": "6.6.6.6, 5.5.5.5" })), "5.5.5.5");
  assert.equal(clientIp(req({})), "10.0.0.1");
});

it("the migration aborts on a conflict instead of choosing: a kept original that differs from the CRR value", () => {
  const db = freshDb();
  db.prepare("INSERT INTO signals (id, title, content, consent_scope) VALUES ('s', 'T', 'CRR-WORDS', 'structural_only')").run();
  db.prepare("INSERT INTO signal_private (signal_id, reasons, content) VALUES ('s', 'structural_only', 'OTHER-WORDS')").run();
  assert.throws(() => migratePrivacy(db), PrivacyConflictError);
  assert.equal((db.prepare("SELECT content FROM signals WHERE id = 's'").get() as any).content, "CRR-WORDS", "nothing blanked");
  assert.throws(() => withholdSignal(db, "s", "structural_only"), /conflict/);
  // before-images likewise
  db.prepare("DELETE FROM signal_private").run();
  db.prepare("UPDATE signals SET consent_scope = 'full_commons' WHERE id = 's'").run();
  db.prepare("UPDATE signals SET processing_trace = ? WHERE id = 's'").run(JSON.stringify({ prior: [{ op: "patch_node", node_id: "n", at: "t", updated_by: "u", before: { k: "A" } }] }));
  db.prepare("INSERT INTO signal_priors (signal_id, idx, op, node_id, at, updated_by, before) VALUES ('s', 0, 'patch_node', 'n', 't', 'u', '{\"k\":\"B\"}')").run();
  assert.throws(() => migratePrivacy(db), /signal_priors conflict/);
  assert.match((db.prepare("SELECT processing_trace FROM signals WHERE id = 's'").get() as any).processing_trace, /"before"/, "nothing stripped");
});

it("POST /api/contribute in review: no contributor row and no name in the CRR until a curator approves; never when rejected", async () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  const { server, base } = await serve(api);
  const post = (name: string) => fetch(`${base}/api/contribute`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ target_node: "artwork:w", title: `about W by ${name}`, content: "some words", contributor_name: name }),
  });
  try {
    assert.equal((await post("Typed Name One")).status, 200);
    assert.equal((await post("Typed Name Two")).status, 200);
    assert.ok(!streamText(db).includes("Typed Name"), "a typed name in the CRR while in review");
    assert.equal(db.prepare("SELECT 1 FROM contributors WHERE name LIKE 'Typed Name%'").get(), undefined);
    const q = (name: string) => (db.prepare("SELECT id, signal_id FROM intake_queue WHERE submitted_by = ?").get(name) as any);
    assert.equal(fullSignal(db, q("Typed Name One").signal_id).submitted_by, "Typed Name One", "the curator sees it");
    approveIntakeItem(db, q("Typed Name One").id, "curator");
    rejectIntakeItem(db, q("Typed Name Two").id, "spam");
    const one = db.prepare("SELECT trust_tier, contributions, approved_count FROM contributors WHERE name = 'Typed Name One'").get() as any;
    assert.deepEqual({ ...one }, { trust_tier: "probationary", contributions: 1, approved_count: 1 });
    assert.equal((db.prepare("SELECT submitted_by FROM signals WHERE id = ?").get(q("Typed Name One").signal_id) as any).submitted_by, "Typed Name One");
    const text = streamText(db);
    assert.ok(text.includes("Typed Name One") && !text.includes("Typed Name Two"));
    assert.equal(backlogTotal(privacyBacklog(db)), 0);
  } finally {
    server.close();
  }
});
