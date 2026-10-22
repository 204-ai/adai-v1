// Issue #80, parts 3 and 4: any contributor's labelled reading of one live
// relation ("a reading by X", never the subject), and the DOCUMENTS edge type
// (publication → project / artwork).

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { gunzipSync } from "node:zlib";

process.env.SESSION_SECRET = "test-secret-at-least-16-chars";
process.env.MAIL_TRANSPORT = "stdout";
process.env.ADMIN_EMAILS = "curator@adai.test";
delete process.env.ADMIN_NOTIFY_EMAILS;

const { initDb } = await import("../src/db.js");
const { default: claim } = await import("../src/routes/claim.js");
const { default: pages } = await import("../src/routes/pages.js");
const { default: api } = await import("../src/routes/api.js");
const { default: contributorApi } = await import("../src/routes/contributor-api.js");
const { mintToken } = await import("../src/utils/token-mint.js");
const { ensureContributorForEmail, issueSession, cookieHeader } = await import("../src/intake/auth.js");
const { accountsFor } = await import("../src/entity/accounts.js");
const { publicNotesFor } = await import("../src/claim/notes.js");
const { buildLog } = await import("../src/claim/log.js");
const { nodeHistory } = await import("../src/utils/history.js");
const { checkDirection, SUGGESTABLE_EDGE_TYPES, EDGE_DIRECTIONS } = await import("../src/intake/candidate.js");

function setup() {
  const db = initDb(":memory:");
  const node = (id: string, type: string, name: string, meta: any = {}) =>
    db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, 't')").run(id, type, name, id.split(":")[1]!, JSON.stringify(meta));
  node("artwork:glitch-one", "artwork", "Glitch One");
  node("project:glitch-show", "project", "GLITCH Show");
  node("practitioner:artist-a", "practitioner", "Artist A", { claimed: { handle: "artista", by: [] } });
  node("publication:glitch-catalogue", "publication", "GLITCH Catalogue");
  const edge = (s: string, t: string, type: string, by = "test") =>
    db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, created_by) VALUES (?, ?, ?, ?, ?)").run(`${s}--${type}--${t}--${by}`, s, t, type, by);
  edge("artwork:glitch-one", "project:glitch-show", "EXHIBITED_AT");
  edge("artwork:glitch-one", "practitioner:artist-a", "CREATED_BY");
  edge("artwork:glitch-one", "project:glitch-show", "VISUALLY_AFFINE", "embedding-multimodal-v1");
  const critic = mintToken(db, { contributorName: "A Critic", createIfMissing: true, tier: "auto" });
  const newcomer = mintToken(db, { contributorName: "New Voice", createIfMissing: true, tier: "probationary" });
  const admin = mintToken(db, { contributorName: "Op", createIfMissing: true, tier: "auto", scope: "admin" });
  const shy = mintToken(db, { contributorName: "Secret Reader", createIfMissing: true, tier: "auto" });
  // Artist A claims their page and holds a token too
  const artist = mintToken(db, { contributorName: "Artist A", createIfMissing: true, tier: "auto" });
  db.prepare("INSERT INTO node_claims (id, node_id, contributor_id, status, via) VALUES ('clm_a', 'practitioner:artist-a', ?, 'approved', 'invite')").run(artist.contributor_id);
  return { db, edge, critic, newcomer, admin, shy, artist };
}

async function serve(db: any) {
  const app = express();
  app.use(express.json());
  app.use(claim); app.use(pages); app.use(api); app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, auth?: { token?: string; cookie?: string } | null, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth?.token) headers.authorization = `Bearer ${auth.token}`;
    if (auth?.cookie) headers.cookie = auth.cookie;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text };
  };
  void db;
  return { server, base, call };
}

const REL = { source_id: "artwork:glitch-one", edge_type: "EXHIBITED_AT", target_id: "project:glitch-show" };

it("readings: any contributor, on a live relation, shown on both ends as 'a reading by X' — never the subject", async () => {
  const { db, critic, artist } = setup();
  const { server, call } = await serve(db);
  try {
    let r = await call("POST", "/api/v1/readings", { token: critic.raw_token }, {
      relation: REL, note: "Shown as a record of <failure>, not a glitch aesthetic.", source_url: "https://www.critic.example/essay",
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.status, "live");
    assert.ok(r.json.signal_id && r.json.intake_id);
    const criticSignal = r.json.signal_id;
    // the authenticated author is recorded; the queue row is a 'reading'
    assert.equal((db.prepare("SELECT contributor_id FROM signal_authors WHERE signal_id = ?").get(criticSignal) as any).contributor_id, critic.contributor_id);
    assert.equal((db.prepare("SELECT kind, status FROM intake_queue WHERE id = ?").get(r.json.intake_id) as any).kind, "reading");

    // the claimant of one end writes a reading too: still a reading, not the subject
    const rel2 = { source_id: "artwork:glitch-one", edge_type: "CREATED_BY", target_id: "practitioner:artist-a" };
    r = await call("POST", "/api/v1/readings", { token: artist.raw_token }, { relation: rel2, note: "I read my own work as a diary." });
    assert.equal(r.status, 201);
    const n = publicNotesFor(db, "practitioner:artist-a").find((x) => x.kind === "reading")!;
    assert.equal(n.subject_now, false);
    assert.equal(n.handle, null);

    for (const path of ["/artwork/glitch-one", "/project/glitch-show"]) {
      const html = (await call("GET", path)).text;
      assert.match(html, /class="ev-rel-note ev-rel-note--reading"[^>]*><span class="ev-rel-note-label">a reading by A Critic:<\/span> “Shown as a record of &lt;failure&gt;, not a glitch aesthetic\.”/, `${path}: on the relation row`);
      assert.match(html, /critic\.example ↗/, `${path}: its source`);
      assert.match(html, /a reading of: /, `${path}: in the accounts`);
      assert.match(html, /a reading by A Critic/);
    }
    // the artist's works have their own section, so on their page it is in the accounts; on the work's, on the row
    const a = (await call("GET", "/practitioner/artist-a")).text;
    assert.match(a, /<p class="ev-account-by">a reading by Artist A/);
    assert.match(a, /I read my own work as a diary\./);
    assert.match((await call("GET", "/artwork/glitch-one")).text, /a reading by Artist A:<\/span> “I read my own work as a diary\.”/);
    assert.doesNotMatch(a, /in their own words/, "a reading is never the subject's voice");
    assert.doesNotMatch(a, /a reading by @artista/, "never under the page's handle");
    const acc = accountsFor(db, "practitioner:artist-a").find((x) => x.kind === "reading")!;
    assert.equal(acc.subject, false);
    assert.equal(acc.speaking_for, null);
    assert.equal(acc.account_type, "reading");
    assert.equal(acc.by, "Artist A");

    // refused: a relation that is not live, a derived one, the same words twice, too long, a bad source
    assert.equal((await call("POST", "/api/v1/readings", { token: critic.raw_token }, { relation: { ...REL, edge_type: "HELD_BY" }, note: "x" })).status, 404);
    assert.equal((await call("POST", "/api/v1/readings", { token: critic.raw_token }, { relation: { ...REL, edge_type: "VISUALLY_AFFINE" }, note: "x" })).status, 404);
    assert.equal((await call("POST", "/api/v1/readings", { token: critic.raw_token }, { relation: REL, note: "Shown as a record of <failure>, not a glitch aesthetic." })).json.error, "already_read");
    assert.equal((await call("POST", "/api/v1/readings", { token: critic.raw_token }, { relation: REL, note: "x".repeat(2001) })).status, 400);
    assert.equal((await call("POST", "/api/v1/readings", { token: critic.raw_token }, { relation: REL, note: "y", source_url: "javascript:alert(1)" })).json.error, "bad_source_url");
    assert.equal((await call("POST", "/api/v1/readings", { token: critic.raw_token }, { relation: REL, note: "y", batch_id: "bad id!" })).status, 400);
    assert.equal((await call("POST", "/api/v1/readings", null, { relation: REL, note: "y" })).status, 401);

    // history lists it as a reading; withdrawal by its author only
    const hist = nodeHistory(db, "project:glitch-show")!.events.filter((e: any) => e.kind === "note");
    assert.deepEqual(hist.map((e: any) => e.note_kind), ["reading"]);
    assert.match((await call("GET", "/project/glitch-show/history")).text, /<strong>a reading<\/strong>/);
    assert.equal((await call("POST", `/api/v1/readings/${criticSignal}/withdraw`, { token: artist.raw_token })).status, 403);
    assert.equal((await call("POST", `/api/v1/readings/${criticSignal}/withdraw`, { token: critic.raw_token })).status, 200);
    assert.doesNotMatch((await call("GET", "/project/glitch-show")).text, /a reading by A Critic/);
  } finally {
    server.close();
  }
});

it("readings: probationary → /review?kind=reading; consent respected; taken down by the admin correction model", async () => {
  const { db, newcomer, admin, shy, critic, edge } = setup();
  const { server, call } = await serve(db);
  const curator = ensureContributorForEmail(db, { email: "curator@adai.test", name: "Cura", invite: true });
  const cur = { cookie: cookieHeader(issueSession(db, curator.id).signed, 100, false).split(";")[0]! };
  try {
    let r = await call("POST", "/api/v1/readings", { token: newcomer.raw_token }, { relation: REL, note: "A probationary reading." });
    assert.equal(r.status, 201);
    assert.equal(r.json.status, "pending");
    const pendingQueue = r.json.intake_id;
    assert.doesNotMatch((await call("GET", "/project/glitch-show")).text, /probationary reading/, "not public while pending");
    const review = await call("GET", "/review?kind=reading", cur);
    assert.equal(review.status, 200);
    assert.match(review.text, /Readings \(1\)/);
    assert.match(review.text, /A reading by New Voice/);
    assert.match(review.text, /Publish reading/);
    const listed = await call("GET", "/api/v1/review?kind=reading", { token: admin.raw_token });
    assert.equal(listed.json.items?.length ?? listed.json.length ?? 0, 1);
    assert.equal((await call("POST", `/api/v1/review/${pendingQueue}/approve`, { token: admin.raw_token }, {})).status, 200);
    assert.match((await call("GET", "/project/glitch-show")).text, /a reading by New Voice:<\/span> “A probationary reading\.”/);

    // anonymous: "someone", and nothing that names them anywhere in the page or the claimant's log
    r = await call("POST", "/api/v1/readings", { token: shy.raw_token }, { relation: REL, note: "An unsigned reading.", consent_attribution: "anonymous" });
    assert.equal(r.status, 201);
    const page = (await call("GET", "/project/glitch-show")).text;
    assert.match(page, /a reading by someone:<\/span> “An unsigned reading\.”/);
    assert.doesNotMatch(page, /Secret Reader/);
    const log = JSON.stringify(buildLog(db, (db.prepare("SELECT contributor_id FROM node_claims WHERE id = 'clm_a'").get() as any).contributor_id, "practitioner:artist-a"));
    assert.doesNotMatch(log, /Secret Reader/);
    const anon = publicNotesFor(db, "project:glitch-show").find((n) => n.note === "An unsigned reading.")!;
    assert.equal(anon.contributor_id, "", "no contributor id on a public anonymous note");
    assert.equal(anon.node_id, "");

    // structural_only: the fact stays, the words do not
    r = await call("POST", "/api/v1/readings", { token: critic.raw_token }, { relation: REL, note: "Words kept private.", consent_scope: "structural_only", source_url: "https://private.example/x" });
    const withheldSig = r.json.signal_id;
    const p2 = (await call("GET", "/project/glitch-show")).text;
    assert.doesNotMatch(p2, /Words kept private|private\.example/);
    assert.match(p2, /a reading by A Critic:<\/span> <em>words kept off the public page<\/em>/);

    // revoke the signal → gone everywhere public; history keeps its place, not its words
    assert.equal((await call("POST", `/api/v1/signals/${withheldSig}/revoke`, { token: admin.raw_token }, { reason: "asked" })).status, 200);
    assert.doesNotMatch((await call("GET", "/project/glitch-show")).text, /a reading by A Critic/);

    // batch rollback ends what the batch wrote
    r = await call("POST", "/api/v1/readings", { token: critic.raw_token }, { relation: REL, note: "A batched reading.", batch_id: "glitch-readings" });
    assert.match((await call("GET", "/project/glitch-show")).text, /A batched reading/);
    assert.equal((await call("POST", "/api/v1/batches/glitch-readings/retire", { token: admin.raw_token }, { reason: "test" })).status, 200);
    assert.doesNotMatch((await call("GET", "/project/glitch-show")).text, /A batched reading/);
    const batched = nodeHistory(db, "project:glitch-show")!.events.find((e: any) => e.kind === "note" && e.source?.batch_id === "glitch-readings") as any;
    assert.ok(batched, "a revoked reading keeps its place in the history");
    assert.equal(batched.note, "", "… not its words");
    assert.doesNotMatch((await call("GET", "/project/glitch-show/history")).text, /A batched reading/);
    // the record page (curators only) sees it in the audit
    const record = (await call("GET", "/record/project/glitch-show", cur)).text;
    assert.match(record, /reading · live/);
    assert.match(record, /a reading — never shown as the subject/);

    // the relation ends → its readings leave the page (and the accounts)
    assert.ok(accountsFor(db, "project:glitch-show").some((a) => a.kind === "reading"));
    const nodeRetire = await call("POST", `/api/v1/nodes/${encodeURIComponent("artwork:glitch-one")}/retire`, { token: admin.raw_token }, { reason: "duplicate" });
    assert.equal(nodeRetire.status, 200);
    assert.equal(accountsFor(db, "project:glitch-show").filter((a) => a.kind === "reading").length, 0);
    assert.doesNotMatch((await call("GET", "/project/glitch-show")).text, /a reading by/);
    // and a retired end refuses new readings
    edge("artwork:glitch-one", "project:glitch-show", "EXHIBITED_AT", "again");
    assert.equal((await call("POST", "/api/v1/readings", { token: critic.raw_token }, { relation: REL, note: "late" })).status, 404);
  } finally {
    server.close();
  }
});

it("readings from the relation row: '+ reading' only for a signed-in viewer; POST /api/readings by session", async () => {
  const { db } = setup();
  const { server, call } = await serve(db);
  const eve = ensureContributorForEmail(db, { email: "eve@x.org", name: "Eve", invite: true, tier: "reviewed" });
  const cookie = cookieHeader(issueSession(db, eve.id).signed, 100, false).split(";")[0]!;
  try {
    const out = (await call("GET", "/project/glitch-show")).text;
    assert.doesNotMatch(out, /class="ev-rel-read"/, "signed out: no button");
    const inn = (await call("GET", "/project/glitch-show", { cookie })).text;
    assert.match(inn, /<button type="button" class="ev-rel-read" data-source-id="artwork:glitch-one" data-edge-type="EXHIBITED_AT" data-target-id="project:glitch-show"/);
    const overlay = (await call("GET", `/api/entity?id=${encodeURIComponent("project:glitch-show")}`, { cookie })).json.html;
    assert.match(overlay, /class="ev-rel-read"/, "the /field overlay is the same article");
    assert.equal((await call("POST", "/api/readings", null, { relation: REL, note: "x" })).status, 401);
    const r = await call("POST", "/api/readings", { cookie }, { relation: REL, note: "Seen from the room." });
    assert.equal(r.status, 201);
    assert.equal(r.json.status, "live");
    assert.match((await call("GET", "/artwork/glitch-one")).text, /a reading by Eve:<\/span> “Seen from the room\.”/);
    assert.equal((await call("POST", `/api/readings/${r.json.signal_id}/withdraw`, { cookie }, {})).status, 200);
    assert.doesNotMatch((await call("GET", "/artwork/glitch-one")).text, /Seen from the room/);
  } finally {
    server.close();
  }
});

it("the entity-view client wires the reading form and the asset version moved", async () => {
  const fs = await import("node:fs/promises");
  const js = await fs.readFile("public/field/js-interface/entity-view.js", "utf8");
  assert.match(js, /function handleReading\(e\)/);
  assert.match(js, /fetch\('\/api\/readings'/);
  const html = await fs.readFile("public/field/index.html", "utf8");
  const { ENTITY_ASSET_VERSION } = await import("../src/entity/page.js");
  assert.ok(html.includes(`entity-view.js?v=${ENTITY_ASSET_VERSION}`));
  assert.ok(html.includes(`entity-view.css?v=${ENTITY_ASSET_VERSION}`));
});

it("DOCUMENTS: publication → project / artwork, everywhere edge types are listed", async () => {
  assert.ok((SUGGESTABLE_EDGE_TYPES as readonly string[]).includes("DOCUMENTS"));
  assert.deepEqual(EDGE_DIRECTIONS.DOCUMENTS, { source: ["publication"], target: ["project", "artwork"] });
  const typeOf = (ref: string) => ref.split(":")[0]!;
  checkDirection({ source: "publication:c", target: "project:s", edge_type: "DOCUMENTS" }, typeOf);
  checkDirection({ source: "publication:c", target: "artwork:w", edge_type: "DOCUMENTS" }, typeOf);
  assert.throws(() => checkDirection({ source: "project:s", target: "publication:c", edge_type: "DOCUMENTS" }, typeOf), /Swap source and target/);
  assert.throws(() => checkDirection({ source: "publication:c", target: "practitioner:p", edge_type: "DOCUMENTS" }, typeOf));

  const fs = await import("node:fs/promises");
  const read = (p: string) => fs.readFile(p, "utf8");
  assert.match(await read("worker/src/tools.ts"), /"COLLABORATES_WITH", "DOCUMENTS"\]/);
  assert.match(await read("worker/src/candidate.ts"), /"DOCUMENTS"/);
  assert.match(await read("worker/src/prompt.ts"), /\| DOCUMENTS +\| publication -> project\/artwork/);
  assert.match(await read("SKILL.md"), /\| `DOCUMENTS` \| publication → project \/ artwork \|/);
  assert.match(await read("CLAUDE.md"), /\*\*DOCUMENTS\*\*/);
  assert.match(await read("docs/URL-INTAKE-SPEC.md"), /\| DOCUMENTS \| publication -> project\/artwork \|/);
  assert.match(await read("public/field/js-interface/edge-type-colors.js"), /DOCUMENTS: +\{ hex:/);
  assert.match(await read("public/field/js-interface/graph-field.js"), /DOCUMENTS: +\{ dash:/);

  const { db, critic } = setup();
  const { server, call, base } = await serve(db);
  try {
    let r = await call("POST", "/api/v1/edges", { token: critic.raw_token }, { source_id: "publication:glitch-catalogue", target_id: "project:glitch-show", edge_type: "DOCUMENTS" });
    assert.equal(r.status, 200);
    assert.ok(!(r.json.warnings ?? []).some((w: string) => /uncurated|direction/.test(w)), JSON.stringify(r.json.warnings));
    r = await call("POST", "/api/v1/edges", { token: critic.raw_token }, { source_id: "project:glitch-show", target_id: "publication:glitch-catalogue", edge_type: "DOCUMENTS" });
    assert.ok((r.json.warnings ?? []).some((w: string) => /direction: .*Swap/.test(w)), "a swapped one is warned about");
    // supersede the swapped one so it doesn't muddle the pages below
    db.prepare("UPDATE edges SET valid_until = '2026-10-24T00:00:00Z' WHERE source_id = 'project:glitch-show' AND edge_type = 'DOCUMENTS'").run();

    const show = (await call("GET", "/project/glitch-show")).text;
    assert.match(show, /data-group="DOCUMENTS:in"[\s\S]*?\/\/ documented in[\s\S]*?GLITCH Catalogue/);
    const cat = (await call("GET", "/publication/glitch-catalogue")).text;
    assert.match(cat, /data-group="DOCUMENTS:out"[\s\S]*?\/\/ documents[\s\S]*?GLITCH Show/);

    // /field stamp parity holds with the new type (the counting clauses are type-agnostic)
    const stats = await (await fetch(`${base}/api/stats`)).json() as any;
    const raw = Buffer.from(await (await fetch(`${base}/api/graph/stream`, { headers: { "accept-encoding": "identity" } })).arrayBuffer());
    const lines = (raw[0] === 0x1f ? gunzipSync(raw) : raw).toString().trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].meta.stamp, `${stats.total_nodes}:${stats.curated_edges}`);
    assert.ok(lines.some((l) => l.e && l.e.type === "DOCUMENTS"));
  } finally {
    server.close();
  }
});
