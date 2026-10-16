// Left-open items (issue #77): cards a contributor could not decide stay
// open at Confirm, for another contributor to pick up.
//
// What counts as open is decided here, in one place, for Confirm, the
// receipt and the draft page's preview: a card nobody accepted or rejected
// (still "proposed", or marked "Leave open"), and an accepted card that
// needs an open one (an edge whose new work was left open waits with it). A
// card that needs a card the contributor turned down cannot stand, so it is
// not kept.
//
// The rows live in intake_open_items; the cards stay in their (immutable,
// submitted) draft. A pick-up copies them into a draft of the picker's
// (createPickupDraft in draft.ts) and that draft's Confirm decides them —
// under the picker's own name and tier, the first proposer in provenance.

import type { DatabaseSync } from "node:sqlite";
import { isCidRef, linkUnchecked, type Candidate } from "./candidate.js";

export type OpenReason = "undecided" | "link_failed";

/** The draft cards a card needs (cids, without the `cid:` prefix). */
export function cardDeps(c: Candidate): string[] {
  const refs =
    c.kind === "edge" ? [c.edge.source, c.edge.target]
    : c.kind === "image" ? [c.image.for]
    : c.kind === "question" ? [c.question.if_yes.source, c.question.if_yes.target]
    : [];
  return refs.filter(isCidRef).map((r) => r.slice(4));
}

const TURNED_DOWN = new Set(["rejected", "context_only"]);

function ownReason(c: Candidate): OpenReason | null {
  if (c.kind === "known") return null;
  if (c.state === "proposed" || c.state === "open") return "undecided";
  // Started rejected because the reader could not open its page (#75), and
  // nobody has decided it since: it waits for someone to re-check the link.
  if (linkUnchecked(c)) return "link_failed";
  return null;
}

/**
 * The cards of `cands` that stay open at Confirm, with why. `skip`: cards to
 * leave out altogether (in a pick-up, items someone else has decided since).
 */
export function leftOpen(cands: Candidate[], skip: ReadonlySet<string> = new Set()): Map<string, OpenReason> {
  const live = cands.filter((c) => !skip.has(c.cid));
  const byCid = new Map(live.map((c) => [c.cid, c]));
  const open = new Map<string, OpenReason>();
  // Node cards first: they need nothing, and everything else needs them.
  for (const c of live) {
    const r = c.kind === "node" ? ownReason(c) : null;
    if (r) open.set(c.cid, r);
  }
  for (const c of live) {
    if (c.kind === "node" || c.kind === "known") continue;
    const deps = cardDeps(c).map((cid) => byCid.get(cid));
    if (deps.some((d) => !d || (TURNED_DOWN.has(d.state) && !open.has(d.cid)))) continue;
    const r = ownReason(c) ?? (c.state === "accepted" && deps.some((d) => open.has(d!.cid)) ? "undecided" : null);
    if (r) open.set(c.cid, r);
  }
  return open;
}

export interface OpenItemRow {
  draft_id: string;
  cid: string;
  kind: string;
  label: string;
  reason: OpenReason;
  subject_node_id: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_in: string | null;
  outcome: string | null;
}

export function openItemsOf(db: DatabaseSync, draftId: string): OpenItemRow[] {
  return db.prepare("SELECT * FROM intake_open_items WHERE draft_id = ? ORDER BY cid").all(draftId) as unknown as OpenItemRow[];
}

export function insertOpenItem(db: DatabaseSync, row: { draft_id: string; cid: string; kind: string; label: string; reason: OpenReason; subject_node_id: string | null }): void {
  db.prepare(
    "INSERT OR IGNORE INTO intake_open_items (draft_id, cid, kind, label, reason, subject_node_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(row.draft_id, row.cid, row.kind, row.label.slice(0, 300), row.reason, row.subject_node_id);
}

/** Record a pick-up's decision on an item. False when someone decided it first. */
export function decideOpenItem(db: DatabaseSync, draftId: string, cid: string, by: string, inDraft: string, outcome: string): boolean {
  const r = db.prepare(
    "UPDATE intake_open_items SET decided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), decided_by = ?, decided_in = ?, outcome = ? WHERE draft_id = ? AND cid = ? AND decided_at IS NULL"
  ).run(by, inDraft, outcome, draftId, cid);
  return r.changes > 0;
}

export interface OpenRead {
  draft_id: string;
  source_url: string;
  source_domain: string;
  left_by: string | null;
  left_at: string;
  subject: { id: string; name: string | null } | null;
  items: number;
  links_to_recheck: number;
  kinds: Record<string, number>;
}

/** Reads with items still open, newest first; `nodeId` narrows to one subject. */
export function listOpenReads(db: DatabaseSync, opts: { nodeId?: string; limit?: number } = {}): OpenRead[] {
  const rows = db.prepare(
    `SELECT o.draft_id, d.source_url, d.source_domain, c.name AS left_by, MIN(o.created_at) AS left_at,
            MAX(o.subject_node_id) AS subject_node_id, COUNT(*) AS items,
            SUM(CASE WHEN o.reason = 'link_failed' THEN 1 ELSE 0 END) AS links, GROUP_CONCAT(o.kind) AS kinds
       FROM intake_open_items o
       JOIN drafts d ON d.id = o.draft_id
       LEFT JOIN contributors c ON c.id = d.contributor_id
      WHERE o.decided_at IS NULL ${opts.nodeId ? "AND o.subject_node_id = ?" : ""}
      GROUP BY o.draft_id
      ORDER BY left_at DESC
      LIMIT ?`
  ).all(...(opts.nodeId ? [opts.nodeId] : []), Math.min(Math.max(opts.limit ?? 50, 1), 200)) as any[];
  const nameOf = db.prepare("SELECT name FROM nodes WHERE id = ?");
  return rows.map((r) => {
    const kinds: Record<string, number> = {};
    for (const k of String(r.kinds ?? "").split(",").filter(Boolean)) kinds[k] = (kinds[k] ?? 0) + 1;
    return {
      draft_id: r.draft_id,
      source_url: r.source_url,
      source_domain: r.source_domain,
      left_by: r.left_by ?? null,
      left_at: r.left_at,
      subject: r.subject_node_id ? { id: r.subject_node_id, name: (nameOf.get(r.subject_node_id) as any)?.name ?? null } : null,
      items: r.items,
      links_to_recheck: r.links ?? 0,
      kinds,
    };
  });
}
