// The personal log (docs/CLAIM-SPEC.md §4): for one node the contributor
// claimed, what the commons holds about it and what they can do about it.
// Read-only assembly over relations (collapsed per relation, like the
// profile), nodeHistory(), the review queue and the claimant's own notes.

import type { DatabaseSync } from "node:sqlite";
import { collapseClaims, CLAIM_COLS, tripleKey } from "../utils/claims.js";
import { nodeHistory } from "../utils/history.js";
import { CLAIMABLE_TYPES, approvedClaimsFor, claimsOf } from "./store.js";
import { invitesLeft, notesByContributor, publicNotesFor, notesByTriple, objectionsFor, queueItemTouches, INVITES_PER_WEEK, type RelationNote } from "./notes.js";

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export interface LogNode {
  id: string;
  name: string;
  type: string;
  slug: string;
  handle: string | null;
  claim_id: string;
  claim_status: string;
}

export function myNodes(db: DatabaseSync, contributorId: string): LogNode[] {
  return claimsOf(db, contributorId, ["approved", "pending"]).map((c) => {
    const n = db.prepare("SELECT id, name, type, slug, metadata FROM nodes WHERE id = ?").get(c.node_id) as any;
    return {
      id: c.node_id,
      name: n?.name ?? c.node_id,
      type: n?.type ?? "",
      slug: n?.slug ?? "",
      handle: (parse(n?.metadata) ?? {}).claimed?.handle ?? null,
      claim_id: c.id,
      claim_status: c.status,
    };
  });
}

function pendingAbout(db: DatabaseSync, nodeId: string, contributorId: string): any[] {
  const like = `%${JSON.stringify(nodeId).slice(1, -1)}%`;
  const rows = db
    .prepare(
      `SELECT q.id, q.kind, q.submitted_by, q.created_at, q.target_node, q.proposed_nodes, q.proposed_edges, s.title, s.source_url
         FROM intake_queue q LEFT JOIN signals_full s ON s.id = q.signal_id
        WHERE q.status = 'pending' AND q.kind IN ('human_signal','ai_suggestion')
          AND (q.target_node = ? OR q.proposed_edges LIKE ? OR q.proposed_nodes LIKE ?)
        ORDER BY q.created_at DESC LIMIT 100`
    )
    .all(nodeId, like, like) as any[];
  return rows
    .filter((r) => queueItemTouches(db, r.id, nodeId))
    .map((r) => {
      const edges = (parse(r.proposed_edges) ?? []).filter((e: any) => e?.source_id === nodeId || e?.target_id === nodeId);
      const ops = (parse(r.proposed_nodes) ?? []).filter((o: any) => o?.node_id === nodeId || (o?.op === "create_node" && `${o.type}:${o.slug}` === nodeId));
      return {
        queue_id: r.id,
        kind: r.kind,
        submitted_by: r.submitted_by,
        created_at: r.created_at,
        title: r.title ?? null,
        source_url: r.source_url ?? null,
        edges: edges.map((e: any) => ({ source_id: e.source_id, edge_type: e.edge_type, target_id: e.target_id, names: [nameOf(db, e.source_id), nameOf(db, e.target_id)] })),
        patches: ops.filter((o: any) => o.op === "patch_node").map((o: any) => ({ keys: Object.keys(o.metadata ?? {}) })),
        my_objections: objectionsFor(db, r.id).filter((o) => o.contributor_id === contributorId),
      };
    });
}

function nameOf(db: DatabaseSync, id: string): string {
  return (db.prepare("SELECT name FROM nodes WHERE id = ?").get(id) as any)?.name ?? id;
}

export function buildLog(db: DatabaseSync, contributorId: string, nodeId: string | null) {
  const nodes = myNodes(db, contributorId);
  const approved = nodes.filter((n) => n.claim_status === "approved");
  const current = (nodeId && approved.find((n) => n.id === nodeId)) || approved[0] || null;
  const base = {
    nodes,
    invites_left: invitesLeft(db, contributorId),
    invites_per_week: INVITES_PER_WEEK,
    invites: (db
      .prepare(
        `SELECT c.node_id, c.status, c.created_at, n.name, k.name AS invitee
           FROM node_claims c LEFT JOIN nodes n ON n.id = c.node_id LEFT JOIN contributors k ON k.id = c.contributor_id
          WHERE c.invited_by = ? AND c.via = 'peer_invite' ORDER BY c.created_at DESC LIMIT 50`
      )
      .all(contributorId) as any[]),
    my_notes: notesByContributor(db, contributorId),
  };
  if (!current) return { ...base, node: null };

  const id = current.id;
  // Live relations, one per (source, type, target), with their sources.
  const rels = collapseClaims(db
    .prepare(
      `SELECT ${CLAIM_COLS}, o.name AS other_name, o.type AS other_type, o.slug AS other_slug, e.valid_from
         FROM edges e LEFT JOIN signals s ON s.id = e.signal_id
         LEFT JOIN nodes o ON o.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
        WHERE e.valid_until IS NULL AND (e.source_id = ? OR e.target_id = ?) AND e.created_by != 'embedding-multimodal-v1'
        ORDER BY e.valid_from DESC`
    )
    .all(id, id, id) as any[]);
  const notes = notesByTriple(publicNotesFor(db, id));
  const mine = new Map<string, RelationNote[]>();
  for (const n of notesByContributor(db, contributorId)) {
    if (!n.relation) continue;
    const k = tripleKey(n.relation);
    if (!mine.has(k)) mine.set(k, []);
    mine.get(k)!.push(n);
  }
  const relations = rels.map((r: any) => {
    const otherId = r.source_id === id ? r.target_id : r.source_id;
    const k = tripleKey(r);
    const claimable = (CLAIMABLE_TYPES as readonly string[]).includes(r.other_type);
    return {
      relation: { source_id: r.source_id, edge_type: r.edge_type, target_id: r.target_id },
      direction: r.source_id === id ? "out" : "in",
      other: { id: otherId, name: r.other_name ?? otherId, type: r.other_type ?? null, slug: r.other_slug ?? null },
      since: r.valid_from ?? null,
      sources: r.origins.map((o: any) => o.label),
      notes: notes.get(k) ?? [],
      my_notes: mine.get(k) ?? [],
      can_invite: claimable && approvedClaimsFor(db, otherId).length === 0,
    };
  });
  const history = nodeHistory(db, id);
  return {
    ...base,
    node: current,
    relations,
    pending: pendingAbout(db, id, contributorId),
    history: (history?.events ?? []).slice(0, 200),
  };
}
