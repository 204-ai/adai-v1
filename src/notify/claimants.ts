// Telling claimants when something is added about them (issue #81).
//
// Standing only works if you know you have been described: when a
// contribution touches a page someone has claimed — a relation (live or
// still in review), an edit, a note, a relation ended — the claimant hears
// about it and is sent to /me, where they can add context, contest or object.
//
// Two halves, both idempotent:
//
//   scanClaimantEvents  — reads what the commons already keeps (nodeHistory
//                         for live changes, the review queue for pending
//                         ones) for every approved claim and records one
//                         `claimant_events` row per (claimant, node, change).
//                         The event key names the underlying change, so a
//                         rescan, or a pending relation that later goes
//                         live, never repeats itself.
//   deliverClaimantEmails — one email per claimant with everything not yet
//                         taken on the 'email' channel, as their setting
//                         says (notify_prefs: immediate | daily | off;
//                         default daily). Events are bound to a batch with a
//                         lease before any network I/O (so a server pass and
//                         the CLI never mail the same thing), the message is
//                         frozen on the first attempt and sent under the
//                         batch id as Resend's Idempotency-Key (so a retry
//                         after a crash is not a second email); transient
//                         failures retry up to MAX_ATTEMPTS. Delivery rows
//                         are per channel, so web push can join email later.
//
// Events store references, not sentences: right before a mail is written
// each one is re-checked — the claim still approved, the node not retired,
// the signal not revoked, a pending item not rejected (approved ones read
// as added), a note not withdrawn — and what fails is suppressed for good.
//
// Not notified: the claimant's own contributions, changes that are only the
// claim being published, embedding-derived edges (nodeHistory leaves them
// out), objections (they are for the curator), anything before the feature
// started (settings.claimant_notify_since, set at server boot) or before the
// claim was approved, and anything about a retired page.
//
// Consent: read at send time from the signal — an anonymous contribution
// reads "Someone …", a structural_only note shows the fact without its words. The mail transport (src/utils/mail.ts) applies
// staging's mail switch.
//
// Runs: the server kicks an `immediate` pass shortly after a contribution
// (src/notify/kick.ts, wired in src/index.ts); the daily pass is the CLI
// src/cli/notify-claimants.ts, run by .github/workflows/notify-digest.yml.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nodeHistory, type HistoryEvent } from "../utils/history.js";
import { MailError, sendMail, textToHtml } from "../utils/mail.js";
import { baseUrl, deliverableEmailFor, issueMagicLink } from "../intake/auth.js";
import { fromAddress, replyTo } from "../intake/mail.js";

export const EMAIL_MODES = ["immediate", "daily", "off"] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];
export const DEFAULT_EMAIL_MODE: EmailMode = "daily";
const SINCE_KEY = "claimant_notify_since";
const NOTE_MAX = 240;
const LINES_PER_NODE = 15;

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ---- settings ---------------------------------------------------------------------

export interface NotifyPrefs { email: EmailMode; push: string }

export function getNotifyPrefs(db: DatabaseSync, contributorId: string): NotifyPrefs {
  const r = db.prepare("SELECT email, push FROM notify_prefs WHERE contributor_id = ?").get(contributorId) as any;
  const email = (EMAIL_MODES as readonly string[]).includes(r?.email) ? (r.email as EmailMode) : DEFAULT_EMAIL_MODE;
  return { email, push: r?.push ?? "off" };
}

export function setEmailMode(db: DatabaseSync, contributorId: string, mode: string): NotifyPrefs {
  if (!(EMAIL_MODES as readonly string[]).includes(mode)) throw new Error(`email must be one of ${EMAIL_MODES.join(", ")}`);
  db.prepare(
    `INSERT INTO notify_prefs (contributor_id, email, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     ON CONFLICT(contributor_id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at`
  ).run(contributorId, mode);
  return getNotifyPrefs(db, contributorId);
}

// ---- sentences ----------------------------------------------------------------------

type Phrase = (s: string, o: string, you: boolean) => string;
const be = (you: boolean) => (you ? "were" : "was");
const v = (you: boolean, base: string, third: string) => (you ? base : third);

/** A relation as a sentence about the claimed side. `out`: the claimed node is the source. */
const RELATION: Record<string, { out: Phrase; in: Phrase }> = {
  CREATED_BY: { out: (s, o, y) => `${s} ${be(y)} created by ${o}`, in: (s, o) => `${s} made ${o}` },
  COLLABORATES_WITH: { out: (s, o) => `${s} collaborated with ${o}`, in: (s, o) => `${s} collaborated with ${o}` },
  INFLUENCES: { out: (s, o) => `${s} influenced ${o}`, in: (s, o) => `${o} influenced ${s}` },
  PARTICIPATED_IN: { out: (s, o) => `${s} took part in ${o}`, in: (s, o) => `${o} took part in ${s}` },
  CURATED_BY: { out: (s, o, y) => `${s} ${be(y)} curated by ${o}`, in: (s, o) => `${s} curated ${o}` },
  PRESENTED_BY: { out: (s, o, y) => `${s} ${be(y)} presented by ${o}`, in: (s, o) => `${s} presented ${o}` },
  REPRESENTS: { out: (s, o, y) => `${s} ${v(y, "represent", "represents")} ${o}`, in: (s, o) => `${o} represents ${s}` },
  HELD_BY: { out: (s, o, y) => `${s} ${y ? "are" : "is"} held by ${o}`, in: (s, o, y) => `${s} ${v(y, "hold", "holds")} ${o}` },
  EXHIBITED_AT: { out: (s, o, y) => `${s} ${be(y)} exhibited at ${o}`, in: (s, o) => `${o} was exhibited at ${s}` },
  BELONGS_TO: { out: (s, o, y) => `${s} ${v(y, "belong", "belongs")} to ${o}`, in: (s, o) => `${o} belongs to ${s}` },
  PRACTICES: { out: (s, o, y) => `${s} ${v(y, "practise", "practises")} ${o}`, in: (s, o) => `${o} practises ${s}` },
  USES_TECHNIQUE: { out: (s, o, y) => `${s} ${v(y, "use", "uses")} ${o}`, in: (s, o) => `${o} uses ${s}` },
};

interface Subject { id: string; name: string; type: string }

function nameOf(db: DatabaseSync, id: string, fallback?: string | null): string {
  return (db.prepare("SELECT name FROM nodes WHERE id = ?").get(id) as any)?.name ?? fallback ?? id;
}

/** "you" for a claimed person; a collective's or institution's own name. */
function subjectWord(subj: Subject): { s: string; you: boolean } {
  return subj.type === "practitioner" ? { s: "you", you: true } : { s: subj.name, you: false };
}

export function relationPhrase(db: DatabaseSync, subj: Subject, edgeType: string, direction: "out" | "in", otherId: string, otherName?: string | null): string {
  const { s, you } = subjectWord(subj);
  let o = nameOf(db, otherId, otherName);
  // "you made Anticyclone with Artist A": the work's other makers, so a
  // collaboration on a work reads as one.
  if (edgeType === "CREATED_BY" && direction === "in") {
    const co = (db.prepare(
      `SELECT DISTINCT n.name FROM edges e JOIN nodes n ON n.id = e.target_id
        WHERE e.source_id = ? AND e.edge_type = 'CREATED_BY' AND e.valid_until IS NULL AND e.target_id != ?
        ORDER BY n.name LIMIT 4`
    ).all(otherId, subj.id) as any[]).map((r) => r.name);
    if (co.length) o = `${o} with ${co.join(", ")}`;
  }
  const p = RELATION[edgeType];
  if (p) return p[direction](s, o, you);
  const verb = edgeType.toLowerCase().replace(/_/g, " ");
  return direction === "out" ? `${s} ${verb} ${o}` : `${o} ${verb} ${s}`;
}

const who = (by: string | null | undefined) => (by && by.trim() ? by.trim() : "Someone");
const clip = (s: string) => (s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX - 1)}…` : s);

function pageOf(subj: Subject): string {
  return subj.type === "practitioner" ? "your page" : `the page of ${subj.name}`;
}

// ---- scan -----------------------------------------------------------------------------

export type EventKind = "relation" | "ended" | "edit" | "note" | "pending";

/** What to re-read when the mail is written. Never the words themselves. */
export type EventRef =
  | { kind: "relation"; signal_id: string | null; edge_id: string; edge_type: string; direction: "out" | "in"; other_id: string; by_fallback: string | null }
  | { kind: "ended"; signal_id: string | null; edge_id: string; edge_type: string; direction: "out" | "in"; other_id: string; by_fallback: string | null }
  | { kind: "edit"; signal_id: string | null; op: string; keys: string[] }
  | { kind: "note"; signal_id: string }
  | { kind: "pending"; queue_id: string; signal_id: string | null; edge?: { edge_type: string; direction: "out" | "in"; other_id: string; other_name: string | null }; keys?: string[] };

export interface FoundEvent { key: string; kind: EventKind; ref: EventRef; at: string | null; submitter: string | null }

/** The raw submitter of a signal (consent hides it from the line, not from this check). */
function submitterOf(db: DatabaseSync, signalId: string | null | undefined): string | null {
  if (!signalId) return null;
  // signals_full: an anonymous signal's author is on the private side, and
  // their own contribution is still theirs (not news to them).
  return (db.prepare("SELECT submitted_by FROM signals_full WHERE id = ?").get(signalId) as any)?.submitted_by ?? null;
}

function liveEvents(db: DatabaseSync, subj: Subject, events: HistoryEvent[], floor: string): FoundEvent[] {
  const out: FoundEvent[] = [];
  for (const e of events) {
    // Inclusive: a change in the same second as the floor is still news; the
    // event key keeps a rescan from repeating it.
    if (!e.at || e.at < floor) continue;
    const sig = e.source?.signal_id ?? null;
    if (e.kind === "relation") {
      const triple = e.direction === "out" ? `${subj.id}|${e.edge_type}|${e.other.id}` : `${e.other.id}|${e.edge_type}|${subj.id}`;
      const base = { signal_id: sig, edge_id: e.edge_id, edge_type: e.edge_type, direction: e.direction, other_id: e.other.id, by_fallback: e.source ? null : e.by };
      if (e.change === "added") {
        out.push({ key: `rel:${sig ?? e.edge_id}:${triple}`, kind: "relation", at: e.at, submitter: submitterOf(db, sig) ?? e.by, ref: { kind: "relation", ...base } });
      } else {
        out.push({ key: `end:${e.edge_id}`, kind: "ended", at: e.at, submitter: submitterOf(db, sig) ?? e.by, ref: { kind: "ended", ...base } });
      }
    } else if (e.kind === "metadata") {
      const keys = e.changes.map((c) => c.key).filter((k) => k !== "claimed");
      if (!keys.length) continue; // the claim itself being published
      out.push({ key: `meta:${sig ?? `${e.op}:${e.at}`}:${e.op}`, kind: "edit", at: e.at, submitter: submitterOf(db, sig) ?? e.by, ref: { kind: "edit", signal_id: sig, op: e.op, keys } });
    } else if (e.kind === "note" && sig) {
      out.push({ key: `note:${sig}`, kind: "note", at: e.at, submitter: submitterOf(db, sig) ?? e.by, ref: { kind: "note", signal_id: sig } });
    }
  }
  return out;
}

function pendingEvents(db: DatabaseSync, subj: Subject, floor: string): FoundEvent[] {
  const like = `%${JSON.stringify(subj.id).slice(1, -1)}%`;
  const rows = db.prepare(
    `SELECT q.id, q.signal_id, q.submitted_by, q.created_at, q.target_node, q.proposed_nodes, q.proposed_edges
       FROM intake_queue q
      WHERE q.status = 'pending' AND q.kind = 'human_signal' AND q.created_at >= ?
        AND (q.target_node = ? OR q.proposed_edges LIKE ? OR q.proposed_nodes LIKE ?)`
  ).all(floor, subj.id, like, like) as any[];
  const out: FoundEvent[] = [];
  for (const r of rows) {
    const ops = (parse(r.proposed_nodes) ?? []) as any[];
    const created = new Map<string, string>();
    for (const op of ops) if (op?.op === "create_node" && op.type && op.slug) created.set(`${op.type}:${op.slug}`, op.name ?? op.slug);
    for (const e of (parse(r.proposed_edges) ?? []) as any[]) {
      if (!e || (e.source_id !== subj.id && e.target_id !== subj.id)) continue;
      const dir: "out" | "in" = e.source_id === subj.id ? "out" : "in";
      const other = String(dir === "out" ? e.target_id : e.source_id);
      out.push({
        // the signal its live edge will carry (materialise: e.signal_id ?? the item's)
        key: `rel:${e.signal_id ?? r.signal_id ?? r.id}:${e.source_id}|${e.edge_type}|${e.target_id}`,
        kind: "pending", at: r.created_at, submitter: r.submitted_by,
        ref: { kind: "pending", queue_id: r.id, signal_id: e.signal_id ?? r.signal_id ?? null, edge: { edge_type: String(e.edge_type), direction: dir, other_id: other, other_name: created.get(other) ?? null } },
      });
    }
    for (const op of ops) {
      if (op?.node_id !== subj.id || op.op !== "patch_node") continue;
      const keys = Object.keys(op.metadata ?? {}).filter((k) => k !== "claimed");
      if (!keys.length) continue;
      out.push({
        key: `meta:${op.signal_id ?? r.signal_id ?? r.id}:patch_node`,
        kind: "pending", at: r.created_at, submitter: r.submitted_by,
        ref: { kind: "pending", queue_id: r.id, signal_id: op.signal_id ?? r.signal_id ?? null, keys },
      });
    }
  }
  return out;
}

const retired = (db: DatabaseSync, nodeId: string): boolean =>
  !!(db.prepare("SELECT 1 FROM nodes WHERE id = ? AND json_extract(metadata, '$.retired') IS 1").get(nodeId));

/** What happened to one claimed node since `floor` (inclusive), not by `self` (names or ids). */
export function eventsFor(db: DatabaseSync, nodeId: string, floor: string, self: string[]): FoundEvent[] {
  const h = nodeHistory(db, nodeId);
  if (!h) return [];
  const subj: Subject = { id: h.node.id, name: h.node.name, type: h.node.type };
  const mine = new Set(self.filter(Boolean));
  return [...pendingEvents(db, subj, floor), ...liveEvents(db, subj, h.events, floor)]
    .filter((e) => !(e.submitter && mine.has(e.submitter)));
}

/**
 * The starting line: nothing before it is news. Set once, synchronously, when
 * the feature starts (server boot, before it serves; the CLI) — never by the
 * first scan, which would swallow whatever came between boot and that scan.
 */
export function ensureBaseline(db: DatabaseSync): string {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))").run(SINCE_KEY);
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(SINCE_KEY) as any).value as string;
}

/** Record new events for every approved claim on a live (not retired) node. Returns how many were new. */
export function scanClaimantEvents(db: DatabaseSync): number {
  const since = ensureBaseline(db);
  const claims = db.prepare(
    `SELECT c.node_id, c.contributor_id, COALESCE(c.reviewed_at, c.created_at) AS since, k.name
       FROM node_claims c LEFT JOIN contributors k ON k.id = c.contributor_id
      WHERE c.status = 'approved'`
  ).all() as any[];
  const ins = db.prepare(
    "INSERT OR IGNORE INTO claimant_events (id, contributor_id, node_id, event_key, kind, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let n = 0;
  for (const c of claims) {
    if (retired(db, c.node_id)) continue; // policy: a retired page is not news to anyone
    const floor = [since, c.since ?? ""].sort().pop()!;
    for (const e of eventsFor(db, c.node_id, floor, [c.contributor_id, c.name])) {
      const r = ins.run(`cev_${crypto.randomBytes(8).toString("hex")}`, c.contributor_id, c.node_id, e.key, e.kind, JSON.stringify(e.ref), e.at);
      n += Number(r.changes);
    }
  }
  return n;
}

// ---- the sentence, from the record as it stands ------------------------------------------

export interface EventRow { id: string; contributor_id: string; node_id: string; kind: string; ref: string; at: string | null }

type Rendered = { line: string } | { suppress: string };

function signalRow(db: DatabaseSync, id: string | null | undefined): any {
  return id ? db.prepare("SELECT status, submitted_by, consent_scope, consent_attribution FROM signals WHERE id = ?").get(id) ?? null : null;
}

const live = (s: any) => !s || (s.status ?? "active") === "active";

/** Who did it, as consent allows: anonymous → "Someone". */
function byOf(s: any, fallback: string | null = null): string {
  if (s) return s.consent_attribution === "anonymous" ? "Someone" : who(s.submitted_by);
  return who(fallback);
}

/** The event's sentence now — or why it is no longer to be sent. */
export function renderEvent(db: DatabaseSync, ev: EventRow, opts: { asProposed?: boolean } = {}): Rendered {
  const n = db.prepare("SELECT id, name, type, metadata FROM nodes WHERE id = ?").get(ev.node_id) as any;
  if (!n) return { suppress: "node_gone" };
  if (parse(n.metadata)?.retired === true) return { suppress: "retired" };
  const subj: Subject = { id: n.id, name: n.name, type: n.type };
  const ref = parse(ev.ref) as EventRef | null;
  if (!ref) return { suppress: "unreadable" };

  if (ref.kind === "relation" || ref.kind === "ended") {
    const s = signalRow(db, ref.signal_id);
    // the signal that added — or ended — the relation, revoked since: not news
    if (!live(s)) return { suppress: "revoked" };
    const phrase = relationPhrase(db, subj, ref.edge_type, ref.direction, ref.other_id);
    if (ref.kind === "relation") {
      return { line: `${byOf(s, ref.by_fallback)} added that ${phrase}.` };
    }
    const by = s ? byOf(s) : ref.by_fallback;
    return { line: by && by !== "Someone" ? `${by} ended the record that ${phrase}.` : `The record that ${phrase} was ended.` };
  }
  if (ref.kind === "edit") {
    const s = signalRow(db, ref.signal_id);
    if (!live(s)) return { suppress: "revoked" };
    const what = ref.op === "attach_image" ? "added an image to" : ref.op === "retire_node" ? "retired" : `changed ${ref.keys.join(", ")} on`;
    return { line: `${byOf(s)} ${what} ${pageOf(subj)}.` };
  }
  if (ref.kind === "note") {
    const note = db.prepare("SELECT kind, state, note, source_id, edge_type, target_id, meta_key FROM relation_notes WHERE signal_id = ?").get(ref.signal_id) as any;
    if (!note) return { suppress: "note_gone" };
    if (["withdrawn", "rejected", "pending"].includes(note.state)) return { suppress: `note_${note.state}` };
    const s = signalRow(db, ref.signal_id);
    if (!live(s)) return { suppress: "revoked" };
    let about = pageOf(subj);
    if (note.source_id) {
      const outDir = note.source_id === subj.id;
      about = `the record that ${relationPhrase(db, subj, note.edge_type, outDir ? "out" : "in", outDir ? note.target_id : note.source_id)}`;
    } else if (note.meta_key) {
      about = `${note.meta_key} on ${pageOf(subj)}`;
    }
    const words = s?.consent_scope === "structural_only" || !note.note ? "" : `: “${clip(String(note.note))}”`;
    const verb = note.kind === "contest" ? "contested" : "added context to";
    return { line: `${byOf(s)} ${verb} ${about}${words || "."}` };
  }
  // pending: the review queue decides the wording now
  const q = db.prepare("SELECT status FROM intake_queue WHERE id = ?").get(ref.queue_id) as any;
  if (!q) return { suppress: "queue_gone" };
  if (q.status === "rejected") return { suppress: "rejected" };
  const s = signalRow(db, ref.signal_id);
  if (!live(s)) return { suppress: "revoked" };
  const approved = q.status === "approved" && !opts.asProposed;
  if (ref.edge) {
    const phrase = relationPhrase(db, subj, ref.edge.edge_type, ref.edge.direction, ref.edge.other_id, ref.edge.other_name);
    return { line: approved ? `${byOf(s)} added that ${phrase}.` : `${byOf(s)} proposed that ${phrase} (waiting for a curator).` };
  }
  const keys = (ref.keys ?? []).join(", ");
  return { line: approved ? `${byOf(s)} changed ${keys} on ${pageOf(subj)}.` : `${byOf(s)} proposed changing ${keys} on ${pageOf(subj)} (waiting for a curator).` };
}

/** A claimant's events with their sentences now (suppressed ones left out). For tests and previews. */
export function eventLines(db: DatabaseSync, contributorId: string): string[] {
  const rows = db.prepare("SELECT id, contributor_id, node_id, kind, ref, at FROM claimant_events WHERE contributor_id = ? ORDER BY at, rowid").all(contributorId) as unknown as EventRow[];
  return rows.map((r) => renderEvent(db, r)).flatMap((r) => ("line" in r ? [r.line] : []));
}

// ---- deliver ----------------------------------------------------------------------------

export interface RenderedClaimantEmail { to: string; subject: string; text: string; html: string }

export const LEASE_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
/** Resend keeps an idempotency key for 24 h; past this, an unresolved batch is never resent automatically. */
export const IDEMPOTENCY_SAFE_MS = 23 * 3600_000;
const isoAt = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function claimApproved(db: DatabaseSync, contributorId: string, nodeId: string): boolean {
  return !!db.prepare("SELECT 1 FROM node_claims WHERE contributor_id = ? AND node_id = ? AND status = 'approved'").get(contributorId, nodeId);
}

/** Still theirs to hear about, and still true: else the reason to suppress it. */
function eligibility(db: DatabaseSync, ev: EventRow): Rendered {
  if (!claimApproved(db, ev.contributor_id, ev.node_id)) return { suppress: "claim_ended" };
  return renderEvent(db, ev);
}

function untaken(db: DatabaseSync, contributorId: string): EventRow[] {
  return db.prepare(
    `SELECT e.id, e.contributor_id, e.node_id, e.kind, e.ref, e.at FROM claimant_events e
      WHERE e.contributor_id = ? AND NOT EXISTS (SELECT 1 FROM claimant_deliveries d WHERE d.event_id = e.id AND d.channel = 'email')
      ORDER BY e.node_id, e.at, e.created_at`
  ).all(contributorId) as unknown as EventRow[];
}

function settle(db: DatabaseSync, eventIds: string[], state: string, reason: string | null): void {
  const ins = db.prepare("INSERT OR IGNORE INTO claimant_deliveries (event_id, channel, state, reason) VALUES (?, 'email', ?, ?)");
  for (const id of eventIds) ins.run(id, state, reason);
}

const newOwner = () => `own_${crypto.randomBytes(6).toString("hex")}`;

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/**
 * Bind events to a new batch, atomically, under a lease held by `owner`: an
 * event already taken by another pass (this process or another one) is
 * skipped. Returns the batch id, or null when nothing was left to take.
 * Never spans network I/O.
 */
export function reserveBatch(db: DatabaseSync, contributorId: string, eventIds: string[], owner = newOwner()): string | null {
  const id = `cnb_${crypto.randomBytes(8).toString("hex")}`;
  return tx(db, () => {
    db.prepare("INSERT INTO claimant_batches (id, contributor_id, channel, state, lease_owner, lease_until) VALUES (?, ?, 'email', 'reserved', ?, ?)")
      .run(id, contributorId, owner, isoAt(Date.now() + LEASE_MS));
    const ins = db.prepare("INSERT OR IGNORE INTO claimant_deliveries (event_id, channel, state, batch_id) VALUES (?, 'email', 'reserved', ?)");
    let taken = 0;
    for (const e of eventIds) taken += Number(ins.run(e, id).changes);
    if (!taken) db.prepare("DELETE FROM claimant_batches WHERE id = ?").run(id);
    return taken ? id : null;
  });
}

/**
 * Acquire (or renew) the lease on a reserved batch for `owner`: only when it
 * is free (lease ran out) or already ours. The fencing token for every later
 * write to the batch.
 */
export function acquireLease(db: DatabaseSync, batchId: string, owner: string): boolean {
  const now = isoAt(Date.now());
  return Number(db.prepare(
    `UPDATE claimant_batches SET lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND state = 'reserved' AND (lease_owner = ? OR lease_until IS NULL OR lease_until <= ?)`
  ).run(owner, isoAt(Date.now() + LEASE_MS), now, batchId, owner, now).changes) === 1;
}

/** A write to a reserved batch, fenced by its lease owner: false if the lease was lost. */
function fenced(db: DatabaseSync, batchId: string, owner: string, set: string, ...args: any[]): boolean {
  return Number(db.prepare(`UPDATE claimant_batches SET ${set}, updated_at = ? WHERE id = ? AND state = 'reserved' AND lease_owner = ?`)
    .run(...args, isoAt(Date.now()), batchId, owner).changes) === 1;
}

/** Terminal: only from reserved, only by the lease owner; never changes again. */
function finishBatch(db: DatabaseSync, batchId: string, owner: string, state: "sent" | "failed" | "suppressed" | "skipped" | "reconcile", fields: { ref?: string | null; error?: string | null; reason?: string | null }): boolean {
  return tx(db, () => {
    const ok = Number(db.prepare(
      `UPDATE claimant_batches SET state = ?, ref = COALESCE(?, ref), error = COALESCE(?, error), lease_until = NULL, updated_at = ?
        WHERE id = ? AND state = 'reserved' AND lease_owner = ?`
    ).run(state, fields.ref ?? null, fields.error ?? null, isoAt(Date.now()), batchId, owner).changes) === 1;
    if (ok) {
      db.prepare("UPDATE claimant_deliveries SET state = ?, reason = ?, at = ? WHERE batch_id = ? AND channel = 'email' AND state = 'reserved'")
        .run(state, fields.reason ?? null, isoAt(Date.now()), batchId);
    }
    return ok;
  });
}

export function renderClaimantEmail(db: DatabaseSync, to: string, mode: EmailMode, events: Array<{ node_id: string; line: string }>, link: string): RenderedClaimantEmail {
  const byNode = new Map<string, string[]>();
  for (const e of events) {
    if (!byNode.has(e.node_id)) byNode.set(e.node_id, []);
    byNode.get(e.node_id)!.push(e.line);
  }
  const base = baseUrl();
  const subject = events.length === 1
    ? clip(events[0].line.replace(/\.$/, "")) + " — review it"
    : `${events.length} new things about ${byNode.size === 1 ? nameOf(db, events[0].node_id) : "your A(DAI) pages"} — review them`;
  const parts: string[] = [];
  for (const [nodeId, lines] of byNode) {
    // A big read (a gallery's whole roster) stays readable: the rest is on /me.
    const shown = lines.slice(0, LINES_PER_NODE).map((l) => `• ${l}`);
    if (lines.length > LINES_PER_NODE) shown.push(`• … and ${lines.length - LINES_PER_NODE} more`);
    parts.push(`${nameOf(db, nodeId)}\n${shown.join("\n")}\n${base}/me?node=${encodeURIComponent(nodeId)}`);
  }
  const text =
    `New in the A(DAI) commons about ${byNode.size === 1 ? "a page you claimed" : "pages you claimed"}:\n\n` +
    parts.join("\n\n") +
    `\n\nReview it in your log — confirm it, add context, contest what is wrong, or object to what is still in review:\n${link}\n` +
    `(the link signs you in and is valid for 7 days)\n\n` +
    `You get these ${mode === "immediate" ? "as they happen" : "once a day"}. Change it, or turn them off, on ${base}/me`;
  return { to, subject, text, html: textToHtml(text) };
}

/** The provider request, frozen whole on the first attempt: every retry sends exactly this. */
export interface FrozenRequest { from: string; to: string[]; reply_to: string[]; subject: string; text: string; html: string }
export interface FrozenPayload { request: FrozenRequest; lines: Array<{ event_id: string; node_id: string; line: string }> }

export interface DeliverResult {
  sent: number;           // emails handed to the transport (or logged by stdout / held by staging)
  events: number;         // events they carried
  skipped: number;        // events not mailed by setting (off) or for want of an address
  suppressed: number;     // events no longer true or no longer theirs
  failed: number;         // emails that did not go through on this pass (retried later until MAX_ATTEMPTS)
  reconcile: number;      // batches left for a person: an unresolved send older than Resend's key window
  emails: RenderedClaimantEmail[];
}

/**
 * Is the frozen message still permissible, member by member? Every member is
 * re-rendered now; the batch may go only if each one still renders, and to
 * the very line that was frozen — a revoked signal, a withdrawn note, a
 * rejected proposal, a consent or wording change all stop the whole batch
 * (never a rewritten body under the same key). Policy for a proposal
 * approved since freezing: its frozen "proposed … (waiting for a curator)"
 * line is left as it is — still true of when it was written.
 */
function frozenStillTrue(db: DatabaseSync, members: EventRow[], frozen: FrozenPayload): string | null {
  const byId = new Map(members.map((m) => [m.id, m]));
  if (frozen.lines.length !== members.length) return "members_changed";
  for (const l of frozen.lines) {
    const m = byId.get(l.event_id);
    if (!m) return "members_changed";
    const now = eligibility(db, m);
    if (!("line" in now)) return now.suppress;
    if (now.line === l.line) continue;
    if (m.kind === "pending") {
      const asWas = renderEvent(db, m, { asProposed: true });
      if ("line" in asWas && asWas.line === l.line) continue;
    }
    return "content_changed";
  }
  return null;
}

/**
 * One attempt at a reserved batch, holding its lease as `owner`. Before
 * every attempt — the first or a retry, ours or taken over after a crash —
 * the preference, the address, the attempt count, the age of the first
 * attempt and every member are checked again. The first attempt freezes the
 * whole provider request; a retry sends that exact request under the same
 * idempotency key (the batch id). Every write is fenced by the lease owner,
 * so a worker that lost its lease mid-send cannot complete or fail the batch.
 */
export async function sendBatch(db: DatabaseSync, batchId: string, owner: string, result: DeliverResult): Promise<void> {
  if (!acquireLease(db, batchId, owner)) return;
  const b = db.prepare("SELECT * FROM claimant_batches WHERE id = ?").get(batchId) as any;
  if (!b || b.state !== "reserved") return;
  const members = db.prepare(
    `SELECT e.id, e.contributor_id, e.node_id, e.kind, e.ref, e.at FROM claimant_deliveries d JOIN claimant_events e ON e.id = d.event_id
      WHERE d.batch_id = ? AND d.channel = 'email' AND d.state = 'reserved' ORDER BY e.node_id, e.at, e.created_at`
  ).all(batchId) as unknown as EventRow[];

  // the setting, now
  if (getNotifyPrefs(db, b.contributor_id).email === "off") {
    if (finishBatch(db, batchId, owner, "skipped", { reason: "off" })) result.skipped += members.length;
    return;
  }
  const to = deliverableEmailFor(db, b.contributor_id);
  if (!to) {
    if (finishBatch(db, batchId, owner, "suppressed", { reason: "no_address" })) result.suppressed += members.length;
    return;
  }
  // bounded: a crashed attempt counted too
  if (b.attempts >= MAX_ATTEMPTS) {
    if (finishBatch(db, batchId, owner, "failed", { reason: "max_attempts", error: b.error ?? "max attempts" })) result.failed++;
    return;
  }
  // an earlier attempt may have reached Resend; past its key window a resend could duplicate
  if (b.attempts > 0 && b.first_attempt_at && Date.now() - Date.parse(b.first_attempt_at) > IDEMPOTENCY_SAFE_MS) {
    if (finishBatch(db, batchId, owner, "reconcile", { reason: "unresolved_past_key_window" })) {
      result.reconcile++;
      console.error(`[notify:claimants] batch ${batchId} needs a person: an attempt from ${b.first_attempt_at} is unresolved and Resend's idempotency window has passed`);
    }
    return;
  }

  let frozen = parse(b.payload) as FrozenPayload | null;
  if (!frozen) {
    const keep: Array<{ event_id: string; node_id: string; line: string }> = [];
    for (const m of members) {
      const r = eligibility(db, m);
      if ("line" in r) keep.push({ event_id: m.id, node_id: m.node_id, line: r.line });
      else {
        db.prepare("UPDATE claimant_deliveries SET state = 'suppressed', reason = ?, batch_id = NULL WHERE event_id = ? AND channel = 'email' AND batch_id = ?").run(r.suppress, m.id, batchId);
        result.suppressed++;
      }
    }
    if (!keep.length) { finishBatch(db, batchId, owner, "suppressed", { reason: "nothing_left" }); return; }
    const mode = getNotifyPrefs(db, b.contributor_id).email;
    const link = issueMagicLink(db, { email: to, purpose: "receipt", redirect: `/me?node=${encodeURIComponent(keep[0].node_id)}` }).url;
    const msg = renderClaimantEmail(db, to, mode, keep, link);
    frozen = { request: { from: fromAddress(), to: [to], reply_to: replyTo(), subject: msg.subject, text: msg.text, html: msg.html }, lines: keep };
    if (!fenced(db, batchId, owner, "payload = ?", JSON.stringify(frozen))) return; // lost the lease
  } else {
    const live = members.filter((m) => frozen!.lines.some((l) => l.event_id === m.id));
    const why = live.length !== members.length ? "members_changed" : frozenStillTrue(db, members, frozen);
    if (why || frozen.request.to.length !== 1 || frozen.request.to[0] !== to) {
      if (finishBatch(db, batchId, owner, "suppressed", { reason: why ?? "address_changed" })) result.suppressed += members.length;
      return;
    }
  }
  // the attempt is recorded before the request leaves (a crash counts)
  if (!fenced(db, batchId, owner, "attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?), lease_until = ?", isoAt(Date.now()), isoAt(Date.now() + LEASE_MS))) return;
  const req = frozen.request;
  result.emails.push({ to: req.to[0], subject: req.subject, text: req.text, html: req.html });
  try {
    const r = await sendMail({ from: req.from, to: req.to, replyTo: req.reply_to, subject: req.subject, text: req.text, html: req.html, idempotencyKey: batchId });
    if (finishBatch(db, batchId, owner, "sent", { ref: r.id || r.transport })) {
      result.sent++;
      result.events += frozen.lines.length;
    }
  } catch (e: any) {
    result.failed++;
    const attempts = Number((db.prepare("SELECT attempts FROM claimant_batches WHERE id = ?").get(batchId) as any).attempts);
    const message = String(e?.message ?? e).slice(0, 500);
    if (e instanceof MailError && e.transient && attempts < MAX_ATTEMPTS) {
      // Wait its turn: the lease runs out at the backoff, a later pass takes it over.
      fenced(db, batchId, owner, "lease_until = ?, error = ?", isoAt(Date.now() + 2 ** attempts * 60_000), message);
    } else {
      finishBatch(db, batchId, owner, "failed", { error: message, reason: e instanceof MailError && e.code ? e.code : "send_failed" });
    }
    console.error(`[notify:claimants] batch ${batchId} to ${b.contributor_id} failed (attempt ${attempts}): ${message}`);
  }
}

/**
 * `immediate`: only contributors who asked for it. `daily`: everyone who
 * gets email (immediate included, catching anything an immediate pass missed).
 * Either also takes over any batch whose lease ran out.
 */
export async function deliverClaimantEmails(db: DatabaseSync, opts: { mode: "immediate" | "daily"; dryRun?: boolean }): Promise<DeliverResult> {
  const result: DeliverResult = { sent: 0, events: 0, skipped: 0, suppressed: 0, failed: 0, reconcile: 0, emails: [] };
  const owner = newOwner();
  const contributors = db.prepare(
    `SELECT DISTINCT e.contributor_id FROM claimant_events e
      WHERE NOT EXISTS (SELECT 1 FROM claimant_deliveries d WHERE d.event_id = e.id AND d.channel = 'email')`
  ).all() as any[];
  const mine: string[] = [];
  for (const { contributor_id } of contributors) {
    const prefs = getNotifyPrefs(db, contributor_id);
    if (opts.mode === "immediate" && prefs.email !== "immediate" && prefs.email !== "off") continue;
    const events = untaken(db, contributor_id);
    if (!events.length) continue;
    // Suppress what is no longer theirs or no longer true, so it cannot leak
    // after a later re-approval.
    const ok: EventRow[] = [];
    for (const ev of events) {
      const r = eligibility(db, ev);
      if ("line" in r) ok.push(ev);
      else { if (!opts.dryRun) settle(db, [ev.id], "suppressed", r.suppress); result.suppressed++; }
    }
    if (!ok.length) continue;
    if (prefs.email === "off") {
      if (!opts.dryRun) settle(db, ok.map((e) => e.id), "skipped", "off");
      result.skipped += ok.length;
      continue;
    }
    const to = deliverableEmailFor(db, contributor_id);
    if (!to) {
      if (!opts.dryRun) settle(db, ok.map((e) => e.id), "skipped", "no_address");
      result.skipped += ok.length;
      continue;
    }
    if (opts.dryRun) {
      const lines = ok.map((ev) => ({ node_id: ev.node_id, line: (renderEvent(db, ev) as { line: string }).line }));
      result.emails.push(renderClaimantEmail(db, to, prefs.email, lines, `${baseUrl()}/me?node=${encodeURIComponent(ok[0].node_id)}`));
      continue;
    }
    const batch = reserveBatch(db, contributor_id, ok.map((e) => e.id), owner);
    if (batch) mine.push(batch);
  }
  if (opts.dryRun) return result;
  // Batches left by a crash or waiting to retry, whose lease ran out.
  const due = db.prepare("SELECT id FROM claimant_batches WHERE channel = 'email' AND state = 'reserved' AND lease_until <= ?").all(isoAt(Date.now())) as any[];
  for (const { id } of due) if (!mine.includes(id) && acquireLease(db, id, owner)) mine.push(id);
  // Keep going past a failure: each batch is its own email.
  for (const id of mine) await sendBatch(db, id, owner, result);
  return result;
}

/**
 * Batches waiting for a person (state 'reconcile': an unresolved send older
 * than Resend's idempotency window), whichever pass marked them — they are
 * never requeued automatically; the CLI reports them on every run.
 */
export function outstandingReconcile(db: DatabaseSync): Array<{ id: string; contributor_id: string; first_attempt_at: string | null }> {
  return db.prepare(
    "SELECT id, contributor_id, first_attempt_at FROM claimant_batches WHERE state = 'reconcile' ORDER BY first_attempt_at, id"
  ).all() as any[];
}

/** One pass: find what is new, then email whoever this pass is for. */
export async function runClaimantNotifications(db: DatabaseSync, opts: { mode: "immediate" | "daily"; dryRun?: boolean }): Promise<DeliverResult & { found: number }> {
  const found = scanClaimantEvents(db);
  const r = await deliverClaimantEmails(db, opts);
  return { ...r, found };
}

// ---- the immediate pass, in the server ----------------------------------------------------

/**
 * Run an `immediate` pass a little after each contribution (debounced, so a
 * URL-intake Confirm of 40 cards is one pass), plus a slow backstop. The
 * daily pass is the CLI. Timers are unref'd: they never keep a process up.
 * The baseline is set here, synchronously, before the server serves.
 */
export function startClaimantNotifier(db: DatabaseSync, onContribution: (fn: () => void) => unknown, opts: { delayMs?: number; everyMs?: number } = {}): () => void {
  ensureBaseline(db);
  const delayMs = opts.delayMs ?? 90_000;
  const everyMs = opts.everyMs ?? 15 * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  const pass = async () => {
    timer = null;
    if (running) return;
    running = true;
    try {
      const r = await runClaimantNotifications(db, { mode: "immediate" });
      if (r.sent) console.log(`[notify:claimants] ${r.sent} email(s), ${r.events} event(s)`);
      if (r.failed) console.error(`[notify:claimants] ${r.failed} email(s) failed this pass`);
    } catch (e: any) {
      console.error("[notify:claimants] pass failed:", e?.message ?? e);
    } finally {
      running = false;
    }
  };
  const soon = () => {
    if (timer) return;
    timer = setTimeout(pass, delayMs);
    timer.unref?.();
  };
  onContribution(soon);
  const iv = setInterval(pass, everyMs);
  iv.unref?.();
  return () => { if (timer) clearTimeout(timer); clearInterval(iv); };
}
