// Organisation kinds through the contributor API (fixed list, several
// allowed, normalised) and the institution page: kinds as labels, and the
// artists read off the graph before the raw connections.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import contributorApi from "../src/routes/contributor-api.js";
import pages from "../src/routes/pages.js";
import api from "../src/routes/api.js";
import { mintToken } from "../src/utils/token-mint.js";

it("kind: validated on create and patch; the page shows kinds and leads with artists", async () => {
  const db = initDb(":memory:");
  const tok = mintToken(db, { contributorName: "Curator", createIfMissing: true, tier: "auto" } as any);
  const app = express();
  app.use(express.json());
  app.use(contributorApi);
  app.use(pages);
  app.use(api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { authorization: `Bearer ${tok.raw_token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    let r = await call("POST", "/api/v1/nodes", { type: "institution", name: "Interface Gallery", metadata: { kind: ["gallery", "shop"] } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /shop not in the list/);

    r = await call("POST", "/api/v1/nodes", { type: "institution", name: "Interface Gallery", metadata: { kind: ["Gallery", "art dealership", "advisory"], kind_source: { page_url: "https://www.interfacegallery.io/about", quote: "a project-based gallery, private art dealership and advisory" } } });
    assert.ok(r.status < 300, `create: ${r.status}`);
    const row = db.prepare("SELECT id, metadata FROM nodes WHERE type = 'institution'").get() as any;
    assert.deepEqual(JSON.parse(row.metadata).kind, ["gallery", "dealership", "advisory"]);

    r = await call("PATCH", `/api/v1/nodes/${encodeURIComponent(row.id)}`, { kind: "national museum of art and design" });
    assert.equal(r.status, 400);
    r = await call("PATCH", `/api/v1/nodes/${encodeURIComponent(row.id)}`, { kind: ["gallery", "fair"] });
    assert.ok(r.status < 300, `patch: ${r.status}`);

    db.prepare("INSERT INTO nodes (id, type, name, slug, updated_by) VALUES ('practitioner:vera-molnar', 'practitioner', 'Vera Molnár', 'vera-molnar', 't')").run();
    db.prepare("INSERT INTO nodes (id, type, name, slug, updated_by) VALUES ('artwork:untitled', 'artwork', 'Untitled', 'untitled', 't')").run();
    db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES ('e1', 'artwork:untitled', ?, 'EXHIBITED_AT', 't', '2026-01-01T00:00:00Z')").run(row.id);
    db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES ('e2', 'artwork:untitled', 'practitioner:vera-molnar', 'CREATED_BY', 't', '2026-01-01T00:00:00Z')").run();

    // the entity view: kinds in its metadata, artists from its works
    const view = await (await fetch(`${base}/institution/${row.id.split(":")[1]}`)).text();
    assert.match(view, /kind<\/dt><dd class="ev-meta-v">:gallery · fair/);
    assert.match(view, /\/\/ artists[\s\S]*Vera Molnár[\s\S]*1 work/);
    // the record view
    const html = await (await fetch(`${base}/record/institution/${row.id.split(":")[1]}`)).text();
    assert.match(html, /<span class='tag'>gallery<\/span> <span class='tag'>fair<\/span>/);
    assert.match(html, /a project-based gallery, private art dealership and advisory/);
    assert.match(html, /artists \(1\)[\s\S]*Vera Molnár[\s\S]*1 work/);
    assert.ok(html.indexOf("artists (1)") < html.indexOf("connections ("), "artists lead");

    // the same roster for /field and the JSON export
    const slug = row.id.split(":")[1];
    const ro = await (await fetch(`${base}/api/roster/institution/${slug}`)).json();
    assert.deepEqual(ro.roster.map((a: any) => [a.name, a.works]), [["Vera Molnár", 1]]);
    const data = await (await fetch(`${base}/institution/${slug}/data`)).json();
    assert.equal(data.roster.length, 1);
    const none = await (await fetch(`${base}/api/roster/practitioner/vera-molnar`)).json();
    assert.deepEqual(none.roster, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    db.close();
  }
});
