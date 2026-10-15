// The URL intake is invite-only: an uninvited sign-in request sends no link
// (and says the same thing as an invited one), and becomes a pending request
// the admins see; only admin tokens can invite, list and revoke.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.SESSION_SECRET = "test-secret-at-least-16-chars";
process.env.MAIL_TRANSPORT = "stdout";
delete process.env.INTAKE_OPEN;

const { initDb } = await import("../src/db.js");
const { default: intake } = await import("../src/routes/intake.js");
const { default: contributorApi } = await import("../src/routes/contributor-api.js");
const { mintToken } = await import("../src/utils/token-mint.js");

it("uninvited sign-in sends nothing and is queued; admins invite, list and revoke", async () => {
  const db = initDb(":memory:");
  const admin = mintToken(db, { contributorName: "Admin", createIfMissing: true, scope: "admin" } as any);
  const writer = mintToken(db, { contributorName: "Writer", createIfMissing: true } as any);
  const app = express(); app.use(express.json()); app.use(intake); app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const links = (email: string) => (db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = ?").get(email) as any).n;
  const settle = () => new Promise((r) => setTimeout(r, 50)); // the login route answers first, then works
  try {
    // uninvited: same answer, no link, a pending request
    let r = await post("/api/intake/login", { email: "Stranger@Example.org" });
    assert.deepEqual(await r.json(), { ok: true });
    await settle();
    assert.equal(links("stranger@example.org"), 0);

    // only admin tokens reach the invite endpoints
    assert.equal((await post("/api/v1/invites", { email: "irina@example.org", name: "Irina" }, writer.raw_token)).status, 403);
    r = await post("/api/v1/invites", { email: "Irina@Example.org", name: "Irina", tier: "reviewed" }, admin.raw_token);
    assert.equal(r.status, 201);
    assert.equal((await r.json()).invited.trust_tier, "reviewed");
    assert.equal((await post("/api/v1/invites", { email: "x@example.org" }, admin.raw_token)).status, 400, "name required");

    const list = await (await fetch(base + "/api/v1/invites", { headers: { authorization: `Bearer ${admin.raw_token}` } })).json();
    assert.equal(list.invite_only, true);
    assert.deepEqual(list.invites.map((i: any) => i.email), ["irina@example.org"]);
    assert.deepEqual(list.requests.map((q: any) => q.email), ["stranger@example.org"]);

    // invited: a link is issued
    await post("/api/intake/login", { email: "irina@example.org" });
    await settle();
    assert.equal(links("irina@example.org"), 1);

    // revoked: no more links
    assert.equal((await post("/api/v1/invites/revoke", { email: "irina@example.org" }, admin.raw_token)).status, 200);
    await post("/api/intake/login", { email: "irina@example.org" });
    await settle();
    assert.equal(links("irina@example.org"), 1);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    db.close();
  }
});

it("an access request carries the name the requester asked for, and the invite defaults to it (#72)", async () => {
  const db = initDb(":memory:");
  const admin = mintToken(db, { contributorName: "Admin", createIfMissing: true, scope: "admin" } as any);
  const app = express(); app.use(express.json()); app.use(intake); app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  try {
    await post("/api/intake/login", { email: "Ada@Studio.example" });
    await settle();
    let r = await post("/api/intake/request-details", { email: "ada@studio.example", name: "  Ada   Lovelace ", about: "artist, plotter drawings" });
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal((await post("/api/intake/request-details", { email: "ada@studio.example", name: "A" })).status, 400, "a name is 2+ characters");
    // an address that never asked (or an invited one) gets the same answer and nothing is stored
    r = await post("/api/intake/request-details", { email: "nobody@example.org", name: "Nobody" });
    assert.deepEqual(await r.json(), { ok: true });
    await settle();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM intake_access_requests WHERE email = 'nobody@example.org'").get()!.n, 0);
    // a stale request (over 30 min) is not updated
    db.prepare("INSERT INTO intake_access_requests (email, first_at, last_at) VALUES ('old@example.org', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
    await post("/api/intake/request-details", { email: "old@example.org", name: "Late" });
    await settle();
    assert.equal(db.prepare("SELECT display_name FROM intake_access_requests WHERE email = 'old@example.org'").get()!.display_name, null);

    const list = await (await fetch(base + "/api/v1/invites", { headers: { authorization: `Bearer ${admin.raw_token}` } })).json();
    const req = list.requests.find((q: any) => q.email === "ada@studio.example");
    assert.equal(req.display_name, "Ada Lovelace");
    assert.equal(req.about, "artist, plotter drawings");

    // inviting without a name uses the requested one; an explicit name wins
    r = await post("/api/v1/invites", { email: "ada@studio.example" }, admin.raw_token);
    assert.equal(r.status, 201);
    assert.equal((await r.json()).invited.name, "Ada Lovelace");
    assert.equal((await post("/api/v1/invites", { email: "old@example.org" }, admin.raw_token)).status, 400, "no requested name");
    r = await post("/api/v1/invites", { email: "old@example.org", name: "Old Friend" }, admin.raw_token);
    assert.equal((await r.json()).invited.name, "Old Friend");
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    db.close();
  }
});
