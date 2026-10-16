// A token linked to the node it stands for (#70): the Outlier Collection
// posts its works through a token; "contributed by" links to its institution
// page, which says it contributes and lists what.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import contributorApi from "../src/routes/contributor-api.js";
import pages from "../src/routes/pages.js";
import { mintToken } from "../src/utils/token-mint.js";
import { contributorNode } from "../src/utils/contributor-node.js";

it("tokens: a node at mint or by PATCH; bylines link to it; its page says it contributes", async () => {
  const db = initDb(":memory:");
  const admin = mintToken(db, { contributorName: "Op", createIfMissing: true, tier: "auto", scope: "admin" });
  const outlier = mintToken(db, { contributorName: "Outlier Collection", createIfMissing: true, tier: "auto" });
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES ('institution:the-outlier-collection', 'institution', 'The Outlier Collection', 'the-outlier-collection', '{}', 'test')").run();
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES ('institution:gone', 'institution', 'Gone', 'gone', '{\"retired\":true}', 'test')").run();
  const app = express();
  app.use(express.json());
  app.use(contributorApi);
  app.use(pages);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  const html = async (path: string) => (await fetch(base + path)).text();
  try {
    const made = await call("POST", "/api/v1/nodes", outlier.raw_token, { type: "artwork", name: "Oscillon 1184" });
    assert.equal(made.status, 200);
    const held = await call("POST", "/api/v1/edges", outlier.raw_token, { source_id: made.json.node_id, target_id: "institution:the-outlier-collection", edge_type: "HELD_BY" });
    assert.equal(held.status, 200);
    // before the link: plain text, no line on the institution page
    assert.doesNotMatch(await html("/artwork/oscillon-1184"), /contributed by/);
    assert.match(await html("/record/artwork/oscillon-1184"), /contributed by Outlier Collection/);

    assert.equal((await call("PATCH", `/api/v1/tokens/${outlier.token_prefix}`, outlier.raw_token, { node: "institution:the-outlier-collection" })).status, 403, "admin only");
    assert.equal((await call("PATCH", `/api/v1/tokens/${outlier.token_prefix}`, admin.raw_token, { node: "institution:nope" })).json.error, "no_such_node");
    assert.equal((await call("PATCH", `/api/v1/tokens/${outlier.token_prefix}`, admin.raw_token, { node: "institution:gone" })).json.error, "node_retired");
    assert.equal((await call("PATCH", `/api/v1/tokens/${outlier.token_prefix}`, admin.raw_token, {})).status, 400);
    const set = await call("PATCH", `/api/v1/tokens/${outlier.token_prefix}`, admin.raw_token, { node: "institution:the-outlier-collection" });
    assert.equal(set.status, 200);
    assert.equal(set.json.node_id, "institution:the-outlier-collection");
    assert.equal(set.json.previous, null);
    const listed = await call("GET", "/api/v1/tokens?contributor=Outlier%20Collection", admin.raw_token);
    assert.equal(listed.json.tokens[0].node_id, "institution:the-outlier-collection");

    // the work's page, its record and its history link to the institution
    const link = /contributed by <a class="ev-prov-link" href="\/institution\/the-outlier-collection">The Outlier Collection<\/a>/;
    assert.match(await html("/artwork/oscillon-1184"), link);
    assert.match(await html("/record/artwork/oscillon-1184"), /contributed by <a href='\/institution\/the-outlier-collection'>Outlier Collection<\/a>/);
    assert.match(await html("/artwork/oscillon-1184/history"), /by <a href='\/institution\/the-outlier-collection'>Outlier Collection<\/a>/);
    // the institution says it contributes, and lists it
    const inst = await html("/institution/the-outlier-collection");
    assert.match(inst, /href="\/institution\/the-outlier-collection\/contributions">contributes to the commons as Outlier Collection · 2 contributions<\/a>/);
    assert.doesNotMatch(inst, /contributed by <a/, "not on its own page");
    const list = await html("/institution/the-outlier-collection/contributions");
    assert.match(list, /Oscillon 1184/);
    assert.match(list, /contributes to the commons as Outlier Collection/);
    // a token minted later naming the node keeps the link; clearing the one token unlinks
    assert.equal(contributorNode(db, "Outlier Collection")?.id, "institution:the-outlier-collection");
    assert.equal((await call("PATCH", `/api/v1/tokens/${outlier.token_prefix}`, admin.raw_token, { node: null })).json.node_id, null);
    assert.equal(contributorNode(db, "Outlier Collection"), null);
    assert.doesNotMatch(await html("/artwork/oscillon-1184"), /contributed by/);
    assert.match(await html("/institution/the-outlier-collection/contributions"), /has not contributed/);
    // at mint
    const m = await call("POST", "/api/v1/tokens", admin.raw_token, { contributor_name: "Outlier Collection", label: "second", node: "institution:the-outlier-collection" });
    assert.equal(m.json.node, "institution:the-outlier-collection");
    assert.equal(contributorNode(db, "Outlier Collection")?.id, "institution:the-outlier-collection");
  } finally {
    server.close();
  }
});
