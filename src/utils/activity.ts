// The live activity feed (issue #83): a light trace of what is happening in
// the commons — "X added a work", "Y claimed their page", "Z connected two
// works" — so residents spread across a venue can find each other through
// traces. Gio's rule: live or empty, never stale — only the past 24 hours.
//
// Read from what the write path already keeps, never from the cached
// /api/graph stream (its stamp only tracks node / relation counts):
//   - approved review-queue rows (auto-merged API and URL-intake writes leave
//     one too): created nodes, relations, images, edits, written accounts;
//   - approved claims;
//   - the claimants' public notes (live context, open contests).
//
// Consent: an anonymous contribution names no one ("Someone") and links to
// nothing that would (an anonymous note's speaker, an anonymous contributor's
// own page); nothing here ever quotes a contribution's words, so
// structural_only shows the connection and nothing more. Retired nodes and
// revoked / superseded signals (a claim's own signal included) are left out;
// a relation shows only while the edge its own evidence made is still live,
// a note only while its relation is.
//
// One contribution is one line or a few: a URL-intake confirm writes one
// queue row per card under one batch_id (the draft), so rows are grouped by
// signals.batch_id (else the row) and folded by kind and attribution.
//
// Cost: candidates are read by time through indexes (db.sql), bounded, with
// statements prepared once per connection; answers are cached for 25 s and
// re-filtered by the window on every read.
//
// Off by default on prod (ACTIVITY_FEED=on turns it on, e.g. for GLITCH; or
// settings.activity_feed = 'on'); on staging the `activity` switch decides.

import type { DatabaseSync } from "node:sqlite";
import { isStaging, switches } from "./staging.js";
import { contributorNode } from "./contributor-node.js";

export const ACTIVITY_WINDOW_HOURS = 24;
export const ACTIVITY_DEFAULT_LIMIT = 6;
export const ACTIVITY_MAX_LIMIT = 20;

export function activityEnabled(db?: DatabaseSync): boolean {
  if (isStaging()) return switches().activity === "on";
  if (process.env.ACTIVITY_FEED === "on") return true;
  if (!db) return false;
  try {
    return (db.prepare("SELECT value FROM settings WHERE key = 'activity_feed'").get() as any)?.value === "on";
  } catch {
    return false;
  }
}

export interface ActivityNode { id: string; type: string; slug: string; name: string }

export interface ActivityEvent {
  at: string;
  kind: "added" | "connected" | "image" | "updated" | "wrote" | "claimed" | "context" | "contested";
  actor: string | null;          // null = anonymous / unknown
  count: number;                 // several of the same kind from one contribution, folded
  text: string;                  // the sentence, plain text (the client escapes it)
  node: ActivityNode | null;     // where the sentence links
}

const TYPE_WORD: Record<string, [string, string]> = {
  artwork: ["a work", "works"],
  practitioner: ["an artist", "artists"],
  collective: ["a collective", "collectives"],
  institution: ["an institution", "institutions"],
  project: ["a show", "shows"],
  concept: ["a concept", "concepts"],
  publication: ["a publication", "publications"],
  platform: ["a platform", "platforms"],
};
const typeWord = (type: string, n: number) => {
  const w = TYPE_WORD[type];
  if (w) return n === 1 ? w[0] : `${n} ${w[1]}`;
  const t = type.replace(/_/g, " ");
  return n === 1 ? `a ${t}` : `${n} ${t}s`;
};

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

const isoAt = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const CACHE_MS = 25_000;
const CANDIDATES = 500;

type Stmts = ReturnType<typeof prepare>;
const stmtCache = new WeakMap<DatabaseSync, Stmts>();
const answerCache = new WeakMap<DatabaseSync, Map<number, { at: number; events: ActivityEvent[] }>>();

function prepare(db: DatabaseSync) {
  return {
    node: db.prepare("SELECT id, type, slug, name, metadata FROM nodes WHERE id = ?"),
    nodeByAddr: db.prepare("SELECT id FROM nodes WHERE type = ? AND slug = ?"),
    sig: db.prepare("SELECT submitted_by, status, consent_attribution, batch_id FROM signals WHERE id = ?"),
    evidenceEdge: db.prepare(
      "SELECT 1 FROM edges WHERE signal_id = ? AND source_id = ? AND edge_type = ? AND target_id = ? AND valid_until IS NULL LIMIT 1"
    ),
    liveTriple: db.prepare(
      "SELECT 1 FROM edges WHERE source_id = ? AND edge_type = ? AND target_id = ? AND valid_until IS NULL AND (created_by IS NULL OR created_by != 'embedding-multimodal-v1') LIMIT 1"
    ),
    claimedBy: db.prepare(
      "SELECT 1 FROM node_claims c JOIN contributors k ON k.id = c.contributor_id WHERE c.node_id = ? AND (k.name = ? OR k.id = ?) LIMIT 1"
    ),
    // OR-split time predicates so the (reviewed_at) / (created_at) indexes serve them
    queue: db.prepare(
      `SELECT q.id, q.signal_id, q.target_node, q.submitted_by, q.proposed_nodes, q.proposed_edges,
              COALESCE(q.reviewed_at, q.created_at) AS at, s.batch_id
         FROM intake_queue q LEFT JOIN signals s ON s.id = q.signal_id
        WHERE +q.status = 'approved' AND +q.kind = 'human_signal' -- unary +: let the time indexes lead (status matches most rows)
          AND ((q.reviewed_at >= :since AND q.reviewed_at <= :until)
               OR (q.reviewed_at IS NULL AND q.created_at >= :since AND q.created_at <= :until))
        ORDER BY at DESC LIMIT ${CANDIDATES}`
    ),
    claims: db.prepare(
      `SELECT c.node_id, COALESCE(c.reviewed_at, c.created_at) AS at FROM node_claims c
         JOIN signals s ON s.id = c.signal_id AND COALESCE(s.status, 'active') = 'active'
        WHERE c.status = 'approved'
          AND ((c.reviewed_at >= :since AND c.reviewed_at <= :until)
               OR (c.reviewed_at IS NULL AND c.created_at >= :since AND c.created_at <= :until))
        ORDER BY at DESC LIMIT ${CANDIDATES}`
    ),
    notes: db.prepare(
      `SELECT signal_id, kind, node_id, source_id, edge_type, target_id, meta_key, created_at AS at FROM relation_notes
        WHERE ((kind = 'context' AND state = 'live') OR (kind = 'contest' AND state = 'open'))
          AND created_at >= :since AND created_at <= :until
        ORDER BY created_at DESC LIMIT ${CANDIDATES}`
    ),
  };
}

function stmts(db: DatabaseSync): Stmts {
  let s = stmtCache.get(db);
  if (!s) { s = prepare(db); stmtCache.set(db, s); }
  return s;
}

/** The past 24 hours, newest first, at most `limit` lines. `now` is for tests (and skips the cache). */
export function recentActivity(db: DatabaseSync, opts: { limit?: number; now?: Date } = {}): ActivityEvent[] {
  const limit = Math.max(1, Math.min(ACTIVITY_MAX_LIMIT, opts.limit ?? ACTIVITY_DEFAULT_LIMIT));
  const nowMs = (opts.now ?? new Date()).getTime();
  const sinceIso = isoAt(nowMs - ACTIVITY_WINDOW_HOURS * 3600_000);
  if (!opts.now) {
    const hit = answerCache.get(db)?.get(limit);
    // a cached answer still respects the window: re-filtered on every read
    if (hit && nowMs - hit.at < CACHE_MS) return hit.events.filter((e) => e.at >= sinceIso);
  }
  const events = compute(db, limit, nowMs);
  if (!opts.now) {
    if (!answerCache.has(db)) answerCache.set(db, new Map());
    answerCache.get(db)!.set(limit, { at: nowMs, events });
  }
  return events;
}

/** Drop cached answers (tests; a switch flipped). */
export function clearActivityCache(db: DatabaseSync): void {
  answerCache.delete(db);
}

function compute(db: DatabaseSync, limit: number, nowMs: number): ActivityEvent[] {
  const q = stmts(db);
  const range = { since: isoAt(nowMs - ACTIVITY_WINDOW_HOURS * 3600_000), until: isoAt(nowMs) };

  const nodeCache = new Map<string, ActivityNode | null>();
  /** A node that may be shown: exists and is not retired. */
  const nodeOf = (id: unknown): ActivityNode | null => {
    if (typeof id !== "string" || !id) return null;
    if (!nodeCache.has(id)) {
      const n = q.node.get(id) as any;
      nodeCache.set(id, n && parse(n.metadata)?.retired !== true ? { id: n.id, type: n.type, slug: n.slug, name: n.name } : null);
    }
    return nodeCache.get(id)!;
  };
  /** null: the signal was revoked / superseded — leave it out. */
  const actorOf = (signalId: unknown, fallback: string | null): { actor: string | null; raw: string | null } | null => {
    const s = typeof signalId === "string" ? (q.sig.get(signalId) as any) : null;
    if (s && (s.status ?? "active") !== "active") return null;
    const raw = (s?.submitted_by as string | undefined) ?? fallback;
    return { actor: s?.consent_attribution === "anonymous" ? null : raw, raw };
  };
  /** An anonymous contributor's own page would name them: they stand for it, or claim it. */
  const ownPage = (node: ActivityNode, raw: string | null): boolean =>
    !!raw && (contributorNode(db, raw)?.id === node.id || !!q.claimedBy.get(node.id, raw, raw));
  const who = (a: string | null) => a ?? "Someone";

  const out: ActivityEvent[] = [];
  const push = (e: Omit<ActivityEvent, "text"> & { text: (who: string) => string }) =>
    out.push({ ...e, text: e.text(who(e.actor)) });

  // ---- contributions: grouped by batch (a URL-intake confirm is one), folded by kind and attribution ----
  type Item = { node: ActivityNode | null; actor: string | null };
  // a connection: either end may be the anonymous author's own page (sHidden / tHidden)
  type Conn = Item & { s: ActivityNode; t: ActivityNode; sHidden: boolean; tHidden: boolean };
  type Group = { at: string; created: Map<string, Item[]>; images: Map<string, Item[]>; updated: Map<string, Item[]>; conns: Map<string, Conn[]>; wrote: Map<string, Item[]> };
  const groups = new Map<string, Group>();
  const add = <T extends Item>(m: Map<string, T[]>, actor: string | null, item: T) => {
    const k = actor ?? "\u0000anon";
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(item);
  };
  for (const r of q.queue.all(range) as any[]) {
    const key = r.batch_id ? `b:${r.batch_id}` : `q:${r.id}`;
    let g = groups.get(key);
    if (!g) { g = { at: r.at, created: new Map(), images: new Map(), updated: new Map(), conns: new Map(), wrote: new Map() }; groups.set(key, g); }
    if (r.at > g.at) g.at = r.at;
    const ops = (parse(r.proposed_nodes) ?? []) as any[];
    const edges = (parse(r.proposed_edges) ?? []) as any[];
    for (const op of ops) {
      const sig = op?.signal_id ?? r.signal_id;
      if (op?.op === "create_node" && op.type && op.slug) {
        // materialiseCreateNode keys it type:slug; older ids keep their spaced form
        const byAddr = q.nodeByAddr.get(op.type, op.slug) as any;
        const node = nodeOf(`${op.type}:${op.slug}`) ?? nodeOf(byAddr?.id);
        const a = actorOf(sig, r.submitted_by);
        if (!node || !a) continue;
        const hidden = a.actor === null && ownPage(node, a.raw);
        if (!g.created.has(node.type)) g.created.set(node.type, []);
        g.created.get(node.type)!.push({ node: hidden ? null : node, actor: a.actor });
      } else if (op?.op === "attach_image" || op?.op === "patch_node") {
        const node = nodeOf(op.node_id);
        const a = actorOf(sig, r.submitted_by);
        if (!node || !a) continue;
        const item = { node: a.actor === null && ownPage(node, a.raw) ? null : node, actor: a.actor };
        add(op.op === "attach_image" ? g.images : g.updated, a.actor, item);
      }
    }
    for (const e of edges) {
      if (!e?.source_id || !e?.target_id || !e?.edge_type) continue;
      const evidence = e.signal_id ?? r.signal_id;
      const s = nodeOf(e.source_id), t = nodeOf(e.target_id);
      const a = actorOf(evidence, r.submitted_by);
      if (!s || !t || !a) continue;
      // the edge this contribution's own evidence made, still live
      if (!q.evidenceEdge.get(evidence, e.source_id, e.edge_type, e.target_id)) continue;
      const anon = a.actor === null;
      add(g.conns, a.actor, { node: t, actor: a.actor, s, t, sHidden: anon && ownPage(s, a.raw), tHidden: anon && ownPage(t, a.raw) });
    }
    if (!ops.length && !edges.length && r.target_node) {
      const node = nodeOf(r.target_node);
      const a = actorOf(r.signal_id, r.submitted_by);
      // an anonymous account of the author's own page would name them: no page, no link
      if (node && a) add(g.wrote, a.actor, { node: a.actor === null && ownPage(node, a.raw) ? null : node, actor: a.actor });
    }
  }
  for (const g of groups.values()) {
    for (const [type, list] of g.created) {
      for (const actor of new Set(list.map((i) => i.actor))) {
        const mine = list.filter((i) => i.actor === actor);
        const one = mine[0];
        push({ at: g.at, kind: "added", actor, count: mine.length, node: mine.length === 1 ? one.node : null,
          text: (w) => mine.length === 1 && one.node ? `${w} added ${typeWord(type, 1)}: ${one.node.name}` : `${w} added ${typeWord(type, mine.length)}` });
      }
    }
    for (const [, list] of g.images) {
      const one = list[0];
      push({ at: g.at, kind: "image", actor: one.actor, count: list.length, node: list.length === 1 ? one.node : null,
        text: (w) => list.length === 1 && one.node ? `${w} added an image to ${one.node.name}` : `${w} added ${list.length === 1 ? "an image" : `${list.length} images`}` });
    }
    for (const [, list] of g.conns) {
      const c = list[0];
      const works = c.s.type === "artwork" && c.t.type === "artwork";
      if (list.length === 1 && (c.sHidden || c.tHidden)) {
        // one end is the anonymous author's own page: name and link only the other end
        const other = c.sHidden && c.tHidden ? null : c.sHidden ? c.t : c.s;
        push({ at: g.at, kind: "connected", actor: c.actor, count: 1, node: other,
          text: (w) => other ? `${w} connected ${other.name} to a page` : `${w} made a connection` });
        continue;
      }
      const anyHidden = list.some((i) => i.sHidden || i.tHidden);
      push({ at: g.at, kind: "connected", actor: c.actor, count: list.length, node: anyHidden ? null : c.t,
        text: (w) => list.length === 1
          ? (works ? `${w} connected two works: ${c.s.name} and ${c.t.name}` : `${w} connected ${c.s.name} and ${c.t.name}`)
          : `${w} made ${list.length} connections` });
    }
    if (!g.created.size) {
      for (const [, list] of g.updated) {
        const one = list[0];
        push({ at: g.at, kind: "updated", actor: one.actor, count: list.length, node: list.length === 1 ? one.node : null,
          text: (w) => list.length === 1 && one.node ? `${w} updated ${one.node.name}` : `${w} updated ${list.length === 1 ? "a page" : `${list.length} pages`}` });
      }
    }
    for (const [, list] of g.wrote) {
      const one = list[0];
      push({ at: g.at, kind: "wrote", actor: one.actor, count: list.length, node: list.length === 1 ? one.node : null,
        text: (w) => list.length === 1
          ? (one.node ? `${w} wrote about ${one.node.name}` : `${w} wrote an account`)
          : `${w} wrote ${list.length} accounts` });
    }
  }

  // ---- claims (their own signal still active) ----
  for (const c of q.claims.all(range) as any[]) {
    const node = nodeOf(c.node_id);
    if (!node) continue;
    // The claim is public (metadata.claimed): the page speaks for itself.
    push({ at: c.at, kind: "claimed", actor: node.name, count: 1, node, text: () => `${node.name} claimed their page` });
  }

  // ---- the claimants' public notes (their relation still live) ----
  for (const n of q.notes.all(range) as any[]) {
    const speaker = nodeOf(n.node_id);
    const a = actorOf(n.signal_id, null);
    if (!speaker || !a) continue;
    const anonymous = a.actor === null;
    const name = anonymous ? "Someone" : speaker.name;
    if (n.source_id) {
      if (!q.liveTriple.get(n.source_id, n.edge_type, n.target_id)) continue;
      const otherId = n.source_id === n.node_id ? n.target_id : n.source_id;
      const other = nodeOf(otherId);
      if (!other) continue;
      push({ at: n.at, kind: n.kind === "contest" ? "contested" : "context", actor: anonymous ? null : speaker.name, count: 1,
        // anonymous: no link to the speaker's page either
        node: anonymous ? other : speaker,
        text: () => n.kind === "contest"
          ? `${name} contested a relation with ${other.name}`
          : `${name} added context to ${anonymous ? "a relation with" : "their relation with"} ${other.name}` });
    } else if (n.meta_key) {
      push({ at: n.at, kind: n.kind === "contest" ? "contested" : "context", actor: anonymous ? null : speaker.name, count: 1,
        node: anonymous ? null : speaker,
        text: () => n.kind === "contest"
          ? `${name} contested a change to ${anonymous ? "a page" : "their page"}`
          : `${name} added context to a change on ${anonymous ? "a page" : "their page"}` });
    }
  }

  return out
    .sort((x, y) => y.at.localeCompare(x.at))
    .slice(0, limit);
}
