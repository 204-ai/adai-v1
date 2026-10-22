// Issue #80 (part 2): the accounts section of the public entity view and its
// /api/entity twin — written contributions side by side, oldest first,
// consent respected, the subject's own words marked but not ranked.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import pages from "../src/routes/pages.js";
import { accountsFor } from "../src/entity/accounts.js";

function setup() {
  const db = initDb(":memory:");
  const node = db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, 't')");
  node.run("project:glitch-show", "project", "GLITCH Show", "glitch-show", "{}");
  node.run("practitioner:artist-b", "practitioner", "Artist B", "artist-b", JSON.stringify({ claimed: { handle: "artistb", by: [] } }));
  node.run("practitioner:artist-a", "practitioner", "Artist A", "artist-a", JSON.stringify({ claimed: { handle: "artista", by: [] } }));
  node.run("publication:catalogue", "publication", "GLITCH Catalogue", "catalogue", "{}");
  const contributor = db.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES (?, ?, 'auto')");
  contributor.run("c-archive", "Archive Desk");
  contributor.run("c-critic", "A Critic");
  contributor.run("c-b", "Artist B");
  contributor.run("c-a", "Artist A");
  contributor.run("c-anon", "Secret Name");
  contributor.run("c-cat", "Catalogue Team");
  const claim = db.prepare("INSERT INTO node_claims (id, node_id, contributor_id, status, via) VALUES (?, ?, ?, 'approved', 'invite')");
  claim.run("clm_b", "practitioner:artist-b", "c-b");
  claim.run("clm_a", "practitioner:artist-a", "c-a");
  // a token that stands for the catalogue (issue #70)
  db.prepare("INSERT INTO contributor_tokens (token_hash, token_prefix, contributor_id, node_id) VALUES ('h', 'adai_x', 'c-cat', 'publication:catalogue')").run();

  let n = 0;
  const signal = (target: string, by: string, at: string, title: string | null, content: string, extra: Partial<{ status: string; scope: string; attribution: string; url: string; queue: string }> = {}) => {
    const id = `sig-${++n}`;
    db.prepare("INSERT INTO signals (id, title, content, submitted_by, created_at, status, consent_scope, consent_attribution, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, title, content, by, at, extra.status ?? "active", extra.scope ?? "full_commons", extra.attribution ?? "attributed", extra.url ?? null);
    db.prepare("INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status, kind) VALUES (?, ?, ?, ?, 'auto', ?, 'human_signal')")
      .run(`q-${id}`, id, target, by, extra.queue ?? "approved");
    return id;
  };
  return { db, signal };
}

it("accounts: what is shown, in what order, with what consent", () => {
  const { db, signal } = setup();
  const S = "artist-b";
  signal(`practitioner:${S}`, "A Critic", "2026-10-27T10:00:00Z", "A reading", "Artist B's glitches read as <care>, not error & noise.", { url: "https://www.critic.example/essay" });
  signal(`practitioner:${S}`, "Artist B", "2026-10-26T09:00:00Z", "My intention", "I wanted the errors to stay visible.");
  signal(`practitioner:${S}`, "Secret Name", "2026-10-28T09:00:00Z", "Testimony", "I was there.", { attribution: "anonymous" });
  signal(`practitioner:${S}`, "Archive Desk", "2026-10-29T09:00:00Z", "Private note", "Words that must not show.", { scope: "structural_only", url: "https://private.example" });
  signal(`practitioner:${S}`, "Archive Desk", "2026-10-30T09:00:00Z", "Revoked", "Revoked words.", { status: "revoked" });
  signal(`practitioner:${S}`, "Archive Desk", "2026-10-30T09:00:00Z", "Superseded", "Old words.", { status: "superseded" });
  signal(`practitioner:${S}`, "Archive Desk", "2026-10-30T09:00:00Z", "Pending", "Not yet reviewed.", { queue: "pending" });
  signal(`practitioner:${S}`, "Archive Desk", "2026-10-30T09:00:00Z", "Add edge", `{"source_id":"x","edge_type":"HELD_BY"}`);

  const list = accountsFor(db, `practitioner:${S}`);
  assert.deepEqual(list.map((a) => a.title ?? (a.withheld ? "(withheld)" : a.text)), ["My intention", "A reading", "Testimony", "(withheld)"], "oldest first; revoked, superseded, pending and API bodies left out");
  const [mine, reading, anon, hidden] = list;
  assert.equal(mine.subject, true, "the claimant speaks as the subject");
  assert.equal(reading.subject, false);
  assert.equal(anon.by, null);
  assert.equal(anon.subject, false);
  assert.equal(hidden.text, null);
  assert.equal(hidden.source_url, null);
  assert.equal(hidden.withheld, true);

  // a token standing for the node is the subject too (here: the catalogue on itself)
  signal("publication:catalogue", "Catalogue Team", "2026-10-26T12:00:00Z", "Colophon", "This catalogue documents the GLITCH show.");
  const cat = accountsFor(db, "publication:catalogue");
  assert.equal(cat[0].subject, true);
  assert.equal(cat[0].by_node?.id, "publication:catalogue");
});

it("accounts: the claimants' notes join them, the other end's speaker named, nothing ranked", async () => {
  const { db, signal } = setup();
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES ('e1', 'practitioner:artist-a', 'practitioner:artist-b', 'COLLABORATES_WITH', 't', '2026-10-26T00:00:00Z')").run();
  const note = db.prepare(
    `INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, node_id, contributor_id, note, state, created_at)
     VALUES (?, ?, 'practitioner:artist-a', 'COLLABORATES_WITH', 'practitioner:artist-b', ?, ?, ?, ?, ?)`
  );
  const sig = db.prepare("INSERT INTO signals (id, title, content, submitted_by, created_at) VALUES (?, 'note', '{}', ?, ?)");
  sig.run("n1", "Artist B", "2026-10-27T08:00:00Z");
  note.run("n1", "context", "practitioner:artist-b", "c-b", "We made it over two nights.", "live", "2026-10-27T08:00:00Z");
  sig.run("n2", "Artist A", "2026-10-28T08:00:00Z");
  note.run("n2", "contest", "practitioner:artist-a", "c-a", "It was my piece; B advised.", "open", "2026-10-28T08:00:00Z");
  sig.run("n3", "Artist B", "2026-10-29T08:00:00Z");
  note.run("n3", "context", "practitioner:artist-b", "c-b", "Pending context.", "pending", "2026-10-29T08:00:00Z");
  sig.run("n4", "Artist B", "2026-10-29T09:00:00Z");
  note.run("n4", "context", "practitioner:artist-b", "c-b", "Withdrawn context.", "withdrawn", "2026-10-29T09:00:00Z");
  signal("practitioner:artist-b", "A Critic", "2026-10-27T12:00:00Z", "Reading", "Two hands, one error.");

  const list = accountsFor(db, "practitioner:artist-b");
  assert.deepEqual(list.map((a) => a.signal_id), ["n1", "sig-1", "n2"]);
  assert.equal(list[0].kind, "context");
  assert.equal(list[0].subject, true);
  assert.equal(list[0].by, "@artistb");
  assert.equal(list[2].kind, "contest");
  assert.equal(list[2].subject, false);
  assert.equal(list[2].speaking_for?.id, "practitioner:artist-a");

  const app = express();
  app.use(pages);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const page = await (await fetch(`${base}/practitioner/artist-b`)).text();
    const overlay = ((await (await fetch(`${base}/api/entity?id=${encodeURIComponent("practitioner:artist-b")}`)).json()) as any).html as string;
    for (const html of [page, overlay]) {
      const sec = html.slice(html.indexOf('id="ev-accounts"'));
      assert.match(sec, /\/\/ accounts <span class="ev-h2-count">\/03<\/span>/);
      assert.match(sec, /No account here is the official one/);
      // order on the page = chronological
      assert.ok(sec.indexOf("two nights") < sec.indexOf("Two hands") && sec.indexOf("Two hands") < sec.indexOf("my piece"));
      assert.match(sec, /<li class="ev-account ev-account--context ev-account--subject"[^>]*><p class="ev-account-label"><span class="ev-account-voice">Artist B, in their own words<\/span> · context on: <a href="\/practitioner\/artist-a"[^>]*>Artist A<\/a> → collaborates with → <a href="\/practitioner\/artist-b"/);
      assert.match(sec, /<span class="ev-account-voice"><a href="\/practitioner\/artist-a"[^>]*>Artist A<\/a>, in their own words<\/span> · contests:/);
      assert.match(sec, /by @artistb · 27 Oct 2026/);
      assert.doesNotMatch(sec, /Pending context|Withdrawn context/);
    }
  } finally {
    server.close();
  }
});

it("accounts: escaping, sources, anonymity and withheld words on the page; long texts fold; many accounts fold", async () => {
  const { db, signal } = setup();
  signal("project:glitch-show", "A Critic", "2026-10-27T10:00:00Z", `Reading "one"`, "<script>alert(1)</script> & more", { url: "https://www.critic.example/essay?a=1&b=2" });
  signal("project:glitch-show", "Secret Name", "2026-10-28T09:00:00Z", "Testimony", "I was there.", { attribution: "anonymous" });
  signal("project:glitch-show", "Archive Desk", "2026-10-29T09:00:00Z", "Private title", "Private words.", { scope: "structural_only", url: "https://private.example" });
  signal("project:glitch-show", "Archive Desk", "2026-10-30T09:00:00Z", "Long", `${"word ".repeat(300)}END`);
  for (let i = 0; i < 9; i++) signal("project:glitch-show", "Archive Desk", `2026-11-0${i + 1}T09:00:00Z`, `Day ${i + 1}`, `Note ${i + 1}.`);

  const app = express();
  app.use(pages);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const page = await (await fetch(`${base}/project/glitch-show`)).text();
    const overlay = ((await (await fetch(`${base}/api/entity?id=${encodeURIComponent("project:glitch-show")}`)).json()) as any).html as string;
    for (const html of [page, overlay]) {
      const sec = html.slice(html.indexOf('id="ev-accounts"'));
      assert.match(sec, /\/13<\/span>/);
      assert.match(sec, /Reading &quot;one&quot;/);
      assert.match(sec, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; more/);
      assert.doesNotMatch(sec, /<script>alert/);
      assert.match(sec, /by A Critic · 27 Oct 2026 · <a href="https:\/\/www\.critic\.example\/essay\?a=1&amp;b=2" target="_blank" rel="noopener">critic\.example ↗<\/a>/);
      assert.match(sec, /<p class="ev-account-by">anonymous · 28 Oct 2026<\/p>/);
      assert.doesNotMatch(sec, /Secret Name/);
      assert.doesNotMatch(sec, /Private title|Private words|private\.example/);
      assert.match(sec, /kept the words of this account off the public page/);
      assert.match(sec, /<details class="ev-account-more"><summary>more<\/summary>.*END/s);
      assert.match(sec, /<details class="ev-accounts-rest"><summary>3 more, in the same order<\/summary>/);
      assert.ok(sec.indexOf("Day 9") > sec.indexOf("ev-accounts-rest"), "the latest stay in order, behind more");
    }
    // a node with nothing written about it has no section
    assert.doesNotMatch(await (await fetch(`${base}/practitioner/artist-a`)).text(), /id="ev-accounts"/);
  } finally {
    server.close();
  }
});
