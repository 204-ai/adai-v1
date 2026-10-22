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
//     is live, contests that are open (src/claim/notes.ts).
//
// Rules: chronological, oldest first, nothing ranked — the subject's own
// words (a claimant of this node, or a contributor whose token stands for
// it) are marked as the subject speaking, not lifted above the rest. Consent
// as everywhere else: structural_only keeps its words (and title, source)
// off the page, anonymous names no one — not even as "the subject".
//
// Account types (part 1 of #80: documentation / intention / reading /
// testimony) are not stored yet; `account_type` is carried as null and the
// renderer already groups by it when any account has one.

import type { DatabaseSync } from "node:sqlite";
import { htmlEscape as esc } from "../templates.js";
import { edgeLabel } from "../utils/edge-labels.js";
import { proseDate } from "../utils/signal-prose.js";
import { contributorNode } from "../utils/contributor-node.js";
import { publicNotesFor } from "../claim/notes.js";

export type AccountKind = "contribution" | "context" | "contest";

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
  by_node: AccountNodeRef | null; // the node the author stands for, when there is one
  subject: boolean;             // this node speaking about itself
  speaking_for: AccountNodeRef | null; // a note written from the relation's other end
  relation: { source: AccountNodeRef | null; source_id: string; edge_type: string; target: AccountNodeRef | null; target_id: string } | null;
  meta_key: string | null;      // a contest on an edited value
  at: string | null;
  source_url: string | null;
}

/** Shown at once; the rest, still in order, behind "more". */
export const ACCOUNTS_SHOWN = 10;
/** Longer texts fold after this many characters. */
const TEXT_FOLD = 700;

const looksJson = (s: string | null | undefined) => !!s && /^\s*[{[]/.test(s);
const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

function nodeRef(db: DatabaseSync, id: string | null | undefined): AccountNodeRef | null {
  if (!id) return null;
  const n = db.prepare("SELECT id, type, slug, name FROM nodes WHERE id = ?").get(id) as AccountNodeRef | undefined;
  return n ?? null;
}

/** Who may speak as this node: its approved claimants and the contributors whose tokens stand for it. */
function subjectVoices(db: DatabaseSync, nodeId: string): { ids: Set<string>; names: Set<string> } {
  const rows = db.prepare(
    `SELECT k.id, k.name FROM contributors k
      WHERE k.id IN (SELECT contributor_id FROM node_claims WHERE node_id = ? AND status = 'approved')
         OR k.id IN (SELECT contributor_id FROM contributor_tokens WHERE node_id = ?)`
  ).all(nodeId, nodeId) as Array<{ id: string; name: string | null }>;
  return { ids: new Set(rows.map((r) => r.id)), names: new Set(rows.map((r) => r.name).filter((n): n is string => !!n)) };
}

export function accountsFor(db: DatabaseSync, nodeId: string): Account[] {
  const voices = subjectVoices(db, nodeId);
  const speaksAsSubject = (by: string | null | undefined) => !!by && (voices.ids.has(by) || voices.names.has(by));
  const out: Account[] = [];

  // ---- contributions' own words -------------------------------------------------
  const rows = db.prepare(
    `SELECT s.id, s.title, s.content, s.source_url, s.submitted_by, s.created_at,
            s.consent_scope, s.consent_attribution
       FROM signals s JOIN intake_queue iq ON iq.signal_id = s.id
      WHERE iq.target_node = ? AND iq.status = 'approved' AND iq.kind = 'human_signal'
        AND COALESCE(s.status, 'active') = 'active'
      GROUP BY s.id`
  ).all(nodeId) as any[];
  for (const r of rows) {
    const text = typeof r.content === "string" && r.content.trim() && !looksJson(r.content) ? r.content.trim() : null;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : null;
    if (!text) continue; // a structured write (an API body), not a written account
    const withheld = r.consent_scope === "structural_only";
    const anonymous = r.consent_attribution === "anonymous";
    const as = anonymous ? null : contributorNode(db, r.submitted_by);
    const named = anonymous || !r.submitted_by ? null
      : ((db.prepare("SELECT name FROM contributors WHERE id = ?").get(r.submitted_by) as any)?.name ?? r.submitted_by);
    out.push({
      signal_id: r.id,
      kind: "contribution",
      account_type: null,
      title: withheld ? null : title,
      text: withheld ? null : text,
      withheld,
      by: named,
      by_node: as ? { id: as.id, type: as.type, slug: as.slug, name: as.name } : null,
      subject: !anonymous && (speaksAsSubject(r.submitted_by) || as?.id === nodeId),
      speaking_for: null,
      relation: null,
      meta_key: null,
      at: r.created_at ?? null,
      source_url: withheld || !isHttp(r.source_url) ? null : r.source_url,
    });
  }

  // ---- the claimants' public notes -------------------------------------------------
  for (const n of publicNotesFor(db, nodeId)) {
    if (n.kind !== "context" && n.kind !== "contest") continue;
    const s = db.prepare("SELECT status, consent_scope, consent_attribution, created_at FROM signals WHERE id = ?").get(n.signal_id) as any;
    if (s && (s.status ?? "active") !== "active") continue;
    const withheld = s?.consent_scope === "structural_only";
    const anonymous = s?.consent_attribution === "anonymous";
    const fromHere = n.node_id === nodeId;
    out.push({
      signal_id: n.signal_id,
      kind: n.kind,
      account_type: null,
      title: null,
      text: withheld ? null : n.note,
      withheld,
      by: anonymous ? null : n.handle ? `@${n.handle}` : n.by,
      by_node: null,
      subject: !anonymous && fromHere,
      speaking_for: !anonymous && !fromHere ? nodeRef(db, n.node_id) : null,
      relation: n.relation
        ? { source: nodeRef(db, n.relation.source_id), source_id: n.relation.source_id, edge_type: n.relation.edge_type, target: nodeRef(db, n.relation.target_id), target_id: n.relation.target_id }
        : null,
      meta_key: n.meta_key,
      at: n.created_at ?? s?.created_at ?? null,
      source_url: null,
    });
  }

  // Oldest first: an order of time, not of standing.
  return out.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")) || a.signal_id.localeCompare(b.signal_id));
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
    parts.push(a.kind === "contest" ? `contests: ${rel}` : `context on: ${rel}`);
  } else if (a.meta_key) {
    parts.push(`${a.kind === "contest" ? "contests" : "context on"} the value of ${esc(a.meta_key)}`);
  }
  return parts.length ? `<p class="ev-account-label">${parts.join(" · ")}</p>` : "";
}

function byline(a: Account): string {
  const parts: string[] = [];
  parts.push(a.by ? `by ${a.by_node ? linkTo(a.by_node, a.by) : esc(a.by)}` : "anonymous");
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

function accountList(list: Account[], node: { name: string }): string {
  const shown = list.slice(0, ACCOUNTS_SHOWN).map((a) => accountItem(a, node)).join("");
  const rest = list.slice(ACCOUNTS_SHOWN);
  return `<ol class="ev-accounts">${shown}</ol>` +
    (rest.length
      ? `<details class="ev-accounts-rest"><summary>${rest.length} more, in the same order</summary><ol class="ev-accounts">${rest.map((a) => accountItem(a, node)).join("")}</ol></details>`
      : "");
}

const pad = (n: number) => String(n).padStart(2, "0");

export function accountsSection(db: DatabaseSync, node: { id: string; name: string }): string {
  const accounts = accountsFor(db, node.id);
  if (!accounts.length) return "";
  // Grouped by account type once types exist (#80 part 1); untyped ones stay
  // together under no heading. Group order is by first appearance — no type
  // outranks another.
  const groups = new Map<string, Account[]>();
  for (const a of accounts) {
    const k = a.account_type ?? "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }
  const typed = [...groups.keys()].some((k) => k);
  const body = typed
    ? [...groups].map(([k, list]) => `<h3 class="ev-accounts-type">${esc(k || "other accounts")}</h3>${accountList(list, node)}`).join("")
    : accountList(accounts, node);
  return `
      <section class="ev-section" id="ev-accounts">
        <h2 class="ev-h2">// accounts <span class="ev-h2-count">/${pad(accounts.length)}</span></h2>
        <p class="ev-accounts-lede">What contributors have written about ${esc(node.name)}, side by side and oldest first. No account here is the official one.</p>
        ${body}
      </section>`;
}
