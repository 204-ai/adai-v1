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
  return { db, signal, queue, edge };
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
  db.prepare("INSERT INTO node_claims (id, node_id, contributor_id, status, via, reviewed_at) VALUES ('c1', 'practitioner:artist-b', 'cb', 'approved', 'invite', ?)").run(H(0.5));
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
