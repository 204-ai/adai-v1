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
// Consent: an anonymous contribution names no one ("Someone"); nothing here
// ever quotes a contribution's words, so structural_only shows the connection
// and nothing more. Retired nodes and revoked / superseded signals are left
// out, and a relation shows only while it is still live.
//
// Off by default on prod (ACTIVITY_FEED=on turns it on, e.g. for GLITCH; or
// settings.activity_feed = 'on'); on staging the `activity` switch decides.

import type { DatabaseSync } from "node:sqlite";
import { isStaging, switches } from "./staging.js";

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

/** The past 24 hours, newest first, at most `limit` lines. `now` is for tests. */
export function recentActivity(db: DatabaseSync, opts: { limit?: number; now?: Date } = {}): ActivityEvent[] {
  const limit = Math.max(1, Math.min(ACTIVITY_MAX_LIMIT, opts.limit ?? ACTIVITY_DEFAULT_LIMIT));
  const nowMs = (opts.now ?? new Date()).getTime();
  const since = isoAt(nowMs - ACTIVITY_WINDOW_HOURS * 3600_000);
  const until = isoAt(nowMs);

  const nodeStmt = db.prepare("SELECT id, type, slug, name, metadata FROM nodes WHERE id = ?");
  const nodeCache = new Map<string, ActivityNode | null>();
  /** A node that may be shown: exists and is not retired. */
  const nodeOf = (id: unknown): ActivityNode | null => {
    if (typeof id !== "string" || !id) return null;
    if (!nodeCache.has(id)) {
      const n = nodeStmt.get(id) as any;
      nodeCache.set(id, n && parse(n.metadata)?.retired !== true ? { id: n.id, type: n.type, slug: n.slug, name: n.name } : null);
    }
    return nodeCache.get(id)!;
  };
  const sigStmt = db.prepare("SELECT submitted_by, status, consent_attribution FROM signals WHERE id = ?");
  /** null: the signal was revoked / superseded — leave it out. */
  const actorOf = (signalId: unknown, fallback: string | null): { actor: string | null } | null => {
    const s = typeof signalId === "string" ? (sigStmt.get(signalId) as any) : null;
    if (s && (s.status ?? "active") !== "active") return null;
    if (s?.consent_attribution === "anonymous") return { actor: null };
    return { actor: (s?.submitted_by as string | undefined) ?? fallback };
  };
  const liveEdge = db.prepare(
    "SELECT 1 FROM edges WHERE source_id = ? AND edge_type = ? AND target_id = ? AND valid_until IS NULL LIMIT 1"
  );
  const who = (a: string | null) => a ?? "Someone";

  const out: ActivityEvent[] = [];
  const push = (e: Omit<ActivityEvent, "text"> & { text: (who: string) => string }) =>
    out.push({ ...e, text: e.text(who(e.actor)) });

  // ---- contributions (one queue row = one contribution; like things fold) ----
  const rows = db.prepare(
    `SELECT id, signal_id, target_node, submitted_by, proposed_nodes, proposed_edges,
            COALESCE(reviewed_at, created_at) AS at
       FROM intake_queue
      WHERE status = 'approved' AND kind = 'human_signal'
        AND COALESCE(reviewed_at, created_at) >= ? AND COALESCE(reviewed_at, created_at) <= ?
      ORDER BY at DESC LIMIT 500`
  ).all(since, until) as any[];
  for (const r of rows) {
    const ops = (parse(r.proposed_nodes) ?? []) as any[];
    const edges = (parse(r.proposed_edges) ?? []) as any[];
    // created nodes, by type
    const created = new Map<string, Array<{ node: ActivityNode; actor: string | null }>>();
    const images: Array<{ node: ActivityNode; actor: string | null }> = [];
    const updated: Array<{ node: ActivityNode; actor: string | null }> = [];
    for (const op of ops) {
      const sig = op?.signal_id ?? r.signal_id;
      if (op?.op === "create_node" && op.type && op.slug) {
        // materialiseCreateNode keys it type:slug; older ids keep their spaced form
        const byAddr = db.prepare("SELECT id FROM nodes WHERE type = ? AND slug = ?").get(op.type, op.slug) as any;
        const node = nodeOf(`${op.type}:${op.slug}`) ?? nodeOf(byAddr?.id);
        const a = actorOf(sig, r.submitted_by);
        if (!node || !a) continue;
        if (!created.has(node.type)) created.set(node.type, []);
        created.get(node.type)!.push({ node, actor: a.actor });
      } else if (op?.op === "attach_image" || op?.op === "patch_node") {
        const node = nodeOf(op.node_id);
        const a = actorOf(sig, r.submitted_by);
        if (!node || !a) continue;
        (op.op === "attach_image" ? images : updated).push({ node, actor: a.actor });
      }
    }
    for (const [type, list] of created) {
      push({ at: r.at, kind: "added", actor: list[0].actor, count: list.length, node: list[0].node,
        text: (w) => list.length === 1 ? `${w} added ${typeWord(type, 1)}: ${list[0].node.name}` : `${w} added ${typeWord(type, list.length)}` });
    }
    if (images.length) {
      push({ at: r.at, kind: "image", actor: images[0].actor, count: images.length, node: images[0].node,
        text: (w) => images.length === 1 ? `${w} added an image to ${images[0].node.name}` : `${w} added ${images.length} images` });
    }
    // relations: only those still live, between nodes still shown
    const conns: Array<{ s: ActivityNode; t: ActivityNode; actor: string | null }> = [];
    for (const e of edges) {
      if (!e?.source_id || !e?.target_id || !e?.edge_type) continue;
      const s = nodeOf(e.source_id), t = nodeOf(e.target_id);
      const a = actorOf(e.signal_id ?? r.signal_id, r.submitted_by);
      if (!s || !t || !a) continue;
      if (!liveEdge.get(e.source_id, e.edge_type, e.target_id)) continue;
      conns.push({ s, t, actor: a.actor });
    }
    if (conns.length) {
      const c = conns[0];
      const works = c.s.type === "artwork" && c.t.type === "artwork";
      push({ at: r.at, kind: "connected", actor: c.actor, count: conns.length, node: c.t,
        text: (w) => conns.length === 1
          ? (works ? `${w} connected two works: ${c.s.name} and ${c.t.name}` : `${w} connected ${c.s.name} and ${c.t.name}`)
          : `${w} made ${conns.length} connections` });
    }
    if (updated.length && !created.size) {
      push({ at: r.at, kind: "updated", actor: updated[0].actor, count: updated.length, node: updated[0].node,
        text: (w) => updated.length === 1 ? `${w} updated ${updated[0].node.name}` : `${w} updated ${updated.length} pages` });
    }
    // a written account about a node (no structured ops): never its words
    if (!ops.length && !edges.length && r.target_node) {
      const node = nodeOf(r.target_node);
      const a = actorOf(r.signal_id, r.submitted_by);
      if (node && a) push({ at: r.at, kind: "wrote", actor: a.actor, count: 1, node, text: (w) => `${w} wrote about ${node.name}` });
    }
  }

  // ---- claims ----
  const claims = db.prepare(
    `SELECT node_id, COALESCE(reviewed_at, created_at) AS at FROM node_claims
      WHERE status = 'approved' AND COALESCE(reviewed_at, created_at) >= ? AND COALESCE(reviewed_at, created_at) <= ?`
  ).all(since, until) as any[];
  for (const c of claims) {
    const node = nodeOf(c.node_id);
    if (!node) continue;
    // The claim is public (metadata.claimed): the page speaks for itself.
    push({ at: c.at, kind: "claimed", actor: node.name, count: 1, node, text: () => `${node.name} claimed their page` });
  }

  // ---- the claimants' public notes ----
  const notes = db.prepare(
    `SELECT signal_id, kind, node_id, source_id, target_id, created_at AS at FROM relation_notes
      WHERE ((kind = 'context' AND state = 'live') OR (kind = 'contest' AND state = 'open'))
        AND created_at >= ? AND created_at <= ?`
  ).all(since, until) as any[];
  for (const n of notes) {
    const speaker = nodeOf(n.node_id);
    const a = actorOf(n.signal_id, null);
    if (!speaker || !a) continue;
    const otherId = n.source_id === n.node_id ? n.target_id : n.source_id;
    const other = otherId ? nodeOf(otherId) : null;
    if (otherId && !other) continue;
    const name = a.actor === null ? "Someone" : speaker.name;
    push({ at: n.at, kind: n.kind === "contest" ? "contested" : "context", actor: a.actor === null ? null : speaker.name, count: 1, node: speaker,
      text: () => n.kind === "contest"
        ? `${name} contested a relation${other ? ` with ${other.name}` : ""}`
        : `${name} added context${other ? ` to their relation with ${other.name}` : ""}` });
  }

  return out
    .sort((x, y) => y.at.localeCompare(x.at))
    .slice(0, limit);
}
