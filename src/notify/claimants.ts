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
//                         delivered on the 'email' channel, as their
//                         setting says (notify_prefs: immediate | daily |
//                         off; default daily). Delivery rows are per channel,
//                         so web push can be added beside email later.
//
// Not notified: the claimant's own contributions, changes that are only the
// claim being published, embedding-derived edges (nodeHistory leaves them
// out), objections (they are for the curator), anything before the feature
// first ran (settings.claimant_notify_since) or before the claim was approved.
//
// Consent: the sentence is built from nodeHistory's consent-filtered view —
// an anonymous contribution reads "Someone …", a structural_only one shows
// the fact without its words. The mail transport (src/utils/mail.ts) applies
// staging's mail switch.
//
// Runs: the server kicks an `immediate` pass shortly after a contribution
// (src/notify/kick.ts, wired in src/index.ts); the daily pass is the CLI
// src/cli/notify-claimants.ts, run by .github/workflows/notify-digest.yml.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nodeHistory, type HistoryEvent } from "../utils/history.js";
import { sendMail, textToHtml } from "../utils/mail.js";
import { baseUrl, emailFor, issueMagicLink } from "../intake/auth.js";
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

function nowIso(db: DatabaseSync): string {
  return (db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS t").get() as { t: string }).t;
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

export interface FoundEvent { key: string; kind: "relation" | "ended" | "edit" | "note" | "pending"; line: string; at: string | null; submitter: string | null }

/** The raw submitter of a signal (consent hides it from the line, not from this check). */
function submitterOf(db: DatabaseSync, signalId: string | null | undefined): string | null {
  if (!signalId) return null;
  return (db.prepare("SELECT submitted_by FROM signals WHERE id = ?").get(signalId) as any)?.submitted_by ?? null;
}

function liveEvents(db: DatabaseSync, subj: Subject, events: HistoryEvent[], floor: string): FoundEvent[] {
  const out: FoundEvent[] = [];
  for (const e of events) {
    if (!e.at || e.at <= floor) continue;
    const sig = e.source?.signal_id ?? null;
    // nodeHistory's `by` is already consent-filtered (anonymous → null).
    if (e.kind === "relation") {
      const phrase = relationPhrase(db, subj, e.edge_type, e.direction, e.other.id, e.other.name);
      const triple = e.direction === "out" ? `${subj.id}|${e.edge_type}|${e.other.id}` : `${e.other.id}|${e.edge_type}|${subj.id}`;
      if (e.change === "added") {
        out.push({ key: `rel:${sig ?? e.edge_id}:${triple}`, kind: "relation", at: e.at, submitter: submitterOf(db, sig) ?? e.by, line: `${who(e.by)} added that ${phrase}.` });
      } else {
        out.push({ key: `end:${e.edge_id}`, kind: "ended", at: e.at, submitter: submitterOf(db, sig) ?? e.by, line: e.by ? `${e.by} ended the record that ${phrase}.` : `The record that ${phrase} was ended.` });
      }
    } else if (e.kind === "metadata") {
      const keys = e.changes.map((c) => c.key).filter((k) => k !== "claimed");
      if (!keys.length) continue; // the claim itself being published
      const what = e.op === "attach_image" ? "added an image to" : e.op === "retire_node" ? "retired" : `changed ${keys.join(", ")} on`;
      out.push({ key: `meta:${sig ?? `${e.op}:${e.at}`}:${e.op}`, kind: "edit", at: e.at, submitter: submitterOf(db, sig) ?? e.by, line: `${who(e.by)} ${what} ${pageOf(subj)}.` });
    } else if (e.kind === "note") {
      let about = pageOf(subj);
      if (e.relation) {
        const outDir = e.relation.source_id === subj.id;
        about = `the record that ${relationPhrase(db, subj, e.relation.edge_type, outDir ? "out" : "in", outDir ? e.relation.target_id : e.relation.source_id)}`;
      } else if (e.meta_key) {
        about = `${e.meta_key} on ${pageOf(subj)}`;
      }
      const words = e.note ? `: “${clip(e.note)}”` : "";
      const verb = e.note_kind === "contest" ? "contested" : "added context to";
      out.push({ key: `note:${sig}`, kind: "note", at: e.at, submitter: submitterOf(db, sig) ?? e.by, line: `${who(e.by)} ${verb} ${about}${words || "."}` });
    }
  }
  return out;
}

function pendingEvents(db: DatabaseSync, subj: Subject, floor: string): FoundEvent[] {
  const like = `%${JSON.stringify(subj.id).slice(1, -1)}%`;
  const rows = db.prepare(
    `SELECT q.id, q.signal_id, q.submitted_by, q.created_at, q.target_node, q.proposed_nodes, q.proposed_edges,
            s.consent_attribution
       FROM intake_queue q LEFT JOIN signals s ON s.id = q.signal_id
      WHERE q.status = 'pending' AND q.kind = 'human_signal' AND q.created_at > ?
        AND (q.target_node = ? OR q.proposed_edges LIKE ? OR q.proposed_nodes LIKE ?)`
  ).all(floor, subj.id, like, like) as any[];
  const out: FoundEvent[] = [];
  for (const r of rows) {
    const by = r.consent_attribution === "anonymous" ? null : r.submitted_by;
    const ops = (parse(r.proposed_nodes) ?? []) as any[];
    const created = new Map<string, string>();
    for (const op of ops) if (op?.op === "create_node" && op.type && op.slug) created.set(`${op.type}:${op.slug}`, op.name ?? op.slug);
    for (const e of (parse(r.proposed_edges) ?? []) as any[]) {
      if (!e || (e.source_id !== subj.id && e.target_id !== subj.id)) continue;
      const dir = e.source_id === subj.id ? "out" : "in";
      const other = dir === "out" ? e.target_id : e.source_id;
      const phrase = relationPhrase(db, subj, String(e.edge_type), dir, String(other), created.get(other));
      out.push({
        // the signal its live edge will carry (materialise: e.signal_id ?? the item's)
        key: `rel:${e.signal_id ?? r.signal_id ?? r.id}:${e.source_id}|${e.edge_type}|${e.target_id}`,
        kind: "pending", at: r.created_at, submitter: r.submitted_by,
        line: `${who(by)} proposed that ${phrase} (waiting for a curator).`,
      });
    }
    for (const op of ops) {
      if (op?.node_id !== subj.id || op.op !== "patch_node") continue;
      const keys = Object.keys(op.metadata ?? {}).filter((k) => k !== "claimed");
      if (!keys.length) continue;
      out.push({
        key: `meta:${op.signal_id ?? r.signal_id ?? r.id}:patch_node`,
        kind: "pending", at: r.created_at, submitter: r.submitted_by,
        line: `${who(by)} proposed changing ${keys.join(", ")} on ${pageOf(subj)} (waiting for a curator).`,
      });
    }
  }
  return out;
}

/** What happened to one claimed node after `floor`, not by `self` (names or ids). */
export function eventsFor(db: DatabaseSync, nodeId: string, floor: string, self: string[]): FoundEvent[] {
  const h = nodeHistory(db, nodeId);
  if (!h) return [];
  const subj: Subject = { id: h.node.id, name: h.node.name, type: h.node.type };
  const mine = new Set(self.filter(Boolean));
  return [...pendingEvents(db, subj, floor), ...liveEvents(db, subj, h.events, floor)]
    .filter((e) => !(e.submitter && mine.has(e.submitter)));
}

/**
 * Record new events for every approved claim. Returns how many were new.
 * The first run ever only sets the starting line (nothing before it is news).
 */
export function scanClaimantEvents(db: DatabaseSync): number {
  const now = nowIso(db);
  const since = (db.prepare("SELECT value FROM settings WHERE key = ?").get(SINCE_KEY) as any)?.value as string | undefined;
  if (!since) {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(SINCE_KEY, now);
    return 0;
  }
  const claims = db.prepare(
    `SELECT c.node_id, c.contributor_id, COALESCE(c.reviewed_at, c.created_at) AS since, k.name
       FROM node_claims c LEFT JOIN contributors k ON k.id = c.contributor_id
      WHERE c.status = 'approved'`
  ).all() as any[];
  const ins = db.prepare(
    "INSERT OR IGNORE INTO claimant_events (id, contributor_id, node_id, event_key, kind, line, at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let n = 0;
  for (const c of claims) {
    const floor = [since, c.since ?? ""].sort().pop()!;
    for (const e of eventsFor(db, c.node_id, floor, [c.contributor_id, c.name])) {
      const r = ins.run(`cev_${crypto.randomBytes(8).toString("hex")}`, c.contributor_id, c.node_id, e.key, e.kind, e.line, e.at);
      n += Number(r.changes);
    }
  }
  return n;
}

// ---- deliver ----------------------------------------------------------------------------

export interface PendingEvent { id: string; node_id: string; kind: string; line: string; at: string | null }

export interface RenderedClaimantEmail { to: string; subject: string; text: string; html: string }

function undelivered(db: DatabaseSync, contributorId: string, channel: string): PendingEvent[] {
  return db.prepare(
    `SELECT e.id, e.node_id, e.kind, e.line, e.at FROM claimant_events e
      WHERE e.contributor_id = ? AND NOT EXISTS (SELECT 1 FROM claimant_deliveries d WHERE d.event_id = e.id AND d.channel = ?)
      ORDER BY e.node_id, e.at, e.created_at`
  ).all(contributorId, channel) as any[];
}

function mark(db: DatabaseSync, events: PendingEvent[], channel: string, state: string, ref: string | null): void {
  const ins = db.prepare("INSERT OR IGNORE INTO claimant_deliveries (event_id, channel, state, ref) VALUES (?, ?, ?, ?)");
  for (const e of events) ins.run(e.id, channel, state, ref);
}

export function renderClaimantEmail(db: DatabaseSync, to: string, mode: EmailMode, events: PendingEvent[], link: string): RenderedClaimantEmail {
  const byNode = new Map<string, PendingEvent[]>();
  for (const e of events) {
    if (!byNode.has(e.node_id)) byNode.set(e.node_id, []);
    byNode.get(e.node_id)!.push(e);
  }
  const base = baseUrl();
  const subject = events.length === 1
    ? clip(events[0].line.replace(/\.$/, "")) + " — review it"
    : `${events.length} new things about ${byNode.size === 1 ? nameOf(db, events[0].node_id) : "your A(DAI) pages"} — review them`;
  const parts: string[] = [];
  for (const [nodeId, evs] of byNode) {
    // A big read (a gallery's whole roster) stays readable: the rest is on /me.
    const shown = evs.slice(0, LINES_PER_NODE).map((e) => `• ${e.line}`);
    if (evs.length > LINES_PER_NODE) shown.push(`• … and ${evs.length - LINES_PER_NODE} more`);
    const lines = shown.join("\n");
    parts.push(`${nameOf(db, nodeId)}\n${lines}\n${base}/me?node=${encodeURIComponent(nodeId)}`);
  }
  const text =
    `New in the A(DAI) commons about ${byNode.size === 1 ? "a page you claimed" : "pages you claimed"}:\n\n` +
    parts.join("\n\n") +
    `\n\nReview it in your log — confirm it, add context, contest what is wrong, or object to what is still in review:\n${link}\n` +
    `(the link signs you in and is valid for 7 days)\n\n` +
    `You get these ${mode === "immediate" ? "as they happen" : "once a day"}. Change it, or turn them off, on ${base}/me`;
  return { to, subject, text, html: textToHtml(text) };
}

export interface DeliverResult {
  sent: number;           // emails sent (or logged by the stdout transport)
  events: number;         // events they carried
  skipped: number;        // events marked skipped (setting off / no address)
  emails: RenderedClaimantEmail[];
}

/**
 * `immediate`: only contributors who asked for it. `daily`: everyone who
 * gets email (immediate included, catching anything an immediate pass missed).
 */
export async function deliverClaimantEmails(db: DatabaseSync, opts: { mode: "immediate" | "daily"; dryRun?: boolean }): Promise<DeliverResult> {
  const result: DeliverResult = { sent: 0, events: 0, skipped: 0, emails: [] };
  const rows = db.prepare(
    `SELECT DISTINCT e.contributor_id FROM claimant_events e
      WHERE NOT EXISTS (SELECT 1 FROM claimant_deliveries d WHERE d.event_id = e.id AND d.channel = 'email')`
  ).all() as any[];
  for (const { contributor_id } of rows) {
    const prefs = getNotifyPrefs(db, contributor_id);
    const events = undelivered(db, contributor_id, "email");
    if (!events.length) continue;
    if (prefs.email === "off") {
      if (!opts.dryRun) mark(db, events, "email", "skipped", "off");
      result.skipped += events.length;
      continue;
    }
    if (opts.mode === "immediate" && prefs.email !== "immediate") continue;
    const to = emailFor(db, contributor_id);
    if (!to) {
      if (!opts.dryRun) mark(db, events, "email", "skipped", "no_address");
      result.skipped += events.length;
      continue;
    }
    const first = events[0].node_id;
    const link = opts.dryRun
      ? `${baseUrl()}/me?node=${encodeURIComponent(first)}`
      : issueMagicLink(db, { email: to, purpose: "receipt", redirect: `/me?node=${encodeURIComponent(first)}` }).url;
    const msg = renderClaimantEmail(db, to, prefs.email, events, link);
    result.emails.push(msg);
    if (opts.dryRun) continue;
    try {
      const r = await sendMail({ from: fromAddress(), to: [to], replyTo: replyTo(), subject: msg.subject, text: msg.text, html: msg.html });
      mark(db, events, "email", "sent", r.id || r.transport);
      result.sent++;
      result.events += events.length;
    } catch (e: any) {
      // Left undelivered: the next pass tries again.
      console.error(`[notify:claimants] mail to ${contributor_id} failed: ${e?.message ?? e}`);
    }
  }
  return result;
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
 */
export function startClaimantNotifier(db: DatabaseSync, onContribution: (fn: () => void) => unknown, opts: { delayMs?: number; everyMs?: number } = {}): () => void {
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
