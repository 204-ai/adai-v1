// The public snapshot of the commons (issue #82): a plain SQLite file anyone
// can download and open — sqlite3, Python, Node — for local experiments.
//
// What goes in: only the five CRR tables (nodes, edges, signals,
// contributors, node_aliases), copied into fresh plain tables — no cr-sqlite
// clock tables, triggers or extension needed to open it — plus a `meta`
// table (what this is, when, from where, under which licence). No local
// table at all: no review queue, emails, tokens, sessions, drafts, claims'
// private side, notification state or embeddings.
//
// What it shows is what the live site shows, consent applied:
//   - only public signals: a signal that is only ever a pending or rejected
//     review item (and anchors no relation), a claimant's objection (for
//     curators), a context note still pending, rejected or withdrawn — out;
//   - structural_only: the fact stays, the words go (title, summary,
//     content, source_url, provenance);
//   - anonymous: submitted_by becomes "anonymous", the batch id goes (it
//     would tie the signal to the contributor's attributed ones), and so does
//     any trace of the name — edges.created_by of edges it anchors;
//   - revoked signals: the row stays (status 'revoked', as /history shows the
//     correction) without its words, source or provenance;
//   - contributors: only those who appear by name on a public, attributed
//     signal; anonymous-only contributors and people who never contributed
//     publicly (invitees, curators) are not in the file; a node's
//     updated_by naming such a person becomes "anonymous";
//   - processing_trace is dropped everywhere (import argv, git SHAs,
//     before-images, operator notes); provenance_chain keeps only public
//     keys (source, fetched_at, batch_id, origin, page_sha256,
//     page_fetched_at) — never draft ids, reader summaries or who picked
//     what up;
//   - retired nodes stay, with metadata.retired, as the site keeps them by URL;
//   - anything shaped like an email address or an A(DAI) token, in any
//     text column, is redacted.
//
// Images are not in the file: nodes keep their public R2 URLs
// (metadata.cdn_image_url). Embedding vectors are not included (an open
// question in #82).

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_SCHEMA_VERSION = "1";
const PROVENANCE_KEYS = ["source", "fetched_at", "batch_id", "origin", "page_sha256", "page_fetched_at"];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN = /\badai_[A-Za-z0-9_-]{6,}/g;
const ANON = "anonymous";

const TABLES: Record<string, string> = {
  nodes: `CREATE TABLE nodes (
    id TEXT PRIMARY KEY NOT NULL, type TEXT, name TEXT, slug TEXT, metadata TEXT, created_at TEXT, updated_by TEXT)`,
  edges: `CREATE TABLE edges (
    id TEXT PRIMARY KEY NOT NULL, source_id TEXT, target_id TEXT, edge_type TEXT, signal_id TEXT, confidence TEXT, charge TEXT,
    created_at TEXT, created_by TEXT, event_time TEXT, valid_from TEXT, valid_until TEXT, invalidated_by TEXT)`,
  signals: `CREATE TABLE signals (
    id TEXT PRIMARY KEY NOT NULL, title TEXT, source_url TEXT, source_type TEXT, cla_layer TEXT, summary TEXT, content TEXT,
    submitted_by TEXT, confidence TEXT, lived_experience INTEGER, created_at TEXT, consent_scope TEXT, consent_attribution TEXT,
    consent_revocable INTEGER, source_origin TEXT, batch_id TEXT, status TEXT, provenance_chain TEXT)`,
  contributors: `CREATE TABLE contributors (
    id TEXT PRIMARY KEY NOT NULL, name TEXT, type TEXT, trust_tier TEXT, contributions INTEGER, approved_count INTEGER, created_at TEXT)`,
  node_aliases: `CREATE TABLE node_aliases (
    source TEXT NOT NULL, external_id TEXT NOT NULL, node_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY (source, external_id))`,
};

const INDEXES = [
  "CREATE INDEX idx_edges_source ON edges(source_id)",
  "CREATE INDEX idx_edges_target ON edges(target_id)",
  "CREATE INDEX idx_edges_type ON edges(edge_type)",
  "CREATE INDEX idx_edges_valid ON edges(valid_until)",
  "CREATE INDEX idx_nodes_type ON nodes(type)",
  "CREATE INDEX idx_nodes_slug ON nodes(slug)",
  "CREATE INDEX idx_aliases_node ON node_aliases(node_id)",
];

export interface SnapshotOptions {
  generatedAt?: string;
  source?: string;          // where it was made from (a URL; never a host path)
  jsonlDir?: string | null; // also write one .jsonl per table here
}

export interface SnapshotReport {
  path: string;
  counts: Record<string, number>;
  dropped: { signals: number; contributors: number };
}

function redact(v: unknown): unknown {
  if (typeof v !== "string") return v;
  return v.replace(EMAIL, "[redacted email]").replace(TOKEN, "[redacted token]");
}

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function publicProvenance(s: unknown): string | null {
  const p = parse(s);
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const out: Record<string, unknown> = {};
  for (const k of PROVENANCE_KEYS) if (p[k] !== undefined && p[k] !== null && typeof p[k] !== "object") out[k] = p[k];
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

function licenceText(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", "..", "LICENSE-DATA"), join(process.cwd(), "LICENSE-DATA")]) {
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8");
      // the summary up to the full legal text
      const cut = text.indexOf("Creative Commons Attribution-ShareAlike 4.0 International Public License");
      return (cut > 0 ? text.slice(0, cut) : text.slice(0, 4000)).trim();
    }
  }
  return "CC BY-SA 4.0 (see LICENSE-DATA in https://github.com/a-digital-arts-institute/adai-v1). Mirrored images are not covered.";
}

/** Has the source a table? (A test fixture may lack the local ones.) */
const has = (db: DatabaseSync, t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

export function buildSnapshot(src: DatabaseSync, outPath: string, opts: SnapshotOptions = {}): SnapshotReport {
  for (const p of [outPath, `${outPath}-journal`, `${outPath}-wal`, `${outPath}-shm`]) if (existsSync(p)) rmSync(p);
  mkdirSync(dirname(outPath), { recursive: true });
  const out = new DatabaseSync(outPath);
  out.exec("PRAGMA journal_mode = DELETE");
  for (const ddl of Object.values(TABLES)) out.exec(ddl);

  // ---- which signals are public ------------------------------------------------------------
  const notPublic = new Set<string>();
  if (has(src, "intake_queue")) {
    for (const r of src.prepare(
      `SELECT q.signal_id AS id FROM intake_queue q
        WHERE q.signal_id IS NOT NULL AND q.status IN ('pending', 'rejected')
          AND NOT EXISTS (SELECT 1 FROM intake_queue a WHERE a.signal_id = q.signal_id AND a.status = 'approved')
          AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.signal_id = q.signal_id)`
    ).all() as any[]) notPublic.add(r.id);
  }
  if (has(src, "relation_notes")) {
    for (const r of src.prepare("SELECT signal_id AS id FROM relation_notes WHERE kind = 'objection' OR state IN ('pending', 'rejected', 'withdrawn')").all() as any[]) notPublic.add(r.id);
  }
  for (const r of src.prepare("SELECT id FROM signals WHERE source_type = 'subject_objection'").all() as any[]) notPublic.add(r.id);

  // ---- signals ------------------------------------------------------------------------------
  const anonSignals = new Set<string>();
  const attributedNames = new Set<string>();
  const insSig = out.prepare(
    `INSERT INTO signals (id, title, source_url, source_type, cla_layer, summary, content, submitted_by, confidence, lived_experience,
       created_at, consent_scope, consent_attribution, consent_revocable, source_origin, batch_id, status, provenance_chain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let droppedSignals = 0;
  for (const s of src.prepare("SELECT * FROM signals ORDER BY rowid").all() as any[]) {
    if (notPublic.has(s.id)) { droppedSignals++; continue; }
    const anonymous = s.consent_attribution === "anonymous";
    const structural = s.consent_scope === "structural_only";
    const revoked = s.status === "revoked";
    const words = !(structural || revoked);
    if (anonymous) anonSignals.add(s.id);
    else if (s.submitted_by) attributedNames.add(String(s.submitted_by));
    insSig.run(
      s.id,
      words ? redact(s.title) as any : null,
      words ? redact(s.source_url) as any : null,
      s.source_type ?? null,
      s.cla_layer ?? null,
      words ? redact(s.summary) as any : null,
      words ? redact(s.content) as any : null,
      anonymous ? ANON : (redact(s.submitted_by) as any) ?? null,
      s.confidence ?? null,
      s.lived_experience ?? null,
      s.created_at ?? null,
      s.consent_scope ?? null,
      s.consent_attribution ?? null,
      s.consent_revocable ?? null,
      s.source_origin ?? null,
      anonymous ? null : (redact(s.batch_id) as any) ?? null,
      s.status ?? null,
      words ? redact(publicProvenance(s.provenance_chain)) as any : null,
    );
  }

  // ---- contributors: only who appears by name on a public, attributed signal ---------------
  const insCon = out.prepare("INSERT INTO contributors (id, name, type, trust_tier, contributions, approved_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const publicNames = new Set<string>();
  let droppedContributors = 0;
  for (const c of src.prepare("SELECT * FROM contributors ORDER BY rowid").all() as any[]) {
    if (!attributedNames.has(c.name) && !attributedNames.has(c.id)) { droppedContributors++; continue; }
    publicNames.add(c.name);
    insCon.run(c.id, redact(c.name) as any, c.type ?? null, c.trust_tier ?? null, c.contributions ?? null, c.approved_count ?? null, c.created_at ?? null);
  }
  // A name that is not public: a contributor seen only anonymously or never publicly.
  const nameIsPublic = (name: string) => publicNames.has(name) || attributedNames.has(name);
  const knownContributor = new Set((src.prepare("SELECT name FROM contributors").all() as any[]).map((r) => String(r.name)));
  /** created_by / updated_by: keep system labels; hide a person's name that is not public. */
  const writer = (v: unknown): string | null => {
    if (typeof v !== "string" || !v) return (v as any) ?? null;
    const m = /^(curator-from-|api-)(.+)$/.exec(v);
    const person = m ? m[2] : v;
    if (knownContributor.has(person) && !nameIsPublic(person)) return m ? `${m[1]}${ANON}` : ANON;
    return redact(v) as string;
  };

  // ---- nodes, edges, aliases ----------------------------------------------------------------
  const insNode = out.prepare("INSERT INTO nodes (id, type, name, slug, metadata, created_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const n of src.prepare("SELECT * FROM nodes ORDER BY rowid").all() as any[]) {
    insNode.run(n.id, n.type ?? null, n.name ?? null, n.slug ?? null, redact(n.metadata) as any, n.created_at ?? null, writer(n.updated_by));
  }
  const insEdge = out.prepare(
    `INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, confidence, charge, created_at, created_by, event_time, valid_from, valid_until, invalidated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // An edge id carries its writer's label (`<src>--<type>--<tgt>--<created_by>`):
  // when that label was hidden, the id is re-minted (random, so it reveals
  // nothing) and references to it follow.
  const renamed = new Map<string, string>();
  const edgeRows = src.prepare("SELECT * FROM edges ORDER BY rowid").all() as any[];
  for (const e of edgeRows) {
    const anonymous = !!e.signal_id && anonSignals.has(e.signal_id);
    const by = anonymous ? ANON : writer(e.created_by);
    if (by !== e.created_by && typeof e.created_by === "string" && e.created_by && String(e.id).includes(e.created_by)) {
      renamed.set(e.id, `${e.source_id}--${e.edge_type}--${e.target_id}--${by}--${crypto.randomBytes(4).toString("hex")}`);
    }
    e._by = by;
  }
  for (const e of edgeRows) {
    insEdge.run(renamed.get(e.id) ?? e.id, e.source_id, e.target_id, e.edge_type, e.signal_id ?? null, e.confidence ?? null, e.charge ?? null,
      e.created_at ?? null, e._by, e.event_time ?? null, e.valid_from ?? null, e.valid_until ?? null,
      e.invalidated_by ? renamed.get(e.invalidated_by) ?? e.invalidated_by : null);
  }
  const insAlias = out.prepare("INSERT INTO node_aliases (source, external_id, node_id, created_at) VALUES (?, ?, ?, ?)");
  for (const a of src.prepare("SELECT * FROM node_aliases ORDER BY rowid").all() as any[]) {
    insAlias.run(a.source, redact(a.external_id) as any, a.node_id, a.created_at ?? null);
  }

  for (const ix of INDEXES) out.exec(ix);

  // ---- meta ---------------------------------------------------------------------------------
  out.exec("CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  const meta = out.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  const counts: Record<string, number> = {};
  for (const t of Object.keys(TABLES)) counts[t] = Number((out.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
  const entries: Array<[string, string]> = [
    ["title", "A(DAI) — Digital Arts Knowledge Commons: public snapshot"],
    ["generated_at", opts.generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z")],
    ["source", opts.source ?? "https://adai-basel.fly.dev/"],
    ["schema_version", SNAPSHOT_SCHEMA_VERSION],
    ["licence", "CC BY-SA 4.0 — the knowledge graph (see licence_text). Mirrored images are NOT covered: they stay with their artists / holding institutions."],
    ["licence_text", licenceText()],
    ["readme", [
      "Five tables, copied from the live commons with consent applied: nodes, edges, signals, contributors, node_aliases.",
      "edges are bi-temporal: the current graph is WHERE valid_until IS NULL; ended relations stay as history.",
      "nodes.metadata is JSON (json_extract works); retired nodes keep metadata.retired = true and drop out of listings on the site.",
      "Images are not in this file: metadata.cdn_image_url points at the public image mirror.",
      "structural_only contributions keep the fact without the words; anonymous ones name no one; revoked signals keep their row without their words.",
      "To contribute, use the live site: changes made to this copy do not flow back.",
      "Guide: /offline on the live site.",
    ].join("\n")],
    ["counts", JSON.stringify(counts)],
  ];
  for (const [k, v] of entries) meta.run(k, v);

  // ---- optional JSON lines ------------------------------------------------------------------
  if (opts.jsonlDir) {
    mkdirSync(opts.jsonlDir, { recursive: true });
    for (const t of [...Object.keys(TABLES), "meta"]) {
      const rows = out.prepare(`SELECT * FROM ${t}`).all() as any[];
      writeFileSync(join(opts.jsonlDir, `${t}.jsonl`), rows.map((r) => JSON.stringify({ ...r })).join("\n") + (rows.length ? "\n" : ""));
    }
  }

  out.exec("VACUUM");
  out.close();
  return { path: outPath, counts, dropped: { signals: droppedSignals, contributors: droppedContributors } };
}
