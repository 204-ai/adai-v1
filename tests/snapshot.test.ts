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
    assert.deepEqual(r.dropped, { signals: 4, contributors: 2 });

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
    assert.match(sig("s-token").content, /\[redacted token\]/);
    const edges = db.prepare("SELECT id, created_by, invalidated_by FROM edges ORDER BY edge_type").all() as any[];
    assert.equal(edges[0].created_by, "anonymous");
    assert.match(edges[0].id, /^artwork:work-1--CREATED_BY--practitioner:artist-a--anonymous--[0-9a-f]{8}$/);
    assert.equal(edges[1].invalidated_by, edges[0].id, "references follow the re-minted id");
    assert.equal((db.prepare("SELECT updated_by FROM nodes WHERE id = 'artwork:work-1'").get() as any).updated_by, "anonymous");
    assert.equal(JSON.parse((db.prepare("SELECT metadata FROM nodes WHERE id = 'artwork:retired'").get() as any).metadata).retired, true);
    assert.match((db.prepare("SELECT metadata FROM nodes WHERE id = 'practitioner:artist-a'").get() as any).metadata, /\[redacted email\]/);
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
