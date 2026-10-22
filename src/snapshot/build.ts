// The public snapshot of the commons (issue #82): a plain SQLite file anyone
// can download and open — sqlite3, Python, Node — for local experiments.
//
// What goes in: only the five CRR tables (nodes, edges, signals,
// contributors, node_aliases), copied into fresh plain tables — no cr-sqlite
// clock tables, triggers or extension needed to open it — plus a `meta`
// table. No local table at all: no review queue, emails, tokens, sessions,
// drafts, claims' private side, notification state or embeddings.
//
// The privacy boundary is the projection below — what is selected, decided
// record by record from consent, review state and provenance — not pattern
// matching. A central sanitiser runs over every exported text value as
// defence in depth only.
//
// Signals (contributions):
//   - only public ones. A contribution is public once its review item was
//     approved (or it was never queued: imports, admin corrections, claims,
//     notes). Decided at batch and operation level: a URL-intake confirm by a
//     probationary contributor writes one signal per card but queues ONE
//     anchor row; while that row is pending or rejected, every signal of the
//     batch (create-node evidence included, which no queue row names) stays
//     out, and so does any signal named only by pending / rejected rows'
//     operations. Claimants' objections and unpublished notes stay out too.
//   - structural_only: the fact stays; title, summary, content, source_url
//     and provenance go;
//   - anonymous: submitted_by 'anonymous'; batch id, provenance and any
//     structured (JSON) content go — they are correlation handles;
//   - revoked: the row stays (status shown, as /history does), its words,
//     source and provenance go;
//   - processing_trace is never exported; provenance_chain keeps only
//     source, fetched_at, origin, page_sha256, page_fetched_at (and batch_id
//     for attributed signals) — never draft ids, reader summaries or who
//     picked what up; `confidence` values that are trust tiers go.
//
// Nodes: metadata is a projection — an allowlist of what the public entity
// view shows (descriptions, location / dates / medium, websites, kind, the
// image URLs and their provenance, the claim as {at, handle, by}, retired
// as a bare flag), and of those keys only values no structural_only,
// revoked or non-public contribution ever wrote (traced through the review
// operations that set them and the before-images on signals). updated_by is
// kept only when the latest contribution that wrote the node is public and
// attributed; otherwise it is omitted.
//
// Edges: created_by follows the edge's own signal (anonymous → 'anonymous');
// an id embedding a hidden writer label is re-minted (random) and every
// reference to it follows — invalidated_by, and edge ids inside retained
// JSON content. References to records not in the file (a signal left out)
// are cleared to NULL.
//
// Contributors: only those named on a public attributed signal; their
// counters recomputed from what the file holds; trust tiers not exported.
//
// Images are not in the file (metadata.cdn_image_url points at the public
// mirror). Embedding vectors are not included (an open question in #82).

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_SCHEMA_VERSION = "2";
const ANON = "anonymous";
const TIERS = new Set(["auto", "reviewed", "probationary", "low"]);
const PROVENANCE_KEYS = ["source", "fetched_at", "batch_id", "origin", "page_sha256", "page_fetched_at"];

// ---- the central sanitiser (defence in depth) ----------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,                  // email addresses
  /\badai_[A-Za-z0-9_-]{6,}/g,                                          // A(DAI) tokens
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,                            // OpenAI / Anthropic-style keys
  /\bre_[A-Za-z0-9_]{16,}/g,                                            // Resend
  /\bFlyV1\s+[A-Za-z0-9_+/=,-]{20,}/g, /\bfm[12]_[A-Za-z0-9_+/=-]{20,}/g, // Fly
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                      // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,                                       // GitHub tokens
  /\bAIza[0-9A-Za-z_-]{30,}/g,                                           // Google API keys
  /((?:api[_-]?key|token|secret|password|passwd|authorization|bearer)["']?\s*[:=]\s*["']?)[A-Za-z0-9+/_=.-]{12,}/gi, // key=… / token: …
];

/** Every exported text value passes here. Deterministic, so references stay consistent. */
export function sanitise(v: unknown): any {
  if (typeof v !== "string") return v ?? null;
  let out = v;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, prefix) => (typeof prefix === "string" && m.startsWith(prefix) ? `${prefix}[redacted]` : "[redacted]"));
  return out;
}

// ---- schema -----------------------------------------------------------------------------

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
    id TEXT PRIMARY KEY NOT NULL, name TEXT, type TEXT, contributions INTEGER, approved_count INTEGER, created_at TEXT)`,
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
  sourcePath?: string;      // the source DB file, so --out can never be it
  jsonlDir?: string | null; // also write one .jsonl per table here
}

export interface SnapshotReport {
  path: string;
  counts: Record<string, number>;
  dropped: { signals: number; contributors: number; metadata_keys: number };
}

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function licenceText(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", "..", "LICENSE-DATA"), join(process.cwd(), "LICENSE-DATA")]) {
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8");
      const cut = text.indexOf("Creative Commons Attribution-ShareAlike 4.0 International Public License");
      return (cut > 0 ? text.slice(0, cut) : text.slice(0, 4000)).trim();
    }
  }
  return "CC BY-SA 4.0 (see LICENSE-DATA in https://github.com/a-digital-arts-institute/adai-v1). Mirrored images are not covered.";
}

const has = (db: DatabaseSync, t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

// ---- node metadata: the public projection -------------------------------------------------

/** Top-level keys the public entity view shows (src/entity/view.ts and its helpers). */
const PUBLIC_KEYS = new Set([
  "summary", "description", "bio", "location", "city", "country", "active_years", "medium", "homepage", "website", "url",
  "kind", "year", "year_start", "year_end", "year_raw", "year_ongoing", "date_text", "mint_opens_at", "created_at",
  "cdn_image_url", "image_url", "image_provenance", "source_url", "va_maker_name", "merged_into",
]);
/** full_profile: only the parts the entity view renders. */
const PROFILE_PATHS: Array<[string, string[]]> = [
  ["basic_info", ["location", "url", "active_years"]],
  ["practice_description", ["practice_summary", "medium", "methodology"]],
  ["commons_orientation", ["commons_summary"]],
  ["governance_model", ["governance_detail"]],
  ["key_works", ["works"]],
];

function projectMetadata(raw: unknown, tainted: Set<string>): { json: string | null; dropped: number } {
  const m = parse(raw);
  if (!m || typeof m !== "object" || Array.isArray(m)) return { json: null, dropped: 0 };
  const out: Record<string, unknown> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(m)) {
    if (tainted.has(k)) { dropped++; continue; }
    if (PUBLIC_KEYS.has(k)) { out[k] = v; continue; }
    if (k === "retired") { if (v === true) out.retired = true; continue; } // never the reason or who
    if (k === "claimed" && v && typeof v === "object") {
      const c = v as any;
      out.claimed = {
        ...(typeof c.at === "string" ? { at: c.at } : {}),
        ...(typeof c.handle === "string" ? { handle: c.handle } : {}),
        by: Array.isArray(c.by) ? c.by.filter((x: unknown) => typeof x === "string") : [],
      };
      continue;
    }
    if (k === "full_profile" && v && typeof v === "object") {
      const fp: Record<string, unknown> = {};
      for (const [section, keys] of PROFILE_PATHS) {
        const sec = (v as any)[section];
        if (!sec || typeof sec !== "object") continue;
        const kept: Record<string, unknown> = {};
        for (const key of keys) if (sec[key] !== undefined) kept[key] = sec[key];
        if (Object.keys(kept).length) fp[section] = kept;
      }
      if (Object.keys(fp).length) out.full_profile = fp;
      continue;
    }
    dropped++;
  }
  return { json: Object.keys(out).length ? JSON.stringify(out, (_k, val) => sanitise(val)) : null, dropped };
}

// ---- build --------------------------------------------------------------------------------

export function buildSnapshot(src: DatabaseSync, outPath: string, opts: SnapshotOptions = {}): SnapshotReport {
  // never over the source, whatever the spelling or symlink
  const outAbs = resolve(outPath);
  if (opts.sourcePath) {
    const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
    if (real(outAbs) === real(opts.sourcePath) || (existsSync(outAbs) && real(outAbs) === real(opts.sourcePath))) {
      throw new Error("refusing to write the snapshot over its source database");
    }
  }
  mkdirSync(dirname(outAbs), { recursive: true });
  const tmp = join(dirname(outAbs), `.${basename(outAbs)}.${crypto.randomBytes(4).toString("hex")}.tmp`);

  // one read transaction across every source read: a consistent picture
  src.exec("BEGIN");
  let out: DatabaseSync | null = null;
  try {
    out = new DatabaseSync(tmp);
    out.exec("PRAGMA journal_mode = DELETE");
    for (const ddl of Object.values(TABLES)) out.exec(ddl);
    const report = fill(src, out, opts);
    out.exec("VACUUM");
    out.close();
    out = null;
    renameSync(tmp, outAbs); // atomic: readers see the old file or the new one
    report.path = outAbs;
    if (opts.jsonlDir) writeJsonl(outAbs, opts.jsonlDir);
    return report;
  } finally {
    try { out?.close(); } catch { /* closing after a failure */ }
    for (const p of [tmp, `${tmp}-journal`]) if (existsSync(p)) rmSync(p);
    try { src.exec("COMMIT"); } catch { /* read-only: nothing to commit */ }
  }
}

function writeJsonl(dbPath: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const t of [...Object.keys(TABLES), "meta"]) {
      const rows = db.prepare(`SELECT * FROM ${t}`).all() as any[];
      writeFileSync(join(dir, `${t}.jsonl`), rows.map((r) => JSON.stringify({ ...r })).join("\n") + (rows.length ? "\n" : ""));
    }
  } finally {
    db.close();
  }
}

function fill(src: DatabaseSync, out: DatabaseSync, opts: SnapshotOptions): SnapshotReport {
  const S = sanitise;

  // ---- which signals are public ------------------------------------------------------------
  const notPublic = new Set<string>();
  const approvedRef = new Set<string>();
  const queue = has(src, "intake_queue") ? (src.prepare("SELECT id, signal_id, status, proposed_nodes, proposed_edges FROM intake_queue").all() as any[]) : [];
  const refsOf = (q: any): string[] => {
    const ids = [q.signal_id];
    for (const op of parse(q.proposed_nodes) ?? []) if (op?.signal_id) ids.push(op.signal_id);
    for (const e of parse(q.proposed_edges) ?? []) if (e?.signal_id) ids.push(e.signal_id);
    return ids.filter((x): x is string => typeof x === "string" && !!x);
  };
  for (const q of queue) if (q.status === "approved") for (const id of refsOf(q)) approvedRef.add(id);
  const anchorsEdge = new Set((src.prepare("SELECT DISTINCT signal_id FROM edges WHERE signal_id IS NOT NULL").all() as any[]).map((r) => r.signal_id as string));
  const batchOf = src.prepare("SELECT batch_id FROM signals WHERE id = ?");
  const closedBatches = new Set<string>(); // batches whose review never approved
  const approvedBatches = new Set<string>();
  for (const q of queue) {
    const b = q.signal_id ? (batchOf.get(q.signal_id) as any)?.batch_id : null;
    if (!b) continue;
    if (q.status === "approved") approvedBatches.add(b);
    else if (q.status === "pending" || q.status === "rejected") closedBatches.add(b);
  }
  for (const q of queue) {
    if (q.status !== "pending" && q.status !== "rejected") continue;
    for (const id of refsOf(q)) if (!approvedRef.has(id) && !anchorsEdge.has(id)) notPublic.add(id);
  }
  const unapprovedBatch = (b: string | null) => !!b && closedBatches.has(b) && !approvedBatches.has(b);
  if (has(src, "relation_notes")) {
    for (const r of src.prepare("SELECT signal_id AS id FROM relation_notes WHERE kind = 'objection' OR state IN ('pending', 'rejected', 'withdrawn')").all() as any[]) notPublic.add(r.id);
  }

  // ---- signals ------------------------------------------------------------------------------
  const sigRows = src.prepare("SELECT * FROM signals ORDER BY rowid").all() as any[];
  const exported = new Map<string, any>(); // id -> source row, for the ones in the file
  let droppedSignals = 0;
  for (const s of sigRows) {
    const out = notPublic.has(s.id) || s.source_type === "subject_objection" || (unapprovedBatch(s.batch_id) && !approvedRef.has(s.id) && !anchorsEdge.has(s.id));
    if (out) { droppedSignals++; continue; }
    exported.set(s.id, s);
  }
  const anonymous = (s: any) => s?.consent_attribution === "anonymous";
  const attributedNames = new Set<string>();
  for (const s of exported.values()) if (!anonymous(s) && s.submitted_by) attributedNames.add(String(s.submitted_by));

  // ---- who may be named --------------------------------------------------------------------
  const contributorRows = src.prepare("SELECT * FROM contributors ORDER BY rowid").all() as any[];
  const knownPerson = new Set(contributorRows.map((c) => String(c.name)));
  const publicPerson = (name: string) => attributedNames.has(name);
  /** A writer label (`api-<name>`, `curator-from-<name>`, a bare name) with no public person in it → anonymous. */
  const writerLabel = (v: unknown): string | null => {
    if (typeof v !== "string" || !v) return null;
    const m = /^(curator-from-|api-)(.+)$/.exec(v);
    const person = m ? m[2] : v;
    if (knownPerson.has(person) && !publicPerson(person)) return m ? `${m[1]}${ANON}` : ANON;
    return S(v);
  };

  // ---- edges: created_by and re-minted ids ---------------------------------------------------
  const edgeRows = src.prepare("SELECT * FROM edges ORDER BY rowid").all() as any[];
  const renamed = new Map<string, string>();
  for (const e of edgeRows) {
    const sig = e.signal_id ? exported.get(e.signal_id) : null;
    const by = sig && anonymous(sig) ? ANON : writerLabel(e.created_by);
    if (by !== e.created_by && typeof e.created_by === "string" && e.created_by && String(e.id).includes(e.created_by)) {
      renamed.set(e.id, `${e.source_id}--${e.edge_type}--${e.target_id}--${by}--${crypto.randomBytes(4).toString("hex")}`);
    }
    e._by = by;
  }
  /** Edge ids inside structured content follow their re-minted ids. */
  const remapJson = (v: any): any => {
    if (typeof v === "string") return renamed.get(v) ?? v;
    if (Array.isArray(v)) return v.map(remapJson);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remapJson(x)]));
    return v;
  };

  // ---- write signals ------------------------------------------------------------------------
  const insSig = out.prepare(
    `INSERT INTO signals (id, title, source_url, source_type, cla_layer, summary, content, submitted_by, confidence, lived_experience,
       created_at, consent_scope, consent_attribution, consent_revocable, source_origin, batch_id, status, provenance_chain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const s of exported.values()) {
    const anon = anonymous(s);
    const words = !(s.consent_scope === "structural_only" || s.status === "revoked");
    let content: unknown = words ? s.content : null;
    const json = typeof content === "string" ? parse(content) : null;
    if (json && typeof json === "object") content = anon ? null : JSON.stringify(remapJson(json)); // structured bodies are correlation handles when anonymous
    let prov: string | null = null;
    if (words && !anon) {
      const p = parse(s.provenance_chain);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        const kept: Record<string, unknown> = {};
        for (const k of PROVENANCE_KEYS) if (p[k] !== undefined && p[k] !== null && typeof p[k] !== "object") kept[k] = p[k];
        if (Object.keys(kept).length) prov = JSON.stringify(kept);
      }
    }
    insSig.run(
      S(s.id),
      words ? S(s.title) : null,
      words ? S(s.source_url) : null,
      S(s.source_type),
      S(s.cla_layer),
      words ? S(s.summary) : null,
      S(content),
      anon ? ANON : S(s.submitted_by),
      TIERS.has(String(s.confidence)) ? null : S(s.confidence),
      s.lived_experience ?? null,
      S(s.created_at),
      S(s.consent_scope),
      S(s.consent_attribution),
      s.consent_revocable ?? null,
      S(s.source_origin),
      anon ? null : S(s.batch_id),
      S(s.status),
      S(prov),
    );
  }

  // ---- contributors: named on a public attributed signal; counters recomputed --------------
  const counts = new Map<string, number>();
  for (const s of exported.values()) if (!anonymous(s) && s.submitted_by) counts.set(String(s.submitted_by), (counts.get(String(s.submitted_by)) ?? 0) + 1);
  const insCon = out.prepare("INSERT INTO contributors (id, name, type, contributions, approved_count, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  let droppedContributors = 0;
  for (const c of contributorRows) {
    const n = (counts.get(String(c.name)) ?? 0) + (c.id !== c.name ? counts.get(String(c.id)) ?? 0 : 0);
    if (!n) { droppedContributors++; continue; }
    insCon.run(S(c.id), S(c.name), S(c.type), n, n, S(c.created_at));
  }

  // ---- node metadata: which keys a non-public contribution ever wrote; the latest writer ----
  const restricted = (sid: string | null | undefined): boolean => {
    if (!sid) return false;
    const s = exported.get(sid);
    if (!s) return true; // not public at all
    return s.consent_scope === "structural_only" || s.status === "revoked";
  };
  const tainted = new Map<string, Set<string>>();
  const taint = (node: string, keys: string[]) => {
    if (!tainted.has(node)) tainted.set(node, new Set());
    for (const k of keys) tainted.get(node)!.add(k);
  };
  const latest = new Map<string, { at: string; sid: string | null }>();
  const wrote = (node: string, at: string | null, sid: string | null) => {
    const prev = latest.get(node);
    if (!prev || String(at ?? "") >= prev.at) latest.set(node, { at: String(at ?? ""), sid });
  };
  for (const q of queue) {
    for (const op of parse(q.proposed_nodes) ?? []) {
      if (!op || (op.op !== "patch_node" && op.op !== "create_node" && op.op !== "attach_image")) continue;
      const node = op.op === "create_node" ? `${op.type}:${op.slug}` : op.node_id;
      const sid = op.signal_id ?? q.signal_id;
      const keys = op.op === "attach_image" ? ["cdn_image_url", "image_url", "image_sha256", "image_provenance"] : Object.keys(op.metadata ?? {});
      // a non-approved item never wrote anything; an approved one by a restricted signal taints what it set
      if (q.status === "approved") {
        if (restricted(sid)) taint(node, keys);
        wrote(node, (exported.get(sid)?.created_at ?? null), sid);
      }
    }
  }
  for (const s of sigRows) {
    const prior = parse(s.processing_trace)?.prior;
    if (!Array.isArray(prior)) continue;
    for (const p of prior) {
      if (!p?.node_id) continue;
      if (restricted(s.id)) taint(p.node_id, Object.keys(p.before ?? {}));
      wrote(p.node_id, p.at ?? s.created_at ?? null, s.id);
    }
  }

  const insNode = out.prepare("INSERT INTO nodes (id, type, name, slug, metadata, created_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let droppedKeys = 0;
  for (const n of src.prepare("SELECT * FROM nodes ORDER BY rowid").all() as any[]) {
    const proj = projectMetadata(n.metadata, tainted.get(n.id) ?? new Set());
    droppedKeys += proj.dropped;
    // updated_by: a system label stays; a person only when the latest contribution that wrote the node is public and attributed
    let updatedBy: string | null = null;
    const label = typeof n.updated_by === "string" ? n.updated_by : null;
    const m = label ? /^(curator-from-|api-)(.+)$/.exec(label) : null;
    const person = label ? (m ? m[2] : label) : null;
    if (label && person && !knownPerson.has(person)) updatedBy = S(label); // not a person: 'claim', 'contributor:migration', 'cli-…'
    else if (label) {
      const last = latest.get(n.id);
      const s = last?.sid ? exported.get(last.sid) : null;
      if (s && !anonymous(s) && String(s.submitted_by) === person) updatedBy = S(label);
    }
    insNode.run(S(n.id), S(n.type), S(n.name), S(n.slug), proj.json, S(n.created_at), updatedBy);
  }

  // ---- write edges and aliases --------------------------------------------------------------
  const insEdge = out.prepare(
    `INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, confidence, charge, created_at, created_by, event_time, valid_from, valid_until, invalidated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const edgeIds = new Set(edgeRows.map((e) => e.id as string));
  // A reference to a record not in the file is cleared (NULL): a signal left
  // out, or anything else unknown.
  const ref = (id: unknown): string | null => {
    if (typeof id !== "string" || !id) return null;
    if (renamed.has(id)) return S(renamed.get(id)!);
    if (edgeIds.has(id) || exported.has(id)) return S(id);
    return null;
  };
  for (const e of edgeRows) {
    insEdge.run(S(renamed.get(e.id) ?? e.id), S(e.source_id), S(e.target_id), S(e.edge_type), ref(e.signal_id),
      TIERS.has(String(e.confidence)) ? null : S(e.confidence), S(e.charge),
      S(e.created_at), e._by, S(e.event_time), S(e.valid_from), S(e.valid_until), ref(e.invalidated_by));
  }
  const insAlias = out.prepare("INSERT INTO node_aliases (source, external_id, node_id, created_at) VALUES (?, ?, ?, ?)");
  for (const a of src.prepare("SELECT * FROM node_aliases ORDER BY rowid").all() as any[]) {
    insAlias.run(S(a.source), S(a.external_id), S(a.node_id), S(a.created_at));
  }
  for (const ix of INDEXES) out.exec(ix);

  // ---- meta ---------------------------------------------------------------------------------
  out.exec("CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  const meta = out.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  const tableCounts: Record<string, number> = {};
  for (const t of Object.keys(TABLES)) tableCounts[t] = Number((out.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
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
      "nodes.metadata is JSON (json_extract works) holding the public fields the site shows; retired nodes keep metadata.retired = true.",
      "Images are not in this file: metadata.cdn_image_url points at the public image mirror.",
      "structural_only contributions keep the fact without the words; anonymous ones name no one; revoked signals keep their row without their words.",
      "A reference to a record not in this file is NULL (a contribution that is not public).",
      "To contribute, use the live site: changes made to this copy do not flow back.",
      "Guide: /offline on the live site.",
    ].join("\n")],
    ["counts", JSON.stringify(tableCounts)],
  ];
  for (const [k, v] of entries) meta.run(k, v);

  return { path: "", counts: tableCounts, dropped: { signals: droppedSignals, contributors: droppedContributors, metadata_keys: droppedKeys } };
}
