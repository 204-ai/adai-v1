// Issue #82: the public snapshot. Built from a fixture with private data in
// every risky place; the output bytes (SQLite file and JSON lines) must hold
// none of it, and the file must open as plain SQLite.

import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initDb } from "../src/db.js";
import { buildSnapshot } from "../src/snapshot/build.js";

function fixture() {
  const db = initDb(":memory:");
  const node = db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, ?)");
  node.run("practitioner:artist-a", "practitioner", "Artist A", "artist-a", JSON.stringify({ bio: "Write to artist@studio.test", claimed: { by: ["Artist A"], handle: "artista" } }), "Artist A");
  node.run("artwork:work-1", "artwork", "Work One", "work-1", JSON.stringify({ cdn_image_url: "https://pub.r2.dev/images/ab/ab.jpg" }), "Hidden Person");
  node.run("artwork:retired", "artwork", "Old Work", "retired", JSON.stringify({ retired: true }), "Artist A");
  const con = db.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES (?, ?, 'auto')");
  con.run("c-a", "Artist A");
  con.run("c-hidden", "Hidden Person");
  con.run("c-invitee", "Invitee Never Public");
  const sig = db.prepare(`INSERT INTO signals (id, title, content, source_url, submitted_by, consent_scope, consent_attribution, status, batch_id, processing_trace, provenance_chain, source_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const trace = JSON.stringify({ argv: ["/home/operator/secret-path"], note: "TRACESECRET operator@internal.test" });
  sig.run("s-pub", "Public title", "Public words.", "https://public.example/", "Artist A", "full_commons", "attributed", "active", "batch-public", trace,
    JSON.stringify({ draft_id: "drf_0123456789abcdef", summary: "SUMMARYSECRET", picked_from: { by: "Picker Person" }, page_sha256: "abc", source: "https://public.example/" }), "contribution");
  sig.run("s-struct", "STRUCTTITLE", "STRUCTURALSECRET", "https://structural.secret/", "Artist A", "structural_only", "attributed", "active", null, null, JSON.stringify({ source: "https://structural.secret/page" }), "contribution");
  sig.run("s-anon", "Anon title", "Anonymous words.", null, "Hidden Person", "full_commons", "anonymous", "active", "hidden-batch-of-hidden-person", null, null, "api_edge");
  sig.run("s-revoked", "Revoked title", "REVOKEDSECRET", "https://revoked.secret/", "Artist A", "full_commons", "attributed", "revoked", null, null, null, "contribution");
  sig.run("s-pending", "Pending", "PENDINGSECRET", null, "Artist A", "full_commons", "attributed", "active", null, null, null, "contribution");
  sig.run("s-rejected", "Rejected", "REJECTEDSECRET", null, "Artist A", "full_commons", "attributed", "active", null, null, null, "contribution");
  sig.run("s-objection", "Objection", "OBJECTIONSECRET", null, "Artist A", "full_commons", "attributed", "active", null, null, null, "subject_objection");
  sig.run("s-pnote", "Context", "PENDINGNOTESECRET", null, "Artist A", "full_commons", "attributed", "active", null, null, null, "subject_context");
  sig.run("s-token", "Token", "my key is adai_SECRETPFX1234567", null, "Artist A", "full_commons", "attributed", "active", null, null, null, "contribution");
  const q = db.prepare("INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status, kind) VALUES (?, ?, 'practitioner:artist-a', 'Artist A', 'auto', ?, 'human_signal')");
  q.run("q1", "s-pub", "approved");
  q.run("q2", "s-pending", "pending");
  q.run("q3", "s-rejected", "rejected");
  db.prepare("INSERT INTO relation_notes (signal_id, kind, node_id, contributor_id, note, state) VALUES ('s-objection', 'objection', 'practitioner:artist-a', 'c-a', 'OBJECTIONSECRET', 'open')").run();
  db.prepare("INSERT INTO relation_notes (signal_id, kind, node_id, contributor_id, note, state) VALUES ('s-pnote', 'context', 'practitioner:artist-a', 'c-a', 'PENDINGNOTESECRET', 'pending')").run();
  // an anonymous contributor's edge: its created_by and its id carry the name
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, created_by) VALUES (?, 'artwork:work-1', 'practitioner:artist-a', 'CREATED_BY', 's-anon', 'api-Hidden Person')")
    .run("artwork:work-1--CREATED_BY--practitioner:artist-a--api-Hidden Person");
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, created_by, valid_until, invalidated_by) VALUES ('e-old', 'artwork:work-1', 'practitioner:artist-a', 'INFLUENCES', 's-pub', 'api-Artist A', '2026-01-01T00:00:00Z', 'artwork:work-1--CREATED_BY--practitioner:artist-a--api-Hidden Person')").run();
  db.prepare("INSERT INTO node_aliases (source, external_id, node_id) VALUES ('handle', 'artista', 'practitioner:artist-a')").run();
  // private local tables
  db.prepare("INSERT INTO contributor_emails (email, contributor_id, invited_at) VALUES ('secret@person.test', 'c-invitee', '2026-01-01')").run();
  db.prepare("INSERT INTO contributor_tokens (token_hash, token_prefix, contributor_id) VALUES ('HASHSECRET', 'adai_PREFIXSECRET', 'c-a')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('SETTINGSECRET', 'x')").run();
  return db;
}

const SECRETS = [
  "secret@person.test", "operator@internal.test", "artist@studio.test", "adai_PREFIXSECRET", "adai_SECRETPFX", "HASHSECRET",
  "SETTINGSECRET", "TRACESECRET", "secret-path", "SUMMARYSECRET", "Picker Person", "drf_0123456789abcdef",
  "STRUCTURALSECRET", "STRUCTTITLE", "structural.secret", "REVOKEDSECRET", "revoked.secret",
  "PENDINGSECRET", "REJECTEDSECRET", "OBJECTIONSECRET", "PENDINGNOTESECRET",
  "Hidden Person", "hidden-batch", "Invitee Never Public",
];

it("snapshot: none of the private data survives, in the SQLite bytes or the JSON lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "adai-snap-"));
  try {
    const path = join(dir, "adai-snapshot.sqlite");
    const r = buildSnapshot(fixture(), path, { generatedAt: "2026-10-26T00:00:00Z", jsonlDir: join(dir, "jsonl") });
    const blobs = [readFileSync(path), ...readdirSync(join(dir, "jsonl")).map((f) => readFileSync(join(dir, "jsonl", f)))];
    for (const b of blobs) {
      const text = b.toString("latin1");
      for (const s of SECRETS) assert.ok(!text.includes(s), `"${s}" leaked`);
    }
    assert.deepEqual({ signals: r.dropped.signals, contributors: r.dropped.contributors }, { signals: 4, contributors: 2 });

    // a plain SQLite file: no extension, no cr-sqlite tables, no triggers
    const db = new DatabaseSync(path);
    const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name").all() as any[];
    assert.deepEqual(objects.map((o) => `${o.type}:${o.name}`), ["table:contributors", "table:edges", "table:meta", "table:node_aliases", "table:nodes", "table:signals"]);

    // what stays: public words, the structural fact, anonymity, the revoked row, retired nodes, the handle
    const sig = (id: string) => db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as any;
    assert.equal(sig("s-pub").content, "Public words.");
    assert.deepEqual(JSON.parse(sig("s-pub").provenance_chain), { page_sha256: "abc", source: "https://public.example/" });
    assert.equal(sig("s-pub").batch_id, "batch-public");
    assert.deepEqual([sig("s-struct").title, sig("s-struct").content, sig("s-struct").source_url, sig("s-struct").consent_scope], [null, null, null, "structural_only"]);
    assert.deepEqual([sig("s-anon").submitted_by, sig("s-anon").batch_id, sig("s-anon").content], ["anonymous", null, "Anonymous words."]);
    assert.deepEqual([sig("s-revoked").status, sig("s-revoked").content, sig("s-revoked").title], ["revoked", null, null]);
    assert.equal(sig("s-pending"), undefined);
    assert.match(sig("s-token").content, /\[redacted\]/);
    const edges = db.prepare("SELECT id, created_by, invalidated_by FROM edges ORDER BY edge_type").all() as any[];
    assert.equal(edges[0].created_by, "anonymous");
    assert.match(edges[0].id, /^artwork:work-1--CREATED_BY--practitioner:artist-a--anonymous--[0-9a-f]{8}$/);
    assert.equal(edges[1].invalidated_by, edges[0].id, "references follow the re-minted id");
    assert.equal((db.prepare("SELECT updated_by FROM nodes WHERE id = 'artwork:work-1'").get() as any).updated_by, null, "no public contribution shown to have written it: omitted");
    assert.equal(JSON.parse((db.prepare("SELECT metadata FROM nodes WHERE id = 'artwork:retired'").get() as any).metadata).retired, true);
    assert.match((db.prepare("SELECT metadata FROM nodes WHERE id = 'practitioner:artist-a'").get() as any).metadata, /Write to \[redacted\]/);
    assert.deepEqual((db.prepare("SELECT name FROM contributors").all() as any[]).map((c) => c.name), ["Artist A"]);
    assert.ok(db.prepare("SELECT 1 FROM node_aliases WHERE source = 'handle' AND external_id = 'artista'").get());
    const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as any[]).map((m) => [m.key, m.value]));
    assert.equal(meta.generated_at, "2026-10-26T00:00:00Z");
    assert.match(meta.licence, /CC BY-SA 4\.0/);
    assert.match(meta.licence_text, /Creative Commons Attribution-ShareAlike/);
    assert.match(meta.readme, /valid_until IS NULL/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("snapshot: the /offline example query runs against it", () => {
  const dir = mkdtempSync(join(tmpdir(), "adai-snap-"));
  try {
    const path = join(dir, "s.sqlite");
    buildSnapshot(fixture(), path);
    const db = new DatabaseSync(path);
    const works = db.prepare(
      `SELECT w.name FROM edges e JOIN nodes w ON w.id = e.source_id JOIN nodes p ON p.id = e.target_id
        WHERE e.edge_type = 'CREATED_BY' AND e.valid_until IS NULL AND p.slug = ? ORDER BY w.name`
    ).all("artist-a") as any[];
    assert.deepEqual(works.map((w) => w.name), ["Work One"]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("/offline: the guide, with the download link from SNAPSHOT_URL — or 'not published yet'", async () => {
  const express = (await import("express")).default;
  const { default: offline } = await import("../src/routes/offline.js");
  const app = express();
  app.use(offline);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    delete process.env.SNAPSHOT_URL;
    let html = await (await fetch(`${base}/offline`)).text();
    assert.match(html, /Not published yet/);
    assert.match(html, /valid_until IS NULL/);
    assert.match(html, /CC BY-SA 4\.0/);
    assert.match(html, /<a href='\/offline'>Offline<\/a>/, "in the site's nav");
    process.env.SNAPSHOT_URL = "https://pub.example.r2.dev/snapshots/adai-latest.sqlite";
    html = await (await fetch(`${base}/offline`)).text();
    assert.match(html, /<a href="https:\/\/pub\.example\.r2\.dev\/snapshots\/adai-latest\.sqlite"><strong>Download the snapshot/);
    assert.match(html, /sqlite3 adai-latest\.sqlite/);
    process.env.SNAPSHOT_URL = "javascript:alert(1)";
    html = await (await fetch(`${base}/offline`)).text();
    assert.doesNotMatch(html, /javascript:/);
  } finally {
    delete process.env.SNAPSHOT_URL;
    server.close();
  }
});

// ---- privacy review (#82 review of 2a15b9d) ------------------------------------------------

const all = (dir: string, path: string) => [readFileSync(path), ...(existsSyncSafe(join(dir, "jsonl")) ? readdirSync(join(dir, "jsonl")).map((f) => readFileSync(join(dir, "jsonl", f))) : [])].map((b) => b.toString("latin1"));
function existsSyncSafe(p: string) { try { readdirSync(p); return true; } catch { return false; } }

async function probationaryDrafts() {
  const { freshDb, insertNode } = await import("./helpers.js");
  const { createDraft, claimJob, finishPass, getDraft, runDraftTool, contributorPatchCandidate, confirmDraft } = await import("../src/intake/draft.js");
  const { rejectIntakeItem } = await import("../src/utils/review.js");
  const db = freshDb();
  insertNode(db, "practitioner:casey-reas", "practitioner", "Casey Reas");
  const make = (id: string, name: string, tier: string) => {
    db.prepare("INSERT INTO contributors (id, name, type, trust_tier) VALUES (?, ?, 'human', ?)").run(id, name, tier);
    return { id, name, trust_tier: tier, token_label: null, token_prefix: "t", scope: "write" } as any;
  };
  const run = async (c: any, site: string, secret: string) => {
    const d = createDraft(db, c.id, `https://${site}/`);
    claimJob(db, "w1");
    const pg = { page_url: `https://${site}/works`, quote: `${secret} — a quote only this read holds.` };
    runDraftTool(db, d.id, "w1", "propose_node", { type: "artwork", name: `${secret} Work`, ...pg });
    runDraftTool(db, d.id, "w1", "propose_node", { type: "practitioner", name: "Casey Reas", resolves_to: "practitioner:casey-reas", resolution: "exact", ...pg });
    runDraftTool(db, d.id, "w1", "propose_edge", { source: "cid:c_01", target: "cid:c_02", edge_type: "CREATED_BY", confidence: "high", ...pg });
    finishPass(db, d.id, "w1", { summary: `${secret} summary` });
    let dr = getDraft(db, d.id)!;
    for (const cid of ["c_01", "c_02", "c_03"]) contributorPatchCandidate(db, dr, cid, { state: "accepted" });
    dr = getDraft(db, d.id)!;
    const r = await confirmDraft(db, dr, c, {});
    return { draft: d.id, r };
  };
  const p = make("contributor:prob", "Probation Person", "probationary");
  const pending = await run(p, "pending.example", "PENDINGBATCHSECRET");
  const rejected = await run(p, "rejected.example", "REJECTEDBATCHSECRET");
  const qid = (db.prepare("SELECT id FROM intake_queue WHERE status = 'pending' AND signal_id IN (SELECT id FROM signals WHERE batch_id = ?)").get(rejected.draft) as any).id;
  rejectIntakeItem(db, qid, "not now", "curator");
  const live = await run(make("contributor:auto", "Auto Person", "auto"), "live.example", "LIVEBATCHPUBLIC");
  return { db, pending, rejected, live };
}

it("probationary URL-intake batches (real confirmDraft), pending or rejected: no signal of the batch is in the file", async () => {
  const { db, pending, rejected, live } = await probationaryDrafts();
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM signals WHERE batch_id = ?").get(pending.draft) as any).n >= 3, "one signal per card, one queue row");
  const dir = mkdtempSync(join(tmpdir(), "adai-snap-"));
  try {
    const path = join(dir, "s.sqlite");
    buildSnapshot(db, path, { jsonlDir: join(dir, "jsonl") });
    for (const text of all(dir, path)) {
      for (const sec of ["PENDINGBATCHSECRET", "REJECTEDBATCHSECRET", "Probation Person", pending.draft, rejected.draft]) assert.ok(!text.includes(sec), `"${sec}" leaked`);
    }
    assert.ok(all(dir, path)[0].includes("LIVEBATCHPUBLIC"), "the approved batch is there");
    const out = new DatabaseSync(path);
    assert.ok((out.prepare("SELECT COUNT(*) AS n FROM signals WHERE batch_id = ?").get(live.draft) as any).n >= 3);
    out.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("metadata: a public projection; values written by a structural_only, revoked or non-public contribution dropped", () => {
  const db = fixture();
  const node = db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, ?)");
  node.run("artwork:meta", "artwork", "Meta Work", "meta", JSON.stringify({
    summary: "STRUCTSUMMARY copied from a structural_only contribution",
    description: "REVOKEDDESC left by a revoked contribution",
    year: "2024", cdn_image_url: "https://pub.r2.dev/images/x.jpg",
    private_note: "PRIVATENOTE", contact: { email_hint: "CONTACTHINT" },
    retired: true, retired_reason: "OPERATORREASON", retired_by: "OPERATORNAME",
    claimed: { at: "2026-10-01T00:00:00Z", handle: "meta", by: ["Artist A"], queue: "CLAIMQUEUE" },
    full_profile: { basic_info: { location: "Basel", phone: "PHONESECRET" }, internal: { x: "PROFILEINTERNAL" } },
  }), "contributor:migration");
  // the structural_only signal s-struct set `summary` (an approved patch); the revoked one's before-image names `description`
  db.prepare("INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status, kind, proposed_nodes) VALUES ('qm', 's-struct', 'artwork:meta', 'Artist A', 'auto', 'approved', 'human_signal', ?)")
    .run(JSON.stringify([{ op: "patch_node", node_id: "artwork:meta", metadata: { summary: "STRUCTSUMMARY copied from a structural_only contribution" } }]));
  db.prepare("UPDATE signals SET processing_trace = ? WHERE id = 's-revoked'").run(JSON.stringify({ prior: [{ op: "patch_node", node_id: "artwork:meta", before: { description: null } }] }));
  const dir = mkdtempSync(join(tmpdir(), "adai-snap-"));
  try {
    const path = join(dir, "s.sqlite");
    buildSnapshot(db, path, { jsonlDir: join(dir, "jsonl") });
    for (const text of all(dir, path)) {
      for (const sec of ["STRUCTSUMMARY", "REVOKEDDESC", "PRIVATENOTE", "CONTACTHINT", "OPERATORREASON", "OPERATORNAME", "CLAIMQUEUE", "PHONESECRET", "PROFILEINTERNAL"]) {
        assert.ok(!text.includes(sec), `"${sec}" leaked`);
      }
    }
    const out = new DatabaseSync(path);
    const m = JSON.parse((out.prepare("SELECT metadata FROM nodes WHERE id = 'artwork:meta'").get() as any).metadata);
    assert.deepEqual(m, {
      year: "2024", cdn_image_url: "https://pub.r2.dev/images/x.jpg", retired: true,
      claimed: { at: "2026-10-01T00:00:00Z", handle: "meta", by: ["Artist A"] },
      full_profile: { basic_info: { location: "Basel" } },
    });
    out.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("a contributor both attributed and anonymous: no correlation handle, no person-wide labels, edge ids in kept JSON follow", () => {
  const db = fixture();
  db.prepare("INSERT INTO contributors (id, name, trust_tier) VALUES ('c-mixed', 'Mixed Person', 'reviewed')").run();
  const sig = db.prepare(`INSERT INTO signals (id, title, content, submitted_by, consent_attribution, batch_id, provenance_chain, source_type, created_at, confidence)
    VALUES (?, ?, ?, 'Mixed Person', ?, ?, ?, ?, ?, 'reviewed')`);
  sig.run("m-pub", "Signed", "Signed words.", "attributed", "mixed-public-batch", null, "contribution", "2026-10-01T00:00:00Z");
  sig.run("m-anon", "Unsigned", JSON.stringify({ source_id: "artwork:work-1", target_id: "practitioner:artist-a", edge_type: "INFLUENCES" }), "anonymous",
    "MIXEDANONBATCH", JSON.stringify({ batch_id: "MIXEDPROVBATCH", source: "https://x.example/" }), "api_edge", "2026-10-02T00:00:00Z");
  db.prepare("INSERT INTO intake_queue (id, signal_id, submitted_by, trust_tier, status, kind) VALUES ('qmp', 'm-pub', 'Mixed Person', 'reviewed', 'approved', 'human_signal')").run();
  // the anonymous signal's edge: created_by and id carry the (otherwise public) name
  const anonEdge = "artwork:work-1--INFLUENCES--practitioner:artist-a--api-Mixed Person";
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, created_by) VALUES (?, 'artwork:work-1', 'practitioner:artist-a', 'INFLUENCES', 'm-anon', 'api-Mixed Person')").run(anonEdge);
  // an attributed signal whose JSON content names that edge (supersedes_edge_id), kept
  sig.run("m-sup", "Supersede", JSON.stringify({ supersedes_edge_id: anonEdge, edge_type: "INFLUENCES" }), "attributed", null, null, "api_edge", "2026-10-03T00:00:00Z");
  db.prepare("INSERT INTO intake_queue (id, signal_id, submitted_by, trust_tier, status, kind) VALUES ('qms', 'm-sup', 'Mixed Person', 'reviewed', 'approved', 'human_signal')").run();
  // a node last written by the anonymous contribution
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES ('concept:mixed', 'concept', 'Mixed', 'mixed', '{}', 'api-Mixed Person')").run();
  db.prepare("INSERT INTO intake_queue (id, signal_id, submitted_by, trust_tier, status, kind, proposed_nodes) VALUES ('qma', 'm-anon', 'Mixed Person', 'reviewed', 'approved', 'human_signal', ?)")
    .run(JSON.stringify([{ op: "patch_node", node_id: "concept:mixed", metadata: { summary: "x" } }]));
  // an edge invalidated by a signal that is not in the file
  db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, created_by, valid_until, invalidated_by) VALUES ('e-inv', 'artwork:work-1', 'practitioner:artist-a', 'EMBODIES', 's-pub', 'api-Artist A', '2026-01-01T00:00:00Z', 's-pending')").run();
  const dir = mkdtempSync(join(tmpdir(), "adai-snap-"));
  try {
    const path = join(dir, "s.sqlite");
    buildSnapshot(db, path, { jsonlDir: join(dir, "jsonl") });
    for (const text of all(dir, path)) for (const sec of ["MIXEDANONBATCH", "MIXEDPROVBATCH", "api-Mixed Person", anonEdge]) assert.ok(!text.includes(sec), `"${sec}" leaked`);
    const out = new DatabaseSync(path);
    const a = out.prepare("SELECT * FROM signals WHERE id = 'm-anon'").get() as any;
    assert.deepEqual([a.submitted_by, a.batch_id, a.provenance_chain, a.content], ["anonymous", null, null, null]);
    const e = out.prepare("SELECT id, created_by FROM edges WHERE signal_id = 'm-anon'").get() as any;
    assert.equal(e.created_by, "anonymous");
    assert.equal(JSON.parse((out.prepare("SELECT content FROM signals WHERE id = 'm-sup'").get() as any).content).supersedes_edge_id, e.id, "the kept JSON follows the re-minted id");
    assert.equal((out.prepare("SELECT updated_by FROM nodes WHERE id = 'concept:mixed'").get() as any).updated_by, null, "last written anonymously: omitted, though the person is public");
    assert.equal((out.prepare("SELECT invalidated_by FROM edges WHERE id = 'e-inv'").get() as any).invalidated_by, null, "a reference to a record not in the file is NULL");
    assert.equal((out.prepare("SELECT signal_id FROM edges WHERE id = 'e-inv'").get() as any).signal_id, "s-pub");
    // contributors: counters from the file, no trust tier anywhere
    const cols = (out.prepare("PRAGMA table_info(contributors)").all() as any[]).map((c) => c.name);
    assert.ok(!cols.includes("trust_tier"));
    assert.deepEqual({ ...(out.prepare("SELECT contributions, approved_count FROM contributors WHERE name = 'Mixed Person'").get() as any) }, { contributions: 2, approved_count: 2 });
    assert.equal((out.prepare("SELECT COUNT(*) AS n FROM signals WHERE confidence IN ('auto', 'reviewed', 'probationary')").get() as any).n, 0);
    out.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the sanitiser: common secret shapes redacted in the SQLite file and the JSON lines (defence in depth)", () => {
  const db = fixture();
  const secrets = [
    "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA", "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBB", "re_CCCCCCCCCCCCCCCCCCCC",
    "FlyV1 fm2_DDDDDDDDDDDDDDDDDDDDDDDD", "AKIAIOSFODNN7EXAMPLE", "ghp_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    "AIzaFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
  ];
  db.prepare("INSERT INTO signals (id, title, content, submitted_by) VALUES ('s-keys', 'keys', ?, 'Artist A')").run(`${secrets.join(" ")} token=GGGGGGGGGGGGGGGG api_key: "HHHHHHHHHHHHHHHH"`);
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata) VALUES ('concept:k', 'concept', 'K', 'k', ?)").run(JSON.stringify({ summary: `see ${secrets[0]}` }));
  const dir = mkdtempSync(join(tmpdir(), "adai-snap-"));
  try {
    const path = join(dir, "s.sqlite");
    buildSnapshot(db, path, { jsonlDir: join(dir, "jsonl") });
    for (const text of all(dir, path)) for (const sec of [...secrets, "GGGGGGGGGGGGGGGG", "HHHHHHHHHHHHHHHH"]) assert.ok(!text.includes(sec), `"${sec}" leaked`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the source: read-only, never written; --out can never be the source (path or symlink); written atomically", async () => {
  const { symlinkSync, statSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "adai-snap-"));
  try {
    const srcPath = join(dir, "src.db");
    const f = initDb(srcPath);
    f.prepare("INSERT INTO nodes (id, type, name, slug, metadata) VALUES ('concept:a', 'concept', 'A', 'a', '{}')").run();
    f.close();
    const schemaBefore = (() => { const d = new DatabaseSync(srcPath, { readOnly: true }); const r = d.prepare("SELECT COUNT(*) AS n, group_concat(name) AS names FROM sqlite_master").get(); d.close(); return r; })();
    const src = new DatabaseSync(srcPath, { readOnly: true });
    buildSnapshot(src, join(dir, "out.sqlite"), { sourcePath: srcPath });
    assert.throws(() => buildSnapshot(src, srcPath, { sourcePath: srcPath }), /over its source/);
    symlinkSync(srcPath, join(dir, "link.db"));
    assert.throws(() => buildSnapshot(src, join(dir, "link.db"), { sourcePath: srcPath }), /over its source/);
    src.close();
    const d = new DatabaseSync(srcPath, { readOnly: true });
    assert.deepEqual(d.prepare("SELECT COUNT(*) AS n, group_concat(name) AS names FROM sqlite_master").get(), schemaBefore, "no schema written on the source");
    d.close();
    assert.ok(statSync(join(dir, "out.sqlite")).size > 0);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no temp file left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
