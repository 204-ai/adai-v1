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
