// Drafts: the unit of work of the URL intake (docs/URL-INTAKE-SPEC.md §5,
// §6.1, §9, §10).
//
// A draft is created by a contributor from a URL, worked on by the intake
// worker through the draft tools (candidates, pages, messages), reviewed on
// /draft/:id, and CONFIRMED into one attributed batch. The `drafts` table is
// also the job queue: `job IS NOT NULL` means "a worker should pick this
// up"; claims are atomic and expire after 20 min without a heartbeat.
//
// Trust promise 1 lives here by omission: nothing in this module except
// confirmDraft imports the materialise* helpers, and confirmDraft is only
// reachable from the contributor route with a session.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuthedContributor } from "../auth.js";
import { isAutoMerge } from "../auth.js";
import { slugify, legacySlugify } from "../utils/slug.js";
import { nowIso, plusIso, todayUtc } from "../utils/time.js";
import { checkUrlSyntax, SsrfError } from "../utils/ssrf.js";
import {
  insertSignal,
  insertIntake,
  ensureContributorRow,
  bumpApprovedCount,
  materialiseCreateNode,
  materialisePatchNode,
  materialiseAttachImage,
  materialiseEdge,
  materialiseEndEdge,
  type ProposedNodeOp,
  type ProposedEdge,
} from "../utils/contribution.js";
import { embedNodeAsync } from "../embed/server.js";
import { mirrorImageFromUrl } from "../utils/images.js";
import {
  validateCandidate,
  applyContributorPatch,
  nextCid,
  isCidRef,
  linkUnchecked,
  CandidateError,
  MAX_CANDIDATES,
  MAX_PAGES,
  PRESENT_TENSE_EDGE_TYPES,
  type Candidate,
  type NodeCandidate,
  type EdgeSpec,
} from "./candidate.js";
import { leftOpen, cardDeps, openItemsOf, insertOpenItem, decideOpenItem } from "./open-items.js";

// ---- types ---------------------------------------------------------------

export type DraftStatus = "queued" | "running" | "ready" | "submitted" | "failed" | "abandoned";
export type JobKind = "initial" | "chat" | "continue";

export interface Job {
  kind: JobKind;
  message?: string;
  queued_at: string;
}

export interface PageEntry {
  url: string;
  final_url: string;
  title: string | null;
  fetched_at: string;
  status: number;
  chars: number;
  sha256: string;
  via: "browser" | "fetch";
}

export interface Message {
  role: "user" | "assistant";
  text: string;
  at: string;
}

/**
 * The agent's survey of the site, written before deep extraction and
 * updated at the end of each pass: what the site holds (inventory), how
 * the pass spreads over it (plan), what was covered and what was not.
 * It is what makes a partial draft honest about being partial, and what a
 * later pass reads instead of starting from scratch.
 */
export interface Survey {
  site_kind: "artist" | "gallery" | "platform" | "institution" | "publication" | "other";
  inventory: Array<{ label: string; count: number | null; url?: string }>;
  plan?: string;
  covered?: string;
  remaining?: string;
  updated_at: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  est_cost_usd: number;
  passes: number;
  model?: string;
}

export interface Draft {
  id: string;
  contributor_id: string;
  source_url: string;
  source_domain: string;
  status: DraftStatus;
  job: Job | null;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  machine_id: string | null;
  subject_node_id: string | null;
  candidates: Candidate[];
  messages: Message[];
  pages: PageEntry[];
  summary: string | null;
  survey: Survey | null;
  usage: Usage | null;
  intake_ids: string[] | null;
  error: string | null;
  passes: number;
  notified_ready_at: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  /** A pick-up of another draft's left-open items (issue #77): that draft. */
  picked_from: string | null;
}

export class DraftError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = "DraftError";
  }
}

// ---- limits (env-tunable) ---------------------------------------------------

function envInt(name: string, def: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
function envFloat(name: string, def: number): number {
  const n = parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export const CLAIM_TTL_MS = 20 * 60_000;
// Beta defaults (Sept 2026): generous on purpose — galleries need several
// passes over a large programme. Tighten via env, not by editing these.
const MAX_ACTIVE_DRAFTS = () => envInt("INTAKE_MAX_ACTIVE_DRAFTS", 6);
const MAX_DRAFTS_PER_DAY = () => envInt("INTAKE_MAX_DRAFTS_PER_DAY", 30);
const MAX_PASSES = () => envInt("INTAKE_MAX_PASSES", 16);
const DAILY_BUDGET_USD = () => envFloat("INTAKE_DAILY_BUDGET_USD", 60);
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 4000;

// ---- row <-> object ---------------------------------------------------------

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function rowToDraft(row: any): Draft {
  return {
    id: row.id,
    contributor_id: row.contributor_id,
    source_url: row.source_url,
    source_domain: row.source_domain,
    status: row.status,
    job: parseJson<Job | null>(row.job, null),
    claimed_by: row.claimed_by ?? null,
    claimed_at: row.claimed_at ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    machine_id: row.machine_id ?? null,
    subject_node_id: row.subject_node_id ?? null,
    candidates: parseJson<Candidate[]>(row.candidates, []),
    messages: parseJson<Message[]>(row.messages, []),
    pages: parseJson<PageEntry[]>(row.pages, []),
    summary: row.summary ?? null,
    survey: parseJson<Survey | null>(row.survey, null),
    usage: parseJson<Usage | null>(row.usage, null),
    intake_ids: parseJson<string[] | null>(row.intake_ids, null),
    error: row.error ?? null,
    passes: row.passes ?? 0,
    notified_ready_at: row.notified_ready_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    submitted_at: row.submitted_at ?? null,
    picked_from: row.picked_from ?? null,
  };
}

const SELECT = "SELECT * FROM drafts";

export function getDraft(db: DatabaseSync, id: string): Draft | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row ? rowToDraft(row) : null;
}

export function mustGetDraft(db: DatabaseSync, id: string): Draft {
  const d = getDraft(db, id);
  if (!d) throw new DraftError("draft not found", 404, "not_found");
  return d;
}

export interface DraftSummary {
  id: string;
  source_url: string;
  source_domain: string;
  status: DraftStatus;
  job_pending: boolean;
  candidate_count: number;
  page_count: number;
  subject_node_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

export function listDrafts(db: DatabaseSync, contributorId: string): DraftSummary[] {
  const rows = db
    .prepare(`${SELECT} WHERE contributor_id = ? ORDER BY created_at DESC LIMIT 100`)
    .all(contributorId) as any[];
  return rows.map(rowToDraft).map(summarise);
}

export function summarise(d: Draft): DraftSummary {
  return {
    id: d.id,
    source_url: d.source_url,
    source_domain: d.source_domain,
    status: d.status,
    job_pending: !!d.job,
    candidate_count: d.candidates.length,
    page_count: d.pages.length,
    subject_node_id: d.subject_node_id,
    created_at: d.created_at,
    updated_at: d.updated_at,
    submitted_at: d.submitted_at,
  };
}

/** What the owner (and a bearer-token assistant) sees. Worker plumbing stripped. */
export function toOwnerJson(d: Draft): Record<string, unknown> {
  const { claimed_by: _cb, machine_id: _mid, ...rest } = d;
  return { ...rest, job_pending: !!d.job, job_kind: d.job?.kind ?? null };
}

// ---- write helpers ---------------------------------------------------------------

function touch(db: DatabaseSync, id: string, sets: Record<string, unknown>): void {
  const keys = Object.keys(sets);
  const sql = `UPDATE drafts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
  db.prepare(sql).run(...(keys.map((k) => sets[k]) as any[]), nowIso(), id);
}

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

// ---- budget ------------------------------------------------------------------------

export function checkDailyBudget(db: DatabaseSync): { ok: boolean; spent: number; cap: number } {
  const cap = DAILY_BUDGET_USD();
  if (cap <= 0) return { ok: true, spent: 0, cap };
  const row = db.prepare("SELECT est_cost_usd FROM intake_usage WHERE date = ?").get(todayUtc()) as any;
  const spent = row?.est_cost_usd ?? 0;
  return { ok: spent < cap, spent, cap };
}

export function recordIntakeUsage(db: DatabaseSync, u: Partial<Usage>): void {
  db.prepare(
    `INSERT INTO intake_usage (date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, est_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         est_cost_usd = est_cost_usd + excluded.est_cost_usd`
  ).run(
    todayUtc(),
    u.input_tokens ?? 0,
    u.output_tokens ?? 0,
    u.cache_read_tokens ?? 0,
    u.cache_write_tokens ?? 0,
    u.est_cost_usd ?? 0
  );
}

// ---- contributor side -------------------------------------------------------------

export function createDraft(db: DatabaseSync, contributorId: string, sourceUrlRaw: unknown): Draft {
  if (typeof sourceUrlRaw !== "string" || !sourceUrlRaw.trim()) throw new DraftError("source_url is required", 400, "bad_url");
  let u: URL;
  try {
    u = checkUrlSyntax(sourceUrlRaw.trim());
  } catch (e: any) {
    if (e instanceof SsrfError) throw new DraftError(`source_url: ${e.message}`, 400, e.code);
    throw e;
  }
  const active = db
    .prepare("SELECT COUNT(*) AS n FROM drafts WHERE contributor_id = ? AND status IN ('queued','running','ready')")
    .get(contributorId) as any;
  if (active.n >= MAX_ACTIVE_DRAFTS()) {
    throw new DraftError(`you already have ${active.n} drafts in progress — confirm or abandon one first`, 429, "too_many_active");
  }
  const today = db
    .prepare("SELECT COUNT(*) AS n FROM drafts WHERE contributor_id = ? AND created_at >= ?")
    .get(contributorId, `${todayUtc()}T00:00:00Z`) as any;
  if (today.n >= MAX_DRAFTS_PER_DAY()) throw new DraftError("daily draft limit reached", 429, "daily_limit");
  const budget = checkDailyBudget(db);
  if (!budget.ok) throw new DraftError("the intake is resting for today (budget reached) — try tomorrow", 503, "budget_exceeded");

  const id = `drf_${crypto.randomBytes(8).toString("hex")}`;
  const job: Job = { kind: "initial", queued_at: nowIso() };
  db.prepare(
    "INSERT INTO drafts (id, contributor_id, source_url, source_domain, status, job) VALUES (?, ?, ?, ?, 'queued', ?)"
  ).run(id, contributorId, u.toString(), u.hostname.toLowerCase(), JSON.stringify(job));
  return getDraft(db, id)!;
}

export function enqueueChat(db: DatabaseSync, draft: Draft, messageRaw: unknown): Draft {
  if (typeof messageRaw !== "string" || !messageRaw.trim()) throw new DraftError("message is required", 400, "bad_message");
  const message = messageRaw.trim().slice(0, MAX_MESSAGE_CHARS);
  if (draft.job) throw new DraftError("the agent is still working on this draft", 409, "job_pending");
  if (draft.status !== "ready" && draft.status !== "failed") {
    throw new DraftError(`draft is ${draft.status}; chat is available once it is ready`, 409, "not_ready");
  }
  if (draft.passes >= MAX_PASSES()) throw new DraftError("this draft has used all its passes", 429, "pass_limit");
  if (draft.messages.length >= MAX_MESSAGES) throw new DraftError("transcript is full", 429, "transcript_full");
  const budget = checkDailyBudget(db);
  if (!budget.ok) throw new DraftError("the intake is resting for today (budget reached)", 503, "budget_exceeded");
  const messages = [...draft.messages, { role: "user" as const, text: message, at: nowIso() }];
  const job: Job = { kind: "chat", message, queued_at: nowIso() };
  touch(db, draft.id, { messages: JSON.stringify(messages), job: JSON.stringify(job), status: "queued", error: null });
  return getDraft(db, draft.id)!;
}

/**
 * Another full reading pass over the same site: the agent gets its survey,
 * the page ledger and the contributor's decisions so far, and reads what
 * the earlier passes did not. `focus` is an optional steer ("the 2019–2021
 * exhibitions", "Auriea Harvey").
 */
export function enqueueContinue(db: DatabaseSync, draft: Draft, focusRaw?: unknown): Draft {
  if (draft.job) throw new DraftError("the agent is still working on this draft", 409, "job_pending");
  if (draft.status !== "ready" && draft.status !== "failed") {
    throw new DraftError(`draft is ${draft.status}; it can be continued once it is ready`, 409, "not_ready");
  }
  if (draft.passes >= MAX_PASSES()) throw new DraftError("this draft has used all its passes", 429, "pass_limit");
  const budget = checkDailyBudget(db);
  if (!budget.ok) throw new DraftError("the intake is resting for today (budget reached)", 503, "budget_exceeded");
  const focus = typeof focusRaw === "string" && focusRaw.trim() ? focusRaw.trim().slice(0, MAX_MESSAGE_CHARS) : undefined;
  const sets: Record<string, unknown> = { status: "queued", error: null };
  if (focus) {
    sets.messages = JSON.stringify([...draft.messages, { role: "user" as const, text: `Read more of the site: ${focus}`, at: nowIso() }].slice(-MAX_MESSAGES));
  }
  const job: Job = { kind: "continue", queued_at: nowIso(), ...(focus ? { message: focus } : {}) };
  touch(db, draft.id, { ...sets, job: JSON.stringify(job) });
  return getDraft(db, draft.id)!;
}

export function abandonDraft(db: DatabaseSync, draft: Draft): Draft {
  if (draft.status === "submitted") throw new DraftError("already submitted", 409, "submitted");
  touch(db, draft.id, { status: "abandoned", job: null });
  return getDraft(db, draft.id)!;
}

/**
 * Pick up the items another read left open (issue #77): a new draft of the
 * picker's holding copies of those cards, ready to decide — no reading pass,
 * no email. An accepted card an item needs (the work an open relation is
 * about) comes along as a link when the graph has it, else as a card to
 * accept with it. Picking up the same read again returns the draft already
 * open for it.
 */
export function createPickupDraft(db: DatabaseSync, contributorId: string, sourceId: string): Draft {
  const source = getDraft(db, sourceId);
  if (!source || source.status !== "submitted") throw new DraftError("no such read", 404, "not_found");
  const rows = openItemsOf(db, source.id).filter((r) => !r.decided_at);
  if (!rows.length) throw new DraftError("nothing is left open in this read", 409, "nothing_open");
  const already = db
    .prepare("SELECT id FROM drafts WHERE contributor_id = ? AND picked_from = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1")
    .get(contributorId, source.id) as { id: string } | undefined;
  if (already) return getDraft(db, already.id)!;
  const active = db
    .prepare("SELECT COUNT(*) AS n FROM drafts WHERE contributor_id = ? AND status IN ('queued','running','ready')")
    .get(contributorId) as any;
  if (active.n >= MAX_ACTIVE_DRAFTS()) {
    throw new DraftError(`you already have ${active.n} drafts in progress — confirm or abandon one first`, 429, "too_many_active");
  }

  const nodeExists = (id: string) => !!db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id);
  const ctx = { nodeExists, slugify };
  const byCid = new Map(source.candidates.map((c) => [c.cid, c]));
  const take = new Map(rows.map((r) => [r.cid, r]));
  const subst = new Map<string, string>(); // "cid:c_03" → node id the graph has
  const carry = new Set<string>();
  for (const cid of take.keys()) {
    const c = byCid.get(cid);
    if (!c) continue;
    for (const dep of cardDeps(c)) {
      if (take.has(dep)) continue;
      const d = byCid.get(dep);
      if (!d || d.kind !== "node") continue;
      const id = d.resolves_to ?? [`${d.node.type}:${slugify(d.node.name)}`, `${d.node.type}:${legacySlugify(d.node.name)}`].find(nodeExists);
      if (id && nodeExists(id)) subst.set(`cid:${dep}`, id);
      else carry.add(dep);
    }
  }
  const order = (c: Candidate) => (c.kind === "node" ? 0 : 1);
  const picked = source.candidates.filter((c) => take.has(c.cid) || carry.has(c.cid)).sort((a, b) => order(a) - order(b));
  const cands: Candidate[] = [];
  for (const c of picked) {
    let json = JSON.stringify(c);
    for (const [ref, id] of subst) json = json.split(JSON.stringify(ref)).join(JSON.stringify(id));
    const raw = JSON.parse(json);
    // A link nobody has re-checked starts rejected again, as it did for the
    // first reader; everything else waits for a decision.
    raw.state = take.get(c.cid)?.reason === "link_failed" && raw.link_check ? "rejected" : "proposed";
    raw.edited = false;
    if (raw.kind === "node" && !raw.resolves_to) {
      // Created since the read: the card now links to it.
      const id = [`${raw.node.type}:${slugify(raw.node.name)}`, `${raw.node.type}:${legacySlugify(raw.node.name)}`].find(nodeExists);
      if (id) { raw.resolves_to = id; raw.resolution = "exact"; }
    }
    try {
      cands.push(validateCandidate(raw, cands, ctx));
    } catch {
      // The graph moved on (a node retired, a card it needs failed); the item
      // stays open for a fresh read.
    }
  }
  if (!cands.some((c) => take.has(c.cid))) throw new DraftError("nothing left open in this read can still be decided", 409, "nothing_open");

  const subj = source.subject_node_id;
  const subject = subj && isCidRef(subj) ? subst.get(subj) ?? (cands.some((c) => c.cid === subj.slice(4)) ? subj : null) : subj;
  const by = (db.prepare("SELECT name FROM contributors WHERE id = ?").get(source.contributor_id) as any)?.name ?? "a contributor";
  const n = cands.filter((c) => take.has(c.cid)).length;
  const summary =
    `Left open in ${by}'s read of ${source.source_domain} (${String(source.submitted_at ?? source.created_at).slice(0, 10)}): ` +
    `${n} item${n === 1 ? "" : "s"} nobody has decided yet. Decide what you can — what you submit is yours, and ${by} is credited as the first to propose it. ` +
    `Whatever you leave undecided stays open for the next person.`;
  const id = `drf_${crypto.randomBytes(8).toString("hex")}`;
  db.prepare(
    `INSERT INTO drafts (id, contributor_id, source_url, source_domain, status, subject_node_id, candidates, pages, summary, notified_ready_at, picked_from)
     VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)`
  ).run(id, contributorId, source.source_url, source.source_domain, subject, JSON.stringify(cands), JSON.stringify(source.pages), summary, nowIso(), source.id);
  return getDraft(db, id)!;
}

// What a card claims, without the review bookkeeping around it.
function cardContent(c: Candidate): Record<string, unknown> {
  const { cid: _cid, state: _state, origin: _origin, edited: _edited, note: _note, evidence: _evidence, proposed_as: _p, ...content } = c;
  return content;
}

export function contributorPatchCandidate(
  db: DatabaseSync,
  draft: Draft,
  cid: string,
  patch: { state?: unknown; patch?: unknown; answer?: unknown; answered_yes?: unknown }
): Candidate {
  if (draft.status !== "ready") throw new DraftError(`draft is ${draft.status}`, 409, "not_ready");
  return tx(db, () => {
    const fresh = mustGetDraft(db, draft.id);
    const idx = fresh.candidates.findIndex((c) => c.cid === cid);
    if (idx < 0) throw new DraftError("candidate not found", 404, "not_found");
    const next = applyContributorPatch(fresh.candidates[idx]!, patch);
    // Re-validate so an edit can't smuggle in an out-of-policy edge type.
    const others = fresh.candidates.filter((c) => c.cid !== cid);
    const checked = validateCandidate(next, others, {
      nodeExists: (id) => !!db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id),
      slugify,
    });
    checked.edited = true;
    const cur = fresh.candidates[idx]!;
    const proposedAs = cur.proposed_as ?? (JSON.stringify(cardContent(cur)) !== JSON.stringify(cardContent(checked)) ? cardContent(cur) : undefined);
    if (proposedAs) checked.proposed_as = proposedAs;
    fresh.candidates[idx] = checked;
    touch(db, draft.id, { candidates: JSON.stringify(fresh.candidates) });
    return checked;
  });
}

// ---- memory across passes and drafts ------------------------------------------------

/** One line a later pass can read: what a card was about, names not cids. */
export function candidateLabel(c: Candidate, all: Candidate[]): string {
  const name = (ref: string): string => {
    if (!isCidRef(ref)) return ref;
    const n = all.find((x) => x.cid === ref.slice(4));
    return n && n.kind === "node" ? `${n.node.type}:${n.node.name}` : ref;
  };
  switch (c.kind) {
    case "node": return `${c.node.type} "${c.node.name}"${c.resolves_to ? ` (= ${c.resolves_to})` : ""}`;
    case "edge": return `${name(c.edge.source)} ${c.edge.edge_type} ${name(c.edge.target)}`;
    case "image": return `image for ${name(c.image.for)}`;
    case "patch": return `correction ${c.patch.node_id}.${c.patch.key}`;
    case "question": return `question: ${c.question.text.slice(0, 160)}`;
    case "known": return `known: ${c.known.summary.slice(0, 160)}`;
    case "ended": return `ended ${c.ended.edge_type} ${c.ended.source_id} → ${c.ended.target_id}`;
  }
}

/** One page of an earlier read: when, and what it hashed to then. */
export interface PriorPage {
  url: string;
  fetched_at: string;
  sha256: string;
}

export interface PriorContext {
  drafts: number;
  /** Most recent earlier read of each page (newest first). */
  pages: PriorPage[];
  /** When the site was last read before this draft, or null. */
  last_read: string | null;
  rejected: string[];
  submitted: string[];
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/**
 * What earlier reads of the same site already did. A read is a dated
 * snapshot, so a later draft is an UPDATE: the page ledger (URL, date,
 * content hash) lets the worker tell a changed page from an unchanged one.
 *
 * The ledger spans this contributor's drafts AND every submitted draft of
 * the site — page hashes are not personal. Decisions are: the rejected and
 * submitted cards come from this contributor's drafts only (one person's
 * "no" is not another's).
 */
export function priorContext(db: DatabaseSync, draft: Draft): PriorContext {
  // gallery.example and www.gallery.example are one site.
  const bare = bareHost(draft.source_domain);
  const rows = db
    .prepare(
      `${SELECT} WHERE source_domain IN (?, ?) AND id != ? AND (contributor_id = ? OR status = 'submitted')
       ORDER BY created_at DESC LIMIT 20`
    )
    .all(bare, `www.${bare}`, draft.id, draft.contributor_id) as any[];
  const pages = new Map<string, PriorPage>();
  const rejected = new Set<string>();
  const submitted = new Set<string>();
  let own = 0;
  for (const d of rows.map(rowToDraft)) {
    for (const p of d.pages) {
      const url = p.final_url || p.url;
      const prev = pages.get(url);
      if (p.sha256 && (!prev || p.fetched_at > prev.fetched_at)) pages.set(url, { url, fetched_at: p.fetched_at, sha256: p.sha256 });
    }
    if (d.contributor_id !== draft.contributor_id) continue;
    own++;
    for (const c of d.candidates) {
      if (c.kind === "image" || c.kind === "known") continue;
      // A card that started rejected because its link failed is nobody's "no".
      if ((c.state === "rejected" && !linkUnchecked(c)) || c.state === "context_only") rejected.add(candidateLabel(c, d.candidates));
      else if (d.status === "submitted" && c.state === "accepted") submitted.add(candidateLabel(c, d.candidates));
    }
  }
  const sorted = [...pages.values()].sort((a, b) => (a.fetched_at < b.fetched_at ? 1 : -1));
  return {
    drafts: rows.length,
    pages: sorted.slice(0, 200),
    last_read: sorted[0]?.fetched_at ?? null,
    rejected: own ? [...rejected].slice(0, 150) : [],
    submitted: own ? [...submitted].slice(0, 150) : [],
  };
}

/**
 * The live edge an `ended` card would close — only a present-tense
 * relation that THIS site attested (its evidence signal cites a page on the
 * same domain). A site can withdraw what it said, not what others said.
 */
function endableEdge(db: DatabaseSync, draft: Draft, edgeId: string): { edge_type: string; source_id: string; target_id: string; attested_at: string | null } {
  const e = db
    .prepare(
      `SELECT e.edge_type, e.source_id, e.target_id, e.valid_until, s.source_url, s.created_at
         FROM edges e LEFT JOIN signals s ON s.id = e.signal_id WHERE e.id = ?`
    )
    .get(edgeId) as any;
  if (!e) throw new CandidateError(`no edge '${edgeId}' — take ids from site_claims`, "ended.edge_id");
  if (e.valid_until) throw new CandidateError(`edge '${edgeId}' already ended ${e.valid_until}`, "ended.edge_id");
  if (!(PRESENT_TENSE_EDGE_TYPES as readonly string[]).includes(e.edge_type)) {
    throw new CandidateError(`${e.edge_type} is an event and stays true; only ${PRESENT_TENSE_EDGE_TYPES.join(", ")} can end`, "ended.edge_id");
  }
  let host = "";
  try { host = bareHost(new URL(String(e.source_url ?? "")).hostname); } catch { /* no source */ }
  if (!host || host !== bareHost(draft.source_domain)) {
    throw new CandidateError(`edge '${edgeId}' was not attested by ${draft.source_domain}; this site cannot end it`, "ended.edge_id");
  }
  return { edge_type: e.edge_type, source_id: e.source_id, target_id: e.target_id, attested_at: e.created_at ?? null };
}

/**
 * The contributor's "no" binds the agent: a proposal equal to a card they
 * rejected (or set aside as context) is refused here, so a prompt slip
 * cannot resurrect it. Unresolved artworks are exempt — two works can
 * share a title.
 */
function refusedByContributor(next: Candidate, cands: Candidate[]): Candidate | null {
  for (const c of cands) {
    if (c.state !== "rejected" && c.state !== "context_only") continue;
    if (linkUnchecked(c)) continue; // rejected by the reader, not by the contributor
    if (c.kind === "edge" && next.kind === "edge") {
      if (c.edge.edge_type === next.edge.edge_type && c.edge.source === next.edge.source && c.edge.target === next.edge.target) return c;
    } else if (c.kind === "image" && next.kind === "image") {
      if (c.image.for === next.image.for && c.image.image_url === next.image.image_url) return c;
    } else if (c.kind === "ended" && next.kind === "ended") {
      if (c.ended.edge_id === next.ended.edge_id) return c;
    } else if (c.kind === "node" && next.kind === "node") {
      if (c.resolves_to && c.resolves_to === next.resolves_to) return c;
      if (!c.resolves_to && !next.resolves_to && c.node.type !== "artwork" && c.node.type === next.node.type && slugify(c.node.name) === slugify(next.node.name)) return c;
    }
  }
  return null;
}

/**
 * A name on a page attests that the name is on the page — not that the
 * gallery REPRESENTS the artist. First gallery run (interfacegallery.io, a
 * self-described "project-based gallery, private art dealership"): the
 * agent proposed REPRESENTS for David Hockney, Lucio Fontana and Ellsworth
 * Kelly off a roster headed "Artists (project)", quoting only their names.
 * So the agent's REPRESENTS quote must carry representation language beyond
 * the artist's name. Agent path only: a contributor who edits an edge to
 * REPRESENTS is attesting it themselves.
 */
function representsNeedsMoreThanAName(c: Candidate, cands: Candidate[]): void {
  if (c.kind !== "edge" || c.edge.edge_type !== "REPRESENTS" || c.origin !== "site") return;
  const quote = c.evidence?.quote ?? "";
  // "Gallery Artists › Jane Doe": the section heading is the claim (the
  // worker has checked that the name really sits under that heading).
  const [head, item] = quote.split(/\s*[›>]\s*/);
  if (item !== undefined && head && head.trim().length >= 3) return;
  // Otherwise the sentence itself must say it. A bio ("Jane Doe is a
  // Berlin-based artist…") proves the name is on the page, not that the
  // gallery represents her — Fellowship run 3: 5 of 6 quotes were bios.
  if (/\brepresent|\bour artists\b|\bgallery artists\b|\bartists we (represent|work with)\b|\broster\b/i.test(quote)) return;
  throw new CandidateError(
    "REPRESENTS needs evidence of representation: the section heading the artist is listed under (quote it as \"Gallery Artists › Jane Doe\"), or a sentence that says so (\"represented by …\", \"our artists\"). A bio or a bare name shows the artist is on the page, not that the site represents them. If the site only shows, sells or has worked with the artist, connect them through the show (PARTICIPATED_IN) or the works instead, or leave the relation out.",
    "evidence.quote"
  );
}

// Relations about a named person, and which end is the person.
const NAMED_PARTY: Record<string, "source" | "target"> = {
  REPRESENTS: "target",
  CURATED_BY: "target",
  PARTICIPATED_IN: "source",
  BELONGS_TO: "source",
};

const foldName = (x: string) => x.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * A relation about a person must quote something that NAMES that person.
 * Fellowship run: 65 REPRESENTS cards all cited one /about-us sentence
 * ("Our roster spans the field…") that names nobody. A list under a heading
 * is quoted as "Heading › Name". Agent path only (origin 'site'); a
 * contributor who edits a card is attesting it themselves.
 */
function quoteNamesTheParty(db: DatabaseSync, c: Candidate, cands: Candidate[]): void {
  if (c.kind !== "edge" || c.origin !== "site" || c.edited) return;
  const end = NAMED_PARTY[c.edge.edge_type];
  if (!end) return;
  const ref = end === "source" ? c.edge.source : c.edge.target;
  let name: string | null = null;
  if (isCidRef(ref)) {
    const n = cands.find((x) => x.cid === ref.slice(4));
    name = n && n.kind === "node" ? n.node.name : null;
  } else {
    name = (db.prepare("SELECT name FROM nodes WHERE id = ?").get(ref) as any)?.name ?? ref.slice(ref.indexOf(":") + 1).replace(/-/g, " ");
  }
  if (!name) return;
  const quote = ` ${foldName(c.evidence?.quote ?? "")} `;
  const tokens = foldName(name).split(" ").filter((w) => w.length >= 3 && !["the", "and", "estate", "studio", "von", "van", "der", "del"].includes(w));
  if (!tokens.length || tokens.some((w) => quote.includes(` ${w} `))) return;
  throw new CandidateError(
    `${c.edge.edge_type}: the quote must name ${name} — a sentence about the roster in general supports no one in particular. Quote the line that names them; for a list under a heading, quote "Heading › ${name}".`,
    "evidence.quote"
  );
}

const SITE_KINDS: ReadonlySet<string> = new Set(["artist", "gallery", "platform", "institution", "publication", "other"]);

function mergeSurvey(prev: Survey | null, input: Record<string, unknown>): Survey {
  const kind = typeof input.site_kind === "string" ? input.site_kind : prev?.site_kind;
  if (!kind || !SITE_KINDS.has(kind)) throw new CandidateError(`site_kind must be one of ${[...SITE_KINDS].join(", ")}`, "site_kind");
  let inventory = prev?.inventory ?? [];
  if (input.inventory !== undefined) {
    if (!Array.isArray(input.inventory) || input.inventory.length > 16) throw new CandidateError("inventory must be an array of at most 16 entries", "inventory");
    inventory = input.inventory.map((raw) => {
      if (!isObj(raw) || typeof raw.label !== "string" || !raw.label.trim()) throw new CandidateError("each inventory entry needs a label", "inventory");
      const count = typeof raw.count === "number" && Number.isFinite(raw.count) && raw.count >= 0 ? Math.floor(raw.count) : null;
      return { label: raw.label.trim().slice(0, 80), count, ...(typeof raw.url === "string" && raw.url ? { url: raw.url.slice(0, 2048) } : {}) };
    });
  }
  const text = (k: "plan" | "covered" | "remaining"): string | undefined =>
    typeof input[k] === "string" ? (input[k] as string).trim().slice(0, 800) || undefined : prev?.[k];
  return { site_kind: kind as Survey["site_kind"], inventory, plan: text("plan"), covered: text("covered"), remaining: text("remaining"), updated_at: nowIso() };
}

// ---- worker side: queue ------------------------------------------------------------

export interface Claimed {
  draft: Draft;
  job: Job;
}

/**
 * Atomically claim the oldest claimable job (or the given draft). A claim
 * older than CLAIM_TTL_MS with no heartbeat is reclaimable. The UPDATE is
 * subquery-pinned because node:sqlite has no UPDATE … LIMIT.
 */
export function claimJob(db: DatabaseSync, workerId: string, draftId?: string): Claimed | null {
  const stale = plusIso(-CLAIM_TTL_MS);
  const now = nowIso();
  const pin = draftId ? "AND id = ?" : "";
  const params: unknown[] = [workerId, now, now, now, stale];
  if (draftId) params.push(draftId);
  const row = db
    .prepare(
      `UPDATE drafts
          SET claimed_by = ?, claimed_at = ?, heartbeat_at = ?, status = 'running', updated_at = ?
        WHERE id = (
          SELECT id FROM drafts
           WHERE job IS NOT NULL
             AND status IN ('queued', 'running')
             AND (claimed_at IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ?)
             ${pin}
           ORDER BY created_at ASC
           LIMIT 1)
        RETURNING *`
    )
    .get(...(params as any[]));
  if (!row) return null;
  const draft = rowToDraft(row);
  return { draft, job: draft.job! };
}

export function heartbeat(db: DatabaseSync, draftId: string, workerId: string): boolean {
  const r = db
    .prepare("UPDATE drafts SET heartbeat_at = ? WHERE id = ? AND claimed_by = ? AND job IS NOT NULL")
    .run(nowIso(), draftId, workerId);
  return r.changes > 0;
}

function assertClaimed(draft: Draft, workerId: string): void {
  if (draft.claimed_by !== workerId || !draft.job) {
    throw new DraftError("draft is not claimed by this worker", 409, "not_claimed");
  }
}

export interface FinishArgs {
  summary?: string | null;
  usage?: Partial<Usage> | null;
  error?: string | null;
}

export interface FinishResult {
  status: DraftStatus;
  notify: "ready" | "failed" | null;
  job_kind: JobKind;
}

export function finishPass(db: DatabaseSync, draftId: string, workerId: string, args: FinishArgs): FinishResult {
  return tx(db, () => {
    const d = mustGetDraft(db, draftId);
    assertClaimed(d, workerId);
    const jobKind = d.job!.kind;
    const hasCandidates = d.candidates.length > 0;
    const failed = !!args.error && !hasCandidates;
    const status: DraftStatus = failed ? "failed" : "ready";
    const prev = d.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, est_cost_usd: 0, passes: 0 };
    const u = args.usage ?? {};
    const usage: Usage = {
      input_tokens: prev.input_tokens + (u.input_tokens ?? 0),
      output_tokens: prev.output_tokens + (u.output_tokens ?? 0),
      cache_read_tokens: (prev.cache_read_tokens ?? 0) + (u.cache_read_tokens ?? 0),
      cache_write_tokens: (prev.cache_write_tokens ?? 0) + (u.cache_write_tokens ?? 0),
      est_cost_usd: Math.round((prev.est_cost_usd + (u.est_cost_usd ?? 0)) * 1e6) / 1e6,
      passes: prev.passes + 1,
      model: u.model ?? prev.model,
    };
    recordIntakeUsage(db, u);
    const sets: Record<string, unknown> = {
      status,
      job: null,
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
      machine_id: null,
      passes: d.passes + 1,
      usage: JSON.stringify(usage),
      error: args.error ? String(args.error).slice(0, 2000) : null,
    };
    if (typeof args.summary === "string" && args.summary.trim()) sets.summary = args.summary.trim().slice(0, 4000);
    touch(db, draftId, sets);
    // Email only for the initial pass (chat replies are read on the page).
    const notify: FinishResult["notify"] = jobKind === "initial" && !d.notified_ready_at ? (failed ? "failed" : "ready") : null;
    return { status, notify, job_kind: jobKind };
  });
}

export function markNotified(db: DatabaseSync, draftId: string): void {
  touch(db, draftId, { notified_ready_at: nowIso() });
}

export function setMachineId(db: DatabaseSync, draftId: string, machineId: string | null): void {
  touch(db, draftId, { machine_id: machineId });
}

/** Jobs queued with no live claim — the spawner's work list. */
export function pendingJobs(db: DatabaseSync): Draft[] {
  const stale = plusIso(-CLAIM_TTL_MS);
  const rows = db
    .prepare(
      `${SELECT} WHERE job IS NOT NULL AND status IN ('queued','running')
         AND (claimed_at IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ?)
       ORDER BY created_at ASC LIMIT 20`
    )
    .all(stale) as any[];
  return rows.map(rowToDraft);
}

// ---- worker side: draft tools ------------------------------------------------------------

export type DraftToolName =
  | "set_subject"
  | "note_survey"
  | "propose_node"
  | "propose_edge"
  | "propose_image"
  | "propose_patch"
  | "note_known"
  | "ask_contributor"
  | "propose_ended"
  | "update_candidate"
  | "remove_candidate";

export const DRAFT_TOOL_NAMES: ReadonlySet<string> = new Set<DraftToolName>([
  "set_subject", "note_survey", "propose_node", "propose_edge", "propose_image", "propose_patch",
  "note_known", "ask_contributor", "propose_ended", "update_candidate", "remove_candidate",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function evidenceFrom(input: Record<string, unknown>): { page_url: unknown; quote: unknown } | undefined {
  if (input.page_url === undefined && input.quote === undefined) return undefined;
  return { page_url: input.page_url, quote: input.quote };
}

/**
 * Execute one draft tool on behalf of the worker. Every path goes through
 * validateCandidate; the returned object is what the agent sees as the
 * tool result. Throws CandidateError / DraftError with agent-readable text.
 */
export function runDraftTool(
  db: DatabaseSync,
  draftId: string,
  workerId: string,
  name: string,
  inputRaw: unknown
): unknown {
  const input = isObj(inputRaw) ? inputRaw : {};
  return tx(db, () => {
    const d = mustGetDraft(db, draftId);
    assertClaimed(d, workerId);
    const nodeExists = (id: string) => !!db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id);
    const ctx = { nodeExists, slugify };
    const cands = d.candidates;

    const add = (raw: Record<string, unknown>): Candidate => {
      if (cands.length >= MAX_CANDIDATES) throw new CandidateError(`draft already has ${MAX_CANDIDATES} candidates — prefer fewer, stronger ones`);
      // A card whose own page failed to open starts rejected (issue #75): an
      // untouched one stays open for a re-check at Confirm.
      const c = validateCandidate({ ...raw, cid: nextCid(cands), state: raw.link_check ? "rejected" : "proposed", edited: false }, cands, ctx);
      representsNeedsMoreThanAName(c, cands);
      quoteNamesTheParty(db, c, cands);
      const no = refusedByContributor(c, cands);
      if (no) throw new CandidateError(`the contributor already said no to this (${no.cid}, ${no.state}) — do not propose it again`);
      cands.push(c);
      return c;
    };

    switch (name) {
      case "set_subject": {
        const ref = typeof input.node_id === "string" ? input.node_id : typeof input.cid === "string" ? `cid:${input.cid}` : null;
        if (!ref) throw new CandidateError("set_subject needs node_id or cid");
        if (isCidRef(ref)) {
          const c = cands.find((x) => x.cid === ref.slice(4));
          if (!c || c.kind !== "node") throw new CandidateError(`${ref} is not a node candidate in this draft`);
        } else if (!nodeExists(ref)) {
          throw new CandidateError(`node '${ref}' does not exist — use resolve_entity first, or propose_node`);
        }
        touch(db, draftId, { subject_node_id: ref });
        return { ok: true, subject: ref };
      }
      case "note_survey": {
        const survey = mergeSurvey(d.survey, input);
        touch(db, draftId, { survey: JSON.stringify(survey) });
        return { ok: true, survey };
      }
      case "propose_node": {
        const c = add({
          kind: "node",
          origin: input.origin ?? "site",
          note: input.note,
          evidence: evidenceFrom(input),
          node: { type: input.type, name: input.name, metadata: input.metadata ?? {}, aliases: input.page_url ? [{ source: "web", external_id: input.page_url }] : [] },
          resolves_to: input.resolves_to ?? null,
          resolution: input.resolution,
          link_check: input.link_check,
        }) as NodeCandidate;
        touch(db, draftId, { candidates: JSON.stringify(cands) });
        return { ok: true, cid: c.cid, ref: `cid:${c.cid}`, resolves_to: c.resolves_to, would_create: c.resolves_to ? null : `${c.node.type}:${slugify(c.node.name)}`, ...(c.link_check ? { state: c.state } : {}) };
      }
      case "propose_edge": {
        const c = add({
          kind: "edge",
          origin: input.origin ?? "site",
          note: input.note,
          evidence: evidenceFrom(input),
          edge: { source: input.source, target: input.target, edge_type: input.edge_type, event_time: input.event_time, confidence: input.confidence ?? "medium" },
          link_check: input.link_check,
        });
        touch(db, draftId, { candidates: JSON.stringify(cands) });
        return { ok: true, cid: c.cid, ...(c.link_check ? { state: c.state } : {}) };
      }
      case "propose_image": {
        const c = add({
          kind: "image",
          origin: input.origin ?? "site",
          note: input.note,
          image: { for: input.for, image_url: input.image_url, page_url: input.page_url, alt: input.alt, width: input.width, height: input.height },
          link_check: input.link_check,
        });
        touch(db, draftId, { candidates: JSON.stringify(cands) });
        return { ok: true, cid: c.cid };
      }
      case "propose_patch": {
        const c = add({
          kind: "patch",
          origin: input.origin ?? "site",
          note: input.note,
          evidence: evidenceFrom(input),
          patch: { node_id: input.node_id, key: input.key, existing: input.existing, proposed: input.proposed },
        });
        touch(db, draftId, { candidates: JSON.stringify(cands) });
        return { ok: true, cid: c.cid };
      }
      case "note_known": {
        const c = add({
          kind: "known",
          origin: input.origin ?? "graph",
          note: input.note,
          known: { node_id: input.node_id, edge_type: input.edge_type, other_id: input.other_id, summary: input.summary },
        });
        touch(db, draftId, { candidates: JSON.stringify(cands) });
        return { ok: true, cid: c.cid };
      }
      case "ask_contributor": {
        const c = add({
          kind: "question",
          origin: input.origin ?? "graph",
          note: input.note,
          question: { text: input.text, if_yes: isObj(input.if_yes) ? { confidence: "medium", ...input.if_yes } : input.if_yes },
        });
        touch(db, draftId, { candidates: JSON.stringify(cands) });
        return { ok: true, cid: c.cid };
      }
      case "propose_ended": {
        const edgeId = typeof input.edge_id === "string" ? input.edge_id : "";
        const e = endableEdge(db, d, edgeId);
        const ev = evidenceFrom(input);
        if (ev && typeof ev.page_url === "string") {
          let host = "";
          try { host = bareHost(new URL(ev.page_url).hostname); } catch { /* checked by the validator */ }
          if (host && host !== bareHost(d.source_domain)) throw new CandidateError("ended: the evidence must be this site's own page as it reads now", "page_url");
        }
        const c = add({
          kind: "ended",
          origin: "site",
          note: input.note,
          evidence: ev,
          ended: { edge_id: edgeId, edge_type: e.edge_type, source_id: e.source_id, target_id: e.target_id, last_seen: e.attested_at?.slice(0, 10), summary: input.summary },
        });
        touch(db, draftId, { candidates: JSON.stringify(cands) });
        return { ok: true, cid: c.cid };
      }
      case "update_candidate": {
        const cid = typeof input.cid === "string" ? input.cid : "";
        const idx = cands.findIndex((c) => c.cid === cid);
        if (idx < 0) throw new CandidateError(`no candidate ${cid}`);
        const cur = cands[idx]!;
        if (cur.edited || (cur.state !== "proposed" && !linkUnchecked(cur))) {
          throw new CandidateError(`${cid} was touched by the contributor and cannot be updated`);
        }
        const patch = isObj(input.patch) ? input.patch : {};
        if (isObj(patch.question) && ("answer" in patch.question || "answered_yes" in patch.question)) {
          throw new CandidateError("only the contributor may answer a question");
        }
        // Merge-patch, but state/edited/cid are the contributor's, not the agent's.
        const merged: any = { ...cur };
        for (const [k, v] of Object.entries(patch)) {
          // link_check comes from the worker's fetch record on proposal only.
          if (k === "state" || k === "edited" || k === "cid" || k === "kind" || k === "link_check") continue;
          merged[k] = isObj(v) && isObj((cur as any)[k]) ? { ...(cur as any)[k], ...v } : v;
        }
        const others = cands.filter((c) => c.cid !== cid);
        const checked = validateCandidate(merged, others, ctx);
        checked.state = cur.state;
        checked.edited = cur.edited;
        cands[idx] = checked;
        touch(db, draftId, { candidates: JSON.stringify(cands) });
        return { ok: true, cid };
      }
      case "remove_candidate": {
        const cid = typeof input.cid === "string" ? input.cid : "";
        const idx = cands.findIndex((c) => c.cid === cid);
        if (idx < 0) throw new CandidateError(`no candidate ${cid}`);
        const cur = cands[idx]!;
        if (cur.edited || (cur.state !== "proposed" && !linkUnchecked(cur))) throw new CandidateError(`${cid} was touched by the contributor and cannot be removed`);
        const ref = `cid:${cid}`;
        const dependents = cands.filter((c) => JSON.stringify(c).includes(`"${ref}"`) && c.cid !== cid);
        if (dependents.length) throw new CandidateError(`${cid} is referenced by ${dependents.map((c) => c.cid).join(", ")}; remove those first`);
        cands.splice(idx, 1);
        touch(db, draftId, { candidates: JSON.stringify(cands) });
        return { ok: true, removed: cid };
      }
      default:
        throw new DraftError(`unknown draft tool '${name}'`, 400, "unknown_tool");
    }
  });
}

export function workerAddPage(db: DatabaseSync, draftId: string, workerId: string, raw: unknown): { ok: true; pages: number } {
  if (!isObj(raw)) throw new DraftError("page entry must be an object", 400, "bad_page");
  return tx(db, () => {
    const d = mustGetDraft(db, draftId);
    assertClaimed(d, workerId);
    if (d.pages.length >= MAX_PAGES) throw new DraftError(`page cap (${MAX_PAGES}) reached`, 429, "page_cap");
    const entry: PageEntry = {
      url: String(raw.url ?? "").slice(0, 2048),
      final_url: String(raw.final_url ?? raw.url ?? "").slice(0, 2048),
      title: typeof raw.title === "string" ? raw.title.slice(0, 300) : null,
      fetched_at: nowIso(),
      status: typeof raw.status === "number" ? raw.status : 0,
      chars: typeof raw.chars === "number" ? raw.chars : 0,
      sha256: typeof raw.sha256 === "string" ? raw.sha256.slice(0, 64) : "",
      via: raw.via === "fetch" ? "fetch" : "browser",
    };
    if (!entry.url) throw new DraftError("page.url is required", 400, "bad_page");
    const pages = [...d.pages, entry];
    touch(db, draftId, { pages: JSON.stringify(pages) });
    return { ok: true, pages: pages.length };
  });
}

export function workerAddMessage(db: DatabaseSync, draftId: string, workerId: string, textRaw: unknown): { ok: true } {
  if (typeof textRaw !== "string" || !textRaw.trim()) throw new DraftError("text is required", 400, "bad_message");
  return tx(db, () => {
    const d = mustGetDraft(db, draftId);
    assertClaimed(d, workerId);
    const messages = [...d.messages, { role: "assistant" as const, text: textRaw.trim().slice(0, MAX_MESSAGE_CHARS), at: nowIso() }];
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
    touch(db, draftId, { messages: JSON.stringify(messages) });
    return { ok: true };
  });
}

// ---- confirm: draft -> batch ---------------------------------------------------------------

export interface ConfirmResult {
  batch_id: string;
  status: "live" | "review";
  intake_ids: string[];
  created_nodes: string[];
  linked_nodes: string[];
  patched_nodes: string[];
  edges: Array<{ source_id: string; target_id: string; edge_type: string }>;
  images: Array<{ node_id: string; cdn_image_url: string }>;
  ended: string[];
  skipped: Array<{ cid: string; reason: string }>;
  /** Cards kept open for another contributor to decide (issue #77). */
  left_open: number;
  /** A pick-up: the left-open items this Confirm decided. */
  decided: number;
}

interface PlannedOp {
  cid: string;
  origin: string;
  signal: { title: string; content: string; source_url: string | null; source_type: string };
  node_op?: ProposedNodeOp;
  edge?: ProposedEdge;
  target_node: string;
}

/**
 * Turn accepted candidates into one attributed batch (batch_id = draft.id).
 * Images are mirrored to R2 BEFORE the transaction (content-addressed, so
 * a retry is harmless); everything else is one SQLite transaction.
 *
 * What the contributor did not decide stays open for someone else
 * (src/intake/open-items.ts). A pick-up draft decides items of the draft it
 * was picked from; one that only turns items down still confirms.
 */
export async function confirmDraft(
  db: DatabaseSync,
  draft: Draft,
  contributor: AuthedContributor,
  deps: { mirror?: typeof mirrorImageFromUrl } = {}
): Promise<ConfirmResult> {
  if (draft.status !== "ready") throw new DraftError(`draft is ${draft.status}`, 409, "not_ready");
  if (draft.job) throw new DraftError("the agent is still working on this draft", 409, "job_pending");
  if (draft.contributor_id !== contributor.id) throw new DraftError("not your draft", 403, "forbidden");
  const mirror = deps.mirror ?? mirrorImageFromUrl;

  const skipped: ConfirmResult["skipped"] = [];
  // A pick-up: the items it carries from the draft it was picked from, and
  // the ones another contributor has decided since (left out here).
  const source = draft.picked_from ? getDraft(db, draft.picked_from) : null;
  const sourceCids = new Set(source?.candidates.map((c) => c.cid) ?? []);
  const items = new Map(source ? openItemsOf(db, source.id).map((r) => [r.cid, r]) : []);
  const gone = new Set([...items.values()].filter((r) => r.decided_at && sourceCids.has(r.cid)).map((r) => r.cid));
  for (const c of draft.candidates) if (gone.has(c.cid) && c.state === "accepted") skipped.push({ cid: c.cid, reason: "already decided by another contributor" });
  const open = leftOpen(draft.candidates, gone);
  const live = draft.candidates.filter((c) => !gone.has(c.cid) && !open.has(c.cid));
  const accepted = live.filter((c) => c.state === "accepted");
  const answeredYes = live.filter(
    (c): c is Extract<Candidate, { kind: "question" }> => c.kind === "question" && c.state === "answered" && c.question.answered_yes === true
  );
  const decisions = live.filter((c) => items.has(c.cid) && !items.get(c.cid)!.decided_at);
  if (!accepted.length && !answeredYes.length && !decisions.length) {
    if (skipped.length) throw new DraftError("another contributor has decided these items since you picked them up — nothing is left to confirm", 409, "already_decided");
    throw new DraftError("nothing accepted — accept at least one card", 400, "nothing_to_submit");
  }

  // 1. Resolve refs. A node candidate contributes an id if accepted:
  //    resolves_to → link; else → deterministic create id.
  const refToId = new Map<string, string>();
  const createOps: Array<{ cid: string; c: NodeCandidate }> = [];
  const linked: string[] = [];
  for (const c of accepted) {
    if (c.kind !== "node") continue;
    if (c.resolves_to) {
      refToId.set(`cid:${c.cid}`, c.resolves_to);
      linked.push(c.resolves_to);
    } else {
      refToId.set(`cid:${c.cid}`, `${c.node.type}:${slugify(c.node.name)}`);
      createOps.push({ cid: c.cid, c });
    }
  }
  const resolve = (ref: string, cid: string): string | null => {
    if (!isCidRef(ref)) return ref;
    const id = refToId.get(ref);
    if (!id) skipped.push({ cid, reason: gone.has(ref.slice(4)) ? `depends on ${ref}, which another contributor decided first` : `depends on ${ref}, which was not accepted` });
    return id ?? null;
  };
  // A read is a dated snapshot: every signal says which page it quotes, what
  // that page hashed to, and WHEN it was read — not only when it was submitted.
  // picked_from: the card was first proposed in another contributor's read
  // and left open there; the signal is the picker's, the first proposer is
  // credited here (and in /history).
  const pickedFrom = source
    ? { draft_id: source.id, by: (db.prepare("SELECT name FROM contributors WHERE id = ?").get(source.contributor_id) as any)?.name ?? null }
    : null;
  const prov = (c: Candidate) => {
    const url = c.kind === "image" ? c.image.page_url : c.evidence?.page_url;
    const page = pageEntry(draft, url);
    // proposed_as: the contributor changed this card before confirming; it
    // holds what the reader proposed, so the signal shows both.
    return JSON.stringify({ draft_id: draft.id, cid: c.cid, origin: c.origin, page_sha256: page?.sha256 ?? null, page_fetched_at: page?.fetched_at ?? null, ...(c.proposed_as ? { proposed_as: c.proposed_as } : {}), ...(pickedFrom && sourceCids.has(c.cid) ? { picked_from: pickedFrom } : {}) });
  };

  const ops: PlannedOp[] = [];

  // 2a. nodes
  for (const { cid, c } of createOps) {
    const slug = slugify(c.node.name);
    const aliases = c.node.aliases.map((a) => ({ source: a.source, external_id: a.external_id }));
    const metadata = { ...c.node.metadata, source_url: c.evidence?.page_url ?? draft.source_url };
    ops.push({
      cid,
      origin: c.origin,
      target_node: `${c.node.type}:${slug}`,
      signal: {
        title: `Create node: ${c.node.type}:${c.node.name}`,
        content: c.evidence?.quote ?? JSON.stringify({ type: c.node.type, name: c.node.name }),
        source_url: c.evidence?.page_url ?? draft.source_url,
        source_type: "api_url_intake",
      },
      node_op: { op: "create_node", type: c.node.type, name: c.node.name, slug, metadata, aliases },
    });
  }

  // 2b. images (mirror first — network, outside the transaction)
  const imageResults: ConfirmResult["images"] = [];
  for (const c of accepted) {
    if (c.kind !== "image") continue;
    const nodeIdFor = resolve(c.image.for, c.cid);
    if (!nodeIdFor) continue;
    let m;
    try {
      m = await mirror(c.image.image_url);
    } catch (e: any) {
      skipped.push({ cid: c.cid, reason: `image could not be mirrored: ${e?.message ?? e}` });
      continue;
    }
    ops.push({
      cid: c.cid,
      origin: c.origin,
      target_node: nodeIdFor,
      signal: {
        title: `Upload image to ${nodeIdFor}`,
        content: JSON.stringify({ node_id: nodeIdFor, key: m.upload.key, sha256: m.upload.sha256, bytes: m.upload.bytes, content_type: m.upload.content_type, image_url: c.image.image_url }),
        source_url: c.image.page_url,
        source_type: "api_url_intake",
      },
      node_op: { op: "attach_image", node_id: nodeIdFor, image_url: c.image.image_url, cdn_image_url: m.upload.url, sha256: m.upload.sha256 },
    });
    imageResults.push({ node_id: nodeIdFor, cdn_image_url: m.upload.url });
  }

  // 2c. patches
  const patched: string[] = [];
  for (const c of accepted) {
    if (c.kind !== "patch") continue;
    ops.push({
      cid: c.cid,
      origin: c.origin,
      target_node: c.patch.node_id,
      signal: {
        title: `Patch ${c.patch.node_id}: ${c.patch.key}`,
        content: c.evidence?.quote ?? JSON.stringify({ key: c.patch.key, proposed: c.patch.proposed }),
        source_url: c.evidence?.page_url ?? draft.source_url,
        source_type: "api_url_intake",
      },
      node_op: { op: "patch_node", node_id: c.patch.node_id, metadata: { [c.patch.key]: c.patch.proposed } },
    });
    patched.push(c.patch.node_id);
  }

  // 2d. edges (site-backed), then question edges (contributor-attested)
  const edgeResults: ConfirmResult["edges"] = [];
  const pushEdge = (c: Candidate, spec: EdgeSpec, attested: { content: string; source_type: string; source_url: string | null }) => {
    const s = resolve(spec.source, c.cid);
    const t = resolve(spec.target, c.cid);
    if (!s || !t) return;
    ops.push({
      cid: c.cid,
      origin: c.origin,
      target_node: s,
      signal: { title: `Add edge ${spec.edge_type}: ${s} → ${t}`, ...attested },
      edge: { source_id: s, target_id: t, edge_type: spec.edge_type, confidence: spec.confidence, event_time: spec.event_time ?? null, supersedes_edge_id: null },
    });
    edgeResults.push({ source_id: s, target_id: t, edge_type: spec.edge_type });
  };
  for (const c of accepted) {
    if (c.kind !== "edge") continue;
    pushEdge(c, c.edge, {
      content: c.evidence?.quote ?? JSON.stringify(c.edge),
      source_type: "api_url_intake",
      source_url: c.evidence?.page_url ?? draft.source_url,
    });
  }
  for (const c of answeredYes) {
    pushEdge(c, c.question.if_yes, {
      content: c.question.answer?.trim() || `Yes — ${c.question.text}`,
      source_type: "contributor_attested",
      source_url: null,
    });
  }

  // 2e. present-tense relations the site no longer shows
  const endedResults: string[] = [];
  for (const c of accepted) {
    if (c.kind !== "ended") continue;
    ops.push({
      cid: c.cid,
      origin: c.origin,
      target_node: c.ended.source_id,
      signal: {
        title: `End edge ${c.ended.edge_type}: ${c.ended.source_id} → ${c.ended.target_id}`,
        content: `${c.ended.summary}${c.evidence ? ` — the page now reads: “${c.evidence.quote}”` : ""}`,
        source_url: c.evidence?.page_url ?? draft.source_url,
        source_type: "api_url_intake",
      },
      node_op: { op: "end_edge", edge_id: c.ended.edge_id },
    });
    endedResults.push(c.ended.edge_id);
  }

  if (!ops.length && !decisions.length) throw new DraftError("nothing could be submitted: " + skipped.map((s) => s.reason).join("; "), 400, "nothing_to_submit");

  // The read's subject, as a node id, for the page that lists its open items.
  const subjectId = (() => {
    const ref = draft.subject_node_id;
    if (!ref) return null;
    if (!isCidRef(ref)) return ref;
    const n = draft.candidates.find((c) => c.cid === ref.slice(4));
    return refToId.get(ref) ?? (n && n.kind === "node" ? n.resolves_to ?? null : null);
  })();
  const skippedCids = new Set(skipped.map((x) => x.cid));

  // 3. The transaction.
  const auto = isAutoMerge(contributor.trust_tier);
  const createdBy = `api-${contributor.name}`;
  const intakeIds: string[] = [];
  const touched = new Set<string>();

  tx(db, () => {
    const fresh = mustGetDraft(db, draft.id);
    if (fresh.status !== "ready" || fresh.job || JSON.stringify(fresh.candidates) !== JSON.stringify(draft.candidates)) {
      throw new DraftError("draft changed while confirming — review the current cards and confirm again", 409, "conflict");
    }
    // A pick-up decides each item once: whoever confirms first.
    for (const c of decisions) {
      // "skipped": accepted but it could not be added, or undecided but it
      // needs a card the picker turned down.
      const outcome = skippedCids.has(c.cid) || c.state === "proposed" || c.state === "open" ? "skipped" : c.state;
      if (!decideOpenItem(db, source!.id, c.cid, contributor.id, draft.id, outcome)) {
        throw new DraftError("another contributor decided some of these items while you were confirming — review the current cards and confirm again", 409, "conflict");
      }
    }
    // Left open here: kept for the next person. In a pick-up, an item it
    // carries that is left open again simply stays open where it is.
    for (const [cid, reason] of open) {
      if (sourceCids.has(cid)) continue;
      const c = draft.candidates.find((x) => x.cid === cid)!;
      insertOpenItem(db, { draft_id: draft.id, cid, kind: c.kind, label: candidateLabel(c, draft.candidates), reason, subject_node_id: subjectId });
    }
    if (!ops.length) {
      touch(db, draft.id, { status: "submitted", intake_ids: JSON.stringify([]), submitted_at: nowIso(), error: null });
      return;
    }

    // Anchor signal for the whole draft — what the receipt and the review
    // queue point at.
    const anchorId = insertSignal(db, {
      contributor,
      title: `URL intake: ${draft.source_domain}`,
      content: JSON.stringify({ draft_id: draft.id, source_url: draft.source_url, pages: draft.pages.map((p) => ({ url: p.final_url, sha256: p.sha256, fetched_at: p.fetched_at })), ops: ops.length }),
      source_url: draft.source_url,
      source_type: "api_url_intake",
      batch_id: draft.id,
      source_origin: "url_intake",
      provenance_chain: JSON.stringify({ draft_id: draft.id, summary: draft.summary, ...(pickedFrom ? { picked_from: pickedFrom } : {}) }),
    });

    const queuedNodes: ProposedNodeOp[] = [];
    const queuedEdges: ProposedEdge[] = [];

    for (const op of ops) {
      const cand = draft.candidates.find((c) => c.cid === op.cid)!;
      const signalId = insertSignal(db, {
        contributor,
        title: op.signal.title,
        content: op.signal.content,
        source_url: op.signal.source_url,
        source_type: op.signal.source_type,
        batch_id: draft.id,
        source_origin: "url_intake",
        provenance_chain: prov(cand),
      });
      if (auto) {
        if (op.node_op) {
          if (op.node_op.op === "create_node") {
            const r = materialiseCreateNode(db, op.node_op, { signalId, createdBy });
            touched.add(r.node_id);
          } else if (op.node_op.op === "patch_node") {
            materialisePatchNode(db, op.node_op, { createdBy, signalId });
            touched.add(op.node_op.node_id);
          } else if (op.node_op.op === "end_edge") {
            materialiseEndEdge(db, op.node_op, { signalId });
          } else {
            materialiseAttachImage(db, op.node_op, { createdBy, signalId });
            touched.add(op.node_op.node_id);
          }
        }
        if (op.edge) materialiseEdge(db, { ...op.edge, signal_id: signalId }, { signalId, createdBy });
        const { intake_id } = insertIntake(db, {
          contributor,
          signal_id: signalId,
          target_node: op.target_node,
          proposed_nodes: op.node_op ? [op.node_op] : undefined,
          proposed_edges: op.edge ? [{ ...op.edge, signal_id: signalId }] : undefined,
        });
        intakeIds.push(intake_id);
      } else {
        // Every op but a create carries its own evidence signal, like queued
        // edges do — an end_edge cites it, a patch / image records its
        // before-image on it.
        if (op.node_op) queuedNodes.push(op.node_op.op === "create_node" ? op.node_op : { ...op.node_op, signal_id: signalId });
        if (op.edge) queuedEdges.push({ ...op.edge, signal_id: signalId });
      }
    }

    if (auto) {
      bumpApprovedCount(db, contributor.id);
    } else {
      const { intake_id } = insertIntake(db, {
        contributor,
        signal_id: anchorId,
        target_node: draft.subject_node_id && !isCidRef(draft.subject_node_id) ? draft.subject_node_id : ops[0]!.target_node,
        proposed_nodes: queuedNodes,
        proposed_edges: queuedEdges,
      });
      intakeIds.push(intake_id);
    }
    ensureContributorRow(db, contributor);

    touch(db, draft.id, {
      status: "submitted",
      intake_ids: JSON.stringify(intakeIds),
      submitted_at: nowIso(),
      error: null,
    });
  });

  if (auto) for (const id of touched) embedNodeAsync(db, id);

  return {
    batch_id: draft.id,
    status: auto ? "live" : "review",
    intake_ids: intakeIds,
    created_nodes: createOps.map(({ c }) => `${c.node.type}:${slugify(c.node.name)}`),
    linked_nodes: [...new Set(linked)],
    patched_nodes: [...new Set(patched)],
    edges: edgeResults,
    images: imageResults,
    ended: endedResults,
    skipped,
    left_open: [...open.keys()].filter((cid) => !sourceCids.has(cid) || items.has(cid)).length,
    decided: decisions.length,
  };
}

function pageEntry(draft: Draft, url: string | undefined): PageEntry | null {
  if (!url) return null;
  return draft.pages.find((x) => x.url === url || x.final_url === url) ?? null;
}

/** Receipt view: everything the batch produced, by batch_id. */
export function batchReceipt(db: DatabaseSync, batchId: string): Record<string, unknown> | null {
  const draft = getDraft(db, batchId);
  const signals = db
    .prepare("SELECT id, title, source_type, source_url, content, status, created_at, submitted_by, provenance_chain FROM signals WHERE batch_id = ? ORDER BY created_at ASC")
    .all(batchId) as any[];
  if (draft ? draft.status !== "submitted" : !signals.length) return null;
  const intake = db
    .prepare("SELECT id, status, signal_id, target_node, reviewed_at, rejection_reason FROM intake_queue WHERE signal_id IN (SELECT id FROM signals WHERE batch_id = ?) ORDER BY created_at ASC")
    .all(batchId) as any[];
  const edges = db
    .prepare("SELECT id, source_id, target_id, edge_type, valid_until FROM edges WHERE signal_id IN (SELECT id FROM signals WHERE batch_id = ?)")
    .all(batchId) as any[];
  // Relations this batch ended (a roster the site no longer shows).
  const ended = db
    .prepare(
      `SELECT e.source_id, e.target_id, e.edge_type, e.valid_until FROM edges e
        WHERE e.invalidated_by IN (SELECT id FROM signals WHERE batch_id = ?)`
    )
    .all(batchId) as any[];
  const statuses = new Set(intake.map((i) => i.status));
  let review_state: string;
  // A pick-up that only turned items down added nothing.
  if (!signals.length) review_state = "nothing added";
  else if (signals.every((s) => s.status === "revoked")) review_state = "retired";
  else if (statuses.size === 1 && statuses.has("approved")) review_state = "live";
  else if (statuses.has("approved")) review_state = "partially approved";
  else if (statuses.has("rejected") && !statuses.has("pending")) review_state = "rejected";
  else review_state = "pending";
  const nameOf = db.prepare("SELECT name FROM contributors WHERE id = ?");
  const contributor = signals[0]?.submitted_by ?? (draft ? (nameOf.get(draft.contributor_id) as any)?.name ?? null : null);
  // Left open here (issue #77), each with who decided it since, if anyone.
  const left_open = draft ? openItemsOf(db, draft.id).map((r) => ({
    label: r.label, kind: r.kind, reason: r.reason,
    decided: r.decided_at ? { at: r.decided_at, by: (nameOf.get(r.decided_by ?? "") as any)?.name ?? null, outcome: r.outcome, in: r.decided_in } : null,
  })) : [];
  const source = draft?.picked_from ? getDraft(db, draft.picked_from) : null;
  const picked_from = source ? { batch_id: source.id, source_domain: source.source_domain, by: (nameOf.get(source.contributor_id) as any)?.name ?? null } : null;
  return {
    batch_id: batchId,
    contributor,
    left_open,
    picked_from,
    source_url: draft?.source_url ?? null,
    source_domain: draft?.source_domain ?? null,
    submitted_at: draft?.submitted_at ?? signals[0]?.created_at ?? null,
    review_state,
    subject_node_id: draft?.subject_node_id ?? null,
    signals: signals.map((s) => ({ id: s.id, title: s.title, source_type: s.source_type, source_url: s.source_url, status: s.status, content: s.source_type === "api_url_intake" && s.title.startsWith("URL intake:") ? null : s.content })),
    intake: intake.map((i) => ({ id: i.id, status: i.status, target_node: i.target_node, reviewed_at: i.reviewed_at, rejection_reason: i.rejection_reason })),
    edges: edges.map((e) => ({ source_id: e.source_id, target_id: e.target_id, edge_type: e.edge_type, live: e.valid_until === null })),
    ended: ended.map((e) => ({ source_id: e.source_id, target_id: e.target_id, edge_type: e.edge_type, ended_at: e.valid_until })),
    pages: draft?.pages ?? [],
  };
}
