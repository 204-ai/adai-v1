// The private side of signals (public CRDT sync).
//
// The five CRR tables (nodes, edges, signals, contributors, node_aliases) are
// published as they are: GET /api/sync/changes streams cr-sqlite's own
// crsql_changes, unfiltered, to anyone who forks the commons. So a CRR cell
// only ever holds what the commons would publish; whatever a signal must not
// publish lives in the LOCAL table signal_private (db.sql), keyed by signal
// id, and its CRR cell is blank:
//
//   words  — structural_only (the contributor gave the relations, not their
//            words), revoked, pending review (published on approval),
//            rejected, a note withdrawn before publication, an objection:
//            title, summary, content, source_url, provenance_chain,
//            processing_trace → NULL in the CRR;
//   who    — anonymous: submitted_by → 'anonymous', batch_id and
//            provenance_chain → NULL (correlation handles); the authenticated
//            author stays in signal_authors (local) as for every signal, and
//            the counters credit the anonymous sentinel contributor;
//   before-images — recordPrior's values live in signal_priors (local); the
//            CRR trace keeps {op, node_id, at}. An admin record whose content
//            carried before-images (retire_batch's patches_to_review) keeps
//            the record without the values.
//
// Withholding is an UPDATE of the CRR row (cr-sqlite records it as a cell
// change, so a fork that pulls again loses the words too), always AFTER the
// original was copied to signal_private and checked there. A new signal that
// starts withheld (structural_only, anonymous) is inserted blank — its words
// never touch the CRR. Nothing is deleted: the originals stay on the
// operator's side, read back through the signals_full view.

import { createHash } from "node:crypto";
import { isFormShaped } from "./authorship.js";
import { anonymousGraphAttribution, legacyAnonymousBacklog, recordPrivacyBlocks } from "./privacy-blocks.js";
export { anonymousGraphAttribution, auditPrivacyStream, recordPrivacyBlocks } from "./privacy-blocks.js";
import type { DatabaseSync } from "node:sqlite";

export const WORD_COLS = ["title", "summary", "content", "source_url", "provenance_chain", "processing_trace"] as const;
export const WHO_COLS = ["submitted_by", "batch_id", "provenance_chain"] as const;
export type PrivateCol = (typeof WORD_COLS)[number] | (typeof WHO_COLS)[number];
const ALL_COLS: PrivateCol[] = ["title", "summary", "content", "source_url", "provenance_chain", "processing_trace", "submitted_by", "batch_id"];

export type WithholdReason = "structural_only" | "revoked" | "rejected" | "withdrawn" | "pending" | "pending_name" | "objection" | "anonymous" | "before_images" | "private_batch";

/** Reasons that withhold the words (all but anonymous and before_images). */
const wordReason = (r: string) => r !== "anonymous" && r !== "before_images" && r !== "private_batch" && r !== "pending_name" && r !== "";

/** The name every anonymous signal carries in the CRR, and the sentinel contributor it is credited to. */
export const ANONYMOUS = "anonymous";
export const ANONYMOUS_CONTRIBUTOR_ID = "contributor:anonymous";

/** What a blanked CRR cell holds. */
function blankOf(col: PrivateCol, reason?: WithholdReason): string | null {
  // an anonymous signal says so; a name held back while in review is simply absent
  return col === "submitted_by" && reason !== "pending_name" ? ANONYMOUS : null;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

const tableCache = new WeakMap<DatabaseSync, Map<string, boolean>>();
/** Whether a table exists (a snapshot source or an old file may predate the local tables). */
export function hasTable(db: DatabaseSync, name: string): boolean {
  let m = tableCache.get(db);
  if (!m) { m = new Map(); tableCache.set(db, m); }
  if (!m.has(name)) m.set(name, !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')").get(name));
  return m.get(name)!;
}

function savepoint<T>(db: DatabaseSync, name: string, fn: () => T): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const r = fn();
    db.exec(`RELEASE ${name}`);
    return r;
  } catch (e) {
    try { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); } catch { /* already gone */ }
    throw e;
  }
}

const mergeReasons = (a: string | null | undefined, b: string): string =>
  [...new Set([...(a ? a.split(",") : []), b].filter(Boolean))].sort().join(",");

/** Which columns a reason withholds. */
export function colsFor(reason: WithholdReason): readonly PrivateCol[] {
  if (reason === "anonymous") return WHO_COLS;
  if (reason === "before_images") return ["content"];
  if (reason === "private_batch") return ["title", "content"];
  if (reason === "pending_name") return ["submitted_by"];
  return WORD_COLS;
}

/** Which reasons a signal row's consent alone implies (at insert, and for the migration). */
export function consentReasons(row: { consent_scope?: unknown; consent_attribution?: unknown; status?: unknown }): WithholdReason[] {
  const out: WithholdReason[] = [];
  if (row.consent_scope === "structural_only") out.push("structural_only");
  if (row.status === "revoked") out.push("revoked");
  if (row.consent_attribution === "anonymous") out.push("anonymous");
  return out;
}

function upsertPrivate(db: DatabaseSync, signalId: string, reason: string, originals: Partial<Record<PrivateCol, unknown>>, opts: { bornSafe?: boolean } = {}): void {
  const cols = Object.keys(originals) as PrivateCol[];
  const existing = db.prepare("SELECT * FROM signal_private WHERE signal_id = ?").get(signalId) as any;
  let written: PrivateCol[];
  if (!existing) {
    db.prepare(
      `INSERT INTO signal_private (signal_id, reasons, born_safe${cols.map((c) => `, ${c}`).join("")}) VALUES (?, ?, ?${cols.map(() => ", ?").join("")})`
    ).run(signalId, reason, opts.bornSafe ? 1 : 0, ...cols.map((c) => originals[c] as any));
    written = cols;
  } else {
    // An original already kept is never overwritten (a second withholding
    // sees the blank, not the original). A kept value that DIFFERS from the
    // CRR value about to be blanked is a conflict: abort, never pick one —
    // unless the CRR value is exactly the computed public projection of the
    // kept original (isProjection).
    for (const c of cols) {
      const k = existing[c];
      if (k === null || k === undefined || k === originals[c]) continue;
      if (isProjection(existing, c, originals[c])) continue;
      throw new PrivacyConflictError(signalId, c, k, originals[c]);
    }
    written = cols.filter((c) => existing[c] === null || existing[c] === undefined);
    db.prepare(
      `UPDATE signal_private SET reasons = ?, updated_at = ?, born_safe = CASE WHEN ? THEN 1 ELSE born_safe END${written.map((c) => `, ${c} = ?`).join("")} WHERE signal_id = ?`
    ).run(mergeReasons(existing.reasons, reason), nowIso(), opts.bornSafe ? 1 : 0, ...written.map((c) => originals[c] as any), signalId);
  }
  // Verify before anything is blanked: every original written now is kept, equal.
  const kept = db.prepare("SELECT * FROM signal_private WHERE signal_id = ?").get(signalId) as any;
  for (const c of written) {
    if (originals[c] === null || originals[c] === undefined) continue;
    if (kept?.[c] !== originals[c]) throw new PrivacyConflictError(signalId, c, kept?.[c], originals[c]);
  }
}

/** JSON with sorted keys (undefined dropped), for comparing two projections. */
function canon(v: unknown): string {
  const norm = (x: any): any => (Array.isArray(x) ? x.map(norm) : x && typeof x === "object"
    ? Object.fromEntries(Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => [k, norm(x[k])])) : x);
  return JSON.stringify(norm(v));
}

/**
 * Whether a CRR value is EXACTLY the public projection of the kept original
 * (a before_images record without its values; a private_batch record under
 * its correction id) — computed, not assumed. Anything else is a conflict.
 */
function isProjection(kept: any, col: string, crr: unknown): boolean {
  const reasons = String(kept?.reasons ?? "").split(",");
  const k = kept?.[col];
  if (typeof crr !== "string" || typeof k !== "string") return false;
  if (col === "content" && (reasons.includes("before_images") || reasons.includes("private_batch"))) {
    const full = parse(k);
    const pub = parse(crr);
    if (!full || !pub || typeof full !== "object" || typeof pub !== "object") return false;
    let expected: any = full;
    if (reasons.includes("private_batch")) {
      const cid = pub.correction_id;
      if (typeof cid !== "string" || !/^correction-[0-9a-f]+$/.test(cid)) return false;
      expected = { ...full, batch_id: undefined, correction_id: cid };
    }
    return canon(stripBeforeImages(expected).stripped) === canon(pub);
  }
  if (col === "title" && reasons.includes("private_batch")) {
    return /^Retire batch: correction-[0-9a-f]+$/.test(crr) && k.startsWith("Retire batch: ");
  }
  return false;
}

/** A private value already kept differs from the CRR value about to be blanked. */
export class PrivacyConflictError extends Error {
  constructor(public signalId: string, public col: string, kept: unknown, crr: unknown) {
    super(
      `signal_private conflict on ${signalId}.${col}: the kept original (${String(kept).length} chars) differs from the CRR value ` +
        `(${String(crr).length} chars); nothing blanked — compare signal_private and signals for this id and resolve by hand`
    );
    this.name = "PrivacyConflictError";
  }
}

/**
 * Withhold a signal's private parts: copy the original CRR values to
 * signal_private (verified), then blank the CRR cells with an UPDATE (only
 * cells that are not blank already, so nothing spurious is emitted).
 * `overrides` sets a CRR cell to a given public value instead of the blank
 * (before_images: the record without its values). Idempotent.
 * Returns whether any CRR cell changed.
 */
export function withholdSignal(
  db: DatabaseSync,
  signalId: string,
  reason: WithholdReason,
  opts: { cols?: readonly PrivateCol[]; overrides?: Partial<Record<PrivateCol, string | null>> } = {}
): boolean {
  return savepoint(db, "withhold", () => {
    // before-images first: a trace about to move whole must not carry them
    if (reason !== "anonymous" && reason !== "before_images") movePriorsOf(db, signalId);
    const cols = [...(opts.cols ?? colsFor(reason))];
    const row = db.prepare(`SELECT ${cols.join(", ")} FROM signals WHERE id = ?`).get(signalId) as any;
    if (!row) return false;
    const target = (c: PrivateCol) => (opts.overrides && c in opts.overrides ? opts.overrides[c]! : blankOf(c, reason));
    const originals: Partial<Record<PrivateCol, unknown>> = {};
    for (const c of cols) {
      const v = row[c];
      if (v === null || v === undefined || v === target(c)) continue;
      originals[c] = v;
    }
    upsertPrivate(db, signalId, reason, originals);
    const change = cols.filter((c) => row[c] !== target(c));
    if (!change.length) return false;
    db.prepare(`UPDATE signals SET ${change.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...change.map((c) => target(c)), signalId);
    return true;
  });
}

/** The columns of a signals INSERT that this module may split. */
export interface SignalRow {
  id: string;
  title?: string | null;
  source_url?: string | null;
  source_type?: string | null;
  cla_layer?: string | null;
  summary?: string | null;
  content?: string | null;
  submitted_by?: string | null;
  confidence?: string | null;
  lived_experience?: number | null;
  consent_scope?: string | null;
  consent_attribution?: string | null;
  source_origin?: string | null;
  batch_id?: string | null;
  provenance_chain?: string | null;
  processing_trace?: string | null;
  status?: string | null;
}

/**
 * Insert a signal, its private parts already split off by consent: a
 * structural_only or anonymous signal's words / name reach signal_private
 * only, and the CRR row is born blank. Every signal INSERT goes here.
 */
export function insertSignalRow(db: DatabaseSync, row: SignalRow, extra: WithholdReason[] = []): void {
  savepoint(db, "insert_signal", () => {
    const crr: Record<string, unknown> = { ...row };
    for (const reason of [...consentReasons(row), ...extra]) {
      const originals: Partial<Record<PrivateCol, unknown>> = {};
      for (const c of colsFor(reason)) {
        const v = (row as any)[c];
        if (v !== null && v !== undefined && v !== blankOf(c, reason)) originals[c] = v;
        crr[c] = blankOf(c, reason);
      }
      // born safe: an anonymous signal written by this code never had its name in the CRR
      upsertPrivate(db, row.id, reason, originals, { bornSafe: reason === "anonymous" });
    }
    const cols = Object.keys(crr).filter((k) => crr[k] !== undefined);
    db.prepare(`INSERT INTO signals (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => crr[c] as any));
  });
}

/** A signal with its private originals laid back over it (back office; null when absent). */
export function fullSignal(db: DatabaseSync, signalId: string): any {
  if (!hasTable(db, "signals_full")) return db.prepare("SELECT * FROM signals WHERE id = ?").get(signalId) ?? null;
  return db.prepare("SELECT * FROM signals_full WHERE id = ?").get(signalId) ?? null;
}

/** Whether a signal's words live on the private side (structural_only, revoked, rejected, withdrawn). */
export function wordsWithheld(db: DatabaseSync, signalId: string): boolean {
  if (!hasTable(db, "signal_private")) return false;
  const r = db.prepare("SELECT reasons FROM signal_private WHERE signal_id = ?").get(signalId) as any;
  return !!r && String(r.reasons ?? "").split(",").some(wordReason);
}

/**
 * Lift one reason (a review item approved: 'pending'). When no reason to
 * withhold the words is left, they go back into the CRR (an UPDATE, so forks
 * receive them); the private row stays while another reason (anonymous)
 * needs it, and goes once it holds nothing the CRR does not.
 */
export function publishSignal(db: DatabaseSync, signalId: string, reason: WithholdReason): boolean {
  if (!hasTable(db, "signal_private")) return false;
  return savepoint(db, "publish", () => {
    const p = db.prepare("SELECT * FROM signal_private WHERE signal_id = ?").get(signalId) as any;
    if (!p) return false;
    const reasons = String(p.reasons ?? "").split(",").filter(Boolean);
    if (!reasons.includes(reason)) return false;
    const left = reasons.filter((r) => r !== reason);
    // what the remaining reasons still hold back stays private; the rest goes back
    const still = new Set<string>(left.flatMap((r) => [...colsFor(r as WithholdReason)]));
    const row = db.prepare(`SELECT ${ALL_COLS.join(", ")} FROM signals WHERE id = ?`).get(signalId) as any;
    const back = ALL_COLS.filter((c) => !still.has(c) && p[c] !== null && p[c] !== undefined);
    const write = back.filter((c) => row?.[c] !== p[c]);
    if (write.length) db.prepare(`UPDATE signals SET ${write.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...write.map((c) => p[c]), signalId);
    if (!left.length) db.prepare("DELETE FROM signal_private WHERE signal_id = ?").run(signalId);
    else db.prepare(`UPDATE signal_private SET reasons = ?, updated_at = ?${back.map((c) => `, ${c} = NULL`).join("")} WHERE signal_id = ?`).run(left.join(","), nowIso(), signalId);
    return write.length > 0;
  });
}

/**
 * The signals a review item stands for: its own, the evidence signals its
 * operations name, and — for a URL-intake anchor — every signal of its batch.
 */
export function queueSignals(db: DatabaseSync, queueId: string): string[] {
  const q = db.prepare("SELECT signal_id, proposed_nodes, proposed_edges FROM intake_queue WHERE id = ?").get(queueId) as any;
  if (!q) return [];
  const ids = new Set<string>();
  if (q.signal_id) ids.add(q.signal_id);
  for (const op of parse(q.proposed_nodes) ?? []) if (typeof op?.signal_id === "string") ids.add(op.signal_id);
  for (const e of parse(q.proposed_edges) ?? []) if (typeof e?.signal_id === "string") ids.add(e.signal_id);
  if (q.signal_id) {
    const anchor = db.prepare("SELECT source_type FROM signals WHERE id = ?").get(q.signal_id) as any;
    const batch = hasTable(db, "signals_full") ? (db.prepare("SELECT batch_id FROM signals_full WHERE id = ?").get(q.signal_id) as any)?.batch_id : null;
    if (anchor?.source_type === "api_url_intake" && batch) {
      for (const r of db.prepare("SELECT id FROM signals_full WHERE batch_id = ?").all(batch) as any[]) ids.add(r.id);
    }
  }
  return [...ids];
}

/** A pending review item: every signal it stands for keeps its words private until it is approved. */
export function withholdQueued(db: DatabaseSync, queueId: string): void {
  for (const id of queueSignals(db, queueId)) withholdSignal(db, id, "pending");
}

/** An approved review item: its signals' words are published. */
export function publishQueued(db: DatabaseSync, queueId: string): void {
  for (const id of queueSignals(db, queueId)) {
    publishSignal(db, id, "pending_name");
    publishSignal(db, id, "pending");
  }
}

/** A public-form submission (src/utils/authorship.ts: the one shared predicate). */
export function isFormSubmission(db: DatabaseSync, signalId: string | null | undefined): boolean {
  return isFormShaped(db, signalId);
}

/** Whether a signal's author name is held back while it is in review (the public form). */
export function nameHeldBack(db: DatabaseSync, signalId: string | null | undefined): boolean {
  if (!signalId || !hasTable(db, "signal_private")) return false;
  const r = db.prepare("SELECT reasons FROM signal_private WHERE signal_id = ?").get(signalId) as any;
  return !!r && String(r.reasons ?? "").split(",").includes("pending_name");
}

/**
 * The signals a rejected review item leaves unpublished: its own signal, the
 * evidence signals its operations name, and — for a URL-intake anchor — every
 * signal of that batch; minus any signal an approved item names or a
 * relation was ever made from (those were published). Human contributions
 * only (an AI suggestion's signal is the shared derive run).
 */
export function rejectedSignals(db: DatabaseSync, queueId: string): string[] {
  const q = db.prepare("SELECT kind, status FROM intake_queue WHERE id = ?").get(queueId) as any;
  if (!q || q.status !== "rejected" || (q.kind ?? "human_signal") !== "human_signal") return [];
  const approvedNames = (id: string) => {
    const like = `%${JSON.stringify(id).slice(1, -1)}%`;
    return !!db.prepare(
      "SELECT 1 FROM intake_queue WHERE status = 'approved' AND (signal_id = ? OR proposed_nodes LIKE ? OR proposed_edges LIKE ?) LIMIT 1"
    ).get(id, like, like);
  };
  const anchorsEdge = (id: string) => !!db.prepare("SELECT 1 FROM edges WHERE signal_id = ? OR invalidated_by = ? LIMIT 1").get(id, id);
  return queueSignals(db, queueId).filter((id) => !approvedNames(id) && !anchorsEdge(id));
}

// ---- anonymous ----------------------------------------------------------------------------

/** Whether a signal is anonymous (its consent is in the CRR). */
export function isAnonymousSignal(db: DatabaseSync, signalId: string | null | undefined): boolean {
  if (!signalId) return false;
  const r = db.prepare("SELECT consent_attribution FROM signals WHERE id = ?").get(signalId) as any;
  return r?.consent_attribution === ANONYMOUS;
}

/**
 * The writer label a CRR row gets for a write anchored to `signalId`
 * (edges.created_by — also part of an edge id — and nodes.updated_by): an
 * anonymous signal's writes name no one.
 */
export function writerLabelFor(db: DatabaseSync, signalId: string | null | undefined, label: string): string {
  return isAnonymousSignal(db, signalId) ? ANONYMOUS : label;
}

/** The sentinel contributor anonymous contributions are counted on (created on first use). */
export function ensureAnonymousContributor(db: DatabaseSync): string {
  db.prepare(
    "INSERT OR IGNORE INTO contributors (id, name, type, trust_tier, contributions, approved_count) VALUES (?, ?, 'sentinel', 'probationary', 0, 0)"
  ).run(ANONYMOUS_CONTRIBUTOR_ID, ANONYMOUS);
  return ANONYMOUS_CONTRIBUTOR_ID;
}

/**
 * The contributors row a contribution's counters go to: the anonymous
 * sentinel for an anonymous signal (a real contributor's counter ticking in
 * the same change set as an anonymous signal would name them), else `id`.
 */
export function creditedContributor(db: DatabaseSync, contributorId: string, signalId: string | null | undefined): string {
  return isAnonymousSignal(db, signalId) ? ensureAnonymousContributor(db) : contributorId;
}

// ---- before-images --------------------------------------------------------------------------

export interface PriorEntry {
  op: string;
  node_id: string;
  at: string | null;
  updated_by?: string | null;
  before?: Record<string, unknown> | null;
}

const publicPrior = (p: any) => ({ op: p?.op ?? null, node_id: p?.node_id ?? null, at: p?.at ?? null });

/**
 * Move a signal's before-images out of its CRR processing_trace into
 * signal_priors (idx = position in the list), verified, then rewrite the CRR
 * trace with {op, node_id, at} only. Idempotent; returns how many moved.
 */
export function movePriorsOf(db: DatabaseSync, signalId: string): number {
  const row = db.prepare("SELECT processing_trace FROM signals WHERE id = ?").get(signalId) as any;
  const trace = parse(row?.processing_trace);
  const prior = trace && typeof trace === "object" && !Array.isArray(trace) ? trace.prior : null;
  if (!Array.isArray(prior) || !prior.some((p: any) => p && typeof p === "object" && ("before" in p || "updated_by" in p))) return 0;
  return savepoint(db, "move_priors", () => {
    const ins = db.prepare("INSERT INTO signal_priors (signal_id, idx, op, node_id, at, updated_by, before) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const get = db.prepare("SELECT op, node_id, at, updated_by, before FROM signal_priors WHERE signal_id = ? AND idx = ?");
    let moved = 0;
    prior.forEach((p: any, i: number) => {
      if (!p || typeof p !== "object" || !("before" in p || "updated_by" in p)) return;
      const want = {
        op: String(p.op ?? ""), node_id: String(p.node_id ?? ""), at: p.at ?? null, updated_by: p.updated_by ?? null,
        before: p.before === undefined ? null : JSON.stringify(p.before),
      };
      const same = (k: any) => !!k && k.op === want.op && k.node_id === want.node_id && (k.at ?? null) === want.at && (k.updated_by ?? null) === want.updated_by && (k.before ?? null) === want.before;
      const had = get.get(signalId, i) as any;
      if (had && !same(had)) {
        throw new Error(`signal_priors conflict on ${signalId}[${i}]: a different before-image is already kept; nothing stripped — resolve by hand`);
      }
      if (!had) ins.run(signalId, i, want.op, want.node_id, want.at, want.updated_by, want.before);
      if (!same(get.get(signalId, i))) throw new Error(`signal_priors: ${signalId}[${i}] not kept; refusing to strip it`);
      moved++;
    });
    trace.prior = prior.map(publicPrior);
    db.prepare("UPDATE signals SET processing_trace = ? WHERE id = ?").run(JSON.stringify(trace), signalId);
    return moved;
  });
}

/**
 * Record a before-image for a write anchored to `signalId`: the values go to
 * signal_priors; the CRR trace gets {op, node_id, at} (unless the signal's
 * words are withheld — then its trace lives on the private side only).
 */
export function appendPrior(db: DatabaseSync, signalId: string, entry: PriorEntry): void {
  savepoint(db, "append_prior", () => {
    movePriorsOf(db, signalId);
    const row = db.prepare("SELECT processing_trace FROM signals WHERE id = ?").get(signalId) as any;
    const crrTrace = parse(row?.processing_trace);
    const privTrace = wordsWithheld(db, signalId) ? parse((db.prepare("SELECT processing_trace FROM signal_private WHERE signal_id = ?").get(signalId) as any)?.processing_trace) : null;
    const list = Array.isArray((privTrace ?? crrTrace)?.prior) ? (privTrace ?? crrTrace).prior : [];
    const localMax = (db.prepare("SELECT MAX(idx) AS m FROM signal_priors WHERE signal_id = ?").get(signalId) as any)?.m;
    const idx = Math.max(list.length, localMax === null || localMax === undefined ? 0 : Number(localMax) + 1);
    db.prepare("INSERT INTO signal_priors (signal_id, idx, op, node_id, at, updated_by, before) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(signalId, idx, entry.op, entry.node_id, entry.at, entry.updated_by ?? null, JSON.stringify(entry.before ?? {}));
    // the public stub {op, node_id, at}: in the CRR trace — or, while the
    // signal's words are withheld, in its private trace (published with them)
    updateTrace(db, signalId, (t) => {
      const trace = t && typeof t === "object" && !Array.isArray(t) ? t : {};
      const lst = Array.isArray(trace.prior) ? trace.prior : [];
      while (lst.length < idx) lst.push(null); // keep list index = local idx
      lst[idx] = publicPrior(entry);
      return { ...trace, prior: lst };
    });
  });
}

/**
 * A signal's before-images, oldest first: from signal_priors when it has
 * them; else what its trace holds (a record from before the move, or a fork,
 * where the CRR keeps {op, node_id, at} and `before` is absent).
 */
export function priorsOf(db: DatabaseSync, signalId: string | null | undefined): PriorEntry[] {
  if (!signalId) return [];
  if (hasTable(db, "signal_priors")) {
    const rows = db.prepare("SELECT op, node_id, at, updated_by, before FROM signal_priors WHERE signal_id = ? ORDER BY idx").all(signalId) as any[];
    if (rows.length) return rows.map((r) => ({ op: r.op, node_id: r.node_id, at: r.at ?? null, updated_by: r.updated_by ?? null, before: r.before === null ? null : parse(r.before) }));
  }
  const s = db.prepare("SELECT processing_trace FROM signals WHERE id = ?").get(signalId) as any;
  let trace = parse(s?.processing_trace);
  if (!trace && hasTable(db, "signal_private")) trace = parse((db.prepare("SELECT processing_trace FROM signal_private WHERE signal_id = ?").get(signalId) as any)?.processing_trace);
  const prior = trace?.prior;
  return Array.isArray(prior) ? prior.filter((p: any) => p && typeof p === "object" && p.node_id) : [];
}

/** Every signal that recorded a write to `nodeId` (before-images local or in a trace). */
export function signalsWithPriorsFor(db: DatabaseSync, nodeId: string): string[] {
  const ids = new Set<string>();
  if (hasTable(db, "signal_priors")) for (const r of db.prepare("SELECT DISTINCT signal_id FROM signal_priors WHERE node_id = ?").all(nodeId) as any[]) ids.add(r.signal_id);
  const like = `%${JSON.stringify(nodeId).slice(1, -1)}%`;
  for (const r of db.prepare("SELECT id FROM signals WHERE processing_trace LIKE ?").all(like) as any[]) ids.add(r.id);
  return [...ids];
}

/** An admin record without before-images: retire_batch's patches_to_review lose `before`. */
export function stripBeforeImages(content: unknown): { stripped: any; had: boolean } {
  if (!content || typeof content !== "object" || Array.isArray(content)) return { stripped: content, had: false };
  const c: any = content;
  if (!Array.isArray(c.patches_to_review) || !c.patches_to_review.some((p: any) => p && typeof p === "object" && "before" in p)) return { stripped: content, had: false };
  return { stripped: { ...c, patches_to_review: c.patches_to_review.map((p: any) => { if (!p || typeof p !== "object") return p; const { before: _b, ...rest } = p; return rest; }) }, had: true };
}

// ---- the migration (npm run privacy:migrate) --------------------------------------------------

export interface PrivacyMigrationReport {
  dry_run: boolean;
  priors: { signals: number; entries: number; ids: string[] };
  words: { signals: number; ids: Array<{ id: string; reason: WithholdReason; cols: string[] }> };
  anonymous: { signals: number; ids: string[] };
  admin_before_images: { signals: number; ids: string[] };
  notes: { signals: number; ids: Array<{ id: string; reason: WithholdReason }> };
  rejected: { signals: number; ids: string[] };
  pending: { signals: number; ids: string[] };
  private_batches: { signals: number; ids: string[] };
  /** Rows the migration does NOT move (see PrivacyBacklog.anonymous_graph): clean by hand before enabling sync. */
  anonymous_graph: string[];
  /** After a real run: uncleared privacy_blocks (legacy anonymous signals; sync stays closed until the stream audit clears them). */
  legacy_anonymous_blocks?: number;
  /** After a real run: what is still left to move (must be all zero). */
  left?: PrivacyBacklog;
}

export interface PrivacyBacklog {
  priors: number;
  words: number;
  anonymous: number;
  admin_before_images: number;
  notes: number;
  rejected: number;
  pending: number;
  /** Retirement records naming a private (anonymous) batch handle. */
  private_batches: number;
  /**
   * Legacy anonymous graph attribution — rows an anonymous signal wrote
   * before anonymous writes were labelled: edges whose created_by (or id)
   * names the author, edges referencing those ids, nodes whose updated_by
   * does. NOT moved by the migration (rewriting edge ids and their
   * references is hand work): sync stays closed until it is zero.
   */
  anonymous_graph: number;
  /**
   * Uncleared privacy_blocks plus legacy anonymous signals not recorded yet
   * (src/utils/privacy-blocks.ts): only the operator's stream audit clears them.
   */
  legacy_anonymous: number;
}

const WORDS_PRESENT = WORD_COLS.map((c) => `${c} IS NOT NULL`).join(" OR ");
/** A note that was never published: an objection, one in review, rejected, or withdrawn while in review. */
const UNPUBLISHED_NOTE = "rn.kind = 'objection' OR rn.state IN ('pending', 'rejected') OR (rn.state = 'withdrawn' AND q.status = 'rejected')";

/** Signals of review items still pending whose words are in the CRR. */
function pendingBacklog(db: DatabaseSync): string[] {
  if (!hasTable(db, "intake_queue")) return [];
  const out = new Set<string>();
  const present = db.prepare(`SELECT 1 FROM signals WHERE id = ? AND (${WORDS_PRESENT})`);
  for (const q of db.prepare("SELECT id FROM intake_queue WHERE status = 'pending' AND COALESCE(kind, 'human_signal') = 'human_signal' ORDER BY rowid").all() as any[]) {
    for (const id of queueSignals(db, q.id)) if (present.get(id) || formNameShown(db, id)) out.add(id);
  }
  return [...out];
}

/** A public-form contribution (no authenticated author) in review whose typed name is in the CRR. */
function formNameShown(db: DatabaseSync, signalId: string): boolean {
  if (!hasTable(db, "signal_authors")) return false;
  return isFormShaped(db, signalId) && !!db.prepare(
    `SELECT 1 FROM signals s WHERE s.id = ? AND s.submitted_by IS NOT NULL AND COALESCE(s.consent_attribution, '') != 'anonymous'`
  ).get(signalId);
}

/** Signals whose CRR row still holds what it must not (cheap; the boot check). */
export function privacyBacklog(db: DatabaseSync): PrivacyBacklog {
  const n = (sql: string) => Number((db.prepare(sql).get() as any).n);
  return {
    priors: n(`SELECT COUNT(*) AS n FROM signals WHERE processing_trace LIKE '%"prior"%' AND (processing_trace LIKE '%"before"%' OR processing_trace LIKE '%"updated_by"%')`),
    words: n(`SELECT COUNT(*) AS n FROM signals WHERE (consent_scope = 'structural_only' OR status = 'revoked') AND (${WORDS_PRESENT})`),
    anonymous: n(`SELECT COUNT(*) AS n FROM signals WHERE consent_attribution = 'anonymous' AND (COALESCE(submitted_by, '') != '${ANONYMOUS}' OR batch_id IS NOT NULL OR provenance_chain IS NOT NULL)`),
    admin_before_images: n(`SELECT COUNT(*) AS n FROM signals WHERE source_type = 'api_admin' AND content LIKE '%patches_to_review%' AND content LIKE '%"before"%'`),
    notes: hasTable(db, "relation_notes")
      ? n(`SELECT COUNT(*) AS n FROM signals s JOIN relation_notes rn ON rn.signal_id = s.id
            LEFT JOIN intake_queue q ON q.id = rn.queue_id
           WHERE (${UNPUBLISHED_NOTE}) AND (${WORD_COLS.map((c) => `s.${c} IS NOT NULL`).join(" OR ")})`)
      : 0,
    rejected: rejectedBacklog(db).length,
    pending: pendingBacklog(db).length,
    private_batches: privateBatchRecords(db).length,
    anonymous_graph: anonymousGraphAttribution(db).length,
    legacy_anonymous: legacyAnonymousBacklog(db),
  };
}

export const backlogTotal = (b: PrivacyBacklog) =>
  b.priors + b.words + b.anonymous + b.admin_before_images + b.notes + b.rejected + b.pending + b.private_batches + b.anonymous_graph + b.legacy_anonymous;

/** What the migration can move (everything but legacy anonymous attribution: hand work + the stream audit). */
const movableTotal = (b: PrivacyBacklog) => backlogTotal(b) - b.anonymous_graph - b.legacy_anonymous;

/** Retirement records (api_admin retire_batch) that name a private batch handle in the CRR. */
function privateBatchRecords(db: DatabaseSync): Array<{ id: string; batch_id: string }> {
  const out: Array<{ id: string; batch_id: string }> = [];
  for (const r of db.prepare(`SELECT id, title, content FROM signals WHERE source_type = 'api_admin' AND content LIKE '%"retire_batch"%'`).all() as any[]) {
    const b = parse(r.content)?.batch_id;
    if (typeof b !== "string" || !b) continue;
    const priv = (hasTable(db, "signal_private") && !!db.prepare("SELECT 1 FROM signal_private WHERE batch_id = ? LIMIT 1").get(b))
      || !!db.prepare("SELECT 1 FROM signals WHERE batch_id = ? AND consent_attribution = 'anonymous' LIMIT 1").get(b);
    if (priv) out.push({ id: r.id, batch_id: b });
  }
  return out;
}

/** Signals of rejected human contributions whose words are still in the CRR. */
function rejectedBacklog(db: DatabaseSync): string[] {
  if (!hasTable(db, "intake_queue")) return [];
  const out = new Set<string>();
  const present = db.prepare(`SELECT 1 FROM signals WHERE id = ? AND (${WORDS_PRESENT})`);
  for (const q of db.prepare("SELECT id FROM intake_queue WHERE status = 'rejected' AND COALESCE(kind, 'human_signal') = 'human_signal' ORDER BY rowid").all() as any[]) {
    for (const id of rejectedSignals(db, q.id)) if (present.get(id)) out.add(id);
  }
  return [...out];
}

/**
 * Bring an existing database to the rule: copy every private part to the
 * local tables, verify, then blank its CRR cells. Idempotent (a second run
 * finds nothing); one transaction; dry-run reports what it would move.
 */
export function migratePrivacy(db: DatabaseSync, opts: { dryRun?: boolean } = {}): PrivacyMigrationReport {
  const dryRun = !!opts.dryRun;
  const report: PrivacyMigrationReport = {
    dry_run: dryRun,
    priors: { signals: 0, entries: 0, ids: [] },
    words: { signals: 0, ids: [] },
    anonymous: { signals: 0, ids: [] },
    admin_before_images: { signals: 0, ids: [] },
    notes: { signals: 0, ids: [] },
    rejected: { signals: 0, ids: [] },
    pending: { signals: 0, ids: [] },
    private_batches: { signals: 0, ids: [] },
    anonymous_graph: [],
  };
  const run = () => {
    // 1. before-images
    for (const r of db.prepare(`SELECT id, processing_trace FROM signals WHERE processing_trace LIKE '%"prior"%' ORDER BY rowid`).all() as any[]) {
      const prior = parse(r.processing_trace)?.prior;
      const n = Array.isArray(prior) ? prior.filter((p: any) => p && typeof p === "object" && ("before" in p || "updated_by" in p)).length : 0;
      if (!n) continue;
      report.priors.signals++;
      report.priors.entries += n;
      report.priors.ids.push(r.id);
      if (!dryRun) movePriorsOf(db, r.id);
    }
    // 2. words: structural_only and revoked
    for (const r of db.prepare(`SELECT id, consent_scope, status, ${WORD_COLS.join(", ")} FROM signals WHERE (consent_scope = 'structural_only' OR status = 'revoked') AND (${WORDS_PRESENT}) ORDER BY rowid`).all() as any[]) {
      const reason: WithholdReason = r.status === "revoked" ? "revoked" : "structural_only";
      report.words.signals++;
      report.words.ids.push({ id: r.id, reason, cols: WORD_COLS.filter((c) => r[c] !== null) });
      if (!dryRun) {
        withholdSignal(db, r.id, reason);
        if (r.status === "revoked" && r.consent_scope === "structural_only") withholdSignal(db, r.id, "structural_only");
      }
    }
    // 3. anonymous
    for (const r of db.prepare(`SELECT id FROM signals WHERE consent_attribution = 'anonymous' AND (COALESCE(submitted_by, '') != '${ANONYMOUS}' OR batch_id IS NOT NULL OR provenance_chain IS NOT NULL) ORDER BY rowid`).all() as any[]) {
      report.anonymous.signals++;
      report.anonymous.ids.push(r.id);
      if (!dryRun) withholdSignal(db, r.id, "anonymous");
    }
    // 4. admin records carrying before-images
    for (const r of db.prepare(`SELECT id, content FROM signals WHERE source_type = 'api_admin' AND content LIKE '%patches_to_review%' ORDER BY rowid`).all() as any[]) {
      const { stripped, had } = stripBeforeImages(parse(r.content));
      if (!had) continue;
      report.admin_before_images.signals++;
      report.admin_before_images.ids.push(r.id);
      if (!dryRun) withholdSignal(db, r.id, "before_images", { overrides: { content: JSON.stringify(stripped) } });
    }
    // 5. notes never published: rejected, or withdrawn while in review
    if (hasTable(db, "relation_notes")) {
      for (const r of db.prepare(
        `SELECT s.id, rn.state, rn.kind FROM signals s JOIN relation_notes rn ON rn.signal_id = s.id LEFT JOIN intake_queue q ON q.id = rn.queue_id
          WHERE (${UNPUBLISHED_NOTE}) AND (${WORD_COLS.map((c) => `s.${c} IS NOT NULL`).join(" OR ")})`
      ).all() as any[]) {
        const reason: WithholdReason = r.kind === "objection" ? "objection" : r.state === "pending" ? "pending" : r.state === "rejected" ? "rejected" : "withdrawn";
        report.notes.signals++;
        report.notes.ids.push({ id: r.id, reason });
        if (!dryRun) withholdSignal(db, r.id, reason);
      }
    }
    // 6. contributions a curator rejected: never published
    for (const id of rejectedBacklog(db)) {
      report.rejected.signals++;
      report.rejected.ids.push(id);
      if (!dryRun) withholdSignal(db, id, "rejected");
    }
    // 7. contributions still in review: published when approved
    for (const id of pendingBacklog(db)) {
      report.pending.signals++;
      report.pending.ids.push(id);
      if (!dryRun) {
        const form = formNameShown(db, id);
        withholdSignal(db, id, "pending");
        if (form) withholdSignal(db, id, "pending_name");
      }
    }
    // 8. retirement records naming a private batch handle (after step 3 moved the handles)
    for (const r of privateBatchRecords(db)) {
      report.private_batches.signals++;
      report.private_batches.ids.push(r.id);
      if (!dryRun) {
        const full = parse(fullSignal(db, r.id)?.content) ?? {};
        const correction = `correction-${createHash("sha256").update(r.id).digest("hex").slice(0, 12)}`;
        const { stripped } = stripBeforeImages({ ...full, batch_id: undefined, correction_id: correction });
        withholdSignal(db, r.id, "private_batch", { overrides: { title: `Retire batch: ${correction}`, content: JSON.stringify(stripped) } });
      }
    }
  };
  if (dryRun) {
    run();
    report.anonymous_graph = anonymousGraphAttribution(db);
    return report;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    run();
    const left = privacyBacklog(db);
    if (movableTotal(left)) throw new Error(`privacy migration left rows behind: ${JSON.stringify(left)}`);
    report.left = left;
    report.anonymous_graph = anonymousGraphAttribution(db);
    report.legacy_anonymous_blocks = recordPrivacyBlocks(db);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
  return report;
}

/** Every column that may be withheld, for back-office readers. */
export const PRIVATE_COLS = ALL_COLS;

/**
 * Change a signal's processing_trace: on the private side when its words are
 * withheld (its CRR trace stays blank), else in the CRR.
 */
export function updateTrace(db: DatabaseSync, signalId: string, fn: (trace: any) => any): void {
  if (wordsWithheld(db, signalId)) {
    const priv = db.prepare("SELECT processing_trace FROM signal_private WHERE signal_id = ?").get(signalId) as any;
    const next = fn(parse(priv.processing_trace) ?? {});
    db.prepare("UPDATE signal_private SET processing_trace = ?, updated_at = ? WHERE signal_id = ?").run(JSON.stringify(next), nowIso(), signalId);
    return;
  }
  const row = db.prepare("SELECT processing_trace FROM signals WHERE id = ?").get(signalId) as any;
  if (!row) return;
  const next = fn(parse(row.processing_trace) ?? {});
  db.prepare("UPDATE signals SET processing_trace = ? WHERE id = ?").run(JSON.stringify(next), signalId);
}
