// Legacy anonymous attribution: blocks on publication, and the operator's
// stream audit that alone may clear them (public sync review).
//
// An anonymous signal written by this code is born blank (signal_private
// .born_safe = 1): its name never was in a CRR, its edges are
// `…--anonymous--<signal id>`. A LEGACY one (any anonymous signal not born
// safe — written by older code, or found by the migration) may have left its
// author's name in the change stream for good: in an edge id (a primary key —
// cr-sqlite keeps a tombstone with that pk after a DELETE, so deleting or
// re-keying an edge is NOT enough), in a reference to that id, in a writer
// label. So:
//   - recordPrivacyBlocks() records each legacy anonymous signal in the LOCAL
//     privacy_blocks table, with the author labels and the author-bearing ids
//     it can see — a block does not go away when those rows are deleted;
//   - auditPrivacyStream() scans what a fork would actually receive —
//     crsql_changes, tombstones included (packed pks decoded), every text
//     cell and reference — for those labels and ids, and clears a block only
//     when nothing matches (npm run privacy:audit-stream -- --clear);
//   - the sync endpoints answer 503 while any block is uncleared.
// Matching is structural, never a substring over a whole id: the writer
// component of an edge id (`<source>--<TYPE>--<target>--<writer>[--<hex8>]`)
// is compared with the labels exactly, so a name that happens to occur in a
// node id, an edge type, "anonymous" or a signal id does not match.

import type { DatabaseSync } from "node:sqlite";
import { ANONYMOUS, hasTable, priorsOf } from "./signal-private.js";

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** The writer labels an author's writes carried before anonymous ones were labelled. */
export function authorLabels(name: string | null): string[] {
  return name ? [name, `api-${name}`, `curator-from-${name}`] : [];
}

const SUFFIX = /--(?:merged-)?[0-9a-f]{8}$/;

/**
 * The writer component of an edge id, known its row's source / type /
 * target: what follows `<source>--<TYPE>--<target>--`, supersession and
 * merge suffixes stripped. null when the id is not of that form.
 */
export function edgeWriter(id: string, row: { source_id: string; edge_type: string; target_id: string }): string | null {
  const prefix = `${row.source_id}--${row.edge_type}--${row.target_id}--`;
  if (!id.startsWith(prefix)) return null;
  let rest = id.slice(prefix.length);
  while (SUFFIX.test(rest)) rest = rest.replace(SUFFIX, "");
  return rest;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Without the row (a tombstone, a dangling reference): whether an edge id's
 * writer component is exactly `label` — `…--<TYPE>--…--<label>` at the end,
 * with only supersession / merge suffixes after it.
 */
export function idHasWriter(id: string, label: string): boolean {
  return new RegExp(`^.+--[A-Z][A-Z0-9_]*--.+--${escapeRe(label)}(?:--(?:merged-)?[0-9a-f]{8})*$`).test(id);
}

/** A safe anonymous writer component: `anonymous` or `anonymous--<the anchoring signal>`. */
export function safeAnonymousWriter(writer: string | null, signalId: string): boolean {
  return writer === ANONYMOUS || writer === `${ANONYMOUS}--${signalId}`;
}

/**
 * Decode cr-sqlite's packed primary key (crsql_changes.pk): a column count,
 * then per column a header byte (low 3 bits the type — 0 null, 1 integer,
 * 2 real, 3 text, 4 blob — high bits the byte length of the integer or of the
 * length field) and the value. Strict: a truncated, over-long or malformed
 * key throws, never a partial result.
 */
export function decodePk(pk: Uint8Array): Array<string | number | bigint | null | Uint8Array> {
  const b = Buffer.from(pk);
  let i = 0;
  const need = (k: number) => { if (k < 0 || i + k > b.length) throw new Error(`packed pk truncated at byte ${i} (need ${k}, have ${b.length - i})`); };
  need(1);
  const n = b[i++]!;
  if (n < 1) throw new Error("packed pk has no columns");
  const out: Array<string | number | bigint | null | Uint8Array> = [];
  const uint = (len: number) => { need(len); let v = 0; for (let k = 0; k < len; k++) v = v * 256 + b[i++]!; return v; };
  for (let c = 0; c < n; c++) {
    need(1);
    const h = b[i++]!;
    const type = h & 7;
    const len = h >> 3;
    if (type === 0) {
      if (len) throw new Error("packed pk: null with a length");
      out.push(null);
    } else if (type === 1) {
      if (len > 8) throw new Error(`packed pk: integer of ${len} bytes`);
      need(len);
      let v = 0n;
      for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(b[i++]!);
      if (len && v >= 1n << BigInt(8 * len - 1)) v -= 1n << BigInt(8 * len); // two's complement
      out.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
    } else if (type === 2) {
      need(8);
      out.push(b.readDoubleBE(i));
      i += 8;
    } else if (type === 3 || type === 4) {
      if (len > 4) throw new Error(`packed pk: length field of ${len} bytes`);
      const l = uint(len);
      need(l);
      if (type === 3) {
        const bytes = b.subarray(i, i + l);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        out.push(text);
      } else out.push(new Uint8Array(b.subarray(i, i + l)));
      i += l;
    } else throw new Error(`packed pk: unknown type ${type}`);
  }
  if (i !== b.length) throw new Error(`packed pk: ${b.length - i} trailing byte(s)`);
  return out;
}

/**
 * Anonymous signals not born safe (their author's name may be in the
 * stream), with every author name and writer label the LOCAL records and the
 * signal's own rows establish: the private original, the CRR submitter (when
 * it is not already "anonymous"), the authenticated author (signal_authors →
 * contributors), the review row's submitter, and the writer labels of the
 * edges it still anchors.
 */
export function legacyAnonymousSignals(db: DatabaseSync): Array<{ id: string; names: string[]; labels: string[] }> {
  const has = (t: string) => hasTable(db, t);
  const bornSafe = has("signal_private")
    ? "AND NOT EXISTS (SELECT 1 FROM signal_private p WHERE p.signal_id = s.id AND p.born_safe = 1)"
    : "";
  const rows = db.prepare(`SELECT s.id, s.submitted_by FROM signals s WHERE s.consent_attribution = 'anonymous' ${bornSafe}`).all() as any[];
  return rows.map((r) => {
    const names = new Set<string>();
    const add = (v: unknown) => { if (typeof v === "string" && v.trim() && v !== ANONYMOUS) names.add(v); };
    add(r.submitted_by);
    if (has("signal_private")) add((db.prepare("SELECT submitted_by FROM signal_private WHERE signal_id = ?").get(r.id) as any)?.submitted_by);
    if (has("signal_authors")) {
      for (const a of db.prepare("SELECT k.name FROM signal_authors sa JOIN contributors k ON k.id = sa.contributor_id WHERE sa.signal_id = ?").all(r.id) as any[]) add(a.name);
    }
    if (has("intake_queue")) for (const q of db.prepare("SELECT submitted_by FROM intake_queue WHERE signal_id = ?").all(r.id) as any[]) add(q.submitted_by);
    const labels = new Set<string>([...names].flatMap((n) => authorLabels(n)));
    for (const e of db.prepare("SELECT created_by FROM edges WHERE signal_id = ? AND created_by IS NOT NULL AND created_by != ?").all(r.id, ANONYMOUS) as any[]) labels.add(String(e.created_by));
    return { id: r.id, names: [...names].sort(), labels: [...labels].sort() };
  });
}

/** The finding an audit reports for a block it has nothing to check against: never cleared by the audit. */
export const INSUFFICIENT_EVIDENCE =
  "insufficient evidence: no author label and no author-bearing id could be established for this signal; the audit cannot show the stream is clean — resolve it explicitly (privacy:audit-stream -- --resolve <signal id> --reason …)";

/** The nodes an anonymous signal wrote: its before-images, and the approved review items naming it. */
function nodesWrittenBy(db: DatabaseSync, signalId: string): string[] {
  const nodes = new Set<string>(priorsOf(db, signalId).map((p) => p.node_id));
  if (hasTable(db, "intake_queue")) {
    const like = `%${JSON.stringify(signalId).slice(1, -1)}%`;
    for (const q of db.prepare("SELECT signal_id, proposed_nodes FROM intake_queue WHERE status = 'approved' AND (signal_id = ? OR proposed_nodes LIKE ?)").all(signalId, like) as any[]) {
      for (const op of parse(q.proposed_nodes) ?? []) {
        if ((op?.signal_id ?? q.signal_id) !== signalId) continue;
        if (op?.op === "create_node" && op.type && op.slug) nodes.add(`${op.type}:${op.slug}`);
        else if (op?.node_id) nodes.add(op.node_id);
      }
    }
  }
  return [...nodes];
}

/** Current edge rows an anonymous signal anchors that do not have the safe form, or that carry a label of its author. */
function unsafeEdgesOf(db: DatabaseSync, signalId: string, labels: string[]): string[] {
  const out: string[] = [];
  for (const e of db.prepare("SELECT id, source_id, edge_type, target_id, created_by FROM edges WHERE signal_id = ?").all(signalId) as any[]) {
    const writer = edgeWriter(String(e.id), e);
    if (e.created_by !== ANONYMOUS || !safeAnonymousWriter(writer, signalId) || (writer !== null && labels.includes(writer))) out.push(String(e.id));
  }
  return out;
}

/**
 * Rows in the CRR tables now that attribute an anonymous contribution to its
 * author, as "<table>:<id>": its edges not in the safe form, edges referencing
 * those ids, nodes whose updated_by is the author's label. A diagnostic of
 * current rows; the publication gate is privacy_blocks.
 */
export function anonymousGraphAttribution(db: DatabaseSync): string[] {
  const out = new Set<string>();
  const anon = db.prepare("SELECT id, submitted_by FROM signals WHERE consent_attribution = 'anonymous'").all() as any[];
  if (!anon.length) return [];
  const ref = db.prepare("SELECT id FROM edges WHERE invalidated_by = ?");
  for (const s of anon) {
    const kept = hasTable(db, "signal_private") ? (db.prepare("SELECT submitted_by FROM signal_private WHERE signal_id = ?").get(s.id) as any)?.submitted_by : null;
    const name = kept ?? (s.submitted_by !== ANONYMOUS ? s.submitted_by : null);
    const labels = authorLabels(name);
    for (const id of unsafeEdgesOf(db, s.id, labels)) {
      out.add(`edges:${id}`);
      for (const r of ref.all(id) as any[]) out.add(`edges:${r.id}`);
    }
    for (const id of nodesWrittenBy(db, s.id)) {
      const n = db.prepare("SELECT updated_by FROM nodes WHERE id = ?").get(id) as any;
      if (n && labels.includes(String(n.updated_by))) out.add(`nodes:${id}`);
    }
  }
  return [...out];
}

const union = (a: unknown, b: string[]) => [...new Set([...(Array.isArray(a) ? a : []), ...b])].sort();

/**
 * Record every legacy anonymous signal as a block (or add what is newly seen
 * to its block; a cleared block that shows unsafe rows again is reopened).
 * Returns the number of uncleared blocks.
 */
export function recordPrivacyBlocks(db: DatabaseSync): number {
  if (!hasTable(db, "privacy_blocks")) return 0;
  for (const s of legacyAnonymousSignals(db)) {
    const labels = s.labels;
    const edges = unsafeEdgesOf(db, s.id, labels);
    const nodes = nodesWrittenBy(db, s.id);
    const b = db.prepare("SELECT * FROM privacy_blocks WHERE signal_id = ?").get(s.id) as any;
    // a block resolved by an operator stays resolved unless author-bearing rows appear again
    if (!b) {
      db.prepare("INSERT INTO privacy_blocks (signal_id, labels, edge_ids, node_ids) VALUES (?, ?, ?, ?)")
        .run(s.id, JSON.stringify(labels), JSON.stringify(edges.sort()), JSON.stringify(nodes.sort()));
      continue;
    }
    db.prepare(`UPDATE privacy_blocks SET labels = ?, edge_ids = ?, node_ids = ?${b.cleared_at && edges.length ? ", cleared_at = NULL, resolution = NULL" : ""} WHERE signal_id = ?`)
      .run(JSON.stringify(union(parse(b.labels), labels)), JSON.stringify(union(parse(b.edge_ids), edges)), JSON.stringify(union(parse(b.node_ids), nodes)), s.id);
  }
  return Number((db.prepare("SELECT COUNT(*) AS n FROM privacy_blocks WHERE cleared_at IS NULL").get() as any).n);
}

/** Uncleared blocks, plus legacy anonymous signals not recorded yet (pure: writes nothing). */
export function legacyAnonymousBacklog(db: DatabaseSync): number {
  if (!hasTable(db, "privacy_blocks")) return legacyAnonymousSignals(db).length;
  const uncleared = Number((db.prepare("SELECT COUNT(*) AS n FROM privacy_blocks WHERE cleared_at IS NULL").get() as any).n);
  const unrecorded = legacyAnonymousSignals(db).filter((s) => !db.prepare("SELECT 1 FROM privacy_blocks WHERE signal_id = ?").get(s.id)).length;
  return uncleared + unrecorded;
}

export interface StreamAuditResult {
  signal_id: string;
  findings: string[];
  cleared: boolean;
}

/**
 * Scan what a fork receives — every crsql_changes row, tombstones included —
 * for the recorded labels and author-bearing ids of each uncleared block.
 * Each block's findings are stored (privacy_blocks.audit); with `clear`, a
 * block with no finding is cleared.
 */
export function auditPrivacyStream(db: DatabaseSync, opts: { clear?: boolean } = {}): StreamAuditResult[] {
  recordPrivacyBlocks(db);
  const blocks = db.prepare("SELECT * FROM privacy_blocks WHERE cleared_at IS NULL ORDER BY signal_id").all() as any[];
  if (!blocks.length) return [];
  const prepared = blocks.map((b) => ({
    id: String(b.signal_id),
    labels: (parse(b.labels) ?? []) as string[],
    edges: new Set<string>(parse(b.edge_ids) ?? []),
    nodes: new Set<string>(parse(b.node_ids) ?? []),
    findings: new Set<string>(),
  }));
  const edgeRow = db.prepare("SELECT source_id, edge_type, target_id, signal_id FROM edges WHERE id = ?");
  const stmt = db.prepare(`SELECT "table" AS tbl, pk, cid, CASE typeof(val) WHEN 'text' THEN val END AS val FROM crsql_changes`);
  for (const r of stmt.iterate() as Iterable<any>) {
    const pkVals = decodePk(r.pk as Uint8Array);
    const pkText = pkVals.map((v) => (typeof v === "string" ? v : "")).join("\u0000");
    const tbl = String(r.tbl);
    const cid = String(r.cid);
    const val = typeof r.val === "string" ? r.val : null;
    for (const b of prepared) {
      if (tbl === "edges") {
        const id = String(pkVals[0] ?? "");
        const row = edgeRow.get(id) as any;
        if (b.edges.has(id)) b.findings.add(`edges pk ${id}${row ? "" : " (tombstone)"}`);
        else if (!row && b.labels.some((l) => idHasWriter(id, l))) b.findings.add(`edges pk ${id} (tombstone with the author's writer label)`);
        else if (row && row.signal_id === b.id && (cid === "created_by" ? val !== ANONYMOUS : false)) b.findings.add(`edges.created_by of ${id}`);
      }
      if (val !== null) {
        for (const e of b.edges) if (val.includes(e) || val.includes(JSON.stringify(e).slice(1, -1))) b.findings.add(`${tbl}.${cid} references ${e}`);
        if (cid === "invalidated_by" && !edgeRow.get(val) && b.labels.some((l) => idHasWriter(val, l))) b.findings.add(`${tbl}.${cid} references a missing edge with the author's writer label: ${val}`);
        if (tbl === "nodes" && cid === "updated_by" && b.labels.includes(val) && b.nodes.has(pkText)) b.findings.add(`nodes.updated_by of ${pkText}`);
        if (tbl === "signals" && pkText === b.id && ["submitted_by", "batch_id", "provenance_chain"].includes(cid) && val !== ANONYMOUS) b.findings.add(`signals.${cid} of the anonymous signal`);
      }
    }
  }
  const out: StreamAuditResult[] = [];
  for (const b of prepared) {
    // nothing to match is not "nothing found": such a block is never cleared here
    if (!b.labels.length && !b.edges.size) b.findings.add(INSUFFICIENT_EVIDENCE);
    const findings = [...b.findings].sort();
    const cleared = !!opts.clear && findings.length === 0;
    db.prepare(`UPDATE privacy_blocks SET audit = ?${cleared ? ", cleared_at = ?" : ""} WHERE signal_id = ?`)
      .run(JSON.stringify({ at: nowIso(), findings }), ...(cleared ? [nowIso()] : []), b.id);
    out.push({ signal_id: b.id, findings, cleared });
  }
  return out;
}

/**
 * The operator's explicit decision on a block the audit cannot clear for want
 * of evidence (INSUFFICIENT_EVIDENCE): cleared with a reason, logged in the
 * block (privacy_blocks.resolution). Refused while the last audit found
 * anything concrete — a name in the stream is not resolved by a decision.
 */
export function resolvePrivacyBlock(db: DatabaseSync, signalId: string, opts: { reason: string; by: string }): void {
  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) throw new Error("--reason is required (a sentence: why the stream is known to be clean)");
  const results = auditPrivacyStream(db).filter((r) => r.signal_id === signalId);
  const b = db.prepare("SELECT * FROM privacy_blocks WHERE signal_id = ?").get(signalId) as any;
  if (!b) throw new Error(`no privacy block for ${signalId}`);
  if (b.cleared_at) throw new Error(`the block for ${signalId} is already cleared (${b.cleared_at})`);
  const concrete = (results[0]?.findings ?? []).filter((f) => f !== INSUFFICIENT_EVIDENCE);
  if (concrete.length) throw new Error(`refusing: the audit found the author in the stream (${concrete.join("; ")}) — that database must not be published`);
  const at = nowIso();
  db.prepare("UPDATE privacy_blocks SET cleared_at = ?, resolution = ? WHERE signal_id = ?")
    .run(at, JSON.stringify({ at, by: opts.by, reason, findings: results[0]?.findings ?? [] }), signalId);
}
