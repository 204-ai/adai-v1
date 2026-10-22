// Issue #81: a claimant hears when something is added about their page —
// relations (live or in review), edits, notes — never their own, with
// consent respected, as their /me setting says (immediate / daily / off).

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.SESSION_SECRET = "test-secret-at-least-16-chars";
process.env.MAIL_TRANSPORT = "stdout";
process.env.ADAI_BASE_URL = "https://adai.test";
delete process.env.ADMIN_NOTIFY_EMAILS;
delete process.env.STAGING_SWITCHES;
delete process.env.ADAI_ENV;

const { initDb } = await import("../src/db.js");
const { ensureContributorForEmail, issueSession, cookieHeader } = await import("../src/intake/auth.js");
const { insertSignal, insertIntake, materialiseEdge, materialisePatchNode } = await import("../src/utils/contribution.js");
const { approveIntakeItem } = await import("../src/utils/review.js");
const { fileNote } = await import("../src/claim/notes.js");
const { onContribution } = await import("../src/notify/kick.js");
const N = await import("../src/notify/claimants.js");
const { default: claimRoutes } = await import("../src/routes/claim.js");
const { default: intakeRoutes } = await import("../src/routes/intake.js");

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};

function setup() {
  const db = initDb(":memory:");
  const node = (id: string, type: string, name: string) =>
    db.prepare("INSERT INTO nodes (id, type, name, slug, metadata) VALUES (?, ?, ?, ?, '{}')").run(id, type, name, id.split(":")[1]);
  node("practitioner:artist-a", "practitioner", "Artist A");
  node("practitioner:artist-b", "practitioner", "Artist B");
  node("artwork:glitch-piece", "artwork", "Glitch Piece");
  node("institution:glitch", "institution", "GLITCH");
  const person = (email: string, name: string, tier: string) => {
    const c = ensureContributorForEmail(db, { email, name, tier, invite: true });
    return { id: c.id, name, trust_tier: tier, token_label: null, token_prefix: "", scope: "write" } as any;
  };
  const a = person("a@glitch.test", "Artist A", "auto");
  const b = person("b@glitch.test", "Artist B", "auto");
  const anon = person("anon@glitch.test", "Quiet Person", "auto");
  const probation = person("p@glitch.test", "New Person", "probationary");
  const claim = (who: any, nodeId: string) =>
    db.prepare("INSERT INTO node_claims (id, node_id, contributor_id, status, via, reviewed_at, created_at) VALUES (?, ?, ?, 'approved', 'invite', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')")
      .run(`clm_${nodeId.split(":")[1]}`, nodeId, who.id);
  claim(a, "practitioner:artist-a");
  claim(b, "practitioner:artist-b");
  // the starting line: as if the feature had been running all along
  db.prepare("INSERT INTO settings (key, value) VALUES ('claimant_notify_since', '2000-01-01T00:00:00Z')").run();
  const relate = (who: any, s: string, t: string, type: string, extra: any = {}) => {
    const sig = insertSignal(db, { contributor: who, title: `${s} ${type} ${t}`, content: "{}", ...extra });
    materialiseEdge(db, { source_id: s, target_id: t, edge_type: type }, { signalId: sig, createdBy: who.name });
    return sig;
  };
  return { db, a, b, anon, probation, relate };
}

const linesFor = (db: any, who: any) =>
  (db.prepare("SELECT line FROM claimant_events WHERE contributor_id = ? ORDER BY created_at, rowid").all(who.id) as any[]).map((r) => r.line);

it("claimant events: what others add, never your own; anonymous is 'someone'; pending then live is one event", async () => {
  const { db, a, b, anon, probation, relate } = setup();

  // Artist A records the collaboration: the work, made by both of them
  relate(a, "artwork:glitch-piece", "practitioner:artist-a", "CREATED_BY");
  relate(a, "artwork:glitch-piece", "practitioner:artist-b", "CREATED_BY");
  // B's own addition is not news to B
  relate(b, "practitioner:artist-b", "institution:glitch", "PARTICIPATED_IN");
  // an anonymous contribution names no one
  relate(anon, "practitioner:artist-a", "practitioner:artist-b", "COLLABORATES_WITH", { consent_attribution: "anonymous" });
  // an edit to B's page
  const editSig = insertSignal(db, { contributor: a, title: "bio", content: "{}" });
  materialisePatchNode(db, { op: "patch_node", node_id: "practitioner:artist-b", metadata: { summary: "Glitch artist." } } as any, { createdBy: a.name, signalId: editSig });
  insertIntake(db, { contributor: { ...a, trust_tier: "auto" }, signal_id: editSig, target_node: "practitioner:artist-b", proposed_nodes: [{ op: "patch_node", node_id: "practitioner:artist-b", metadata: { summary: "Glitch artist." } } as any] });
  // a probationary proposal, still in review
  const pSig = insertSignal(db, { contributor: probation, title: "show", content: "{}" });
  const q = insertIntake(db, { contributor: probation, signal_id: pSig, target_node: "practitioner:artist-b", proposed_edges: [{ source_id: "institution:glitch", target_id: "practitioner:artist-b", edge_type: "REPRESENTS" }] });
  assert.equal(q.status, "pending");

  assert.ok(N.scanClaimantEvents(db) > 0);
  const lines = linesFor(db, b);
  assert.ok(lines.includes("Artist A added that you made Glitch Piece with Artist A."), lines.join("\n"));
  assert.ok(lines.includes("Someone added that you collaborated with Artist A."), lines.join("\n"));
  assert.ok(lines.includes("Artist A changed summary on your page."), lines.join("\n"));
  assert.ok(lines.includes("New Person proposed that GLITCH represents you (waiting for a curator)."), lines.join("\n"));
  assert.ok(!lines.some((l) => /took part in/.test(l)), "B's own contribution is not notified");
  assert.ok(!lines.some((l) => /Quiet Person/.test(l)), "anonymous stays anonymous");
  // … in /history too, even though the edge's created_by carries the name
  const { nodeHistory } = await import("../src/utils/history.js");
  const collab = nodeHistory(db, "practitioner:artist-b")!.events.find((e: any) => e.kind === "relation" && e.edge_type === "COLLABORATES_WITH") as any;
  assert.equal(collab.by, null);
  // A hears about what B and others did to A, not about A's own
  assert.ok(!linesFor(db, a).some((l) => /^Artist A /.test(l)));

  // rescans and the proposal going live add nothing new
  assert.equal(N.scanClaimantEvents(db), 0);
  assert.equal(approveIntakeItem(db, q.intake_id, "curator").ok, true);
  assert.equal(N.scanClaimantEvents(db), 0);

  // a note on a relation touching B, by the other end's claimant
  fileNote(db, { contributor: a, kind: "contest", node_id: "practitioner:artist-a", note: "We never collaborated.", relation: { source_id: "practitioner:artist-a", edge_type: "COLLABORATES_WITH", target_id: "practitioner:artist-b" } });
  assert.equal(N.scanClaimantEvents(db), 1);
  assert.ok(linesFor(db, b).includes("Artist A contested the record that you collaborated with Artist A: “We never collaborated.”"), linesFor(db, b).join("\n"));
});

it("claimant emails: daily by default, immediate on request, off skips; one email per pass, links to /me", async () => {
  const { db, a, b, relate } = setup();
  relate(a, "artwork:glitch-piece", "practitioner:artist-b", "CREATED_BY");

  // default daily: the immediate pass leaves B alone
  assert.equal(N.getNotifyPrefs(db, b.id).email, "daily");
  let r = await quiet(() => N.runClaimantNotifications(db, { mode: "immediate" }));
  assert.equal(r.found, 1);
  assert.equal(r.sent, 0);
  r = await quiet(() => N.runClaimantNotifications(db, { mode: "daily" }));
  assert.equal(r.sent, 1);
  const m = r.emails[0];
  assert.equal(m.to, "b@glitch.test");
  assert.equal(m.subject, "Artist A added that you made Glitch Piece — review it");
  assert.match(m.text, /• Artist A added that you made Glitch Piece\./);
  assert.match(m.text, /https:\/\/adai\.test\/me\?node=practitioner%3Aartist-b/);
  assert.match(m.text, /https:\/\/adai\.test\/auth\/[A-Za-z0-9_-]+/, "a sign-in link that lands on /me");
  assert.equal((db.prepare("SELECT redirect FROM magic_links WHERE email = 'b@glitch.test'").get() as any).redirect, "/me?node=practitioner%3Aartist-b");
  assert.match(m.text, /once a day/);
  // nothing twice
  r = await quiet(() => N.runClaimantNotifications(db, { mode: "daily" }));
  assert.equal(r.sent, 0);

  // immediate
  N.setEmailMode(db, b.id, "immediate");
  relate(a, "practitioner:artist-a", "practitioner:artist-b", "COLLABORATES_WITH");
  relate(a, "practitioner:artist-b", "institution:glitch", "PARTICIPATED_IN");
  r = await quiet(() => N.runClaimantNotifications(db, { mode: "immediate" }));
  assert.equal(r.sent, 1);
  assert.equal(r.events, 2);
  assert.match(r.emails[0].subject, /^2 new things about Artist B/);

  // off: recorded, marked skipped, never mailed — and not mailed later when switched back on
  N.setEmailMode(db, b.id, "off");
  relate(a, "artwork:glitch-piece", "institution:glitch", "HELD_BY");
  relate(a, "institution:glitch", "practitioner:artist-b", "REPRESENTS");
  r = await quiet(() => N.runClaimantNotifications(db, { mode: "daily" }));
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 1);
  N.setEmailMode(db, b.id, "daily");
  r = await quiet(() => N.runClaimantNotifications(db, { mode: "daily" }));
  assert.equal(r.sent, 0);
  assert.throws(() => N.setEmailMode(db, b.id, "hourly"));
});

it("claimant notifications: the first run only sets the starting line; staging's mail switch holds the mail", async () => {
  const db = initDb(":memory:");
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata) VALUES ('practitioner:x', 'practitioner', 'X', 'x', '{}')").run();
  assert.equal(N.scanClaimantEvents(db), 0);
  assert.ok((db.prepare("SELECT value FROM settings WHERE key = 'claimant_notify_since'").get() as any).value);

  const { db: db2, a, b, relate } = setup();
  relate(a, "artwork:glitch-piece", "practitioner:artist-b", "CREATED_BY");
  process.env.ADAI_ENV = "staging";
  process.env.STAGING_SWITCHES = "mail=stdout";
  delete process.env.MAIL_TRANSPORT;
  process.env.RESEND_API_KEY = "re_test_never_used";
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("no network in tests"); }) as any;
  try {
    const r = await quiet(() => N.runClaimantNotifications(db2, { mode: "daily" }));
    assert.equal(r.sent, 1, "held mail counts as handled (logged, not sent)");
    assert.equal(fetched, 0, "staging's mail switch kept it off Resend");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ADAI_ENV;
    delete process.env.STAGING_SWITCHES;
    delete process.env.RESEND_API_KEY;
    process.env.MAIL_TRANSPORT = "stdout";
  }
  void b;
});

it("claimant notifications: the write path kicks the server's immediate pass", async () => {
  const { db, a, b, relate } = setup();
  N.setEmailMode(db, b.id, "immediate");
  const stop = N.startClaimantNotifier(db, onContribution, { delayMs: 5, everyMs: 60_000 });
  try {
    await quiet(async () => {
      relate(a, "artwork:glitch-piece", "practitioner:artist-b", "CREATED_BY");
      await new Promise((r) => setTimeout(r, 200));
    });
    const sent = db.prepare("SELECT COUNT(*) AS n FROM claimant_deliveries WHERE channel = 'email' AND state = 'sent'").get() as any;
    assert.equal(sent.n, 1);
  } finally {
    stop();
  }
});

it("/api/me/notifications: read and set the email setting; /me offers it", async () => {
  const { db, b } = setup();
  const { signed } = issueSession(db, b.id);
  const cookie = cookieHeader(signed, 100, false).split(";")[0]!;
  const app = express();
  app.use(intakeRoutes);
  app.use(claimRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (method: string, body?: unknown, auth = true) =>
    fetch(`${base}/api/me/notifications`, { method, headers: { ...(auth ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call("GET", undefined, false)).status, 401);
    assert.equal(((await (await call("GET")).json()) as any).email, "daily");
    assert.equal((await call("POST", { email: "sometimes" })).status, 400);
    const r = await call("POST", { email: "immediate" });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).email, "immediate");
    assert.equal(N.getNotifyPrefs(db, b.id).email, "immediate");
    const me = await (await fetch(`${base}/me`)).text();
    assert.match(me, /\/api\/me\/notifications/);
    assert.match(me, /once a day \(digest\)/);
    assert.match(me, /data-act="confirm"/);
  } finally {
    server.close();
  }
});
