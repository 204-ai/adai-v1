// Claims core (docs/CLAIM-SPEC.md): the approval rule, the public face
// (metadata.claimed + before-image), handles, contests / context notes /
// objections and their curator resolution, peer invites.

import { priorsOf } from "../src/utils/signal-private.js";
import { it } from "node:test";
import assert from "node:assert/strict";
import { freshDb, insertNode } from "./helpers.js";
import { ensureContributorForEmail } from "../src/intake/auth.js";
import {
  requestClaim, approveClaim, rejectClaim, endClaim, backfillInviteClaims, setHandle, resolveHandle,
  handleAvailability, normaliseHandle, contributorById, ClaimError, suggestHandle,
} from "../src/claim/store.js";
import { fileNote, checkInvite, recordPeerInviteClaim, publicNotesFor, withdrawNote, invitesLeft } from "../src/claim/notes.js";
import { approveIntakeItem, rejectIntakeItem } from "../src/utils/review.js";

function edge(db: any, s: string, t: string, type: string, by = "test") {
  db.prepare(
    `INSERT INTO edges (id, source_id, target_id, edge_type, created_by, valid_from) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
  ).run(`${s}--${type}--${t}--${by}`, s, t, type, by);
}

function person(db: any, email: string, name: string, extra: Record<string, unknown> = {}) {
  const c = ensureContributorForEmail(db, { email, name, invite: true, ...extra });
  return contributorById(db, c.id)!;
}

const meta = (db: any, id: string) => JSON.parse((db.prepare("SELECT metadata FROM nodes WHERE id = ?").get(id) as any).metadata ?? "{}");
const liveEdges = (db: any, s: string, type: string, t: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM edges WHERE source_id = ? AND edge_type = ? AND target_id = ? AND valid_until IS NULL").get(s, type, t) as any).n;

it("an invite naming the node is instant; anything else queues for a curator", () => {
  const db = freshDb();
  insertNode(db, "practitioner:ada", "practitioner", "Ada");
  insertNode(db, "practitioner:bob", "practitioner", "Bob");
  insertNode(db, "artwork:w", "artwork", "W");
  const ada = person(db, "ada@ada.art", "Ada L", { self_node_id: "practitioner:ada" });
  const eve = person(db, "eve@x.org", "Eve");

  // backfill turns the invite into an approved claim, once
  assert.equal(backfillInviteClaims(db), 1);
  assert.equal(backfillInviteClaims(db), 0);
  const m = meta(db, "practitioner:ada");
  assert.deepEqual(m.claimed.by, ["Ada L"]);

  // the before-image of that write is on the claim signal
  const sig = db.prepare("SELECT id, processing_trace, source_type FROM signals WHERE source_type = 'claim'").get() as any;
  assert.deepEqual(priorsOf(db, sig.id)[0].before, { claimed: null });
  assert.equal(JSON.parse(sig.processing_trace).prior[0].before, undefined, "not in the CRR");

  // a request on someone else's page queues
  const r = requestClaim(db, { contributor: eve, node_id: "practitioner:bob", evidence: "I am Bob's alt", handle: "bob" });
  assert.equal(r.claim.status, "pending");
  const q = db.prepare("SELECT kind, status, target_node FROM intake_queue WHERE id = ?").get(r.claim.queue_id) as any;
  assert.deepEqual({ ...q }, { kind: "claim", status: "pending", target_node: "practitioner:bob" });
  // idempotent while pending
  assert.equal(requestClaim(db, { contributor: eve, node_id: "practitioner:bob" }).created, false);

  // artworks are not claimable
  assert.throws(() => requestClaim(db, { contributor: eve, node_id: "artwork:w" }), (e: any) => e instanceof ClaimError && e.code === "not_claimable");

  // the curator approves through the shared review path; the requested handle lands
  assert.deepEqual(approveIntakeItem(db, r.claim.queue_id!, "Curator"), { ok: true, intake_id: r.claim.queue_id });
  assert.equal(meta(db, "practitioner:bob").claimed.handle, "bob");
  assert.equal(resolveHandle(db, "@Bob")!.id, "practitioner:bob");
  assert.equal((db.prepare("SELECT status FROM intake_queue WHERE id = ?").get(r.claim.queue_id) as any).status, "approved");
});

it("a second claim on a claimed practitioner waits, even with an invite", () => {
  const db = freshDb();
  insertNode(db, "practitioner:ada", "practitioner", "Ada");
  const a = person(db, "a@x.org", "A", { self_node_id: "practitioner:ada" });
  backfillInviteClaims(db);
  const b = person(db, "b@x.org", "B", { self_node_id: "practitioner:ada" });
  const r = requestClaim(db, { contributor: b, node_id: "practitioner:ada" });
  assert.equal(r.claim.status, "pending");
  assert.deepEqual(r.conflicts_with, [a.id]);
  rejectClaim(db, r.claim.id, { by: "Curator", reason: "not them" });
  assert.equal((db.prepare("SELECT status FROM intake_queue WHERE id = ?").get(r.claim.queue_id) as any).status, "rejected");
});

it("collectives take several claimants; ending one rewrites the badge with its before-image", () => {
  const db = freshDb();
  insertNode(db, "collective:k", "collective", "K");
  const a = person(db, "a@x.org", "A", { self_node_id: "collective:k" });
  const b = person(db, "b@x.org", "B", { self_node_id: "collective:k" });
  backfillInviteClaims(db);
  assert.deepEqual(meta(db, "collective:k").claimed.by, ["A", "B"]);
  const bc = db.prepare("SELECT id FROM node_claims WHERE contributor_id = ?").get(b.id) as any;
  assert.throws(() => endClaim(db, bc.id, { actor: a, mode: "withdrawn" }), /only the claimant/);
  endClaim(db, bc.id, { actor: b, mode: "withdrawn" });
  assert.deepEqual(meta(db, "collective:k").claimed.by, ["A"]);
  const ac = db.prepare("SELECT id FROM node_claims WHERE contributor_id = ?").get(a.id) as any;
  endClaim(db, ac.id, { actor: b, mode: "revoked", reason: "test" });
  assert.equal(meta(db, "collective:k").claimed, undefined);
  const last = db.prepare("SELECT id, source_type FROM signals WHERE source_type = 'api_admin'").get() as any;
  assert.deepEqual((priorsOf(db, last.id)[0].before as any).claimed.by, ["A"]);
});

it("handles: format, reserved, unique, one change per 30 days, old ones still resolve", () => {
  const db = freshDb();
  insertNode(db, "practitioner:ada", "practitioner", "Ada");
  insertNode(db, "practitioner:bob", "practitioner", "Bob");
  const ada = person(db, "a@x.org", "A", { self_node_id: "practitioner:ada" });
  const bob = person(db, "b@x.org", "B", { self_node_id: "practitioner:bob" });
  backfillInviteClaims(db);
  assert.equal(normaliseHandle("@Ada.L"), "ada.l");
  assert.equal(normaliseHandle("a"), null);
  assert.equal(normaliseHandle("-ada"), null);
  assert.equal(handleAvailability(db, "review").ok, false);
  assert.equal(suggestHandle(db, "practitioner:ada"), "ada");
  setHandle(db, { contributor: ada, node_id: "practitioner:ada", handle: "ada" });
  assert.throws(() => setHandle(db, { contributor: bob, node_id: "practitioner:bob", handle: "ada" }), /taken/);
  assert.throws(() => setHandle(db, { contributor: bob, node_id: "practitioner:ada", handle: "x-ada" }), /approved claimant/);
  assert.throws(() => setHandle(db, { contributor: ada, node_id: "practitioner:ada", handle: "ada2" }), /30 days/);
  // pretend a month passed
  const m = meta(db, "practitioner:ada");
  m.claimed.handle_set_at = "2020-01-01T00:00:00Z";
  db.prepare("UPDATE nodes SET metadata = ? WHERE id = ?").run(JSON.stringify(m), "practitioner:ada");
  setHandle(db, { contributor: ada, node_id: "practitioner:ada", handle: "ada2" });
  assert.equal(resolveHandle(db, "ada")!.id, "practitioner:ada");
  assert.equal(resolveHandle(db, "ada2")!.id, "practitioner:ada");
  assert.equal(meta(db, "practitioner:ada").claimed.handle, "ada2");
  // a released handle stays with its node
  assert.throws(() => setHandle(db, { contributor: bob, node_id: "practitioner:bob", handle: "ada" }), /taken/);
});

it("contest: public at once, upheld ends the relation (all sources), dismissed lifts the mark", () => {
  const db = freshDb();
  insertNode(db, "practitioner:ada", "practitioner", "Ada");
  insertNode(db, "institution:g", "institution", "G");
  insertNode(db, "institution:h", "institution", "H");
  edge(db, "institution:g", "practitioner:ada", "REPRESENTS", "a");
  edge(db, "institution:g", "practitioner:ada", "REPRESENTS", "b");
  edge(db, "institution:h", "practitioner:ada", "REPRESENTS");
  const ada = person(db, "a@x.org", "A", { self_node_id: "practitioner:ada" });
  backfillInviteClaims(db);

  assert.throws(() => fileNote(db, { contributor: ada, kind: "contest", node_id: "practitioner:ada", note: "", relation: { source_id: "institution:g", edge_type: "REPRESENTS", target_id: "practitioner:ada" } }), /say why/);
  const c = fileNote(db, { contributor: ada, kind: "contest", node_id: "practitioner:ada", note: "Never represented me", relation: { source_id: "institution:g", edge_type: "REPRESENTS", target_id: "practitioner:ada" } });
  assert.equal(c.state, "open");
  assert.equal(publicNotesFor(db, "practitioner:ada").length, 1);
  assert.equal(publicNotesFor(db, "institution:g").length, 1, "both ends see it");
  assert.throws(() => fileNote(db, { contributor: ada, kind: "contest", node_id: "practitioner:ada", note: "again", relation: { source_id: "institution:g", edge_type: "REPRESENTS", target_id: "practitioner:ada" } }), /already contest/);

  assert.equal(approveIntakeItem(db, c.queue_id!, "Curator").ok, true);
  assert.equal(liveEdges(db, "institution:g", "REPRESENTS", "practitioner:ada"), 0, "every claim row of the relation ended");
  assert.equal(publicNotesFor(db, "practitioner:ada").length, 0);
  const ended = db.prepare("SELECT invalidated_by FROM edges WHERE source_id = 'institution:g'").all() as any[];
  const anchor = db.prepare("SELECT source_type FROM signals WHERE id = ?").get(ended[0].invalidated_by) as any;
  assert.equal(anchor.source_type, "api_admin");

  const d = fileNote(db, { contributor: ada, kind: "contest", node_id: "practitioner:ada", note: "Left in 2020", relation: { source_id: "institution:h", edge_type: "REPRESENTS", target_id: "practitioner:ada" } });
  assert.equal(rejectIntakeItem(db, d.queue_id!, "the gallery's site still lists them", "Curator").ok, true);
  assert.equal(liveEdges(db, "institution:h", "REPRESENTS", "practitioner:ada"), 1);
  assert.equal(publicNotesFor(db, "practitioner:ada").length, 0);

  // not your page: refused
  const eve = person(db, "e@x.org", "E");
  assert.throws(() => fileNote(db, { contributor: eve, kind: "contest", node_id: "practitioner:ada", note: "x", relation: { source_id: "institution:h", edge_type: "REPRESENTS", target_id: "practitioner:ada" } }), /claimed/);
});

it("contest on a metadata edit: upheld restores the before-image", () => {
  const db = freshDb();
  insertNode(db, "practitioner:ada", "practitioner", "Ada", { born: 1980 });
  const ada = person(db, "a@x.org", "A", { self_node_id: "practitioner:ada" });
  backfillInviteClaims(db);
  // someone else's patch, with its before-image
  const sig = "signal-edit";
  db.prepare("INSERT INTO signals (id, title, submitted_by, processing_trace) VALUES (?, 't', 'X', ?)").run(sig, JSON.stringify({ prior: [{ op: "patch_node", node_id: "practitioner:ada", before: { born: 1980 } }] }));
  const m = meta(db, "practitioner:ada"); m.born = 1890;
  db.prepare("UPDATE nodes SET metadata = ? WHERE id = ?").run(JSON.stringify(m), "practitioner:ada");
  const c = fileNote(db, { contributor: ada, kind: "contest", node_id: "practitioner:ada", note: "Wrong year", edit: { key: "born", signal_id: sig } });
  approveIntakeItem(db, c.queue_id!, "Curator");
  assert.equal(meta(db, "practitioner:ada").born, 1980);
});

it("context notes follow the tier; objections settle with their item", () => {
  const db = freshDb();
  insertNode(db, "practitioner:ada", "practitioner", "Ada");
  insertNode(db, "practitioner:bob", "practitioner", "Bob");
  insertNode(db, "institution:g", "institution", "G");
  edge(db, "practitioner:ada", "practitioner:bob", "COLLABORATES_WITH");
  const ada = person(db, "a@x.org", "A", { self_node_id: "practitioner:ada" });
  const bob = person(db, "b@x.org", "B", { self_node_id: "practitioner:bob", tier: "reviewed" });
  backfillInviteClaims(db);
  const rel = { source_id: "practitioner:ada", edge_type: "COLLABORATES_WITH", target_id: "practitioner:bob" };

  const pending = fileNote(db, { contributor: ada, kind: "context", node_id: "practitioner:ada", note: "Two shows, 2019–21", relation: rel });
  assert.equal(pending.state, "pending");
  const live = fileNote(db, { contributor: bob, kind: "context", node_id: "practitioner:bob", note: "A shared studio", relation: rel });
  assert.equal(live.state, "live");
  assert.deepEqual(publicNotesFor(db, "practitioner:ada").map((n) => n.note), ["A shared studio"]);
  approveIntakeItem(db, pending.queue_id!, "Curator");
  assert.equal(publicNotesFor(db, "practitioner:ada").length, 2);
  withdrawNote(db, live.signal_id, bob.id);
  assert.equal(publicNotesFor(db, "practitioner:ada").length, 1);

  // an objection to a pending proposal about Ada
  db.prepare("INSERT INTO intake_queue (id, target_node, submitted_by, trust_tier, status, kind, proposed_edges) VALUES ('q1', 'institution:g', 'X', 'probationary', 'pending', 'human_signal', ?)")
    .run(JSON.stringify([{ source_id: "institution:g", edge_type: "REPRESENTS", target_id: "practitioner:ada" }]));
  db.prepare("INSERT INTO intake_queue (id, target_node, submitted_by, trust_tier, status, kind) VALUES ('q2', 'institution:g', 'X', 'probationary', 'pending', 'human_signal')").run();
  assert.throws(() => fileNote(db, { contributor: ada, kind: "objection", node_id: "practitioner:ada", note: "no", queue_id: "q2" }), /not about your page/);
  const o = fileNote(db, { contributor: ada, kind: "objection", node_id: "practitioner:ada", note: "Not represented there", queue_id: "q1" });
  rejectIntakeItem(db, "q1", "subject objected", "Curator");
  assert.equal((db.prepare("SELECT state FROM relation_notes WHERE signal_id = ?").get(o.signal_id) as any).state, "upheld");
});

it("peer invite: one live hop from a claimed page, unclaimed, instant, rate-limited", () => {
  const db = freshDb();
  insertNode(db, "practitioner:ada", "practitioner", "Ada");
  insertNode(db, "practitioner:bob", "practitioner", "Bob");
  insertNode(db, "practitioner:far", "practitioner", "Far");
  insertNode(db, "artwork:w", "artwork", "W");
  edge(db, "practitioner:ada", "practitioner:bob", "COLLABORATES_WITH");
  edge(db, "artwork:w", "practitioner:ada", "CREATED_BY");
  const ada = person(db, "a@x.org", "A", { self_node_id: "practitioner:ada" });
  backfillInviteClaims(db);
  assert.throws(() => checkInvite(db, ada.id, "practitioner:far"), /other end of a relation/);
  assert.throws(() => checkInvite(db, ada.id, "artwork:w"), /people, collectives and institutions/);
  assert.deepEqual(checkInvite(db, ada.id, "practitioner:bob"), { from_node: "practitioner:ada", edge_type: "COLLABORATES_WITH" });
  const bob = person(db, "b@x.org", "B");
  const c = recordPeerInviteClaim(db, { inviter: ada, invitee_id: bob.id, node_id: "practitioner:bob" });
  assert.equal(c.status, "approved");
  assert.equal(c.invited_by, ada.id);
  assert.equal(invitesLeft(db, ada.id), 9);
  assert.throws(() => checkInvite(db, ada.id, "practitioner:bob"), /already claimed/);
});
