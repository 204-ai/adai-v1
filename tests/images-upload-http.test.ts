// POST /api/v1/images decides what a file is from its first bytes, never from
// the label the client sent (issue #60): a JPEG declared text/plain is stored
// as image/jpeg under a .jpg key; text declared image/png is refused with 415.
// R2 is a tiny fake S3 endpoint (path-style HEAD → 404, PUT → 200) that
// records what the server stored.

import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { initDb } from "../src/db.js";
import contributorApi from "../src/routes/contributor-api.js";
import { mintToken } from "../src/utils/token-mint.js";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(64, 7)]);

it("images: stored type and extension come from the bytes, not the declared label", async () => {
  const puts: Array<{ url: string; type: string | undefined }> = [];
  const s3 = http.createServer((req, res) => {
    if (req.method === "HEAD") { res.statusCode = 404; res.end(); return; }
    req.resume();
    req.on("end", () => {
      puts.push({ url: (req.url ?? "").split("?")[0], type: req.headers["content-type"] });
      res.statusCode = 200;
      res.setHeader("ETag", '"x"');
      res.end();
    });
  });
  s3.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => s3.once("listening", resolve));
  Object.assign(process.env, {
    R2_ENDPOINT: `http://127.0.0.1:${(s3.address() as any).port}`,
    R2_BUCKET: "adai-test",
    R2_ACCESS_KEY_ID: "test",
    R2_SECRET_ACCESS_KEY: "test",
    R2_PUBLIC_BASE: "https://cdn.test",
  });

  const db = initDb(":memory:");
  const tok = mintToken(db, { contributorName: "Uploader", createIfMissing: true, tier: "auto" } as any);
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const auth = { authorization: `Bearer ${tok.raw_token}` };
  try {
    const node = await fetch(`${base}/api/v1/nodes`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ type: "artwork", name: "Oscillon 1184" }) });
    assert.equal(node.status, 200, await node.clone().text());

    // multipart, JPEG bytes labelled text/plain
    const fd = new FormData();
    fd.set("node_id", "artwork:oscillon-1184");
    fd.set("image", new Blob([JPEG], { type: "text/plain" }), "oscillon.txt");
    const r1 = await fetch(`${base}/api/v1/images`, { method: "POST", headers: auth, body: fd });
    const j1 = await r1.json() as any;
    assert.equal(r1.status, 200, JSON.stringify(j1));
    assert.equal(j1.upload.content_type, "image/jpeg");
    assert.match(j1.upload.key, /\.jpg$/);
    assert.equal(puts.length, 1);
    assert.match(puts[0].url, /\.jpg$/);
    assert.equal(puts[0].type, "image/jpeg");
    const sig = db.prepare("SELECT content FROM signals WHERE id = ?").get(j1.signal_id) as any;
    assert.equal(JSON.parse(sig.content).declared_type, "text/plain");
    const meta = JSON.parse((db.prepare("SELECT metadata FROM nodes WHERE id = 'artwork:oscillon-1184'").get() as any).metadata);
    assert.match(meta.cdn_image_url, /^https:\/\/cdn\.test\/images\/.+\.jpg$/);

    // base64, text labelled image/png → refused, nothing stored
    const r2 = await fetch(`${base}/api/v1/images`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ node_id: "artwork:oscillon-1184", mime_type: "image/png", image_base64: Buffer.from("definitely not an image, just some words").toString("base64") }),
    });
    const j2 = await r2.json() as any;
    assert.equal(r2.status, 415);
    assert.equal(j2.error, "not_an_image");
    assert.equal(puts.length, 1);
  } finally {
    server.close();
    s3.close();
  }
});
