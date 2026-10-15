// POST /api/v1/nodes: an explicit slug goes through the slugifier too, and a
// name already slugged under the old rules resolves to that node (#61).

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import contributorApi from "../src/routes/contributor-api.js";
import { mintToken } from "../src/utils/token-mint.js";

it("nodes: explicit slugs are normalised, legacy-slugged names are not duplicated", async () => {
  const db = initDb(":memory:");
  const tok = mintToken(db, { contributorName: "Curator", createIfMissing: true, tier: "auto" } as any);
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES ('artwork:toujours-là', 'artwork', 'Toujours là', 'toujours-là', '{}', 'test')").run();
  const app = express();
  app.use(express.json());
  app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (body: unknown) => {
    const r = await fetch(`${base}/api/v1/nodes`, { method: "POST", headers: { authorization: `Bearer ${tok.raw_token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  try {
    const a = await post({ type: "artwork", name: "Aaron at Tsukuba, #6 22/5/85" });
    assert.equal(a.json.node_id, "artwork:aaron-at-tsukuba-6-22-5-85");
    const b = await post({ type: "artwork", name: "Light Speculation #1", slug: "Light-Speculation-#1" });
    assert.equal(b.json.node_id, "artwork:light-speculation-1");
    assert.ok(b.json.warnings.some((w: string) => w.includes("normalised")));
    const row = db.prepare("SELECT slug FROM nodes WHERE id = 'artwork:light-speculation-1'").get() as any;
    assert.equal(row.slug, "light-speculation-1");
    const c = await post({ type: "artwork", name: "Toujours là" });
    assert.equal(c.json.node_id, "artwork:toujours-là");
    assert.equal(c.json.created, false);
    const d = await post({ type: "artwork", name: "#?!" });
    assert.equal(d.status, 400);
    assert.equal(d.json.error, "invalid_slug");
  } finally {
    server.close();
  }
});
