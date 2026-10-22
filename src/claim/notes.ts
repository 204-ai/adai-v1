// A claimant's word on what the graph says about them (docs/CLAIM-SPEC.md §4).
//
//   contest   — on a live relation or a metadata edit touching a node they
//               claimed. Public at once ("contested by the subject"); the
//               relation stays live. A curator upholds it (the relation ends
//               bi-temporally / the key goes back to its before-image) or
//               dismisses it (the mark comes off; the record stays).
//   context   — a note on a live relation, shown with it. Gated by trust
//               tier like every other write: auto/reviewed live, else queued.
//   objection — on a PENDING queue item about their node. No queue row of
//               its own: the curator sees it on the item; the item's
//               outcome settles it.
//   reading   — issue #80 part 3: ANY contributor's labelled reading of one
//               live relation ("a reading by X"), never the subject's voice —
//               a claimant who wants to speak as the subject adds context.
//               Same tier gate as context (auto/reviewed live, else queued
//               for /review); consent as on every signal; shown only while
//               its relation is live. Written by fileReading, not fileNote
//               (no claim needed).
//
// Users never approve anything: moderators do. Every note is a signal (the
// public record, consent-aware) plus a relation_notes row (the index).
//
// Peer invites live here too: a claimed person invites the other end of one
// of their relations; the invitee's claim is instant (§4.3).

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isAutoMerge, type AuthedContributor } from "../auth.js";
import { insertSignal, priorValues, recordPrior } from "../utils/contribution.js";
import { insertAdminSignal } from "../utils/admin-actions.js";
import { tripleKey } from "../utils/claims.js";
import { ClaimError, CLAIMABLE_TYPES, approvedClaimsFor, claimedNodeIds, hasApprovedClaim, requestClaim, contributorById, type Claim } from "./store.js";

export type NoteKind = "contest" | "context" | "objection" | "reading";

export interface RelationRef {
  source_id: string;
  edge_type: string;
  target_id: string;
}

export interface RelationNote {
  signal_id: string;
  kind: NoteKind;
  relation: RelationRef | null;
  meta_key: string | null;
  edit_signal_id: string | null;
  queue_ref: string | null;
  node_id: string;
  contributor_id: string;
  by: string | null; // claimant display name
  handle: string | null;
  note: string;
  state: string;
  queue_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
  created_at: string | null;
  /** A reading's source (an essay, a review) — set by publicNotesFor, null when withheld. */
  source_url?: string | null;
  // Set by publicNotesFor (the one filter every public surface uses):
  anonymous?: boolean;    // by / handle already blanked
  withheld?: boolean;     // structural_only: note already blanked
  subject_now?: boolean;  // the writer still holds an approved claim on node_id
}

const NOTE_MAX = 2000;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function rowToNote(r: any): RelationNote {
  return {
    signal_id: r.signal_id,
    kind: r.kind,
    relation: r.source_id ? { source_id: r.source_id, edge_type: r.edge_type, target_id: r.target_id } : null,
    meta_key: r.meta_key ?? null,
    edit_signal_id: r.edit_signal_id ?? null,
    queue_ref: r.queue_ref ?? null,
    node_id: r.node_id,
    contributor_id: r.contributor_id,
    by: r.by_name ?? null,
    handle: r.handle ?? null,
    note: r.note,
    state: r.state,
    queue_id: r.queue_id ?? null,
    resolved_by: r.resolved_by ?? null,
    resolved_at: r.resolved_at ?? null,
    resolution: r.resolution ?? null,
    created_at: r.created_at ?? null,
  };
}

const NOTE_SELECT = `SELECT rn.*, c.name AS by_name, json_extract(n.metadata, '$.claimed.handle') AS handle
  FROM relation_notes rn
  LEFT JOIN contributors c ON c.id = rn.contributor_id
  LEFT JOIN nodes n ON n.id = rn.node_id`;

export function getNote(db: DatabaseSync, signalId: string): RelationNote | null {
  const r = db.prepare(`${NOTE_SELECT} WHERE rn.signal_id = ?`).get(signalId);
  return r ? rowToNote(r) : null;
}

export function noteByQueueId(db: DatabaseSync, queueId: string): RelationNote | null {
  const r = db.prepare(`${NOTE_SELECT} WHERE rn.queue_id = ?`).get(queueId);
  return r ? rowToNote(r) : null;
}

/** The public predicate: which notes, on what, still standing — shared by the list, its pages and its count. */
const PUBLIC_NOTES_FROM = `
         FROM relation_notes rn
         LEFT JOIN signals s ON s.id = rn.signal_id
        WHERE ((rn.kind = 'contest' AND rn.state = 'open') OR (rn.kind = 'context' AND rn.state = 'live')
               -- a reading stands only while its relation does (a retired node's
               -- relations are superseded, so its readings go with them)
               OR (rn.kind = 'reading' AND rn.state = 'live' AND EXISTS (
                    SELECT 1 FROM edges le WHERE le.source_id = rn.source_id AND le.edge_type = rn.edge_type AND le.target_id = rn.target_id
                       AND le.valid_until IS NULL AND COALESCE(le.created_by, '') != 'embedding-multimodal-v1')))
          AND (rn.source_id = :node OR rn.target_id = :node OR (rn.meta_key IS NOT NULL AND rn.node_id = :node))
          AND COALESCE(s.status, 'active') = 'active'`;

/**
 * Notes the public sees: open contests and live context notes, on relations /
 * keys touching `nodeId` — the one filter for every public surface (profile,
 * record, accounts, /me). A note whose signal was revoked or superseded is
 * left out; consent is applied here: anonymous blanks who wrote it (by,
 * handle), structural_only blanks the words. `subject_now` says whether the
 * writer still holds an approved claim on the node it wrote from — only then
 * may a page call it the subject speaking, or show the node's handle as its
 * byline. Optionally one page: after a (created_at, signal_id) cursor, in
 * that order, `limit` long — paged in SQL.
 */
export function publicNotesFor(db: DatabaseSync, nodeId: string, page: { after?: { at: string; id: string } | null; limit?: number } = {}): RelationNote[] {
  const cursor = page.after ?? null;
  return (db
    .prepare(
      `SELECT rn.*, c.name AS by_name, json_extract(n.metadata, '$.claimed.handle') AS handle,
              s.consent_scope, s.consent_attribution, s.source_url AS signal_source_url,
              EXISTS (SELECT 1 FROM node_claims k WHERE k.contributor_id = rn.contributor_id AND k.node_id = rn.node_id AND k.status = 'approved') AS subject_now
         ${PUBLIC_NOTES_FROM.replace("FROM relation_notes rn", `FROM relation_notes rn
         LEFT JOIN contributors c ON c.id = rn.contributor_id
         LEFT JOIN nodes n ON n.id = rn.node_id`)}
          AND (:cursor = 0 OR rn.created_at > :at OR (rn.created_at = :at AND rn.signal_id > :id))
        ORDER BY rn.created_at ASC, rn.signal_id ASC
        LIMIT :limit`
    )
    .all({ node: nodeId, cursor: cursor ? 1 : 0, at: cursor?.at ?? "", id: cursor?.id ?? "", limit: page.limit ?? -1 }) as any[]).map((r) => {
      const n = rowToNote(r);
      n.anonymous = r.consent_attribution === "anonymous";
      n.withheld = r.consent_scope === "structural_only";
      n.subject_now = !!r.subject_now;
      if (n.kind === "reading") {
        // A reading is never the subject speaking, whoever wrote it — not even
        // a claimant (they use context) — and never under the page's handle.
        n.subject_now = false;
        n.handle = null;
        n.source_url = !n.withheld && typeof r.signal_source_url === "string" && /^https?:\/\//i.test(r.signal_source_url) ? r.signal_source_url : null;
      }
      // anonymous: nothing that would name the writer — not their name, the
      // handle, their contributor id, or the page they wrote from (the /me log
      // hands these notes to the other end as JSON)
      if (n.anonymous) { n.by = null; n.handle = null; n.contributor_id = ""; n.node_id = ""; n.queue_id = null; }
      if (n.withheld) n.note = "";
      return n;
    });
}

/** How many notes publicNotesFor would list (the same predicate). */
export function countPublicNotes(db: DatabaseSync, nodeId: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n ${PUBLIC_NOTES_FROM}`).get({ node: nodeId }) as any).n);
}

/** One note of the curator's audit view: everything, with its standing spelled out. */
export interface AuditNote extends RelationNote {
  signal_status: string;
  consent_scope: string | null;
  consent_attribution: string | null;
}

/**
 * The curator's view (the record page, curators only): every note touching
 * the node — any kind, any state, revoked signals, anonymous authors and
 * structural_only words included — never filtered, so a curator can see
 * what the public filter hides and why. Not for any public surface.
 */
export function auditNotesFor(db: DatabaseSync, nodeId: string): AuditNote[] {
  return (db
    .prepare(
      `SELECT rn.*, c.name AS by_name, json_extract(n.metadata, '$.claimed.handle') AS handle,
              s.consent_scope, s.consent_attribution, COALESCE(s.status, 'active') AS signal_status,
              EXISTS (SELECT 1 FROM node_claims k WHERE k.contributor_id = rn.contributor_id AND k.node_id = rn.node_id AND k.status = 'approved') AS subject_now
         FROM relation_notes rn
         LEFT JOIN contributors c ON c.id = rn.contributor_id
         LEFT JOIN nodes n ON n.id = rn.node_id
         LEFT JOIN signals s ON s.id = rn.signal_id
        -- the audit reaches every note written from or about the node: an
        -- objection carries only node_id + queue_ref, no relation or key
        WHERE rn.source_id = ? OR rn.target_id = ? OR rn.node_id = ?
        ORDER BY rn.created_at ASC, rn.signal_id ASC`
    )
    .all(nodeId, nodeId, nodeId) as any[]).map((r) => ({
      ...rowToNote(r),
      subject_now: !!r.subject_now,
      signal_status: r.signal_status,
      consent_scope: r.consent_scope ?? null,
      consent_attribution: r.consent_attribution ?? null,
    }));
}

/**
 * Who wrote a public note, as a page may say it: the node's handle and "the
 * subject" only while the writer's claim stands; once it ended, the writer's
 * own name (another claimant may hold the handle now).
 */
export function noteAuthor(n: RelationNote): { who: string; subject: boolean } {
  if (n.anonymous) return { who: "someone", subject: false };
  // a reading: the writer by their own name, never the subject, never the handle
  if (n.kind === "reading") return { who: n.by ?? "a contributor", subject: false };
  const standing = n.subject_now !== false; // notes outside publicNotesFor carry no flag: as before
  const who = standing && n.handle ? `@${n.handle}` : n.by ?? "a contributor";
  return { who, subject: standing };
}

/** Group notes by relation triple (tripleKey), for the profile's relation list. */
export function notesByTriple(notes: RelationNote[]): Map<string, RelationNote[]> {
  const m = new Map<string, RelationNote[]>();
  for (const n of notes) {
    if (!n.relation) continue;
    const k = tripleKey(n.relation);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(n);
  }
  return m;
}

/** Every relation triple with an open contest (for /api/graph's `contested` flag). */
export function contestedTriples(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT source_id, edge_type, target_id FROM relation_notes WHERE kind = 'contest' AND state = 'open' AND source_id IS NOT NULL")
    .all() as any[];
  return new Set(rows.map((r) => tripleKey(r)));
}

export function notesByContributor(db: DatabaseSync, contributorId: string): RelationNote[] {
  return (db.prepare(`${NOTE_SELECT} WHERE rn.contributor_id = ? ORDER BY rn.created_at DESC`).all(contributorId) as any[]).map(rowToNote);
}

export function objectionsFor(db: DatabaseSync, queueId: string): RelationNote[] {
  return (db.prepare(`${NOTE_SELECT} WHERE rn.queue_ref = ? ORDER BY rn.created_at ASC`).all(queueId) as any[]).map(rowToNote);
}

// ---- writing notes ------------------------------------------------------------------

export interface FileNoteArgs {
  contributor: AuthedContributor;
  kind: NoteKind;
  node_id: string;          // the claimed node the note is written from
  note: string;
  relation?: RelationRef;   // contest / context on a relation
  edit?: { key: string; signal_id: string }; // contest on a metadata edit
  queue_id?: string;        // objection to a pending item
}

function liveRelation(db: DatabaseSync, r: RelationRef): boolean {
  return !!db
    .prepare("SELECT 1 FROM edges WHERE source_id = ? AND edge_type = ? AND target_id = ? AND valid_until IS NULL AND created_by != 'embedding-multimodal-v1' LIMIT 1")
    .get(r.source_id, r.edge_type, r.target_id);
}

function nodeName(db: DatabaseSync, id: string): string {
  const r = db.prepare("SELECT name FROM nodes WHERE id = ?").get(id) as any;
  return r?.name ?? id;
}

/** Pending queue rows whose proposal touches `nodeId` (target, edge end, or patched node). */
export function queueItemTouches(db: DatabaseSync, queueId: string, nodeId: string): boolean {
  const q = db.prepare("SELECT target_node, proposed_nodes, proposed_edges FROM intake_queue WHERE id = ?").get(queueId) as any;
  if (!q) return false;
  if (q.target_node === nodeId) return true;
  for (const e of parse(q.proposed_edges) ?? []) if (e?.source_id === nodeId || e?.target_id === nodeId) return true;
  for (const op of parse(q.proposed_nodes) ?? []) if (op?.node_id === nodeId) return true;
  return false;
}

export function fileNote(db: DatabaseSync, args: FileNoteArgs): RelationNote {
  const note = typeof args.note === "string" ? args.note.trim() : "";
  if (!note) throw new ClaimError(400, "note_required", "say why, in a sentence or two");
  if (note.length > NOTE_MAX) throw new ClaimError(400, "note_too_long", `at most ${NOTE_MAX} characters`);
  if (!hasApprovedClaim(db, args.contributor.id, args.node_id)) {
    throw new ClaimError(403, "not_claimant", "you can only speak for a page you have claimed");
  }

  let title: string;
  let content: Record<string, unknown>;
  let rel: RelationRef | null = null;
  let metaKey: string | null = null;
  let editSignal: string | null = null;
  let queueRef: string | null = null;

  if (args.kind === "objection") {
    if (!args.queue_id) throw new ClaimError(400, "queue_id_required", "an objection names the pending item");
    const q = db.prepare("SELECT id, status FROM intake_queue WHERE id = ?").get(args.queue_id) as any;
    if (!q || q.status !== "pending") throw new ClaimError(404, "not_pending", "that item is no longer pending");
    if (!queueItemTouches(db, args.queue_id, args.node_id)) throw new ClaimError(403, "not_about_you", "that item is not about your page");
    queueRef = args.queue_id;
    title = `Objection: ${nodeName(db, args.node_id)}`;
    content = { action: "objection", queue_id: queueRef, node_id: args.node_id, note };
  } else if (args.edit) {
    if (args.kind !== "contest") throw new ClaimError(400, "bad_kind", "only a contest can target a metadata edit");
    metaKey = String(args.edit.key ?? "");
    editSignal = String(args.edit.signal_id ?? "");
    if (!metaKey || !editSignal) throw new ClaimError(400, "edit_required", "edit needs {key, signal_id}");
    title = `Contest: ${nodeName(db, args.node_id)} · ${metaKey}`;
    content = { action: "contest", edit: { node_id: args.node_id, key: metaKey, signal_id: editSignal }, note };
  } else {
    const r = args.relation;
    if (!r?.source_id || !r.edge_type || !r.target_id) throw new ClaimError(400, "relation_required", "relation needs {source_id, edge_type, target_id}");
    if (r.source_id !== args.node_id && r.target_id !== args.node_id) throw new ClaimError(403, "not_about_you", "that relation does not touch your page");
    if (!liveRelation(db, r)) throw new ClaimError(404, "relation_not_live", "no live relation like that");
    rel = { source_id: r.source_id, edge_type: r.edge_type, target_id: r.target_id };
    const open = db
      .prepare("SELECT signal_id FROM relation_notes WHERE kind = ? AND contributor_id = ? AND source_id = ? AND edge_type = ? AND target_id = ? AND state IN ('open','pending','live')")
      .get(args.kind, args.contributor.id, rel.source_id, rel.edge_type, rel.target_id) as any;
    if (open && args.kind === "contest") throw new ClaimError(409, "already_contested", "you already contest this relation");
    title = `${args.kind === "contest" ? "Contest" : "Context"}: ${nodeName(db, rel.source_id)} ${rel.edge_type} ${nodeName(db, rel.target_id)}`;
    content = { action: args.kind, relation: rel, node_id: args.node_id, note };
  }

  const autoLive = args.kind === "context" && isAutoMerge(args.contributor.trust_tier);
  const state = args.kind === "context" ? (autoLive ? "live" : "pending") : "open";

  db.exec("BEGIN");
  try {
    const signalId = insertSignal(db, {
      contributor: args.contributor,
      title,
      content: JSON.stringify(content),
      source_type: args.kind === "objection" ? "subject_objection" : `subject_${args.kind}`,
      source_origin: "human_primary",
    });
    db.prepare("UPDATE signals SET lived_experience = 1 WHERE id = ?").run(signalId);
    let queueId: string | null = null;
    if (args.kind !== "objection") {
      queueId = `intake-${crypto.randomBytes(8).toString("hex")}`;
      db.prepare(
        "INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status, kind, proposed_edges, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        queueId, signalId, args.node_id, args.contributor.name, args.contributor.trust_tier,
        autoLive ? "approved" : "pending", args.kind,
        rel ? JSON.stringify([rel]) : null,
        autoLive ? "auto" : null, autoLive ? nowIso() : null
      );
    }
    db.prepare(
      `INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, meta_key, edit_signal_id, queue_ref, node_id, contributor_id, note, state, queue_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(signalId, args.kind, rel?.source_id ?? null, rel?.edge_type ?? null, rel?.target_id ?? null, metaKey, editSignal, queueRef, args.node_id, args.contributor.id, note, state, queueId);
    db.exec("COMMIT");
    return getNote(db, signalId)!;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

// ---- readings (issue #80 part 3) ----------------------------------------------------

export interface FileReadingArgs {
  contributor: AuthedContributor;
  relation: RelationRef;
  note: string;
  source_url?: string | null;          // the essay / review the reading comes from
  consent_scope?: string | null;       // full_commons (default) | structural_only
  consent_attribution?: string | null; // attributed (default) | anonymous | attributed_with_notification
  batch_id?: string | null;
}

/**
 * Any contributor's reading of one live relation. Not a claim note: no claim
 * is needed and none is implied — the page labels it "a reading by X", even
 * when X happens to claim one end. Tier-gated like context: auto / reviewed
 * publish at once, probationary go to /review (kind 'reading').
 */
/** Readings a contributor may file: per day, and in any one minute — one quota whichever way they sign in. */
export const READINGS_PER_DAY = 30;
export const READINGS_PER_MINUTE = 5;

function readingQuota(db: DatabaseSync, contributorId: string): void {
  const since = (ms: number) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const count = (ms: number) => Number((db.prepare("SELECT COUNT(*) AS n FROM relation_notes WHERE kind = 'reading' AND contributor_id = ? AND created_at >= ?").get(contributorId, since(ms)) as any).n);
  if (count(60_000) >= READINGS_PER_MINUTE) throw new ClaimError(429, "too_many_readings", `at most ${READINGS_PER_MINUTE} readings a minute — slow down`);
  if (count(86_400_000) >= READINGS_PER_DAY) throw new ClaimError(429, "too_many_readings", `at most ${READINGS_PER_DAY} readings a day`);
}

export function fileReading(db: DatabaseSync, args: FileReadingArgs): RelationNote {
  const note = typeof args.note === "string" ? args.note.trim() : "";
  if (!note) throw new ClaimError(400, "note_required", "write the reading, in a sentence or more");
  if (note.length > NOTE_MAX) throw new ClaimError(400, "note_too_long", `at most ${NOTE_MAX} characters`);
  const r = args.relation;
  if (!r?.source_id || !r.edge_type || !r.target_id) throw new ClaimError(400, "relation_required", "relation needs {source_id, edge_type, target_id}");
  if (!liveRelation(db, r)) throw new ClaimError(404, "relation_not_live", "no live relation like that");
  const retired = db
    .prepare("SELECT 1 FROM nodes WHERE id IN (?, ?) AND json_extract(metadata, '$.retired') IS 1 LIMIT 1")
    .get(r.source_id, r.target_id);
  if (retired) throw new ClaimError(404, "relation_not_live", "one end of that relation is retired");
  const srcUrl = args.source_url == null || args.source_url === "" ? null : String(args.source_url).trim();
  if (srcUrl !== null && (!/^https?:\/\//i.test(srcUrl) || srcUrl.length > 2000)) throw new ClaimError(400, "bad_source_url", "source_url must be an http(s) URL");
  const rel: RelationRef = { source_id: r.source_id, edge_type: r.edge_type, target_id: r.target_id };
  const same = db
    .prepare("SELECT 1 FROM relation_notes WHERE kind = 'reading' AND contributor_id = ? AND source_id = ? AND edge_type = ? AND target_id = ? AND note = ? AND state IN ('pending','live')")
    .get(args.contributor.id, rel.source_id, rel.edge_type, rel.target_id, note);
  if (same) throw new ClaimError(409, "already_read", "you already gave this reading of this relation");
  readingQuota(db, args.contributor.id);

  const autoLive = isAutoMerge(args.contributor.trust_tier);
  db.exec("BEGIN");
  try {
    const signalId = insertSignal(db, {
      contributor: args.contributor,
      title: `Reading: ${nodeName(db, rel.source_id)} ${rel.edge_type} ${nodeName(db, rel.target_id)}`,
      content: JSON.stringify({ action: "reading", relation: rel, note }),
      source_url: srcUrl,
      source_type: "reading",
      source_origin: "human_primary",
      consent_scope: args.consent_scope ?? undefined,
      consent_attribution: args.consent_attribution ?? undefined,
      batch_id: args.batch_id ?? null,
    });
    const queueId = `intake-${crypto.randomBytes(8).toString("hex")}`;
    db.prepare(
      "INSERT INTO intake_queue (id, signal_id, target_node, submitted_by, trust_tier, status, kind, proposed_edges, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, 'reading', ?, ?, ?)"
    ).run(
      queueId, signalId, rel.source_id, args.contributor.name, args.contributor.trust_tier,
      autoLive ? "approved" : "pending", JSON.stringify([rel]),
      autoLive ? "auto" : null, autoLive ? nowIso() : null
    );
    // node_id: what the reading is about (the relation's source) — no claim implied
    db.prepare(
      `INSERT INTO relation_notes (signal_id, kind, source_id, edge_type, target_id, node_id, contributor_id, note, state, queue_id)
       VALUES (?, 'reading', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(signalId, rel.source_id, rel.edge_type, rel.target_id, rel.source_id, args.contributor.id, note, autoLive ? "live" : "pending", queueId);
    db.exec("COMMIT");
    return getNote(db, signalId)!;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/** The claimant takes back their own context note or open contest (or any author their reading). */
export function withdrawNote(db: DatabaseSync, signalId: string, contributorId: string): RelationNote {
  const n = getNote(db, signalId);
  if (!n) throw new ClaimError(404, "note_not_found", signalId);
  if (n.contributor_id !== contributorId) throw new ClaimError(403, "not_your_note", "only its author can withdraw a note");
  if (!["open", "pending", "live"].includes(n.state)) throw new ClaimError(409, "note_settled", `note is ${n.state}`);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE relation_notes SET state = 'withdrawn', resolved_by = ?, resolved_at = ? WHERE signal_id = ?").run("author", nowIso(), signalId);
    // an admin revocation stands: the author cannot turn 'revoked' back into 'superseded'
    db.prepare("UPDATE signals SET status = 'superseded' WHERE id = ? AND status != 'revoked'").run(signalId);
    if (n.queue_id) {
      db.prepare("UPDATE intake_queue SET status = 'rejected', rejection_reason = 'withdrawn by author', reviewed_by = 'author', reviewed_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso(), n.queue_id);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
  return getNote(db, signalId)!;
}

// ---- curator resolution --------------------------------------------------------------

/**
 * Uphold a contest. A relation: every live claim row of the triple is
 * superseded by one admin signal. A metadata edit: the key goes back to the
 * before-image that edit recorded (when it recorded one).
 */
export function upholdContest(db: DatabaseSync, queueId: string, opts: { by: string; reason?: string | null }): { edges_ended: number; restored: boolean } {
  const n = noteByQueueId(db, queueId);
  if (!n || n.kind !== "contest") throw new ClaimError(404, "contest_not_found", queueId);
  if (n.state !== "open") throw new ClaimError(409, "contest_settled", `contest is ${n.state}`);
  const anchor = insertAdminSignal(db, {
    by: opts.by,
    title: `Contest upheld: ${n.relation ? `${n.relation.source_id} ${n.relation.edge_type} ${n.relation.target_id}` : `${n.node_id} · ${n.meta_key}`}`,
    content: { action: "uphold_contest", contest_signal_id: n.signal_id, relation: n.relation, edit: n.meta_key ? { key: n.meta_key, signal_id: n.edit_signal_id } : null, reason: opts.reason ?? null },
  });
  let edges = 0;
  let restored = false;
  if (n.relation) {
    const r = db
      .prepare("UPDATE edges SET valid_until = strftime('%Y-%m-%dT%H:%M:%SZ','now'), invalidated_by = ? WHERE source_id = ? AND edge_type = ? AND target_id = ? AND valid_until IS NULL")
      .run(anchor, n.relation.source_id, n.relation.edge_type, n.relation.target_id);
    edges = Number(r.changes);
  } else if (n.meta_key && n.edit_signal_id) {
    const sig = db.prepare("SELECT processing_trace FROM signals WHERE id = ?").get(n.edit_signal_id) as any;
    const prior = (parse(sig?.processing_trace)?.prior ?? []).find((p: any) => p?.node_id === n.node_id && p?.before && n.meta_key! in p.before);
    if (prior) {
      const row = db.prepare("SELECT metadata, updated_by FROM nodes WHERE id = ?").get(n.node_id) as any;
      const base = parse(row?.metadata) ?? {};
      recordPrior(db, anchor, { op: "patch_node", node_id: n.node_id, updated_by: row?.updated_by ?? null, before: priorValues(base, [n.meta_key]) });
      const old = prior.before[n.meta_key];
      if (old === null || old === undefined) delete base[n.meta_key];
      else base[n.meta_key] = old;
      db.prepare("UPDATE nodes SET metadata = ?, updated_by = ? WHERE id = ?").run(JSON.stringify(base), `api-${opts.by}`, n.node_id);
      restored = true;
    }
  }
  settle(db, n, "upheld", opts.by, opts.reason ?? null, anchor);
  return { edges_ended: edges, restored };
}

export function dismissContest(db: DatabaseSync, queueId: string, opts: { by: string; reason: string }): void {
  const n = noteByQueueId(db, queueId);
  if (!n || n.kind !== "contest") throw new ClaimError(404, "contest_not_found", queueId);
  if (n.state !== "open") throw new ClaimError(409, "contest_settled", `contest is ${n.state}`);
  settle(db, n, "dismissed", opts.by, opts.reason, null);
}

/** Publish a pending context note — or a pending reading (the same gate). */
export function approveContext(db: DatabaseSync, queueId: string, opts: { by: string }): void {
  const n = noteByQueueId(db, queueId);
  if (!n || (n.kind !== "context" && n.kind !== "reading")) throw new ClaimError(404, "context_not_found", queueId);
  if (n.state !== "pending") throw new ClaimError(409, "context_settled", `note is ${n.state}`);
  settle(db, n, "live", opts.by, null, null);
}

export function rejectContext(db: DatabaseSync, queueId: string, opts: { by: string; reason: string }): void {
  const n = noteByQueueId(db, queueId);
  if (!n || (n.kind !== "context" && n.kind !== "reading")) throw new ClaimError(404, "context_not_found", queueId);
  if (n.state !== "pending") throw new ClaimError(409, "context_settled", `note is ${n.state}`);
  settle(db, n, "rejected", opts.by, opts.reason, null);
}

function settle(db: DatabaseSync, n: RelationNote, state: string, by: string, reason: string | null, anchor: string | null): void {
  db.prepare("UPDATE relation_notes SET state = ?, resolved_by = ?, resolved_at = ?, resolution = ? WHERE signal_id = ?")
    .run(state, by, nowIso(), reason, n.signal_id);
  const approved = state === "upheld" || state === "live";
  if (n.queue_id) {
    db.prepare("UPDATE intake_queue SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'")
      .run(approved ? "approved" : "rejected", approved ? null : reason, by, nowIso(), n.queue_id);
  }
  if (state === "rejected") db.prepare("UPDATE signals SET status = 'superseded' WHERE id = ?").run(n.signal_id);
  if (anchor) {
    // The contest signal points at what settled it.
    const sig = db.prepare("SELECT processing_trace FROM signals WHERE id = ?").get(n.signal_id) as any;
    const trace = parse(sig?.processing_trace) ?? {};
    trace.settled_by = anchor;
    db.prepare("UPDATE signals SET processing_trace = ? WHERE id = ?").run(JSON.stringify(trace), n.signal_id);
  }
}

/** A reviewed queue item settles the objections filed against it. */
export function settleObjections(db: DatabaseSync, queueId: string, outcome: "approved" | "rejected", by: string): void {
  db.prepare(
    "UPDATE relation_notes SET state = ?, resolved_by = ?, resolved_at = ?, resolution = ? WHERE queue_ref = ? AND kind = 'objection' AND state = 'open'"
  ).run(outcome === "rejected" ? "upheld" : "dismissed", by, nowIso(), outcome === "rejected" ? "the item was rejected" : "the item was approved", queueId);
}

// ---- peer invites ------------------------------------------------------------------

export const INVITES_PER_WEEK = 10;

export function invitesLeft(db: DatabaseSync, contributorId: string): number {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = db.prepare("SELECT COUNT(*) AS n FROM node_claims WHERE invited_by = ? AND via = 'peer_invite' AND created_at >= ?").get(contributorId, since) as any;
  return Math.max(0, INVITES_PER_WEEK - Number(r?.n ?? 0));
}

/**
 * The live relation that lets `inviterId` invite to `nodeId`: one hop from a
 * node the inviter claimed. Returns the inviter's node and the edge type.
 */
export function inviteBridge(db: DatabaseSync, inviterId: string, nodeId: string): { from_node: string; edge_type: string } | null {
  for (const mine of claimedNodeIds(db, inviterId)) {
    const e = db
      .prepare(
        `SELECT edge_type FROM edges WHERE valid_until IS NULL AND created_by != 'embedding-multimodal-v1'
           AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)) LIMIT 1`
      )
      .get(mine, nodeId, nodeId, mine) as any;
    if (e) return { from_node: mine, edge_type: e.edge_type };
  }
  return null;
}

/**
 * Can `inviterId` invite someone to claim `nodeId`? Throws the reason when not.
 * The node must be claimable, unclaimed, and one live hop from a node the
 * inviter claimed; 10 invites a week.
 */
export function checkInvite(db: DatabaseSync, inviterId: string, nodeId: string): { from_node: string; edge_type: string } {
  const node = db.prepare("SELECT type FROM nodes WHERE id = ?").get(nodeId) as any;
  if (!node) throw new ClaimError(404, "node_not_found", nodeId);
  if (!(CLAIMABLE_TYPES as readonly string[]).includes(node.type)) throw new ClaimError(400, "not_claimable", "only people, collectives and institutions can be invited to claim");
  if (approvedClaimsFor(db, nodeId).length) throw new ClaimError(409, "already_claimed", "that page is already claimed");
  const bridge = inviteBridge(db, inviterId, nodeId);
  if (!bridge) throw new ClaimError(403, "not_related", "you can invite the other end of a relation on a page you claimed");
  if (invitesLeft(db, inviterId) <= 0) throw new ClaimError(429, "invite_limit", `${INVITES_PER_WEEK} invites a week`);
  return bridge;
}

export function recordPeerInviteClaim(db: DatabaseSync, args: { inviter: AuthedContributor; invitee_id: string; node_id: string }): Claim {
  const invitee = contributorById(db, args.invitee_id);
  if (!invitee) throw new ClaimError(404, "contributor_not_found", args.invitee_id);
  const r = requestClaim(db, { contributor: invitee, node_id: args.node_id, via: "peer_invite", invited_by: args.inviter.id });
  return r.claim;
}
