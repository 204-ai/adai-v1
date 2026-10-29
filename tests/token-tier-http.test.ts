// PATCH /api/v1/tokens/:prefix {"tier"}: an admin changes a contributor's
// trust tier over HTTP (no SSH), effective on their next request.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import contributorApi from "../src/routes/contributor-api.js";
import { mintToken } from "../src/utils/token-mint.js";

it("tokens: an admin sets the tier; it applies at once; bad input changes nothing", async () => {
  const db = initDb(":memory:");
  const admin = mintToken(db, { contributorName: "Op", createIfMissing: true, tier: "auto", scope: "admin" });
  const paul = mintToken(db, { contributorName: "Paul", createIfMissing: true, tier: "probationary" });
  const app = express();
  app.use(express.json());
  app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  const tierOf = () => (db.prepare("SELECT trust_tier FROM contributors WHERE name = 'Paul'").get() as any).trust_tier;
  try {
    const path = `/api/v1/tokens/${paul.token_prefix}`;
    assert.equal((await call("PATCH", path, paul.raw_token, { tier: "auto" })).status, 403, "admin only");
    assert.equal(tierOf(), "probationary");
    assert.equal((await call("PATCH", path, admin.raw_token, { tier: "godmode" })).json.error, "invalid_tier");
    assert.equal((await call("PATCH", path, admin.raw_token, {})).status, 400);
    // a bad node rolls the tier back too
    const both = await call("PATCH", path, admin.raw_token, { tier: "reviewed", node: "practitioner:nope" });
    assert.equal(both.json.error, "no_such_node");
    assert.equal(tierOf(), "probationary");

    const ok = await call("PATCH", path, admin.raw_token, { tier: "reviewed" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.trust_tier, "reviewed");
    assert.equal(ok.json.previous_tier, "probationary");
    assert.equal(tierOf(), "reviewed");
    const who = await call("GET", "/api/v1/whoami", paul.raw_token);
    assert.equal(who.json.trust_tier ?? who.json.contributor?.trust_tier, "reviewed");
    assert.equal((await call("PATCH", "/api/v1/tokens/adai_nothere", admin.raw_token, { tier: "auto" })).status, 404);
  } finally {
    server.close();
  }
});
