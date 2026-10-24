// POST /api/contribute is anonymous by identity: a typed name never borrows a
// trust tier and never counts on an existing contributor row.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { initDb } from "../src/db.js";
import { insertNode } from "./helpers.js";
import api from "../src/routes/api.js";
import { mintToken } from "../src/utils/token-mint.js";
import { approveIntakeItem } from "../src/utils/review.js";

function contributorClock(db: DatabaseSync, id: string): string {
  const rows = (db.prepare(`SELECT pk, cid, col_version, db_version FROM crsql_changes WHERE "table" = 'contributors'`).all() as any[])
    .filter((r) => Buffer.from(r.pk).includes(Buffer.from(id)))
    .map((r) => [r.cid, r.col_version, r.db_version])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.ok(rows.length, `no change rows for ${id}`);
  return JSON.stringify(rows);
}

it("typing an auto contributor's name: pending in /review, not materialised; approval leaves their row untouched and writes a separate form row", async () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  const tok = mintToken(db, { contributorName: "Trusted Person", createIfMissing: true, tier: "auto" } as any);
  const real = db.prepare("SELECT id, trust_tier, contributions, approved_count FROM contributors WHERE name = 'Trusted Person'").get() as any;
  assert.equal(real.trust_tier, "auto");
  const before = { counters: JSON.stringify(real), clock: contributorClock(db, real.id) };

  const app = express();
  app.use(express.json());
  app.use(api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const res = await fetch(`${base}/api/contribute`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_node: "artwork:w", title: "IMPERSONATED-TITLE", content: "IMPERSONATED-WORDS", contributor_name: "Trusted Person" }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /queued for review/);
    const q = db.prepare("SELECT id, signal_id, status, trust_tier FROM intake_queue WHERE submitted_by = 'Trusted Person'").get() as any;
    assert.deepEqual([q.status, q.trust_tier], ["pending", "probationary"], "in /review, whatever name was typed");
    const sig = db.prepare("SELECT title, content, submitted_by, confidence FROM signals WHERE id = ?").get(q.signal_id) as any;
    assert.deepEqual({ ...sig }, { title: null, content: null, submitted_by: null, confidence: "probationary" }, "not published");
    const stream = (db.prepare(`SELECT group_concat(CAST(val AS TEXT), '|') AS v FROM crsql_changes WHERE "table" = 'signals'`).get() as any).v ?? "";
    assert.ok(!stream.includes("IMPERSONATED"));
    assert.deepEqual({ counters: JSON.stringify(db.prepare("SELECT id, trust_tier, contributions, approved_count FROM contributors WHERE id = ?").get(real.id)), clock: contributorClock(db, real.id) }, before);

    approveIntakeItem(db, q.id, "curator");
    assert.deepEqual({ counters: JSON.stringify(db.prepare("SELECT id, trust_tier, contributions, approved_count FROM contributors WHERE id = ?").get(real.id)), clock: contributorClock(db, real.id) }, before,
      "the real contributor's counters and change versions are untouched");
    const rows = db.prepare("SELECT id, type, trust_tier, contributions, approved_count FROM contributors WHERE name = 'Trusted Person' ORDER BY type").all() as any[];
    assert.equal(rows.length, 2, "a separate row");
    const form = rows.find((r) => r.id !== real.id);
    assert.match(form.id, /^contributor:form-[0-9a-f]{16}$/);
    assert.deepEqual([form.type, form.trust_tier, form.contributions, form.approved_count], ["form", "probationary", 1, 1]);
    assert.equal(db.prepare("SELECT 1 FROM contributor_tokens WHERE contributor_id = ?").get(form.id), undefined, "attached to no identity");
    assert.equal((db.prepare("SELECT content FROM signals WHERE id = ?").get(q.signal_id) as any).content, "IMPERSONATED-WORDS", "published on approval");

    // a second submission under the same typed name is another row again
    await fetch(`${base}/api/contribute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target_node: "artwork:w", title: "t2", content: "c2", contributor_name: "Trusted Person" }) });
    approveIntakeItem(db, (db.prepare("SELECT id FROM intake_queue WHERE status = 'pending'").get() as any).id, "curator");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM contributors WHERE name = 'Trusted Person' AND type = 'form'").get() as any).n, 2);
    void tok;
  } finally {
    server.close();
  }
});

it("an authenticated contribution's approval counts on its author by id, never on a namesake form row", () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  db.prepare("INSERT INTO contributors (id, name, type, trust_tier, contributions, approved_count) VALUES ('c-real', 'Same Name', 'contributor', 'probationary', 1, 0), ('contributor:form-x', 'Same Name', 'form', 'probationary', 1, 1)").run();
  db.prepare("INSERT INTO signals (id, title, content, source_type, submitted_by) VALUES ('s1', 't', 'c', 'api_node', 'Same Name')").run();
  db.prepare("INSERT INTO signal_authors (signal_id, contributor_id) VALUES ('s1', 'c-real')").run();
  db.prepare("INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status) VALUES ('q1', 's1', 'artwork:w', 'Same Name', 'probationary', 'pending')").run();
  approveIntakeItem(db, "q1", "curator");
  const counts = db.prepare("SELECT id, approved_count FROM contributors ORDER BY id").all() as any[];
  assert.deepEqual(counts.map((r) => [r.id, r.approved_count]), [["c-real", 1], ["contributor:form-x", 1]]);
});

it("a form submission named after a contributor whose token stands for a node: approved, its byline never links to that node", async () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  insertNode(db, "institution:outlier", "institution", "Outlier Collection");
  const tok = mintToken(db, { contributorName: "Outlier Collection", createIfMissing: true, tier: "auto" } as any);
  db.prepare("UPDATE contributor_tokens SET node_id = 'institution:outlier' WHERE token_prefix = ?").run(tok.token_prefix);
  const { default: pages } = await import("../src/routes/pages.js");
  const { default: contributorApi } = await import("../src/routes/contributor-api.js");
  const { nodeHistory } = await import("../src/utils/history.js");
  const app = express();
  app.use(express.json());
  app.use(api);
  app.use(contributorApi);
  app.use(pages);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    // the real one, through its token: links to its node
    const real = await (await fetch(`${base}/api/v1/edges`, {
      method: "POST", headers: { authorization: `Bearer ${tok.raw_token}`, "content-type": "application/json" },
      body: JSON.stringify({ source_id: "artwork:w", target_id: "institution:outlier", edge_type: "HELD_BY" }),
    })).json() as any;
    // the impostor, through the public form, approved by a curator
    await fetch(`${base}/api/contribute`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_node: "artwork:w", title: "Not really them", content: "typed name", contributor_name: "Outlier Collection" }) });
    const q = db.prepare("SELECT id, signal_id FROM intake_queue WHERE status = 'pending'").get() as any;
    approveIntakeItem(db, q.id, "curator");
    // an approved form patch shows up in /history as a metadata event of the impostor's signal
    const { materialisePatchNode } = await import("../src/utils/contribution.js");
    materialisePatchNode(db, { op: "patch_node", node_id: "artwork:w", metadata: { year: "1999" } }, { createdBy: "curator-from-Outlier Collection", signalId: q.signal_id });
    db.prepare("INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status, proposed_nodes) VALUES ('q-p', ?, 'artwork:w', 'Outlier Collection', 'probationary', 'approved', ?)")
      .run(q.signal_id, JSON.stringify([{ op: "patch_node", node_id: "artwork:w", metadata: { year: "1999" } }]));

    const events = nodeHistory(db, "artwork:w")!.events as any[];
    const fake = events.find((e) => e.source?.signal_id === q.signal_id)!;
    const genuine = events.find((e) => e.source?.signal_id === real.signal_id)!;
    assert.equal(fake.source.by, "Outlier Collection", "the typed name is shown…");
    assert.equal(fake.source.by_node, undefined, "…without the namesake's node");
    assert.deepEqual(genuine.source.by_node, { type: "institution", slug: "outlier" });

    const html = await (await fetch(`${base}/artwork/w/history`)).text();
    const links = html.match(/href='\/institution\/outlier'/g) ?? [];
    // one link for the genuine relation's byline (and the relation's other end), none for the form's edit
    const at = html.indexOf("year");
    const editBlock = html.slice(at, html.indexOf("</div>", at));
    assert.match(editBlock, /by Outlier Collection · Not really them/);
    assert.ok(!editBlock.includes("href='/institution/outlier'"), editBlock);
    assert.match(html, /by <a href='\/institution\/outlier'>Outlier Collection<\/a> · Add edge HELD_BY/, "the genuine one still links");
    assert.ok(links.length >= 1);

    // the institution's contributions page lists only what it wrote
    const contrib = await (await fetch(`${base}/institution/outlier/contributions`)).text();
    assert.ok(!contrib.includes("Not really them"), "the impostor is not listed as the institution's");
    // the record view's byline: no link for the form submission
    const record = await (await fetch(`${base}/record/artwork/w`)).text();
    const c0 = record.indexOf("Not really them");
    const card = record.slice(c0, record.indexOf("</div></div>", c0) > 0 ? record.indexOf("</p>", record.indexOf("contributed by", c0)) + 4 : c0 + 400);
    assert.ok(card.includes("contributed by Outlier Collection") && !card.includes("href='/institution/outlier'>Outlier Collection"), card);
  } finally {
    server.close();
  }
});

// ---- ownership is never a typed name (src/utils/authorship.ts) --------------------------------

async function serveAll(db: DatabaseSync) {
  const { default: contributorApi } = await import("../src/routes/contributor-api.js");
  const app = express();
  app.use(express.json());
  app.use(api);
  app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
}

it("GET /api/v1/contributions: a form submission under a token holder's name is neither listed nor counted, pending or approved", async () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  const tok = mintToken(db, { contributorName: "Token Holder", createIfMissing: true, tier: "probationary" } as any);
  const { server, base } = await serveAll(db);
  const mine = async () => (await fetch(`${base}/api/v1/contributions`, { headers: { authorization: `Bearer ${tok.raw_token}` } })).json() as Promise<any>;
  try {
    await fetch(`${base}/api/v1/signals`, { method: "POST", headers: { authorization: `Bearer ${tok.raw_token}`, "content-type": "application/json" },
      body: JSON.stringify({ target_node: "artwork:w", title: "MY-OWN", content: "mine" }) });
    await fetch(`${base}/api/contribute`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_node: "artwork:w", title: "FORM-PRIVATE-TITLE", content: "x", contributor_name: "Token Holder" }) });
    let j = await mine();
    assert.deepEqual(j.items.map((i: any) => i.title), ["MY-OWN"], "pending form not listed");
    assert.deepEqual(j.totals, { pending: 1 }, "nor counted");
    assert.ok(!JSON.stringify(j).includes("FORM-PRIVATE-TITLE"));
    for (const q of db.prepare("SELECT id FROM intake_queue WHERE status = 'pending'").all() as any[]) approveIntakeItem(db, q.id, "curator");
    j = await mine();
    assert.deepEqual(j.items.map((i: any) => i.title), ["MY-OWN"], "approved form still not theirs");
    assert.deepEqual(j.totals, { approved: 1 });
  } finally {
    server.close();
  }
});

it("snapshot export credits each signal to its provable owner: the real contributor gets none of a form submission, each form row only its own", async () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  const tok = mintToken(db, { contributorName: "Real Name", createIfMissing: true, tier: "auto" } as any);
  const { server, base } = await serveAll(db);
  try {
    await fetch(`${base}/api/v1/signals`, { method: "POST", headers: { authorization: `Bearer ${tok.raw_token}`, "content-type": "application/json" },
      body: JSON.stringify({ target_node: "artwork:w", title: "real", content: "real words" }) });
    for (const t of ["form one", "form two"]) {
      await fetch(`${base}/api/contribute`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_node: "artwork:w", title: t, content: t, contributor_name: "Real Name" }) });
    }
    for (const q of db.prepare("SELECT id FROM intake_queue WHERE status = 'pending'").all() as any[]) approveIntakeItem(db, q.id, "curator");
  } finally {
    server.close();
  }
  const { buildSnapshot } = await import("../src/snapshot/build.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync: Plain } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "snap-"));
  try {
    buildSnapshot(db, join(dir, "s.sqlite"));
    const out = new Plain(join(dir, "s.sqlite"), { readOnly: true });
    const rows = out.prepare("SELECT id, name, type, contributions FROM contributors WHERE name = 'Real Name' ORDER BY type, id").all() as any[];
    const real = db.prepare("SELECT id FROM contributors WHERE name = 'Real Name' AND type != 'form'").get() as any;
    assert.deepEqual(rows.find((r) => r.id === real.id)?.contributions, 1, "the real contributor: their own signal only");
    const forms = rows.filter((r) => r.type === "form");
    assert.equal(forms.length, 2);
    assert.ok(forms.every((r) => r.contributions === 1), JSON.stringify(rows));
    out.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("contributor:rename rewrites only what is provably theirs; the shared predicate agrees everywhere", async () => {
  const db = initDb(":memory:");
  insertNode(db, "artwork:w", "artwork", "W");
  db.prepare("INSERT INTO contributors (id, name, type, trust_tier) VALUES ('c-real', 'Old Name', 'contributor', 'auto'), ('contributor:form-1', 'Old Name', 'form', 'probationary')").run();
  db.prepare("INSERT INTO signals (id, title, content, source_type, submitted_by, batch_id) VALUES ('s-auth', 't', 'c', 'contribution', 'Old Name', NULL), ('s-form', 't', 'c', 'contribution', 'Old Name', NULL), ('s-legacy', 't', 'c', 'contribution', 'Old Name', 'b1')").run();
  db.prepare("INSERT INTO signal_authors (signal_id, contributor_id) VALUES ('s-auth', 'c-real')").run();
  db.prepare("INSERT INTO form_signals (signal_id, contributor_id) VALUES ('s-form', 'contributor:form-1')").run();
  const { signalOwner, isFormShaped } = await import("../src/utils/authorship.js");
  const { signalAuthorNode } = await import("../src/utils/contributor-node.js");
  const { isFormSubmission } = await import("../src/utils/signal-private.js");
  assert.deepEqual(signalOwner(db, "s-auth"), { id: "c-real", how: "author" });
  assert.deepEqual(signalOwner(db, "s-form"), { id: "contributor:form-1", how: "form" });
  // a plain contribution WITH a batch id and no recorded author: a legacy /api/v1 write for every caller
  assert.equal(isFormShaped(db, "s-legacy"), false);
  assert.equal(isFormSubmission(db, "s-legacy"), false);
  assert.deepEqual(signalOwner(db, "s-legacy"), { id: "c-real", how: "legacy" });
  assert.equal(signalAuthorNode(db, { id: "s-form" }), null);

  // rename: the real one's signals change, the form submission keeps its typed name
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "rename-"));
  try {
    const path = join(dir, "db.sqlite");
    db.exec(`VACUUM INTO '${path}'`);
    const r = spawnSync("npx", ["tsx", "src/cli/rename-contributor.ts", "--from", "Old Name", "--to", "New Name", "--by", "op"], { env: { ...process.env, DB_PATH: path }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const { DatabaseSync: Plain } = await import("node:sqlite");
    const after = new Plain(path, { readOnly: true });
    const by = Object.fromEntries((after.prepare("SELECT id, submitted_by FROM signals WHERE id LIKE 's-%'").all() as any[]).map((x) => [x.id, x.submitted_by]));
    assert.deepEqual(by, { "s-auth": "New Name", "s-form": "Old Name", "s-legacy": "New Name" });
    assert.equal((after.prepare("SELECT name FROM contributors WHERE id = 'contributor:form-1'").get() as any).name, "Old Name");
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
