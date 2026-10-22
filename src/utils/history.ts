// A node's history, newest first: every metadata write and every relation
// that started or ended, each with the signal that caused it. Read-only; it
// assembles what the correction model already keeps (nothing is deleted):
//
//   metadata  — patch / image ops from intake_queue (what was set), joined to
//               the before-image recordPrior wrote on the causing signal
//               (signals.processing_trace.prior, src/utils/contribution.ts),
//               plus trace-only writes (retire, apply-image-patch). Writes
//               older than before-image recording show `before: null`.
//   relations — every edge touching the node, live or closed: `added` at
//               valid_from, `ended` at valid_until (+ the invalidating id).
//               Embedding-derived edges are left out: they are rebuilt every
//               night and are not anyone's claim.
//
// Each metadata event also carries `after` — the value the next write to that
// key replaced, else the node's current value — so a key reads as a chain.
//
// Consent is honoured the same way as on the profile page: a structural_only
// signal shows the fact of the change but not its title / source / content,
// and an anonymous one hides who.

import type { DatabaseSync } from "node:sqlite";
import { contributorNode, type StandsFor } from "./contributor-node.js";

export interface HistorySource {
  signal_id: string;
  title: string | null;
  by: string | null;
  source_url: string | null;
  source_type: string | null;
  batch_id: string | null;
  status: string | null;
  // URL intake: the contributor changed the card; this is what the reader proposed.
  proposed_as?: Record<string, unknown>;
  // URL intake: picked up from another read's left-open items (issue #77) —
  // the contributor who first proposed it, and that read.
  first_proposed?: { by: string | null; batch_id: string };
  // The node the contributor stands for (issue #70): `by` links to it.
  by_node?: { type: string; slug: string };
}

export type HistoryEvent =
  | {
      kind: "metadata";
      at: string | null;
      op: string; // patch_node | attach_image | retire_node | apply_image_patch | merge_node | rename_slug
      changes: Array<{ key: string; before: unknown; after: unknown }>;
      before_recorded: boolean;
      by: string | null;
      source: HistorySource | null;
    }
  | {
      kind: "relation";
      at: string | null;
      change: "added" | "ended";
      edge_id: string;
      edge_type: string;
      direction: "out" | "in";
      other: { id: string; name: string | null; type: string | null; slug: string | null };
      event_time: string | null;
      invalidated_by: string | null;
      by: string | null;
      source: HistorySource | null;
    }
  | {
      // The subject's word (docs/CLAIM-SPEC.md §4): a contest on a relation or
      // an edit, or a published context note. `state` is where it stands now.
      kind: "note";
      at: string | null;
      note_kind: "contest" | "context";
      state: string;
      note: string;
      relation: { source_id: string; edge_type: string; target_id: string } | null;
      meta_key: string | null;
      resolution: string | null;
      resolved_at: string | null;
      by: string | null;
      source: HistorySource | null;
    };

export interface NodeHistory {
  node: { id: string; name: string; type: string; slug: string; created_at: string | null };
  events: HistoryEvent[];
}

const DERIVED_CREATED_BY = "embedding-multimodal-v1";

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function nodeHistory(db: DatabaseSync, nodeId: string): NodeHistory | null {
  const node = db.prepare("SELECT id, name, type, slug, metadata, created_at FROM nodes WHERE id = ?").get(nodeId) as any;
  if (!node) return null;
  const current = parse(node.metadata) ?? {};

  const sigCache = new Map<string, any>();
  const signal = (id: string | null | undefined): any => {
    if (!id) return null;
    if (!sigCache.has(id)) {
      sigCache.set(id, db.prepare(
        "SELECT rowid AS seq, id, title, submitted_by, source_url, source_type, batch_id, status, consent_scope, consent_attribution, provenance_chain, processing_trace FROM signals WHERE id = ?"
      ).get(id) ?? null);
    }
    return sigCache.get(id);
  };
  const standsCache = new Map<string, StandsFor | null>();
  const standsFor = (by: string): StandsFor | null => {
    if (!standsCache.has(by)) standsCache.set(by, contributorNode(db, by));
    return standsCache.get(by)!;
  };
  const sourceOf = (s: any): HistorySource | null => {
    if (!s) return null;
    const structural = s.consent_scope === "structural_only";
    const out: HistorySource = {
      signal_id: s.id,
      title: structural ? null : s.title ?? null,
      by: s.consent_attribution === "anonymous" ? null : s.submitted_by ?? null,
      source_url: structural ? null : s.source_url ?? null,
      source_type: s.source_type ?? null,
      batch_id: s.batch_id ?? null,
      status: s.status ?? null,
    };
    const prov = structural ? null : parse(s.provenance_chain);
    if (prov && typeof prov.proposed_as === "object" && prov.proposed_as) out.proposed_as = prov.proposed_as;
    if (prov?.picked_from && typeof prov.picked_from.draft_id === "string") out.first_proposed = { by: prov.picked_from.by ?? null, batch_id: prov.picked_from.draft_id };
    const as = out.by ? standsFor(out.by) : null;
    if (as) out.by_node = { type: as.type, slug: as.slug };
    return out;
  };
  const priorOf = (s: any, op: string): any => {
    const prior = parse(s?.processing_trace)?.prior;
    return Array.isArray(prior) ? prior.find((p: any) => p?.op === op && p?.node_id === nodeId) ?? null : null;
  };

  // Timestamps are to the second, so writes in one second tie; the causing
  // signal's insertion order breaks the tie.
  const seqOf = new Map<HistoryEvent, number>();
  const at = (e: { at: string | null }) => String(e.at ?? "");

  // ---- metadata writes ---------------------------------------------------
  type Raw = { at: string | null; op: string; keys: string[]; set: Record<string, unknown> | null; prior: any; sig: any };
  const raws: Raw[] = [];
  const seen = new Set<string>(); // `${signal_id}|${op}`

  // (a) every approved op that wrote this node (auto-merged writes leave an
  // approved row too). A queued URL-intake op carries its own signal_id.
  const like = `%${JSON.stringify(nodeId).slice(1, -1)}%`;
  const rows = db.prepare(
    "SELECT signal_id, proposed_nodes, reviewed_at, created_at FROM intake_queue WHERE status = 'approved' AND proposed_nodes LIKE ?"
  ).all(like) as any[];
  for (const row of rows) {
    const ops = parse(row.proposed_nodes);
    if (!Array.isArray(ops)) continue;
    for (const op of ops) {
      if (op?.node_id !== nodeId || (op.op !== "patch_node" && op.op !== "attach_image")) continue;
      const sid = op.signal_id ?? row.signal_id;
      const key = `${sid}|${op.op}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sig = signal(sid);
      const prior = priorOf(sig, op.op);
      const set: Record<string, unknown> = op.op === "patch_node"
        ? (op.metadata && typeof op.metadata === "object" ? op.metadata : {})
        : { cdn_image_url: op.cdn_image_url, image_url: op.image_url, image_sha256: op.sha256 };
      raws.push({
        at: prior?.at ?? row.reviewed_at ?? row.created_at ?? null,
        op: op.op,
        keys: prior?.before ? Object.keys(prior.before) : Object.keys(set),
        set,
        prior,
        sig,
      });
    }
  }

  // (b) writes recorded only on a signal's trace (admin retire, image shrink).
  const traced = db.prepare("SELECT id FROM signals WHERE processing_trace LIKE ?").all(like) as any[];
  for (const { id } of traced) {
    const sig = signal(id);
    const prior = parse(sig?.processing_trace)?.prior;
    if (!Array.isArray(prior)) continue;
    for (const p of prior) {
      if (p?.node_id !== nodeId) continue;
      const key = `${id}|${p.op}`;
      if (seen.has(key)) continue;
      seen.add(key);
      raws.push({ at: p.at ?? null, op: p.op, keys: Object.keys(p.before ?? {}), set: null, prior: p, sig });
    }
  }

  // Oldest first to chain before → after per key; the next write's `before`
  // is this write's `after`, the last one's is the current value.
  raws.sort((a, b) => at(a).localeCompare(at(b)) || Number(a.sig?.seq ?? 0) - Number(b.sig?.seq ?? 0));
  const metaEvents: HistoryEvent[] = raws.map((r, i) => {
    const changes = r.keys.map((key) => {
      const next = raws.slice(i + 1).find((n) => n.keys.includes(key));
      const after = !next
        ? (r.op === "rename_slug" && key === "slug" ? node.slug : current[key]) // last write to this key: what it holds now
        : next.prior?.before
          ? next.prior.before[key] // what the next write replaced
          : r.set?.[key]; // next write predates before-images: what this one set
      return { key, before: r.prior?.before ? r.prior.before[key] ?? null : null, after: after ?? null };
    });
    const ev: HistoryEvent = {
      kind: "metadata",
      at: r.at,
      op: r.op,
      changes,
      before_recorded: !!r.prior?.before,
      by: sourceOf(r.sig)?.by ?? null,
      source: sourceOf(r.sig),
    };
    seqOf.set(ev, Number(r.sig?.seq ?? 0));
    return ev;
  });

  // ---- relations -----------------------------------------------------------
  const edges = db.prepare(
    `SELECT e.id, e.source_id, e.target_id, e.edge_type, e.signal_id, e.created_by, e.event_time,
            e.valid_from, e.valid_until, e.invalidated_by,
            o.name AS other_name, o.type AS other_type, o.slug AS other_slug
       FROM edges e
       LEFT JOIN nodes o ON o.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
      WHERE (e.source_id = ? OR e.target_id = ?) AND (e.created_by IS NULL OR e.created_by != ?)`
  ).all(nodeId, nodeId, nodeId, DERIVED_CREATED_BY) as any[];
  const relEvents: HistoryEvent[] = [];
  for (const e of edges) {
    const out = e.source_id === nodeId;
    const otherId = out ? e.target_id : e.source_id;
    const base = {
      kind: "relation" as const,
      edge_id: e.id,
      edge_type: e.edge_type,
      direction: out ? ("out" as const) : ("in" as const),
      other: { id: otherId, name: e.other_name ?? null, type: e.other_type ?? null, slug: e.other_slug ?? null },
      event_time: e.event_time ?? null,
      invalidated_by: e.invalidated_by ?? null,
    };
    const addSig = signal(e.signal_id);
    const src = sourceOf(addSig);
    // With a signal, its consent decides who is shown (an anonymous one hides
    // the name that edges.created_by may also carry); without one, the edge's
    // own created_by is all there is.
    const added: HistoryEvent = { ...base, change: "added", at: e.valid_from ?? null, by: src ? src.by : e.created_by ?? null, source: src };
    seqOf.set(added, Number(addSig?.seq ?? 0));
    relEvents.push(added);
    if (e.valid_until) {
      // Ended by a signal (admin correction, a later read) or by the edge
      // that superseded it — credit whichever it was.
      let endSig = signal(e.invalidated_by);
      let endBy: string | null = null;
      if (!endSig && e.invalidated_by) {
        const sup = db.prepare("SELECT signal_id, created_by FROM edges WHERE id = ?").get(e.invalidated_by) as any;
        endSig = signal(sup?.signal_id);
        endBy = sup?.created_by ?? null;
      }
      const endSrc = sourceOf(endSig);
      const ended: HistoryEvent = { ...base, change: "ended", at: e.valid_until, by: endSrc ? endSrc.by : endBy, source: endSrc };
      seqOf.set(ended, Number(endSig?.seq ?? 0));
      relEvents.push(ended);
    }
  }

  // ---- the subject's notes ------------------------------------------------------
  const noteRows = db.prepare(
    `SELECT signal_id, kind, state, note, source_id, edge_type, target_id, meta_key, resolution, resolved_at, created_at
       FROM relation_notes
      WHERE kind IN ('contest','context') AND state NOT IN ('pending','rejected')
        AND (source_id = ? OR target_id = ? OR (meta_key IS NOT NULL AND node_id = ?))`
  ).all(nodeId, nodeId, nodeId) as any[];
  const noteEvents: HistoryEvent[] = noteRows.map((r) => {
    const sig = signal(r.signal_id);
    const src = sourceOf(sig);
    const ev: HistoryEvent = {
      kind: "note",
      at: r.created_at ?? null,
      note_kind: r.kind,
      state: r.state,
      note: sig?.consent_scope === "structural_only" ? "" : r.note,
      relation: r.source_id ? { source_id: r.source_id, edge_type: r.edge_type, target_id: r.target_id } : null,
      meta_key: r.meta_key ?? null,
      resolution: r.resolution ?? null,
      resolved_at: r.resolved_at ?? null,
      by: src?.by ?? null,
      source: src,
    };
    seqOf.set(ev, Number(sig?.seq ?? 0));
    return ev;
  });

  const events = [...metaEvents, ...relEvents, ...noteEvents].sort((a, b) => at(b).localeCompare(at(a)) || (seqOf.get(b) ?? 0) - (seqOf.get(a) ?? 0));
  return {
    node: { id: node.id, name: node.name, type: node.type, slug: node.slug, created_at: node.created_at ?? null },
    events,
  };
}
