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
import { embedNodesAsync } from "../embed/server.js";
import { ClaimError, approveClaim, claimByQueueId, rejectClaim } from "../claim/store.js";
import { isFormShaped, recordFormSignal, signalOwner } from "./authorship.js";
import { ensureAnonymousContributor, isAnonymousSignal, nameHeldBack, publishQueued, rejectedSignals, withholdSignal } from "./signal-private.js";
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
    } else if (item.kind === "context" || item.kind === "reading") {
      // a reading (any contributor's, #80 part 3) passes the same gate as context
      if (action === "approve") approveContext(db, item.id, { by });
      else rejectContext(db, item.id, { by, reason: reason ?? "rejected" });
    }
  } catch (e) {
    if (e instanceof ClaimError) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
  return { ok: true, intake_id: item.id };
}

export const CLAIM_KINDS = ["claim", "contest", "context", "reading"];

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

  // All or nothing: one item may be a whole package (up to a hundred nodes and
  // their edges). A failure part-way rolls every write back and the item stays
  // pending, instead of leaving half of it live. A savepoint, so a caller that
  // already holds a transaction nests. Embeds run only after it is kept.
  const toEmbed = new Set<string>();
  db.exec("SAVEPOINT approve_item");
  let outcome: ReviewOutcome;
  try {
    outcome = approvePending(db, id, item, reviewedBy, toEmbed);
    db.exec("RELEASE approve_item");
  } catch (e) {
    try { db.exec("ROLLBACK TO approve_item"); db.exec("RELEASE approve_item"); } catch { /* already gone */ }
    throw e;
  }
  // Same fire-and-forget contract as the auto-merge path in contributor-api.ts
  // (one at a time); failures fall through to the daily backfill.
  embedNodesAsync(db, toEmbed);
  contributionWritten(); // what was in review is live now (issue #81)
  return outcome;
}

function approvePending(db: DatabaseSync, id: string, item: any, reviewedBy: string, touchedNodes: Set<string>): ReviewOutcome {
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
    const dedupedTo = new Map<string, string>(); // create id → existing node id
    if (item.proposed_nodes) {
      let ops: any[] = [];
      try { ops = JSON.parse(item.proposed_nodes); } catch { ops = []; }
      for (const op of ops) {
        if (op?.op === "create_node") {
          const result = materialiseCreateNode(db, op, { signalId: item.signal_id, createdBy });
          // Use the materialised id so a slug normalisation upstream doesn't
          // desync the embed call from the actual row written.
          if (result.node_id) touchedNodes.add(result.node_id);
          // Deduped onto an existing node at the same (type, slug): what the
          // queued item says about the create id is about that node.
          if (result.deduped_from) dedupedTo.set(result.deduped_from, result.node_id);
        } else if (op?.op === "patch_node") {
          if (op.node_id && dedupedTo.has(op.node_id)) op.node_id = dedupedTo.get(op.node_id);
          materialisePatchNode(db, op, { createdBy, signalId: op.signal_id ?? item.signal_id });
          if (op.node_id) touchedNodes.add(op.node_id);
        } else if (op?.op === "attach_image") {
          if (op.node_id && dedupedTo.has(op.node_id)) op.node_id = dedupedTo.get(op.node_id);
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
        const ends = { source_id: dedupedTo.get(e.source_id) ?? e.source_id, target_id: dedupedTo.get(e.target_id) ?? e.target_id };
        materialiseEdge(db, { ...e, ...ends, signal_id: signalId }, { signalId, createdBy });
      }
    }
  }

  db.prepare(
    "UPDATE intake_queue SET status = 'approved', reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(reviewedBy, id);
  // What was in review is published: its words go into the CRR now — and,
  // for the public form, the contributor row under the typed name.
  const heldName = nameHeldBack(db, item.signal_id);
  const form = isFormShaped(db, item.signal_id);
  if (item.kind === "human_signal") publishQueued(db, id);

  // Counters. An anonymous contribution counts on the anonymous sentinel. A
  // public-form one (no authenticated author: the typed name proves nothing)
  // gets a contributor row of its own — a fresh id, type 'form', the typed
  // name as its display name — and never counts on an existing row, which
  // may be someone else's account. Anything else counts on exactly the row
  // the signal provably belongs to (signalOwner: its authenticated author,
  // or a legacy write whose name / id is unambiguous) — or on nobody.
  if (isAnonymousSignal(db, item.signal_id)) {
    db.prepare("UPDATE contributors SET approved_count = approved_count + 1 WHERE id = ?").run(ensureAnonymousContributor(db));
  } else if (form || heldName) {
    if (item.submitted_by) {
      const formId = `contributor:form-${crypto.randomBytes(8).toString("hex")}`;
      db.prepare("INSERT INTO contributors (id, name, type, trust_tier, contributions, approved_count) VALUES (?, ?, 'form', 'probationary', 1, 1)")
        .run(formId, item.submitted_by);
      if (item.signal_id) recordFormSignal(db, item.signal_id, formId); // this signal is that row's, and only it
    }
  } else {
    const owner = signalOwner(db, item.signal_id);
    if (owner) db.prepare("UPDATE contributors SET approved_count = approved_count + 1 WHERE id = ?").run(owner.id);
  }
  settleObjections(db, id, "approved", reviewedBy);

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
  // A rejected contribution was never published: its words leave the CRR.
  for (const sid of rejectedSignals(db, id)) withholdSignal(db, sid, "rejected");
  settleObjections(db, id, "rejected", reviewedBy);

  return { ok: true, intake_id: id };
}
