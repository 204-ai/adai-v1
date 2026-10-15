// The entity view's sections come from the graph (issue #57): relations
// grouped by type and direction, two hops through works and shows, only
// non-empty groups, an edge type nobody templated still shows.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import pages from "../src/routes/pages.js";

it("entity relations: in collections via works, shows via participation, new types, nothing empty", async () => {
  const db = initDb(":memory:");
  const node = db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, '{}', 't')");
  const edge = db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES (?, ?, ?, ?, 't', '2026-01-01T00:00:00Z')");
  node.run("practitioner:ben-laposky", "practitioner", "Ben Laposky", "ben-laposky");
  node.run("artwork:oscillon-40", "artwork", "Oscillon 40", "oscillon-40");
  node.run("artwork:oscillon-520", "artwork", "Oscillon 520", "oscillon-520");
  node.run("institution:outlier", "institution", "The Outlier Collection", "outlier");
  node.run("project:electronic-abstractions", "project", "Electronic Abstractions", "electronic-abstractions");
  node.run("institution:sanford", "institution", "Sanford Museum", "sanford");
  node.run("institution:foundation", "institution", "A Foundation", "foundation");
  edge.run("c1", "artwork:oscillon-40", "practitioner:ben-laposky", "CREATED_BY");
  edge.run("c2", "artwork:oscillon-520", "practitioner:ben-laposky", "CREATED_BY");
  edge.run("h1", "artwork:oscillon-40", "institution:outlier", "HELD_BY");
  edge.run("h2", "artwork:oscillon-520", "institution:outlier", "HELD_BY");
  edge.run("p1", "practitioner:ben-laposky", "project:electronic-abstractions", "PARTICIPATED_IN");
  edge.run("p2", "project:electronic-abstractions", "institution:sanford", "PRESENTED_BY");
  edge.run("f1", "practitioner:ben-laposky", "institution:foundation", "FUNDED_BY");
  const app = express();
  app.use(pages);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const html = await (await fetch(`${base}/practitioner/ben-laposky`)).text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.match(text, /\/\/ in collections \/01 ·········· \[institution\] The Outlier Collection 2 works/);
    assert.match(text, /\/\/ shows \/01 ·········· \[project\] Electronic Abstractions/);
    assert.match(text, /\/\/ shows presented by \/01 ·········· \[institution\] Sanford Museum 1 show/);
    assert.match(text, /\/\/ funded by \/01 ·········· \[institution\] A Foundation/);
    assert.match(text, /\/\/ works \/02/);
    assert.doesNotMatch(text, /\/00|awards|exhibitions\.selected|no .* yet|awaiting/);
    assert.equal((html.match(/ev-contrib-link/g) ?? []).length, 1, "one invitation, at the bottom");
    assert.ok(text.indexOf("in collections") < text.indexOf("funded by"));
  } finally {
    server.close();
  }
});
