// Shared curator review actions — approve / reject an intake_queue item.
//
// Used by BOTH the legacy web curator UI (src/routes/api.ts → POST
// /api/review/:id/approve|reject, HTML responses for htmx) and the admin
// contributor API (src/routes/contributor-api.ts → /api/v1/review/*, JSON
// responses). Centralised here so the two paths can't drift — same pattern
// as src/utils/token-mint.ts.
//
// The materialisation logic moved here verbatim from src/routes/api.ts
// (June 2026): ai_suggestion rows materialise their proposed edges,
// human_signal rows replay the discriminated proposed_nodes ops
// (create_node / patch_node / attach_image) plus proposed_edges (with
// bi-temporal supersession), then the intake row flips to approved and the
// contributor's approved_count bumps. Rejection records ai_suggestion pairs
// in rejected_ai_suggestions so the nightly derive won't re-propose them.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contributionWritten } from "../notify/kick.js";
import {
  materialiseCreateNode,
  materialisePatchNode,
  materialiseAttachImage,
  materialiseEndEdge,
  materialiseEdge,
} from "./contribution.js";
import { embedNodeAsync } from "../embed/server.js";
import { ClaimError, approveClaim, claimByQueueId, rejectClaim } from "../claim/store.js";
import { approveContext, dismissContest, rejectContext, settleObjections, upholdContest } from "../claim/notes.js";

// Claims and a subject's notes (docs/CLAIM-SPEC.md) settle through their
// own code: approve = approve the claim / uphold the contest / publish the
// context note; reject = reject / dismiss / reject.
function reviewClaimKind(
  db: DatabaseSync,
  item: { id: string; kind: string },
  action: "approve" | "reject",
  by: string,
  reason: string | null
): ReviewOutcome {
  try {
    if (item.kind === "claim") {
      const c = claimByQueueId(db, item.id);
      if (!c) return { ok: false, status: 404, error: "claim not found for this item" };
      if (action === "approve") approveClaim(db, c.id, { by });
      else rejectClaim(db, c.id, { by, reason: reason ?? "rejected" });
    } else if (item.kind === "contest") {
      if (action === "approve") upholdContest(db, item.id, { by, reason });
      else dismissContest(db, item.id, { by, reason: reason ?? "dismissed" });
    } else if (item.kind === "context") {
      if (action === "approve") approveContext(db, item.id, { by });
      else rejectContext(db, item.id, { by, reason: reason ?? "rejected" });
    }
  } catch (e) {
    if (e instanceof ClaimError) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
  return { ok: true, intake_id: item.id };
}

export const CLAIM_KINDS = ["claim", "contest", "context"];

const sha256Hex = (s: string): string =>
  crypto.createHash("sha256").update(s).digest("hex");

export type ReviewOutcome =
  | { ok: true; intake_id: string }
  | { ok: false; status: number; error: string };

export function approveIntakeItem(
  db: DatabaseSync,
  id: string,
  reviewedBy = "curator"
): ReviewOutcome {
  const item = db
    .prepare(
      "SELECT id, signal_id, target_node, submitted_by, kind, proposed_edges, proposed_nodes FROM intake_queue WHERE id = ? AND status = 'pending'"
    )
    .get(id) as any;

  if (!item) {
    return { ok: false, status: 404, error: "not found or already reviewed" };
  }
  if (CLAIM_KINDS.includes(item.kind)) return reviewClaimKind(db, item, "approve", reviewedBy, null);

  // For AI-suggestion items, materialise the proposed edge into the live
  // graph. The `proposed_edges` column carries a JSON array of edge specs
  // produced by the embedding derive pass.
  if (item.kind === "ai_suggestion" && item.proposed_edges) {
    let proposals: Array<{ source_id: string; target_id: string; edge_type: string; similarity?: number }> = [];
    try {
      proposals = JSON.parse(item.proposed_edges);
    } catch {
      return { ok: false, status: 500, error: "proposed_edges is not valid JSON" };
    }
    const insertEdge = db.prepare(
      `INSERT INTO edges (
         id, source_id, target_id, edge_type, signal_id,
         confidence, charge, created_at, created_by,
         event_time, valid_from, valid_until, invalidated_by
       ) VALUES (?, ?, ?, ?, ?, 'medium', NULL,
                 strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'curator-from-ai-suggestion',
                 NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'), NULL, NULL)`
    );
    for (const p of proposals) {
      const edgeId = `${p.source_id}--${p.edge_type}--${p.target_id}--curator-from-ai-suggestion`;
      insertEdge.run(edgeId, p.source_id, p.target_id, p.edge_type, item.signal_id);
    }
  }

  // For human_signal items submitted via /api/v1/*, materialise the queued
  // payload. Shape matches the helpers in src/utils/contribution.ts —
  // proposed_nodes is a discriminated array (create_node / patch_node /
  // attach_image), proposed_edges is a flat list of edge specs (may carry
  // supersedes_edge_id for bi-temporal supersession).
  if (item.kind === "human_signal") {
    const createdBy = `curator-from-${item.submitted_by ?? "api"}`;
    const touchedNodes = new Set<string>();
    if (item.proposed_nodes) {
      let ops: any[] = [];
      try { ops = JSON.parse(item.proposed_nodes); } catch { ops = []; }
      for (const op of ops) {
        if (op?.op === "create_node") {
          const result = materialiseCreateNode(db, op, { signalId: item.signal_id, createdBy });
          // Use the materialised id so a slug normalisation upstream doesn't
          // desync the embed call from the actual row written.
          if (result.node_id) touchedNodes.add(result.node_id);
        } else if (op?.op === "patch_node") {
          materialisePatchNode(db, op, { createdBy, signalId: op.signal_id ?? item.signal_id });
          if (op.node_id) touchedNodes.add(op.node_id);
        } else if (op?.op === "attach_image") {
          materialiseAttachImage(db, op, { createdBy, signalId: op.signal_id ?? item.signal_id });
          if (op.node_id) touchedNodes.add(op.node_id);
        } else if (op?.op === "end_edge" && op.edge_id) {
          materialiseEndEdge(db, op, { signalId: op.signal_id ?? item.signal_id });
        }
      }
    }
    if (item.proposed_edges) {
      let edges: any[] = [];
      try { edges = JSON.parse(item.proposed_edges); } catch { edges = []; }
      for (const e of edges) {
        // URL-intake batches carry an individual evidence signal for each edge.
        const signalId = e.signal_id ?? item.signal_id;
        materialiseEdge(db, { ...e, signal_id: signalId }, { signalId, createdBy });
      }
    }
    // Embed any nodes just materialised. Same fire-and-forget contract as
    // the auto-merge path in contributor-api.ts — failures fall through to
    // the daily backfill.
    for (const nodeId of touchedNodes) embedNodeAsync(db, nodeId);
  }

  db.prepare(
    "UPDATE intake_queue SET status = 'approved', reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(reviewedBy, id);

  db.prepare("UPDATE contributors SET approved_count = approved_count + 1 WHERE name = ?").run(item.submitted_by);
  settleObjections(db, id, "approved", reviewedBy);
  contributionWritten(); // what was in review is live now (issue #81)

  return { ok: true, intake_id: id };
}

export function rejectIntakeItem(
  db: DatabaseSync,
  id: string,
  reason: string,
  reviewedBy = "curator"
): ReviewOutcome {
  const item = db
    .prepare(
      "SELECT id, kind, proposed_edges FROM intake_queue WHERE id = ? AND status = 'pending'"
    )
    .get(id) as any;
  if (!item) {
    return { ok: false, status: 404, error: "not found or already reviewed" };
  }
  if (CLAIM_KINDS.includes(item.kind)) return reviewClaimKind(db, item, "reject", reviewedBy, reason);

  // For AI suggestions, record the rejected pair in rejected_ai_suggestions
  // so the next derive pass won't re-propose it. Hash is sha256(source||
  // type||target) — same convention as src/embed/derive.ts.
  if (item.kind === "ai_suggestion" && item.proposed_edges) {
    let proposals: Array<{ source_id: string; target_id: string; edge_type: string }> = [];
    try {
      proposals = JSON.parse(item.proposed_edges);
    } catch {
      proposals = [];
    }
    const insertRej = db.prepare(
      `INSERT OR REPLACE INTO rejected_ai_suggestions
         (pair_hash, source_id, target_id, edge_type, reason)
         VALUES (?, ?, ?, ?, ?)`
    );
    for (const p of proposals) {
      const h = sha256Hex(`${p.source_id}|${p.edge_type}|${p.target_id}`);
      insertRej.run(h, p.source_id, p.target_id, p.edge_type, reason);
    }
  }

  db.prepare(
    "UPDATE intake_queue SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(reason, reviewedBy, id);
  settleObjections(db, id, "rejected", reviewedBy);

  return { ok: true, intake_id: id };
}
