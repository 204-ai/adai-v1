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

/** Decode cr-sqlite's packed primary key (crsql_changes.pk). */
export function decodePk(pk: Uint8Array): Array<string | number | bigint | null | Uint8Array> {
  const b = Buffer.from(pk);
  let i = 0;
  const n = b[i++]!;
  const out: Array<string | number | bigint | null | Uint8Array> = [];
  const uint = (len: number) => { let v = 0; for (let k = 0; k < len; k++) v = v * 256 + b[i++]!; return v; };
  for (let c = 0; c < n; c++) {
    const h = b[i++]!;
    const type = h & 7;
    const len = h >> 3;
    if (type === 0) out.push(null);
    else if (type === 1) {
      let v = 0n;
      for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(b[i++]!);
      if (len && v >= 1n << BigInt(8 * len - 1)) v -= 1n << BigInt(8 * len); // two's complement
      out.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
    } else if (type === 2) { out.push(b.readDoubleBE(i)); i += 8; }
    else if (type === 3) { const l = uint(len); out.push(b.toString("utf8", i, i + l)); i += l; }
    else if (type === 4) { const l = uint(len); out.push(new Uint8Array(b.subarray(i, i + l))); i += l; }
    else throw new Error(`unknown packed type ${type}`);
  }
  return out;
}

/** Anonymous signals not born safe (their author's name may be in the stream), with the name when known. */
export function legacyAnonymousSignals(db: DatabaseSync): Array<{ id: string; name: string | null }> {
  const bornSafe = hasTable(db, "signal_private")
    ? "AND NOT EXISTS (SELECT 1 FROM signal_private p WHERE p.signal_id = s.id AND p.born_safe = 1)"
    : "";
  const rows = db.prepare(`SELECT s.id, s.submitted_by FROM signals s WHERE s.consent_attribution = 'anonymous' ${bornSafe}`).all() as any[];
  return rows.map((r) => {
    const kept = hasTable(db, "signal_private") ? (db.prepare("SELECT submitted_by FROM signal_private WHERE signal_id = ?").get(r.id) as any)?.submitted_by : null;
    const name = kept ?? (r.submitted_by !== ANONYMOUS ? r.submitted_by : null);
    return { id: r.id, name: typeof name === "string" && name ? name : null };
  });
}

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
    const labels = authorLabels(s.name);
    const edges = unsafeEdgesOf(db, s.id, labels);
    const nodes = nodesWrittenBy(db, s.id);
    const b = db.prepare("SELECT * FROM privacy_blocks WHERE signal_id = ?").get(s.id) as any;
    if (!b) {
      db.prepare("INSERT INTO privacy_blocks (signal_id, labels, edge_ids, node_ids) VALUES (?, ?, ?, ?)")
        .run(s.id, JSON.stringify(labels), JSON.stringify(edges.sort()), JSON.stringify(nodes.sort()));
      continue;
    }
    db.prepare(`UPDATE privacy_blocks SET labels = ?, edge_ids = ?, node_ids = ?${b.cleared_at && edges.length ? ", cleared_at = NULL" : ""} WHERE signal_id = ?`)
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
    const findings = [...b.findings].sort();
    const cleared = !!opts.clear && findings.length === 0;
    db.prepare(`UPDATE privacy_blocks SET audit = ?${cleared ? ", cleared_at = ?" : ""} WHERE signal_id = ?`)
      .run(JSON.stringify({ at: nowIso(), findings }), ...(cleared ? [nowIso()] : []), b.id);
    out.push({ signal_id: b.id, findings, cleared });
  }
  return out;
}
