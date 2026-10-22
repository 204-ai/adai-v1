// The embedding provider switch (src/embed/provider.ts): Gemini stays the
// default, the OpenAI-compatible path sends one fused item with our own task
// prefix, and readers only ever see the current model's vectors.

import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { embedProvider, embedModel, embedKey, embedBaseUrl } from "../src/embed/provider.js";
import { embedOnce, embedNodeNow } from "../src/embed/server.js";
import { loadAll, invalidateVectorCache, DIMS } from "../src/embed/vectors.js";
import { freshDb, insertNode, encodeF32, unitVector } from "./helpers.js";

const KEYS = ["EMBED_PROVIDER", "EMBED_MODEL", "EMBED_BASE_URL", "EMBED_API_KEY", "GEMINI_API_KEY", "ADAI_ENV", "STAGING_SWITCHES"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
  invalidateVectorCache();
});

function useOpenAI() {
  process.env.EMBED_PROVIDER = "openai";
  process.env.EMBED_API_KEY = "test-key";
  delete process.env.EMBED_MODEL;
  delete process.env.EMBED_BASE_URL;
  delete process.env.ADAI_ENV;
}

function mockFetch(): Array<{ url: string; body: any; auth: string | null }> {
  const calls: Array<{ url: string; body: any; auth: string | null }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), auth: new Headers(init.headers).get("authorization") });
    const v = Array.from(unitVector(DIMS, calls.length % DIMS));
    return new Response(JSON.stringify({ data: [{ embedding: v }] }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

it("provider: gemini is the default, with its old model tag", () => {
  delete process.env.EMBED_PROVIDER;
  delete process.env.EMBED_MODEL;
  delete process.env.ADAI_ENV;
  process.env.GEMINI_API_KEY = "g";
  assert.equal(embedProvider(), "gemini");
  assert.equal(embedModel(), "gemini-embedding-2");
  assert.equal(embedKey(), "g");
});

it("provider: openai defaults to EmbeddingGemma 2 on DeepInfra, keyed by EMBED_API_KEY", () => {
  useOpenAI();
  process.env.GEMINI_API_KEY = "g";
  assert.equal(embedModel(), "google/embeddinggemma-2");
  assert.equal(embedBaseUrl(), "https://api.deepinfra.com/v1/openai");
  assert.equal(embedKey(), "test-key");
  process.env.ADAI_ENV = "staging"; // embeddings off by default on staging
  assert.equal(embedKey(), null);
});

it("provider: an unknown EMBED_PROVIDER fails loudly", () => {
  process.env.EMBED_PROVIDER = "cohere";
  assert.throws(() => embedProvider(), /EMBED_PROVIDER/);
});

it("embedOnce (openai): text + image as one item, no task field, our prefix kept", async () => {
  useOpenAI();
  const calls = mockFetch();
  const v = await embedOnce("task: sentence similarity | query: Artwork", { bytes: Buffer.from([1, 2, 3]), mime: "image/png" });
  assert.equal(v.length, DIMS);
  assert.equal(calls.length, 1);
  const { url, body, auth } = calls[0]!;
  assert.equal(url, "https://api.deepinfra.com/v1/openai/embeddings");
  assert.equal(auth, "Bearer test-key");
  assert.equal(body.model, "google/embeddinggemma-2");
  assert.equal(body.dimensions, DIMS);
  assert.equal(body.task, undefined);
  assert.equal(body.input.length, 1);
  assert.deepEqual(body.input[0], [
    { type: "text", text: "task: sentence similarity | query: Artwork" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
  ]);
});

it("embedOnce (openai): an error status surfaces as an error", async () => {
  useOpenAI();
  globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  await assert.rejects(embedOnce("x", null), /401/);
});

it("a model switch: other-model rows are invisible and get re-embedded", async () => {
  useOpenAI();
  const db = freshDb();
  insertNode(db, "concept:noise", "concept", "Noise");
  // A vector from the previous model, same text hash as the current text would be.
  db.prepare(
    `INSERT INTO node_embeddings (node_id, kind, model, dims, vector, has_image, image_hash, text_hash)
     VALUES ('concept:noise', 'identity', 'gemini-embedding-2', ?, ?, 0, NULL, 'stale')`
  ).run(DIMS, encodeF32(unitVector(DIMS, 0)));
  assert.equal(loadAll(db, { fresh: true }).size, 0, "old-model row must not be loaded");

  const calls = mockFetch();
  const r = await embedNodeNow(db, "concept:noise");
  assert.equal(r.status, "embedded");
  assert.equal(calls.length, 1);
  const row = db.prepare("SELECT model FROM node_embeddings WHERE node_id='concept:noise' AND kind='identity'").get() as { model: string };
  assert.equal(row.model, "google/embeddinggemma-2");
  assert.equal(loadAll(db, { fresh: true }).size, 1);

  // Same text, same model → skipped, no second call.
  const again = await embedNodeNow(db, "concept:noise");
  assert.equal(again.status, "skipped_unchanged");
  assert.equal(calls.length, 1);
});
