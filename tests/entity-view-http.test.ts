// The clean address of a node is its entity view (issue #64): server-rendered,
// with meta tags for sharing; the same article feeds the /field overlay via
// /api/entity; the back-office page moved to /record/<type>/<slug>.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import pages from "../src/routes/pages.js";

it("entity view: page, overlay JSON, record, wrong-type redirect", async () => {
  const db = initDb(":memory:");
  const ins = db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, 't')");
  ins.run("practitioner:ben laposky", "practitioner", "Ben Laposky", "ben-laposky", JSON.stringify({ summary: "Oscilloscope pioneer." }));
  ins.run("artwork:oscillon-1184", "artwork", "Oscillon 1184", "oscillon-1184", JSON.stringify({ cdn_image_url: "https://cdn.test/o.jpg", year: "1952" }));
  ins.run("concept:ben-laposky", "concept", "Same slug, other type", "ben-laposky", null);
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES ('e1', 'artwork:oscillon-1184', 'practitioner:ben laposky', 'CREATED_BY', 't', '2026-01-01T00:00:00Z')").run();
  const app = express();
  app.use(pages);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const page = await (await fetch(`${base}/practitioner/ben-laposky`)).text();
    assert.match(page, /<h1 class="ev-title">Ben Laposky/);
    assert.match(page, /<meta name="description" content="Oscilloscope pioneer\.">/);
    assert.match(page, /<meta property="og:image" content="https:\/\/cdn\.test\/o\.jpg">/); // hero = a work, never a portrait
    assert.match(page, /href="\/artwork\/oscillon-1184" data-node-id="artwork:oscillon-1184"/);
    assert.match(page, /href="\/field\?node=practitioner%3Aben%20laposky"/);
    assert.doesNotMatch(page, /href="\/record\//, "the record link is for curators");

    // (type, slug) wins over slug alone
    assert.match(await (await fetch(`${base}/concept/ben-laposky`)).text(), /Same slug, other type/);
    const wrong = await fetch(`${base}/project/oscillon-1184`, { redirect: "manual" });
    assert.equal(wrong.status, 301);
    assert.equal(wrong.headers.get("location"), "/artwork/oscillon-1184");

    const j = await (await fetch(`${base}/api/entity?id=${encodeURIComponent("practitioner:ben laposky")}`)).json() as any;
    assert.equal(j.slug, "ben-laposky");
    assert.match(j.html, /^\s*<article class="ev-article" data-node-id="practitioner:ben laposky"/);
    assert.equal((await fetch(`${base}/api/entity?id=nope`)).status, 404);

    const record = await (await fetch(`${base}/record/practitioner/ben-laposky`)).text();
    assert.match(record, /<h2>Ben Laposky<\/h2>/);
    assert.match(record, /href='\/record\/artwork\/oscillon-1184'/);

    // the way back into the field (issue #63): beside the title, and the nav carries the node
    assert.match(page, /<p class="ev-mono-dim ev-claim" id="ev-claim">.*class="ev-field-link" href="\/field\?node=practitioner%3Aben%20laposky">view in field →/);
    assert.match(await (await fetch(`${base}/concept/ben-laposky`)).text(), /class="ev-field-link" href="\/field\?node=concept%3Aben-laposky"/);
    assert.match(record, /<nav><a href='\/field\?node=practitioner%3Aben%20laposky'>Field<\/a>/);
    assert.match(record, /<a href='\/field\?node=practitioner%3Aben%20laposky'>view in field →<\/a>/);
    const hist = await (await fetch(`${base}/practitioner/ben-laposky/history`)).text();
    assert.match(hist, /<nav><a href='\/field\?node=practitioner%3Aben%20laposky'>Field<\/a>/);
  } finally {
    server.close();
  }
});
