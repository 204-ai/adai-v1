// GET /api/v1/review: newest-first pages with a deterministic (created_at, id)
// order and a `before` cursor, so large batches are fully reachable.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.SESSION_SECRET = "test-secret-at-least-16-chars";
process.env.MAIL_TRANSPORT = "stdout";

const { initDb } = await import("../src/db.js");
const { default: contributorApi } = await import("../src/routes/contributor-api.js");
const { mintToken } = await import("../src/utils/token-mint.js");

it("pages through the queue with before/next_before, no gaps or repeats", async () => {
  const db = initDb(":memory:");
  const admin = mintToken(db, { contributorName: "Op", createIfMissing: true, tier: "auto", scope: "admin" });
  const ins = db.prepare("INSERT INTO intake_queue (id, submitted_by, trust_tier, status, kind, created_at) VALUES (?, 'x', 'probationary', 'pending', 'signal', ?)");
  // 25 rows over only 3 distinct seconds: ties must be broken by id
  for (let i = 0; i < 25; i++) ins.run(`q-${String(i).padStart(2, "0")}`, `2026-01-01 00:00:0${i % 3}`);

  const app = express();
  app.use(express.json());
  app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const get = async (qs: string) => {
    const r = await fetch(`${base}/api/v1/review${qs}`, { headers: { authorization: `Bearer ${admin.raw_token}` } });
    return { status: r.status, json: (await r.json()) as any };
  };
  try {
    const seen: string[] = [];
    let before = "";
    let pages = 0;
    for (;;) {
      const r = await get(`?limit=10${before}`);
      assert.equal(r.status, 200);
      seen.push(...r.json.items.map((i: any) => i.intake_id));
      pages++;
      if (!r.json.has_more) { assert.equal(r.json.next_before, undefined); break; }
      assert.equal(r.json.returned, 10);
      before = `&before=${encodeURIComponent(r.json.next_before)}`;
    }
    assert.equal(pages, 3);
    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25);
    const all = (await get("?limit=500")).json;
    assert.equal(all.has_more, false);
    assert.deepEqual(all.items.map((i: any) => i.intake_id), seen);
    assert.equal((await get("?before=garbage")).status, 400);
  } finally {
    server.close();
  }
});
