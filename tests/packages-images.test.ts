// POST /api/v1/packages: optional image_url per node. An image never fails a
// package: bad URL / failed fetch → warning (direct) or a recorded failure
// (queued, at approval). The network step is replaced by a fake mirror.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import contributorApi from "../src/routes/contributor-api.js";
import { mintToken } from "../src/utils/token-mint.js";
import { approveIntakeItem } from "../src/utils/review.js";
import { mirrorQueuedImages, queuedImageFailures, setImageMirrorForTests } from "../src/utils/package-images.js";
import { ImageFetchError } from "../src/utils/images.js";

Object.assign(process.env, {
  R2_ENDPOINT: "http://127.0.0.1:1", R2_BUCKET: "t", R2_ACCESS_KEY_ID: "t", R2_SECRET_ACCESS_KEY: "t", R2_PUBLIC_BASE: "https://cdn.test",
});

const fetched: string[] = [];
function fakeMirror(failOn: string[] = []) {
  return setImageMirrorForTests(async (url) => {
    fetched.push(url);
    if (failOn.some((f) => url.includes(f))) throw new ImageFetchError("upstream responded 404", "upstream_status", 502);
    const sha = Buffer.from(url).toString("hex").padEnd(64, "0").slice(0, 64);
    return { upload: { key: `images/${sha.slice(0, 2)}/${sha}.jpg`, url: `https://cdn.test/images/${sha.slice(0, 2)}/${sha}.jpg`, sha256: sha, bytes: 10, content_type: "image/jpeg" } as any, mime: "image/jpeg", source_url: url, final_url: url };
  });
}

async function setup() {
  fetched.length = 0;
  const db = initDb(":memory:");
  const prob = mintToken(db, { contributorName: "Probie", createIfMissing: true, tier: "probationary" } as any);
  const auto = mintToken(db, { contributorName: "Founder", createIfMissing: true, tier: "reviewed" } as any);
  const app = express();
  app.use(express.json());
  app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (tok: { raw_token: string }, body: unknown) => {
    const r = await fetch(`${base}/api/v1/packages`, { method: "POST", headers: { authorization: `Bearer ${tok.raw_token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  return { db, prob, auto, server, post };
}
const meta = (db: any, id: string) => JSON.parse((db.prepare("SELECT metadata FROM nodes WHERE id = ?").get(id) as any).metadata);

it("probationary: image waits in the item, is mirrored at approval", async () => {
  const prev = fakeMirror();
  const { db, prob, server, post } = await setup();
  try {
    const r = await post(prob, { nodes: [{ type: "artwork", name: "Pic", image_url: "https://example.org/a.jpg" }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, "pending");
    assert.equal(r.json.images_queued, 1);
    assert.equal(fetched.length, 0, "nothing is fetched while the item waits");
    const q = db.prepare("SELECT proposed_nodes FROM intake_queue WHERE id = ?").get(r.json.intake_id) as any;
    const ops = JSON.parse(q.proposed_nodes);
    assert.deepEqual(ops.map((o: any) => o.op), ["create_node", "attach_image"]);
    assert.equal(ops[1].node_id, "artwork:pic");
    assert.equal(ops[1].cdn_image_url, undefined);

    assert.deepEqual(await mirrorQueuedImages(db, r.json.intake_id), []);
    assert.equal(approveIntakeItem(db, r.json.intake_id, "curator").ok, true);
    const m = meta(db, "artwork:pic");
    assert.match(m.cdn_image_url, /^https:\/\/cdn\.test\/images\//);
    assert.equal(m.image_url, "https://example.org/a.jpg");
    assert.ok(m.image_sha256);
  } finally { server.close(); setImageMirrorForTests(prev); }
});

it("probationary: a failed fetch is recorded and does not fail approval", async () => {
  const prev = fakeMirror(["broken"]);
  const { db, prob, server, post } = await setup();
  try {
    const r = await post(prob, { nodes: [
      { type: "artwork", name: "Good", image_url: "https://example.org/good.png" },
      { type: "artwork", name: "Bad", image_url: "https://example.org/broken.png" },
    ] });
    const warns = await mirrorQueuedImages(db, r.json.intake_id);
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /artwork:bad.*upstream_status/);
    assert.equal(approveIntakeItem(db, r.json.intake_id, "curator").ok, true);
    assert.ok(db.prepare("SELECT 1 FROM nodes WHERE id='artwork:bad'").get(), "node is live");
    assert.equal(meta(db, "artwork:bad").cdn_image_url, undefined);
    assert.ok(meta(db, "artwork:good").cdn_image_url);
    assert.equal(queuedImageFailures(db, r.json.intake_id).length, 1);
    const ops = JSON.parse((db.prepare("SELECT proposed_nodes FROM intake_queue WHERE id = ?").get(r.json.intake_id) as any).proposed_nodes);
    assert.ok(ops.some((o: any) => o.op === "image_failed" && o.node_id === "artwork:bad" && /404/.test(o.image_error)));
  } finally { server.close(); setImageMirrorForTests(prev); }
});

it("approval without the mirror step still succeeds and attaches nothing", async () => {
  const { db, prob, server, post } = await setup();
  try {
    const r = await post(prob, { nodes: [{ type: "artwork", name: "Raw", image_url: "https://example.org/raw.jpg" }] });
    assert.equal(approveIntakeItem(db, r.json.intake_id, "curator").ok, true);
    assert.equal(meta(db, "artwork:raw").cdn_image_url, undefined);
  } finally { server.close(); }
});

it("reviewed: mirrored right after creation; failure is a warning", async () => {
  const prev = fakeMirror(["broken"]);
  const { db, auto, server, post } = await setup();
  try {
    const r = await post(auto, { nodes: [
      { type: "artwork", name: "Good", image_url: "https://example.org/good.jpg" },
      { type: "artwork", name: "Bad", image_url: "https://example.org/broken.jpg" },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, "approved");
    assert.deepEqual(r.json.created_nodes.sort(), ["artwork:bad", "artwork:good"]);
    assert.deepEqual(r.json.images_attached, ["artwork:good"]);
    assert.equal(r.json.images_failed.length, 1);
    assert.ok(r.json.warnings.some((w: string) => /artwork:bad.*not attached/.test(w)));
    assert.ok(meta(db, "artwork:good").cdn_image_url);
    assert.equal(meta(db, "artwork:bad").cdn_image_url, undefined);
  } finally { server.close(); setImageMirrorForTests(prev); }
});

it("invalid image_url is a warning, not a 400, on both paths", async () => {
  const prev = fakeMirror();
  const { db, prob, auto, server, post } = await setup();
  try {
    for (const [tok, name] of [[auto, "A1"], [prob, "P1"]] as const) {
      for (const bad of ["http://example.org/x.jpg", "not a url", "https://u:p@example.org/x.jpg", 42]) {
        const r = await post(tok, { nodes: [{ type: "artwork", name: `${name} ${String(bad).length}`, image_url: bad }] });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.ok(r.json.warnings.some((w: string) => /image_url not used/.test(w)), JSON.stringify(r.json.warnings));
      }
    }
    assert.equal(fetched.length, 0);
    const q = db.prepare("SELECT proposed_nodes FROM intake_queue WHERE status='pending' LIMIT 1").get() as any;
    assert.ok(JSON.parse(q.proposed_nodes).some((o: any) => o.op === "image_failed"));
  } finally { server.close(); setImageMirrorForTests(prev); }
});

it("an existing node keeps its page: image_url is ignored with a warning", async () => {
  const prev = fakeMirror();
  const { db, auto, server, post } = await setup();
  try {
    db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES ('artwork:old', 'artwork', 'Old', 'old', '{}', 'test')").run();
    const r = await post(auto, { nodes: [{ type: "artwork", name: "Old", image_url: "https://example.org/o.jpg" }, { type: "artwork", name: "New" }] });
    assert.equal(r.status, 200);
    assert.ok(r.json.warnings.some((w: string) => /image_url ignored/.test(w)));
    assert.equal(fetched.length, 0);
  } finally { server.close(); setImageMirrorForTests(prev); }
});

it("no image_url: response and queue rows are unchanged", async () => {
  const { db, prob, auto, server, post } = await setup();
  try {
    const a = await post(auto, { nodes: [{ type: "artwork", name: "Plain A" }] });
    assert.equal(a.json.images_attached, undefined);
    assert.equal(a.json.images_failed, undefined);
    const b = await post(prob, { nodes: [{ type: "artwork", name: "Plain B" }] });
    assert.equal(b.json.images_queued, undefined);
    const ops = JSON.parse((db.prepare("SELECT proposed_nodes FROM intake_queue WHERE id = ?").get(b.json.intake_id) as any).proposed_nodes);
    assert.deepEqual(ops.map((o: any) => o.op), ["create_node"]);
  } finally { server.close(); }
});
