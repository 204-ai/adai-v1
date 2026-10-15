// Claims over HTTP: curator-gated review, /@handle, the claim + log + note +
// invite endpoints, the signed-out claim request and its curator approval.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.SESSION_SECRET = "test-secret-at-least-16-chars";
process.env.MAIL_TRANSPORT = "stdout";
process.env.ADMIN_EMAILS = "curator@adai.test";
delete process.env.ADMIN_NOTIFY_EMAILS;
delete process.env.INTAKE_OPEN;

const { initDb } = await import("../src/db.js");
const { default: intake } = await import("../src/routes/intake.js");
const { default: claim } = await import("../src/routes/claim.js");
const { default: pages } = await import("../src/routes/pages.js");
const { default: api } = await import("../src/routes/api.js");
const { ensureContributorForEmail, issueSession, cookieHeader } = await import("../src/intake/auth.js");
const { backfillInviteClaims } = await import("../src/claim/store.js");

function node(db: any, id: string, type: string, name: string, metadata: any = null) {
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata) VALUES (?, ?, ?, ?, ?)").run(id, type, name, id.split(":")[1], metadata ? JSON.stringify(metadata) : null);
}
function edge(db: any, s: string, t: string, type: string) {
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by) VALUES (?, ?, ?, ?, 'test')").run(`${s}--${type}--${t}--test`, s, t, type);
}

it("claim → handle → log → contest → curator; signed-out request → invite + approve; peer invite", async () => {
  const db = initDb(":memory:");
  node(db, "practitioner:ada", "practitioner", "Ada", { website: "https://ada.art" });
  node(db, "practitioner:bob", "practitioner", "Bob");
  node(db, "practitioner:cy", "practitioner", "Cy");
  node(db, "institution:g", "institution", "Gallery G");
  edge(db, "institution:g", "practitioner:ada", "REPRESENTS");
  edge(db, "practitioner:ada", "practitioner:bob", "COLLABORATES_WITH");

  const session = (email: string, name: string, extra: any = {}) => {
    const c = ensureContributorForEmail(db, { email, name, invite: true, ...extra });
    const { signed } = issueSession(db, c.id);
    return { id: c.id, cookie: cookieHeader(signed, 100, false).split(";")[0]! };
  };
  const ada = session("ada@ada.art", "Ada L");
  const curator = session("curator@adai.test", "Cura");
  const eve = session("eve@x.org", "Eve");

  const app = express(); app.use(express.json()); app.use(intake); app.use(claim); app.use(pages); app.use(api);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, who?: { cookie: string } | null, body?: unknown) => {
    const r = await fetch(base + path, { method, redirect: "manual", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(who ? { cookie: who.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, location: r.headers.get("location") };
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));

  try {
    // /review is for curators only
    assert.equal((await call("GET", "/review")).status, 401);
    assert.equal((await call("GET", "/review", eve)).status, 403);
    assert.equal((await call("GET", "/review?kind=claim", curator)).status, 200);

    // Ada claims her page; it waits for a curator
    let r = await call("POST", "/api/claims", ada, { node_id: "practitioner:ada", evidence: "my site ada.art", handle: "ada" });
    assert.equal(r.status, 201);
    assert.equal(r.json.claim.status, "pending");
    const queueId = r.json.claim.queue_id;
    // the review card shows the domain match
    const card = await call("GET", "/review?kind=claim", curator);
    assert.match(card.text, /matches the page&#39;s website|matches the page's website/);
    // an outsider cannot approve
    assert.equal((await call("POST", `/api/review/${queueId}/approve`, eve)).status, 403);
    assert.equal((await call("POST", `/api/review/${queueId}/approve`, null)).status, 401);
    assert.equal((await call("POST", `/api/review/${queueId}/approve`, curator)).status, 200);

    // the badge + handle
    r = await call("GET", "/@ada");
    assert.equal(r.status, 302);
    assert.equal(r.location, "/practitioner/ada");
    assert.equal((await call("GET", "/@ada/history")).location, "/practitioner/ada/history");
    assert.equal((await call("GET", "/@nobody")).status, 404);
    const profile = await call("GET", "/practitioner/ada", null);
    assert.match(profile.text, /✓ claimed/);
    assert.match(profile.text, /@ada/);
    assert.match((await call("GET", "/practitioner/ada", ada)).text, /this is your page/);
    assert.match((await call("GET", "/practitioner/bob", eve)).text, /is this you\? claim this page/);
    assert.match((await call("GET", "/record/practitioner/ada", ada)).text, /This is your page/);
    assert.match((await call("GET", "/record/practitioner/bob", eve)).text, /Is this you\? Claim this page/);

    // her log: both relations, Bob invitable
    r = await call("GET", "/api/me/log", ada);
    assert.equal(r.json.node.id, "practitioner:ada");
    assert.equal(r.json.relations.length, 2);
    const bobRel = r.json.relations.find((x: any) => x.other.id === "practitioner:bob");
    assert.equal(bobRel.can_invite, true);

    // contest the gallery relation: public at once
    r = await call("POST", "/api/me/contest", ada, { node_id: "practitioner:ada", relation: { source_id: "institution:g", edge_type: "REPRESENTS", target_id: "practitioner:ada" }, note: "Never represented me" });
    assert.equal(r.status, 201);
    assert.match((await call("GET", "/institution/g")).text, /contested by the subject/);
    // Eve cannot speak for Ada
    assert.equal((await call("POST", "/api/me/contest", eve, { node_id: "practitioner:ada", relation: { source_id: "institution:g", edge_type: "REPRESENTS", target_id: "practitioner:ada" }, note: "x" })).status, 403);
    const contestQ = r.json.note.queue_id;
    assert.match((await call("GET", "/review?kind=contest", curator)).text, /Never represented me/);
    assert.equal((await call("POST", `/api/review/${contestQ}/approve`, curator)).status, 200);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM edges WHERE source_id = 'institution:g' AND valid_until IS NULL").get() as any).n, 0);
    // history keeps the contest and its outcome next to the ended relation
    const hist = await call("GET", "/practitioner/ada/history.json");
    const note = hist.json.events.find((e: any) => e.kind === "note");
    assert.equal(note.state, "upheld");
    assert.equal(note.note, "Never represented me");
    assert.match((await call("GET", "/practitioner/ada/history")).text, /contested by the subject/);

    // peer invite Bob: instant claim, email sent with a link
    r = await call("POST", "/api/me/invite", ada, { node_id: "practitioner:bob", email: "bob@x.org", message: "join us" });
    assert.equal(r.status, 201);
    assert.equal(r.json.claim.status, "approved");
    await settle();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = 'bob@x.org'").get() as any).n, 1);
    assert.equal((await call("POST", "/api/me/invite", ada, { node_id: "practitioner:cy", email: "cy@x.org" })).status, 403, "not related");

    // signed out: Cy (not invited) asks to claim — an access request naming the node
    r = await call("POST", "/api/claims/request", null, { email: "cy@cy.org", node_id: "practitioner:cy", evidence: "I am Cy" });
    assert.deepEqual(r.json, { ok: true });
    await settle();
    assert.equal((db.prepare("SELECT node_id FROM intake_access_requests WHERE email = 'cy@cy.org'").get() as any).node_id, "practitioner:cy");
    assert.match((await call("GET", "/review?kind=claim", curator)).text, /cy@cy\.org/);
    r = await call("POST", "/api/review/access/approve", curator, { email: "cy@cy.org" });
    assert.equal(r.status, 200);
    assert.equal(r.json.claim.status, "approved");
    await settle();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = 'cy@cy.org'").get() as any).n, 1);
    assert.equal(JSON.parse((db.prepare("SELECT metadata FROM nodes WHERE id = 'practitioner:cy'").get() as any).metadata).claimed.by[0], "Cy");

    // handle check + change rules over HTTP
    r = await call("GET", "/api/claims/handle?h=ada&node=practitioner:bob", eve);
    assert.equal(r.json.ok, false);
    assert.equal((await call("POST", "/api/claims/handle", eve, { node_id: "practitioner:ada", handle: "eve" })).status, 403);

    // /api/intake/me lists the claims
    r = await call("GET", "/api/intake/me", ada);
    assert.deepEqual(r.json.claims.map((c: any) => [c.id, c.claim_status, c.handle]), [["practitioner:ada", "approved", "ada"]]);
    assert.equal(r.json.curator, false);
    assert.equal((await call("GET", "/api/intake/me", curator)).json.curator, true);

    // backfill is a no-op when everything is already a claim
    assert.equal(backfillInviteClaims(db), 0);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    db.close();
  }
});
