// A node's history (src/utils/history.ts) through the real write path:
// create → patch → patch → edge → superseding edge → retire, then read back
// /:type/:slug/history.json and the HTML page. Plus the consent rules: an
// anonymous signal hides who, a structural_only one hides what it said.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import contributorApi from "../src/routes/contributor-api.js";
import pages from "../src/routes/pages.js";
import { mintToken } from "../src/utils/token-mint.js";
import { insertSignal, insertIntake, materialisePatchNode, materialiseEdge } from "../src/utils/contribution.js";
import { nodeHistory } from "../src/utils/history.js";

it("history: edits chain before → after, relations show added and ended, retire is the last word", async () => {
  const db = initDb(":memory:");
  const tok = mintToken(db, { contributorName: "Curator", createIfMissing: true, tier: "auto", scope: "admin" } as any);
  const app = express();
  app.use(express.json());
  app.use(contributorApi);
  app.use(pages);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok.raw_token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${await r.clone().text()}`);
    return r.json() as Promise<any>;
  };
  try {
    await call("POST", "/api/v1/nodes", { type: "artwork", name: "Process 4", metadata: { year: "1999" } });
    await call("POST", "/api/v1/nodes", { type: "institution", name: "bitforms" });
    await call("POST", "/api/v1/nodes", { type: "institution", name: "Other Gallery" });
    const id = "artwork:process-4";
    await call("PATCH", `/api/v1/nodes/${encodeURIComponent(id)}`, { year: "2001", medium: "software" });
    await call("PATCH", `/api/v1/nodes/${encodeURIComponent(id)}`, { year: "2005" });
    const e1 = await call("POST", "/api/v1/edges", { source_id: id, target_id: "institution:bitforms", edge_type: "EXHIBITED_AT" });
    await call("POST", "/api/v1/edges", { source_id: id, target_id: "institution:other-gallery", edge_type: "EXHIBITED_AT", supersedes_edge_id: e1.edge_id });
    await call("POST", `/api/v1/nodes/${encodeURIComponent(id)}/retire`, { reason: "duplicate" });

    const h = await (await fetch(`${base}/artwork/process-4/history.json`)).json() as any;
    assert.equal(h.node.id, id);
    const edits = h.events.filter((e: any) => e.kind === "metadata");
    // newest first: retire, then the two patches
    assert.deepEqual(edits.map((e: any) => e.op), ["retire_node", "patch_node", "patch_node"]);
    const [, second, first] = edits;
    assert.deepEqual(first.changes, [
      { key: "year", before: "1999", after: "2001" },
      { key: "medium", before: null, after: "software" },
    ]);
    assert.deepEqual(second.changes, [{ key: "year", before: "2001", after: "2005" }]);
    assert.equal(first.by, "Curator");
    assert.ok(first.source.signal_id);
    assert.equal(edits[0].changes.find((c: any) => c.key === "retired_reason").after, "duplicate");

    const rel = h.events.filter((e: any) => e.kind === "relation").map((e: any) => [e.change, e.other.id]);
    // retire ends the live edge; the superseded one ended when replaced
    assert.equal(rel.filter(([c]: any) => c === "added").length, 2);
    assert.deepEqual(rel.filter(([c]: any) => c === "ended").map(([, o]: any) => o).sort(), ["institution:bitforms", "institution:other-gallery"]);
    assert.ok(h.events.every((e: any, i: number) => i === 0 || String(h.events[i - 1].at) >= String(e.at)), "newest first");

    const html = await (await fetch(`${base}/artwork/process-4/history`)).text();
    assert.match(html, /History: <a href='\/artwork\/process-4'>Process 4<\/a>/);
    assert.match(html, /year: <code>1999<\/code> → <code>2001<\/code>/);
    assert.match(html, /relation ended/);
    assert.match(html, /retired/);
    const profile = await (await fetch(`${base}/artwork/process-4`)).text();
    assert.match(profile, /href="\/artwork\/process-4\/history"/);
    assert.match(profile, /retired/);
    const record = await (await fetch(`${base}/record/artwork/process-4`)).text();
    assert.match(record, /href='\/artwork\/process-4\/history'/);

    assert.equal((await fetch(`${base}/artwork/nope/history.json`)).status, 404);
    assert.equal((await fetch(`${base}/artwork/nope/history`)).status, 404);
  } finally {
    server.close();
  }
});

it("history: anonymous hides who; structural_only hides title and source but keeps the change", () => {
  const db = initDb(":memory:");
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES ('artwork:x', 'artwork', 'X', 'x', '{\"year\":\"1\"}', 'seed')").run();
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES ('practitioner:p', 'practitioner', 'P', 'p', '{}', 'seed')").run();
  const who = { id: "c", name: "Someone", trust_tier: "auto", token_label: null, token_prefix: "t", scope: "write" } as any;
  const anonSig = insertSignal(db, { contributor: who, title: "secret title", content: "{}", source_url: "https://example.org/p", consent_attribution: "anonymous" });
  const op = { op: "patch_node" as const, node_id: "artwork:x", metadata: { year: "2" } };
  materialisePatchNode(db, op, { createdBy: "api-Someone", signalId: anonSig });
  insertIntake(db, { contributor: who, signal_id: anonSig, target_node: "artwork:x", proposed_nodes: [op] });
  // A structural_only contribution gives relations, never node metadata
  // (it would put its words in a CRR): the write is refused.
  const structSig = insertSignal(db, { contributor: who, title: "secret title", content: "{}", source_url: "https://example.org/p", consent_scope: "structural_only" });
  assert.throws(() => materialisePatchNode(db, { op: "patch_node", node_id: "artwork:x", metadata: { year: "3" } }, { createdBy: "api-Someone", signalId: structSig }), /structural_only/);
  materialiseEdge(db, { source_id: "artwork:x", target_id: "practitioner:p", edge_type: "CREATED_BY" }, { signalId: structSig, createdBy: "api-Someone" });
  const events = nodeHistory(db, "artwork:x")!.events as any[];
  const anon = events.find((e) => e.kind === "metadata");
  const structural = events.find((e) => e.kind === "relation");
  assert.equal(anon.by, null);
  assert.equal(anon.source.title, "secret title");
  assert.deepEqual(anon.changes, [{ key: "year", before: "1", after: "2" }]);
  assert.equal(structural.by, "Someone");
  assert.equal(structural.source.title, null);
  assert.equal(structural.source.source_url, null);
  assert.equal(events.length, 2);
});
