// Issue #83: the live activity feed — the past 24 hours only, consent
// respected, retired / revoked / ended left out, off unless switched on.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";

delete process.env.ACTIVITY_FEED;
delete process.env.ADAI_ENV;
delete process.env.STAGING_SWITCHES;

const { initDb } = await import("../src/db.js");
const { recentActivity, activityEnabled } = await import("../src/utils/activity.js");
const { default: activityRoutes } = await import("../src/routes/activity.js");

const NOW = new Date("2026-10-27T12:00:00Z");
const H = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

function setup() {
  const db = initDb(":memory:");
  const node = (id: string, type: string, name: string, meta: any = {}) =>
    db.prepare("INSERT INTO nodes (id, type, name, slug, metadata) VALUES (?, ?, ?, ?, ?)").run(id, type, name, id.split(":")[1], JSON.stringify(meta));
  node("artwork:glitch-1", "artwork", "Glitch One");
  node("artwork:glitch-2", "artwork", "Glitch Two");
  node("artwork:glitch-3", "artwork", "Glitch Three");
  node("artwork:old", "artwork", "Old Work");
  node("artwork:gone", "artwork", "Retired Work", { retired: true });
  node("practitioner:artist-a", "practitioner", "Artist A");
  node("practitioner:artist-b", "practitioner", "Artist B");
  node("project:glitch-show", "project", "GLITCH Show");
  let n = 0;
  const signal = (by: string, extra: Partial<{ status: string; attribution: string; scope: string }> = {}) => {
    const id = `sig-${++n}`;
    db.prepare("INSERT INTO signals (id, title, content, submitted_by, status, consent_attribution, consent_scope) VALUES (?, 'secret title', 'secret words', ?, ?, ?, ?)")
      .run(id, by, extra.status ?? "active", extra.attribution ?? "attributed", extra.scope ?? "full_commons");
    return id;
  };
  const queue = (sig: string, by: string, at: string, nodes: any[] | null, edges: any[] | null, target: string | null = null, status = "approved") =>
    db.prepare("INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status, kind, proposed_nodes, proposed_edges, created_at, reviewed_at) VALUES (?, ?, ?, ?, 'auto', ?, 'human_signal', ?, ?, ?, ?)")
      .run(`q-${sig}`, sig, target, by, status, nodes ? JSON.stringify(nodes) : null, edges ? JSON.stringify(edges) : null, at, at);
  const edge = (s: string, t: string, type: string, sig: string, ended = false) =>
    db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, created_by, valid_until) VALUES (?, ?, ?, ?, ?, 't', ?)")
      .run(`${s}--${type}--${t}--${sig}`, s, t, type, sig, ended ? "2026-10-27T00:00:00Z" : null);
  return { db, signal, queue, edge, node };
}

it("recentActivity: what shows, worded, folded, newest first; consent, retired, revoked, ended and old left out", () => {
  const { db, signal, queue, edge } = setup();
  // A adds one work (1 h ago)
  let s = signal("Artist A");
  queue(s, "Artist A", H(1), [{ op: "create_node", type: "artwork", slug: "glitch-1", name: "Glitch One" }], null);
  // the Outlier adds two works in one read (2 h ago): folded
  s = signal("Outlier Collection");
  queue(s, "Outlier Collection", H(2), [{ op: "create_node", type: "artwork", slug: "glitch-2" }, { op: "create_node", type: "artwork", slug: "glitch-3" }], null);
  // an anonymous connection between two works (3 h ago), structural_only: no words anywhere
  s = signal("Quiet Person", { attribution: "anonymous", scope: "structural_only" });
  edge("artwork:glitch-1", "artwork:glitch-2", "RESPONDS_TO", s);
  queue(s, "Quiet Person", H(3), null, [{ source_id: "artwork:glitch-1", target_id: "artwork:glitch-2", edge_type: "RESPONDS_TO" }]);
  // a written account (4 h ago): named, never quoted
  s = signal("A Critic");
  queue(s, "A Critic", H(4), null, null, "project:glitch-show");
  // left out: older than 24 h, a retired node, a revoked signal, an ended relation, a pending item
  s = signal("Artist A"); queue(s, "Artist A", H(30), [{ op: "create_node", type: "artwork", slug: "old" }], null);
  s = signal("Artist A"); queue(s, "Artist A", H(5), [{ op: "create_node", type: "artwork", slug: "gone" }], null);
  s = signal("Artist A", { status: "revoked" }); queue(s, "Artist A", H(5), [{ op: "create_node", type: "artwork", slug: "glitch-3" }], null);
  s = signal("Artist B");
  edge("practitioner:artist-b", "project:glitch-show", "PARTICIPATED_IN", s, true);
  queue(s, "Artist B", H(5), null, [{ source_id: "practitioner:artist-b", target_id: "project:glitch-show", edge_type: "PARTICIPATED_IN" }]);
  s = signal("Artist B"); queue(s, "Artist B", H(1), [{ op: "create_node", type: "artwork", slug: "glitch-3" }], null, null, "pending");
  // B claims their page (30 min ago); A contests a relation (10 min ago)
  db.prepare("INSERT INTO node_claims (id, node_id, contributor_id, status, via, reviewed_at, signal_id) VALUES ('c1', 'practitioner:artist-b', 'cb', 'approved', 'invite', ?, ?)").run(H(0.5), signal("Artist B"));
  edge("practitioner:artist-a", "practitioner:artist-b", "COLLABORATES_WITH", signal("Artist A"));
  const ns = signal("Artist A");
  db.prepare("INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, node_id, contributor_id, note, state, created_at) VALUES (?, 'contest', 'practitioner:artist-a', 'COLLABORATES_WITH', 'practitioner:artist-b', 'practitioner:artist-a', 'ca', 'Not so.', 'open', ?)").run(ns, H(1 / 6));

  const ev = recentActivity(db, { now: NOW, limit: 20 });
  assert.deepEqual(ev.map((e) => e.text), [
    "Artist A contested a relation with Artist B",
    "Artist B claimed their page",
    "Artist A added a work: Glitch One",
    "Outlier Collection added 2 works",
    "Someone connected two works: Glitch One and Glitch Two",
    "A Critic wrote about GLITCH Show",
  ]);
  assert.equal(ev[3].count, 2);
  assert.equal(ev[4].actor, null);
  const all = JSON.stringify(ev);
  assert.doesNotMatch(all, /Quiet Person|secret|Not so|Old Work|Retired Work/);
  // the limit keeps the newest
  assert.deepEqual(recentActivity(db, { now: NOW, limit: 2 }).map((e) => e.kind), ["contested", "claimed"]);
  // a day later it is all gone: live or empty
  assert.deepEqual(recentActivity(db, { now: new Date(NOW.getTime() + 25 * 3600_000) }), []);
});

it("/api/activity: off by default; ACTIVITY_FEED=on (or the setting) turns it on; staging has its own switch", async () => {
  const { db, signal, queue } = setup();
  const s = signal("Artist A");
  queue(s, "Artist A", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), [{ op: "create_node", type: "artwork", slug: "glitch-1" }], null);
  const app = express();
  app.use(activityRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const get = async () => {
    const r = await fetch(`${base}/api/activity`);
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get("cache-control")), /max-age=30/);
    return (await r.json()) as any;
  };
  try {
    assert.deepEqual(await get(), { enabled: false, events: [] });
    process.env.ACTIVITY_FEED = "on";
    const on = await get();
    assert.equal(on.enabled, true);
    assert.equal(on.window_hours, 24);
    assert.deepEqual(on.events.map((e: any) => [e.text, e.href, e.id]), [["Artist A added a work: Glitch One", "/artwork/glitch-1", "artwork:glitch-1"]]);
    delete process.env.ACTIVITY_FEED;
    db.prepare("INSERT INTO settings (key, value) VALUES ('activity_feed', 'on')").run();
    assert.equal((await get()).enabled, true);
    // staging ignores prod's env / setting: its own switch, off by default
    process.env.ADAI_ENV = "staging";
    process.env.ACTIVITY_FEED = "on";
    assert.equal((await get()).enabled, false);
    process.env.STAGING_SWITCHES = "activity=on";
    assert.equal((await get()).enabled, true);
    assert.equal(activityEnabled(), true);
  } finally {
    delete process.env.ADAI_ENV;
    delete process.env.STAGING_SWITCHES;
    delete process.env.ACTIVITY_FEED;
    server.close();
  }
});

it("the feed stays off the cached graph stream and is wired into /field", async () => {
  const { readFileSync } = await import("node:fs");
  const api = readFileSync(new URL("../src/routes/api.ts", import.meta.url), "utf8");
  assert.doesNotMatch(api, /activity/i, "nothing in the graph stream / stamp knows about it");
  const html = readFileSync(new URL("../public/field/index.html", import.meta.url), "utf8");
  assert.match(html, /\/field-static\/js-interface\/activity\.js/);
  assert.match(html, /\/field-static\/css\/activity\.css/);
  const js = readFileSync(new URL("../public/field/js-interface/activity.js", import.meta.url), "utf8");
  assert.match(js, /POLL_MS = 60_000/);
  assert.match(js, /document\.hidden/);
  assert.doesNotMatch(js, /innerHTML\s*=\s*[^'"]*e\.text/, "event text is set as text, never as HTML");
});

// ---- review fixes (#83 review of e5b806c) ---------------------------------------------------

it("claims: withdrawn, revoked, or their own signal revoked / superseded — not shown", () => {
  const { db, signal } = setup();
  const claim = (id: string, node: string, status: string, sigStatus = "active") =>
    db.prepare("INSERT INTO node_claims (id, node_id, contributor_id, status, via, reviewed_at, signal_id) VALUES (?, ?, 'c', ?, 'invite', ?, ?)")
      .run(id, node, status, H(1), signal("Someone", { status: sigStatus }));
  claim("c1", "practitioner:artist-a", "withdrawn");
  claim("c2", "practitioner:artist-b", "revoked");
  claim("c3", "artwork:glitch-1", "approved", "revoked");
  claim("c4", "artwork:glitch-2", "approved", "superseded");
  claim("c5", "project:glitch-show", "approved");
  assert.deepEqual(recentActivity(db, { now: NOW }).map((e) => e.text), ["GLITCH Show claimed their page"]);
});

it("a relation is reported only while the edge its own evidence made is live; notes only while their relation is", () => {
  const { db, signal, queue, edge } = setup();
  // two contributions of the same triple: the first one's edge was ended, the second's is live
  const s1 = signal("Artist A");
  edge("artwork:glitch-1", "artwork:glitch-2", "RESPONDS_TO", s1, true);
  queue(s1, "Artist A", H(2), null, [{ source_id: "artwork:glitch-1", target_id: "artwork:glitch-2", edge_type: "RESPONDS_TO" }]);
  const s2 = signal("Artist B");
  edge("artwork:glitch-1", "artwork:glitch-2", "RESPONDS_TO", s2);
  queue(s2, "Artist B", H(1), null, [{ source_id: "artwork:glitch-1", target_id: "artwork:glitch-2", edge_type: "RESPONDS_TO" }]);
  // a contest on an ended relation; a contest on an edited value
  edge("practitioner:artist-a", "project:glitch-show", "PARTICIPATED_IN", signal("X"), true);
  const note = db.prepare("INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, meta_key, node_id, contributor_id, note, state, created_at) VALUES (?, 'contest', ?, ?, ?, ?, 'practitioner:artist-a', 'ca', 'no', 'open', ?)");
  note.run(signal("Artist A"), "practitioner:artist-a", "PARTICIPATED_IN", "project:glitch-show", null, H(0.5));
  note.run(signal("Artist A"), null, null, null, "summary", H(0.4));
  assert.deepEqual(recentActivity(db, { now: NOW }).map((e) => e.text), [
    "Artist A contested a change to their page",
    "Artist B connected two works: Glitch One and Glitch Two",
  ]);
});

it("anonymous: no speaker's name, slug or id anywhere in the response; an anonymous author's own page stays unnamed", async () => {
  const { db, signal, queue, edge, node } = setup();
  const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  // an anonymous claimant's context note
  edge("practitioner:artist-a", "practitioner:artist-b", "COLLABORATES_WITH", signal("X"));
  db.prepare("INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, node_id, contributor_id, note, state, created_at) VALUES (?, 'context', 'practitioner:artist-a', 'COLLABORATES_WITH', 'practitioner:artist-b', 'practitioner:artist-a', 'ca', 'words', 'live', ?)")
    .run(signal("Artist A", { attribution: "anonymous" }), ago(1));
  // an anonymous contributor creating their own page (they hold a claim on it)
  node("practitioner:quiet-person", "practitioner", "Quiet Person");
  db.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES ('cq', 'Quiet Person', 'auto')").run();
  db.prepare("INSERT INTO node_claims (id, node_id, contributor_id, status, via) VALUES ('cq1', 'practitioner:quiet-person', 'cq', 'approved', 'invite')").run();
  const s = signal("Quiet Person", { attribution: "anonymous" });
  queue(s, "Quiet Person", ago(2), [{ op: "create_node", type: "practitioner", slug: "quiet-person" }], null);
  const { default: activityRoutes2 } = await import("../src/routes/activity.js");
  process.env.ACTIVITY_FEED = "on";
  const app = express();
  app.use(activityRoutes2);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/activity`);
    const body = await res.text();
    const j = JSON.parse(body);
    assert.deepEqual(j.events.map((e: any) => e.text), ["Someone added context to a relation with Artist B", "Someone added an artist"]);
    assert.doesNotMatch(body, /artist-a|Artist A|quiet-person|Quiet Person/, "the whole response");
  } finally {
    delete process.env.ACTIVITY_FEED;
    server.close();
  }
});

it("a real auto-confirmed URL-intake draft is one contribution: a few folded lines, not one per card", async () => {
  const { freshDb, insertNode } = await import("./helpers.js");
  const { createDraft, claimJob, finishPass, getDraft, runDraftTool, contributorPatchCandidate, confirmDraft } = await import("../src/intake/draft.js");
  const db = freshDb();
  db.prepare("INSERT INTO contributors (id, name, type, trust_tier) VALUES ('contributor:gal', 'Gallery Desk', 'human', 'auto')").run();
  const c = { id: "contributor:gal", name: "Gallery Desk", trust_tier: "auto", token_label: null, token_prefix: "t", scope: "write" } as any;
  insertNode(db, "practitioner:casey-reas", "practitioner", "Casey Reas");
  insertNode(db, "institution:bitforms", "institution", "bitforms gallery");
  const d = createDraft(db, c.id, "https://gallery.example/");
  claimJob(db, "w1");
  const pg = { page_url: "https://gallery.example/works", quote: "Process 4, Process 5 and Process 6 by Casey Reas at bitforms." };
  const W = "w1";
  for (const name of ["Process 4", "Process 5", "Process 6"]) runDraftTool(db, d.id, W, "propose_node", { type: "artwork", name, ...pg });
  runDraftTool(db, d.id, W, "propose_node", { type: "practitioner", name: "Casey Reas", resolves_to: "practitioner:casey-reas", resolution: "exact", ...pg });
  for (const cid of ["c_01", "c_02", "c_03"]) runDraftTool(db, d.id, W, "propose_edge", { source: `cid:${cid}`, target: "cid:c_04", edge_type: "CREATED_BY", confidence: "high", ...pg });
  runDraftTool(db, d.id, W, "propose_edge", { source: "cid:c_01", target: "institution:bitforms", edge_type: "EXHIBITED_AT", confidence: "high", ...pg });
  finishPass(db, d.id, W, { summary: "s" });
  let dr = getDraft(db, d.id)!;
  for (let i = 1; i <= 8; i++) contributorPatchCandidate(db, dr, `c_0${i}`, { state: "accepted" });
  dr = getDraft(db, d.id)!;
  const r = await confirmDraft(db, dr, c, {});
  assert.equal(r.status, "live");
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM intake_queue WHERE status = 'approved'").get() as any).n;
  assert.ok(rows >= 7, `one queue row per card (${rows})`);
  const ev = recentActivity(db, { now: new Date(Date.now() + 1000), limit: 20 });
  assert.deepEqual(ev.map((e) => e.text).sort(), ["Gallery Desk added 3 works", "Gallery Desk made 4 connections"]);
});
