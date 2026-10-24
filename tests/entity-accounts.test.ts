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
  // the authenticated author, as insertSignal records it (signal_authors), by name
  const ids: Record<string, string> = { "Archive Desk": "c-archive", "A Critic": "c-critic", "Artist B": "c-b", "Artist A": "c-a", "Secret Name": "c-anon", "Catalogue Team": "c-cat" };
  const signal = (target: string, by: string, at: string, title: string | null, content: string, extra: Partial<{ status: string; scope: string; attribution: string; url: string; queue: string; author: string | null; type: string; ops: any[] }> = {}) => {
    const id = `sig-${++n}`;
    db.prepare("INSERT INTO signals (id, title, content, submitted_by, created_at, status, consent_scope, consent_attribution, source_url, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, title, content, by, at, extra.status ?? "active", extra.scope ?? "full_commons", extra.attribution ?? "attributed", extra.url ?? null, extra.type ?? "contribution");
    db.prepare("INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status, kind, proposed_nodes) VALUES (?, ?, ?, ?, 'auto', ?, 'human_signal', ?)")
      .run(`q-${id}`, id, target, by, extra.queue ?? "approved", extra.ops ? JSON.stringify(extra.ops) : null);
    const author = extra.author === undefined ? ids[by] : extra.author;
    if (author) db.prepare("INSERT INTO signal_authors (signal_id, contributor_id) VALUES (?, ?)").run(id, author);
    return id;
  };
  return { db, signal };
}

const serve = async (...routers: any[]) => {
  const app = express();
  app.use(express.json());
  for (const r of routers) app.use(r);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
};
const both = async (base: string, path: string, id: string) => {
  const page = await (await fetch(`${base}${path}`)).text();
  const overlay = ((await (await fetch(`${base}/api/entity?id=${encodeURIComponent(id)}`)).json()) as any).html as string;
  return [page, overlay];
};

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
      assert.match(sec, /<button type="button" class="ev-accounts-next" data-node-id="project:glitch-show" data-after="2026-11-06T09:00:00Z\|sig-10">3 more, in the same order<\/button>/);
      assert.doesNotMatch(sec, /Day 7/, "the rest is not rendered with the page");
    }
    // a node with nothing written about it has no section
    assert.doesNotMatch(await (await fetch(`${base}/practitioner/artist-a`)).text(), /id="ev-accounts"/);
  } finally {
    server.close();
  }
});

// ---- review fixes (#80 review of 3e3999f) --------------------------------------------------

it("impersonation: the public form cannot speak as the subject or borrow a linked byline", async () => {
  const { db, signal } = setup();
  const { default: api } = await import("../src/routes/api.js");
  const { server, base } = await serve(pages, api);
  try {
    // anyone may type a claimant's name into POST /api/contribute
    for (const [target, name] of [["practitioner:artist-b", "Artist B"], ["publication:catalogue", "Catalogue Team"]]) {
      const r = await fetch(`${base}/api/contribute`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_node: target, title: "Fake", content: `Pretending to be ${name}.`, contributor_name: name }) });
      assert.ok(r.status < 400, String(r.status));
    }
    // the form never inherits a tier by name: both wait in review, unshown
    for (const id of ["practitioner:artist-b", "publication:catalogue"]) assert.equal(accountsFor(db, id).find((a) => a.title === "Fake"), undefined);
    const { approveIntakeItem } = await import("../src/utils/review.js");
    for (const q of db.prepare("SELECT id FROM intake_queue WHERE status = 'pending'").all() as any[]) approveIntakeItem(db, q.id, "curator");
    for (const id of ["practitioner:artist-b", "publication:catalogue"]) {
      const fake = accountsFor(db, id).find((a) => a.title === "Fake");
      // approved by a curator, it is shown — with no standing
      assert.ok(fake, "shown once approved");
      assert.equal(fake.subject, false);
      assert.equal(fake.verified, false);
      assert.equal(fake.by_node, null);
    }
    const [page, overlay] = await both(base, "/practitioner/artist-b", "practitioner:artist-b");
    for (const html of [page, overlay]) {
      const sec = html.slice(html.indexOf('id="ev-accounts"'));
      assert.doesNotMatch(sec, /in their own words/);
    }
    // two contributors with one name: only the claimant's own (proven) writing is the subject
    db.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES ('c-b2', 'Artist B', 'auto')").run();
    signal("practitioner:artist-b", "Artist B", "2026-10-26T09:00:00Z", "Namesake", "Not the artist.", { author: "c-b2" });
    signal("practitioner:artist-b", "Artist B", "2026-10-26T10:00:00Z", "The artist", "Really the artist.", { author: "c-b" });
    const list = accountsFor(db, "practitioner:artist-b");
    assert.equal(list.find((a) => a.title === "Namesake")!.subject, false);
    assert.equal(list.find((a) => a.title === "The artist")!.subject, true);
    // a token standing for the catalogue speaks for it only when the write is proven
    signal("publication:catalogue", "Catalogue Team", "2026-10-26T12:00:00Z", "Colophon", "Proven.", { author: "c-cat" });
    signal("publication:catalogue", "Catalogue Team", "2026-10-26T13:00:00Z", "Unproven", "No author row.", { author: null });
    const cat = accountsFor(db, "publication:catalogue");
    assert.equal(cat.find((a) => a.title === "Colophon")!.subject, true);
    assert.equal(cat.find((a) => a.title === "Colophon")!.by_node?.id, "publication:catalogue");
    const un = cat.find((a) => a.title === "Unproven")!;
    assert.deepEqual([un.subject, un.by_node, un.by], [false, null, "Catalogue Team"]);
  } finally {
    server.close();
  }
});

it("ended claims: no longer the subject, on the accounts and the relation rows; withdrawn notes gone", async () => {
  const { db, signal } = setup();
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES ('e1', 'practitioner:artist-a', 'practitioner:artist-b', 'COLLABORATES_WITH', 't', '2026-10-26T00:00:00Z')").run();
  const note = db.prepare(`INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, node_id, contributor_id, note, state, created_at)
    VALUES (?, ?, 'practitioner:artist-a', 'COLLABORATES_WITH', 'practitioner:artist-b', ?, ?, ?, ?, ?)`);
  const sig = db.prepare("INSERT INTO signals (id, title, content, submitted_by, created_at) VALUES (?, 'note', '{}', ?, ?)");
  sig.run("n1", "Artist B", "2026-10-27T08:00:00Z");
  note.run("n1", "context", "practitioner:artist-b", "c-b", "We made it together.", "live", "2026-10-27T08:00:00Z");
  sig.run("n2", "Artist B", "2026-10-27T09:00:00Z");
  note.run("n2", "contest", "practitioner:artist-b", "c-b", "Withdrawn words.", "withdrawn", "2026-10-27T09:00:00Z");
  signal("practitioner:artist-b", "Artist B", "2026-10-26T09:00:00Z", "Intention", "Mine.");
  db.prepare("UPDATE node_claims SET status = 'withdrawn' WHERE contributor_id = 'c-b'").run();

  const list = accountsFor(db, "practitioner:artist-b");
  assert.ok(list.every((a) => !a.subject && !a.speaking_for));
  assert.equal(list.find((a) => a.signal_id === "n1")!.by, "Artist B", "the writer's name, not the node's handle");
  const { server, base } = await serve(pages);
  try {
    const [page, overlay] = await both(base, "/practitioner/artist-b", "practitioner:artist-b");
    for (const html of [page, overlay]) {
      assert.doesNotMatch(html, /in their own words/);
      assert.doesNotMatch(html, /Withdrawn words/);
      assert.match(html, /We made it together\./);
      assert.doesNotMatch(html, /by the subject/);
    }
  } finally {
    server.close();
  }
});

it("what is an account: decided by source and operation, not by how the text starts", () => {
  const { db, signal } = setup();
  const T = "project:glitch-show";
  signal(T, "A Critic", "2026-10-26T01:00:00Z", "Bracketed", "[draft] notes from the opening, {loosely} kept.");
  signal(T, "A Critic", "2026-10-26T02:00:00Z", "API body", `[{"source_id":"x","edge_type":"HELD_BY"}]`);
  signal(T, "A Critic", "2026-10-26T03:00:00Z", "Object body", `{"note":"structured"}`);
  signal(T, "Archive Desk", "2026-10-26T04:00:00Z", "URL intake: ended", "The site no longer shows this relation.", { type: "api_url_intake" });
  signal(T, "Archive Desk", "2026-10-26T05:00:00Z", "Correction", "Admin note about a merge.", { type: "api_admin" });
  signal(T, "Archive Desk", "2026-10-26T06:00:00Z", "Patch", "Updated the dates.", { ops: [{ op: "patch_node", node_id: T, metadata: { year: "2026" } }] });
  assert.deepEqual(accountsFor(db, T).map((a) => a.title), ["Bracketed"]);
});

it("paging: a stable (created_at, id) cursor through GET /api/entity/accounts, ties included", async () => {
  const { db, signal } = setup();
  const T = "project:glitch-show";
  for (let i = 1; i <= 12; i++) signal(T, "Archive Desk", `2026-11-${String(i).padStart(2, "0")}T09:00:00Z`, `Day ${i}`, `Note ${i}.`);
  for (const t of ["Tie A", "Tie B", "Tie C"]) signal(T, "A Critic", "2026-11-05T09:00:00Z", t, `${t}.`);
  const { server, base } = await serve(pages);
  try {
    const page = await (await fetch(`${base}/project/glitch-show`)).text();
    const titles = [...page.matchAll(/<p class="ev-account-title">([^<]+)<\/p>/g)].map((m) => m[1]);
    assert.equal(titles.length, 10);
    let after = /data-after="([^"]+)"/.exec(page)![1];
    for (;;) {
      const j = (await (await fetch(`${base}/api/entity/accounts?id=${encodeURIComponent(T)}&after=${encodeURIComponent(after)}&limit=2`)).json()) as any;
      titles.push(...[...String(j.html).matchAll(/<p class="ev-account-title">([^<]+)<\/p>/g)].map((m) => m[1]));
      if (!j.next) break;
      after = j.next;
    }
    assert.equal(titles.length, 15);
    assert.equal(new Set(titles).size, 15, "no duplicates");
    assert.deepEqual(titles, accountsFor(db, T).map((a) => a.title), "the same order as the whole list");
    assert.equal((await fetch(`${base}/api/entity/accounts?id=nope`)).status, 404);
  } finally {
    server.close();
  }
});

it("relation rows: one public-note filter — anonymous, structural_only and revoked handled on every surface", async () => {
  const { db } = setup();
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES ('e1', 'practitioner:artist-a', 'practitioner:artist-b', 'COLLABORATES_WITH', 't', '2026-10-26T00:00:00Z')").run();
  const note = db.prepare(`INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, node_id, contributor_id, note, state, created_at)
    VALUES (?, ?, 'practitioner:artist-a', 'COLLABORATES_WITH', 'practitioner:artist-b', 'practitioner:artist-a', 'c-a', ?, ?, ?)`);
  const sig = db.prepare("INSERT INTO signals (id, title, content, submitted_by, created_at, consent_attribution, consent_scope, status) VALUES (?, 'note', '{}', 'Artist A', ?, ?, ?, ?)");
  sig.run("an", "2026-10-27T08:00:00Z", "anonymous", "full_commons", "active");
  note.run("an", "context", "Anonymous words.", "live", "2026-10-27T08:00:00Z");
  sig.run("so", "2026-10-27T09:00:00Z", "attributed", "structural_only", "active");
  note.run("so", "contest", "Structural words.", "open", "2026-10-27T09:00:00Z");
  sig.run("rv", "2026-10-27T10:00:00Z", "attributed", "full_commons", "revoked");
  note.run("rv", "context", "Revoked words.", "live", "2026-10-27T10:00:00Z");
  const ob = db.prepare(`INSERT INTO relation_notes (signal_id, kind, queue_ref, node_id, contributor_id, note, state, created_at)
    VALUES (?, 'objection', 'q-x', 'practitioner:artist-b', 'c-b', ?, ?, ?)`);
  sig.run("ob-open", "2026-10-27T11:00:00Z", "attributed", "full_commons", "active");
  ob.run("ob-open", "Open objection words.", "open", "2026-10-27T11:00:00Z");
  sig.run("ob-done", "2026-10-27T12:00:00Z", "attributed", "full_commons", "active");
  ob.run("ob-done", "Settled objection words.", "settled", "2026-10-27T12:00:00Z");
  const { server, base } = await serve(pages);
  try {
    const [page, overlay] = await both(base, "/practitioner/artist-b", "practitioner:artist-b");
    const record = await (await fetch(`${base}/record/practitioner/artist-b`)).text();
    for (const html of [page, overlay, record]) {
      assert.match(html, /Anonymous words\./, "an anonymous note keeps its words");
      assert.doesNotMatch(html, /Structural words|Revoked words/);
      // the anonymous note names no one
      assert.match(html, /“Anonymous words\.” — someone/);
    }
    for (const html of [page, overlay]) {
      assert.match(html, /kept off the public page/);
    }
  } finally {
    server.close();
  }
});

// ---- second review round (#80 review of 948317c) ---------------------------------------------

it("an ended claimant's note never borrows the node's handle, while another claimant holds it", async () => {
  const { db } = setup();
  db.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES ('c-b2', 'Second Claimant', 'auto')").run();
  db.prepare("INSERT INTO node_claims (id, node_id, contributor_id, status, via) VALUES ('clm_b2', 'practitioner:artist-b', 'c-b2', 'approved', 'invite')").run();
  db.prepare("UPDATE node_claims SET status = 'withdrawn' WHERE id = 'clm_b'").run();
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES ('e1', 'practitioner:artist-a', 'practitioner:artist-b', 'COLLABORATES_WITH', 't', '2026-10-26T00:00:00Z')").run();
  db.prepare("INSERT INTO signals (id, title, content, submitted_by, created_at) VALUES ('nb', 'note', '{}', 'Artist B', '2026-10-27T08:00:00Z')").run();
  db.prepare(`INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, node_id, contributor_id, note, state, created_at)
    VALUES ('nb', 'contest', 'practitioner:artist-a', 'COLLABORATES_WITH', 'practitioner:artist-b', 'practitioner:artist-b', 'c-b', 'Old claimant speaking.', 'open', '2026-10-27T08:00:00Z')`).run();
  const { server, base } = await serve(pages);
  try {
    const [page, overlay] = await both(base, "/practitioner/artist-b", "practitioner:artist-b");
    const record = await (await fetch(`${base}/record/practitioner/artist-b`)).text();
    for (const html of [page, overlay, record]) {
      assert.match(html, /⚑ contested by Artist B: Old claimant speaking\./, "the writer's own name");
      assert.doesNotMatch(html, /@artistb\)?: Old claimant|by the subject \(@artistb\): Old claimant/);
    }
  } finally {
    server.close();
  }
});

it("/record: the public filter for visitors, the full labelled audit view for a curator", async () => {
  process.env.SESSION_SECRET = "test-secret-at-least-16-chars";
  process.env.ADMIN_EMAILS = "curator@adai.test";
  const { ensureContributorForEmail, issueSession, cookieHeader } = await import("../src/intake/auth.js");
  const { db } = setup();
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES ('e1', 'practitioner:artist-a', 'practitioner:artist-b', 'COLLABORATES_WITH', 't', '2026-10-26T00:00:00Z')").run();
  const note = db.prepare(`INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, node_id, contributor_id, note, state, created_at)
    VALUES (?, ?, 'practitioner:artist-a', 'COLLABORATES_WITH', 'practitioner:artist-b', 'practitioner:artist-a', 'c-a', ?, ?, ?)`);
  const sig = db.prepare("INSERT INTO signals (id, title, content, submitted_by, created_at, consent_attribution, consent_scope, status) VALUES (?, 'note', '{}', 'Artist A', ?, ?, ?, ?)");
  sig.run("an", "2026-10-27T08:00:00Z", "anonymous", "full_commons", "active");
  note.run("an", "context", "Anonymous words.", "live", "2026-10-27T08:00:00Z");
  sig.run("so", "2026-10-27T09:00:00Z", "attributed", "structural_only", "active");
  note.run("so", "contest", "Structural words.", "open", "2026-10-27T09:00:00Z");
  sig.run("rv", "2026-10-27T10:00:00Z", "attributed", "full_commons", "revoked");
  note.run("rv", "context", "Revoked words.", "live", "2026-10-27T10:00:00Z");
  const ob = db.prepare(`INSERT INTO relation_notes (signal_id, kind, queue_ref, node_id, contributor_id, note, state, created_at)
    VALUES (?, 'objection', 'q-x', 'practitioner:artist-b', 'c-b', ?, ?, ?)`);
  sig.run("ob-open", "2026-10-27T11:00:00Z", "attributed", "full_commons", "active");
  ob.run("ob-open", "Open objection words.", "open", "2026-10-27T11:00:00Z");
  sig.run("ob-done", "2026-10-27T12:00:00Z", "attributed", "full_commons", "active");
  ob.run("ob-done", "Settled objection words.", "settled", "2026-10-27T12:00:00Z");
  const cur = ensureContributorForEmail(db, { email: "curator@adai.test", name: "Cura", invite: true });
  const cookie = cookieHeader(issueSession(db, cur.id).signed, 100, false).split(";")[0]!;
  const { server, base } = await serve(pages);
  try {
    const visitor = await (await fetch(`${base}/record/practitioner/artist-b`)).text();
    assert.doesNotMatch(visitor, /Structural words|Revoked words|curator audit/);
    assert.match(visitor, /“Anonymous words\.” — someone/);
    const vres = await fetch(`${base}/record/practitioner/artist-b`);
    assert.equal(vres.headers.get("cache-control"), "private, no-store", "never stored by a shared cache, for anyone");
    const cres = await fetch(`${base}/record/practitioner/artist-b`, { headers: { cookie } });
    assert.equal(cres.headers.get("cache-control"), "private, no-store");
    const curator = await cres.text();
    assert.match(curator, /notes — curator audit \(5\)/);
    // objections (node_id + queue_ref only): in the audit, never public
    assert.match(curator, /data-audit-note='ob-open'>.*objection · open.*review item q-x \(from practitioner:artist-b\).*Open objection words\./);
    assert.match(curator, /data-audit-note='ob-done'>.*objection · settled.*Settled objection words\./);
    assert.doesNotMatch(visitor, /objection words/);
    assert.match(curator, /data-audit-note='rv'>.*signal revoked — hidden from the public.*Revoked words\./);
    assert.match(curator, /data-audit-note='an'>.*anonymous — the public sees “someone”.*Artist A.*Anonymous words\./);
    assert.match(curator, /data-audit-note='so'>.*structural only — the public does not see these words.*Structural words\./);
  } finally {
    server.close();
    delete process.env.ADMIN_EMAILS;
  }
});

it("notes page in SQL with the same cursor; totals only on the first page", async () => {
  const { db, signal } = setup();
  const { accountsPage } = await import("../src/entity/accounts.js");
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES ('e1', 'practitioner:artist-a', 'practitioner:artist-b', 'COLLABORATES_WITH', 't', '2026-10-26T00:00:00Z')").run();
  const note = db.prepare(`INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, node_id, contributor_id, note, state, created_at)
    VALUES (?, 'context', 'practitioner:artist-a', 'COLLABORATES_WITH', 'practitioner:artist-b', 'practitioner:artist-b', 'c-b', ?, 'live', ?)`);
  for (let i = 1; i <= 7; i++) {
    db.prepare("INSERT INTO signals (id, title, content, submitted_by, created_at) VALUES (?, 'note', '{}', 'Artist B', ?)").run(`n${i}`, "2026-10-27T08:00:00Z");
    note.run(`n${i}`, `Note ${i}`, "2026-10-27T08:00:00Z"); // all in one second: the id breaks the tie
  }
  for (let i = 1; i <= 5; i++) signal("practitioner:artist-b", "A Critic", "2026-10-27T08:00:00Z", `Reading ${i}`, `Text ${i}.`);
  const seen: string[] = [];
  let p = accountsPage(db, "practitioner:artist-b", { limit: 4 });
  assert.equal(p.total, 12);
  seen.push(...p.accounts.map((a) => a.signal_id));
  while (p.next) {
    p = accountsPage(db, "practitioner:artist-b", { after: p.next, limit: 4 });
    assert.equal(p.total, null);
    seen.push(...p.accounts.map((a) => a.signal_id));
  }
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12);
  assert.deepEqual(seen, [...seen].sort(), "(created_at, id) order across both kinds");
});

it("the signal_authors backfill runs once (a settings flag)", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "adai-80-bf-"));
  try {
    const path = join(dir, "t.db");
    let db = initDb(path);
    assert.ok((db.prepare("SELECT value FROM settings WHERE key = 'signal_authors_backfill'").get() as any)?.value);
    // a note that would qualify, written behind insertSignal's back after the backfill ran
    db.prepare("INSERT INTO relation_notes (signal_id, kind, node_id, contributor_id, note, state) VALUES ('late', 'context', 'x', 'c', 'n', 'live')").run();
    db.close();
    db = initDb(path);
    assert.equal(db.prepare("SELECT 1 FROM signal_authors WHERE signal_id = 'late'").get(), undefined, "not rescanned on the next boot");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
