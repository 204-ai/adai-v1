// Accounts on the public entity view (issue #80, part 2).
//
// The commons keeps several written accounts of the same thing side by side —
// a catalogue's documentation, an artist's intention, a critic's reading —
// each with its own author, date, source and consent. Until now they were
// visible only on /record and /history. This section shows them where people
// look: the entity view, and so the /field overlay (the same article).
//
// What counts as an account:
//   - a contribution's own words: an approved, active signal written about
//     this node (intake_queue.target_node), whose content is prose — never a
//     structured API body, never a pending, revoked or superseded one;
//   - the claimants' public notes on its relations and edits: context that
//     is live, contests that are open (src/claim/notes.ts);
//   - any contributor's readings of its relations (#80 part 3), live and
//     while the relation is: labelled "a reading by X" — never the subject's
//     words, even when X claims one end (a claimant speaks through context).
//
// What is an account is decided by what the record says the write was, not
// by how its text looks: a signal of source_type 'contribution' (the
// contribute form, POST /api/v1/signals) whose queue row carries no
// structured operation. URL-intake evidence, admin corrections, claims and
// generated operational text never are. A legacy body that is valid JSON
// (an API request body stored as content) is skipped; text that merely
// starts with "[" or "{" is not.
//
// Rules: chronological (created_at, then signal id), oldest first, nothing
// ranked. The subject speaking is marked, not lifted above the rest — and
// only on proof: the signal's authenticated author (signal_authors, never
// the free-text submitted_by, which the public form lets anyone set) holds
// an approved claim on the node now, or a live token standing for it. A note
// from a claim that has since ended reads as an ordinary contribution.
// Consent as everywhere else: structural_only keeps its words (and title,
// source) off the page, anonymous names no one — not even as "the subject".
//
// Bounded: the first ACCOUNTS_SHOWN are rendered with the page; the rest come
// in pages from GET /api/entity/accounts (a stable (created_at, id) cursor).
//
// Account types (part 1 of #80: documentation / intention / reading /
// testimony) are not stored yet; `account_type` is carried as null and
// rendered as a data attribute, so a grouping can be added on top — except a
// reading on a relation (part 3), which is one by construction ('reading').

import type { DatabaseSync } from "node:sqlite";
import { htmlEscape as esc } from "../templates.js";
import { edgeLabel } from "../utils/edge-labels.js";
import { proseDate } from "../utils/signal-prose.js";
import { countPublicNotes, publicNotesFor } from "../claim/notes.js";

export type AccountKind = "contribution" | "context" | "contest" | "reading";

export interface AccountNodeRef { id: string; type: string; slug: string; name: string }

export interface Account {
  signal_id: string;
  kind: AccountKind;
  /** documentation | intention | reading | testimony — #80 part 1; null until stored. */
  account_type: string | null;
  title: string | null;
  text: string | null;          // null when the contributor kept the words off the page
  withheld: boolean;            // structural_only
  by: string | null;            // null = anonymous (or unknown)
  verified: boolean;            // the author is an authenticated contributor (signal_authors)
  by_node: AccountNodeRef | null; // the node the author's live token stands for
  subject: boolean;             // this node speaking about itself, proven
  speaking_for: AccountNodeRef | null; // a note from the relation's other end, by its current claimant
  relation: { source: AccountNodeRef | null; source_id: string; edge_type: string; target: AccountNodeRef | null; target_id: string } | null;
  meta_key: string | null;      // a contest on an edited value
  at: string | null;
  source_url: string | null;
}

export interface AccountCursor { at: string; id: string }

/** Shown at once; the rest, still in order, page by page. */
export const ACCOUNTS_SHOWN = 10;
export const ACCOUNTS_PAGE_MAX = 50;
/** Longer texts fold after this many characters. */
const TEXT_FOLD = 700;

const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
/** Binary string order, as SQLite compares the cursor (never localeCompare: the two must agree). */
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const byTime = (a: { at: string | null; signal_id: string }, b: { at: string | null; signal_id: string }) =>
  cmp(String(a.at ?? ""), String(b.at ?? "")) || cmp(a.signal_id, b.signal_id);

/** Written contributions: what qualifies (see the header). */
const CONTRIBUTIONS_WHERE = `
      WHERE iq.target_node = :node AND iq.status = 'approved' AND iq.kind = 'human_signal'
        AND iq.proposed_nodes IS NULL AND iq.proposed_edges IS NULL
        AND COALESCE(s.status, 'active') = 'active'
        AND COALESCE(s.source_type, 'contribution') = 'contribution'
        AND TRIM(COALESCE(s.content, '')) != ''
        AND NOT (json_valid(s.content) AND json_type(s.content) IN ('object', 'array'))`;

function contributions(db: DatabaseSync, nodeId: string, cursor: AccountCursor | null, limit: number): Account[] {
  const rows = db.prepare(
    `SELECT s.id, s.title, s.content, s.source_url, s.submitted_by, s.created_at AS at,
            s.consent_scope, s.consent_attribution,
            sa.contributor_id AS author_id, k.name AS author_name,
            EXISTS (SELECT 1 FROM node_claims c WHERE c.contributor_id = sa.contributor_id AND c.node_id = :node AND c.status = 'approved') AS claimant_now,
            tn.id AS tn_id, tn.type AS tn_type, tn.slug AS tn_slug, tn.name AS tn_name
       FROM intake_queue iq
       JOIN signals_full s ON s.id = iq.signal_id
       LEFT JOIN signal_authors sa ON sa.signal_id = s.id
       LEFT JOIN contributors k ON k.id = sa.contributor_id
       LEFT JOIN nodes tn ON tn.id = (SELECT t.node_id FROM contributor_tokens t
                                       WHERE t.contributor_id = sa.contributor_id AND t.node_id IS NOT NULL AND t.revoked_at IS NULL
                                       ORDER BY t.created_at DESC LIMIT 1)
                         AND json_extract(tn.metadata, '$.retired') IS NOT 1
       ${CONTRIBUTIONS_WHERE}
        AND (s.created_at > :at OR (s.created_at = :at AND s.id > :id))
      GROUP BY s.id
      ORDER BY s.created_at, s.id
      LIMIT :limit`
  ).all({ node: nodeId, at: cursor?.at ?? "", id: cursor?.id ?? "", limit }) as any[];
  return rows.map((r) => {
    const withheld = r.consent_scope === "structural_only";
    const anonymous = r.consent_attribution === "anonymous";
    const verified = !!r.author_id;
    const byNode = !anonymous && verified && r.tn_id ? { id: r.tn_id, type: r.tn_type, slug: r.tn_slug, name: r.tn_name } : null;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : null;
    return {
      signal_id: r.id,
      kind: "contribution" as const,
      account_type: null,
      title: withheld ? null : title,
      text: withheld ? null : String(r.content).trim(),
      withheld,
      // A verified author by their current name; an unproven one by the name
      // they typed, plain — never linked, never the subject.
      by: anonymous ? null : verified ? (r.author_name ?? r.submitted_by ?? null) : (r.submitted_by ?? null),
      verified,
      by_node: byNode,
      subject: !anonymous && verified && (!!r.claimant_now || byNode?.id === nodeId),
      speaking_for: null,
      relation: null,
      meta_key: null,
      at: r.at ?? null,
      source_url: withheld || !isHttp(r.source_url) ? null : r.source_url,
    };
  });
}

function countContributions(db: DatabaseSync, nodeId: string): number {
  return Number((db.prepare(`SELECT COUNT(DISTINCT s.id) AS n FROM intake_queue iq JOIN signals_full s ON s.id = iq.signal_id ${CONTRIBUTIONS_WHERE}`).get({ node: nodeId }) as any).n);
}

/** Node refs for many ids at once. */
function nodeRefs(db: DatabaseSync, ids: string[]): Map<string, AccountNodeRef> {
  const out = new Map<string, AccountNodeRef>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200);
    const rows = db.prepare(`SELECT id, type, slug, name FROM nodes WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as unknown as AccountNodeRef[];
    for (const r of rows) out.set(r.id, { id: r.id, type: r.type, slug: r.slug, name: r.name });
  }
  return out;
}

/** The claimants' public notes, through the one public filter (consent, status, claim standing). */
function notes(db: DatabaseSync, nodeId: string, cursor: AccountCursor | null, limit: number): Account[] {
  // paged in SQL, through the public predicate (only context / contest are public kinds)
  const page = publicNotesFor(db, nodeId, { after: cursor, limit }).map((n) => ({ n }));
  const refs = nodeRefs(db, page.flatMap(({ n }) => [n.node_id, n.relation?.source_id ?? "", n.relation?.target_id ?? ""]));
  const list = page.map(({ n }): Account => {
    const fromHere = n.node_id === nodeId;
    // publicNotesFor already clears subject_now and the handle on a reading
    const reading = n.kind === "reading";
    const standing = !reading && !n.anonymous && !!n.subject_now;
    return {
      signal_id: n.signal_id,
      kind: n.kind as "context" | "contest" | "reading",
      account_type: reading ? "reading" : null,
      title: null,
      text: n.withheld ? null : n.note,
      withheld: !!n.withheld,
      // the node's handle only while its claim stands; else the writer's name
      by: n.anonymous ? null : standing && n.handle ? `@${n.handle}` : n.by,
      verified: true,
      by_node: null,
      subject: standing && fromHere,
      speaking_for: standing && !fromHere ? refs.get(n.node_id) ?? null : null,
      relation: n.relation
        ? { source: refs.get(n.relation.source_id) ?? null, source_id: n.relation.source_id, edge_type: n.relation.edge_type, target: refs.get(n.relation.target_id) ?? null, target_id: n.relation.target_id }
        : null,
      meta_key: n.meta_key,
      at: n.created_at ?? null,
      source_url: reading ? n.source_url ?? null : null,
    };
  });
  return list;
}

/** One page of accounts after `cursor`, oldest first, and the cursor of the next. */
/** `total` is counted for the first page only (later pages are appended to a list that already says it). */
export function accountsPage(db: DatabaseSync, nodeId: string, opts: { after?: AccountCursor | null; limit?: number } = {}): { accounts: Account[]; next: AccountCursor | null; total: number | null } {
  const limit = Math.max(1, Math.min(ACCOUNTS_PAGE_MAX, opts.limit ?? ACCOUNTS_SHOWN));
  const cursor = opts.after ?? null;
  const merged = [...contributions(db, nodeId, cursor, limit + 1), ...notes(db, nodeId, cursor, limit + 1)].sort(byTime);
  const accounts = merged.slice(0, limit);
  const last = accounts[accounts.length - 1];
  return {
    accounts,
    next: merged.length > limit && last ? { at: String(last.at ?? ""), id: last.signal_id } : null,
    total: cursor ? null : countContributions(db, nodeId) + countPublicNotes(db, nodeId),
  };
}

/** Every account (tests, small nodes). */
export function accountsFor(db: DatabaseSync, nodeId: string): Account[] {
  const out: Account[] = [];
  let cursor: AccountCursor | null = null;
  for (;;) {
    const p = accountsPage(db, nodeId, { after: cursor, limit: ACCOUNTS_PAGE_MAX });
    out.push(...p.accounts);
    if (!p.next) return out;
    cursor = p.next;
  }
}

export function encodeCursor(c: AccountCursor | null): string | null {
  return c ? `${c.at}|${c.id}` : null;
}
export function decodeCursor(s: unknown): AccountCursor | null {
  if (typeof s !== "string" || !s.includes("|")) return null;
  const i = s.indexOf("|");
  return { at: s.slice(0, i), id: s.slice(i + 1) };
}

// ---- render ------------------------------------------------------------------------------

const pathOf = (n: AccountNodeRef) => `/${encodeURIComponent(n.type)}/${encodeURIComponent(n.slug)}`;
const linkTo = (n: AccountNodeRef | null, fallback: string) =>
  n ? `<a href="${pathOf(n)}" data-node-id="${esc(n.id)}">${esc(n.name)}</a>` : esc(fallback);

function paragraphs(text: string): string {
  return text.split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
}

function textHtml(text: string): string {
  if (text.length <= TEXT_FOLD) return paragraphs(text);
  // Fold at a word boundary; the rest stays one click away, in place.
  const cut = text.lastIndexOf(" ", TEXT_FOLD);
  const at = cut > TEXT_FOLD * 0.6 ? cut : TEXT_FOLD;
  return `${paragraphs(text.slice(0, at))}<details class="ev-account-more"><summary>more</summary>${paragraphs(text.slice(at).trimStart())}</details>`;
}

function label(a: Account, node: { name: string }): string {
  const parts: string[] = [];
  if (a.subject) parts.push(`<span class="ev-account-voice">${esc(node.name)}, in their own words</span>`);
  else if (a.speaking_for) parts.push(`<span class="ev-account-voice">${linkTo(a.speaking_for, a.speaking_for.name)}, in their own words</span>`);
  if (a.relation) {
    const rel = `${linkTo(a.relation.source, a.relation.source_id)} → ${esc(edgeLabel(a.relation.edge_type))} → ${linkTo(a.relation.target, a.relation.target_id)}`;
    parts.push(a.kind === "contest" ? `contests: ${rel}` : a.kind === "reading" ? `a reading of: ${rel}` : `context on: ${rel}`);
  } else if (a.meta_key) {
    parts.push(`${a.kind === "contest" ? "contests" : "context on"} the value of ${esc(a.meta_key)}`);
  }
  return parts.length ? `<p class="ev-account-label">${parts.join(" · ")}</p>` : "";
}

function byline(a: Account): string {
  const parts: string[] = [];
  const who = a.by ? (a.by_node ? linkTo(a.by_node, a.by) : esc(a.by)) : null;
  if (a.kind === "reading") parts.push(`a reading by ${who ?? "someone"}`);
  else parts.push(who ? `by ${who}` : "anonymous");
  const day = proseDate(a.at);
  if (day) parts.push(esc(day));
  if (a.source_url) {
    let host = a.source_url;
    try { host = new URL(a.source_url).host.replace(/^www\./, ""); } catch { /* keep the url */ }
    parts.push(`<a href="${esc(a.source_url)}" target="_blank" rel="noopener">${esc(host)} ↗</a>`);
  }
  return `<p class="ev-account-by">${parts.join(" · ")}</p>`;
}

function accountItem(a: Account, node: { name: string }): string {
  const cls = ["ev-account", `ev-account--${a.kind}`, a.subject || a.speaking_for ? "ev-account--subject" : ""].filter(Boolean).join(" ");
  const body = a.withheld
    ? `<p class="ev-account-withheld">The contributor kept the words of this account off the public page.</p>`
    : `${a.title ? `<p class="ev-account-title">${esc(a.title)}</p>` : ""}<div class="ev-account-text">${textHtml(a.text ?? "")}</div>`;
  return `<li class="${cls}" data-signal-id="${esc(a.signal_id)}"${a.account_type ? ` data-account-type="${esc(a.account_type)}"` : ""}>${label(a, node)}${body}${byline(a)}</li>`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The list items of one page — the section and GET /api/entity/accounts share it. */
export function accountItems(accounts: Account[], node: { name: string }): string {
  return accounts.map((a) => accountItem(a, node)).join("");
}

export function moreButton(node: { id: string }, next: AccountCursor | null, remaining: number): string {
  if (!next || remaining <= 0) return "";
  return `<button type="button" class="ev-accounts-next" data-node-id="${esc(node.id)}" data-after="${esc(encodeCursor(next)!)}">${remaining} more, in the same order</button>`;
}

export function accountsSection(db: DatabaseSync, node: { id: string; name: string }): string {
  const page = accountsPage(db, node.id, { limit: ACCOUNTS_SHOWN });
  if (!page.accounts.length) return "";
  const total = page.total ?? page.accounts.length; // always counted on the first page
  return `
      <section class="ev-section" id="ev-accounts">
        <h2 class="ev-h2">// accounts <span class="ev-h2-count">/${pad(total)}</span></h2>
        <p class="ev-accounts-lede">What contributors have written about ${esc(node.name)}, side by side and oldest first. No account here is the official one.</p>
        <ol class="ev-accounts">${accountItems(page.accounts, node)}</ol>
        ${moreButton(node, page.next, total - page.accounts.length)}
      </section>`;
}
