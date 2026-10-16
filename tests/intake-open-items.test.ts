// Left-open items (issue #77): what a contributor does not decide stays open
// at Confirm; another contributor picks it up into a draft of their own and
// decides it under their own name, the first proposer kept in provenance.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { freshDb, insertNode } from "./helpers.js";
import { createDraft, claimJob, finishPass, getDraft, runDraftTool, contributorPatchCandidate, confirmDraft, createPickupDraft, batchReceipt } from "../src/intake/draft.js";
import { leftOpen, listOpenReads, openItemsOf } from "../src/intake/open-items.js";
import { approveIntakeItem } from "../src/utils/review.js";
import { validateCandidate, type Candidate } from "../src/intake/candidate.js";
import type { AuthedContributor } from "../src/auth.js";

process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

function contributor(db: ReturnType<typeof freshDb>, name: string, tier: string): AuthedContributor {
  const id = `contributor:${name.toLowerCase()}`;
  db.prepare("INSERT INTO contributors (id, name, type, trust_tier, contributions, approved_count) VALUES (?, ?, 'human', ?, 0, 0)").run(id, name, tier);
  return { id, name, trust_tier: tier, token_label: null, token_prefix: "t", scope: "write" };
}

const mirror = async (url: string) => ({
  upload: { key: "images/ab/abcd.jpg", url: "https://cdn.example/images/ab/abcd.jpg", sha256: "abcd", bytes: 10, content_type: "image/jpeg", already_existed: false },
  mime: "image/jpeg", source_url: url, final_url: url,
});

const pg = { page_url: "https://teh.example/", quote: "Works by Kim: ZOOM, monogrid, Colors of Noise" };

/** Kim's site, read by EV3: one work accepted, two works and their relations undecided. */
function scottsRead(db: ReturnType<typeof freshDb>, ev3: AuthedContributor) {
  insertNode(db, "practitioner:kim", "practitioner", "Kim");
  const d = createDraft(db, ev3.id, "https://teh.example/");
  claimJob(db, "w1");
  const W = "w1";
  runDraftTool(db, d.id, W, "propose_node", { type: "artwork", name: "ZOOM", ...pg }); // c_01 accepted
  runDraftTool(db, d.id, W, "propose_edge", { source: "cid:c_01", target: "practitioner:kim", edge_type: "CREATED_BY", confidence: "high", ...pg }); // c_02 accepted
  runDraftTool(db, d.id, W, "propose_node", { type: "artwork", name: "monogrid", ...pg }); // c_03 left proposed
  runDraftTool(db, d.id, W, "propose_edge", { source: "cid:c_03", target: "practitioner:kim", edge_type: "CREATED_BY", confidence: "high", ...pg }); // c_04 accepted, waits for c_03
  runDraftTool(db, d.id, W, "propose_node", { type: "artwork", name: "Colors of Noise", ...pg }); // c_05 "Leave open"
  runDraftTool(db, d.id, W, "propose_edge", { source: "cid:c_05", target: "practitioner:kim", edge_type: "CREATED_BY", confidence: "high", ...pg }); // c_06 proposed
  runDraftTool(db, d.id, W, "propose_node", { type: "artwork", name: "Not Kim's", ...pg }); // c_07 rejected
  runDraftTool(db, d.id, W, "propose_edge", { source: "cid:c_07", target: "practitioner:kim", edge_type: "CREATED_BY", confidence: "high", ...pg }); // c_08 proposed — needs a rejected card
  runDraftTool(db, d.id, W, "ask_contributor", { text: "Did Kim and ZOOM respond to each other?", if_yes: { source: "cid:c_01", target: "cid:c_03", edge_type: "RESPONDS_TO" } }); // c_09
  runDraftTool(db, d.id, W, "note_known", { node_id: "practitioner:kim", summary: "Kim is already here" }); // c_10
  runDraftTool(db, d.id, W, "set_subject", { node_id: "practitioner:kim" });
  finishPass(db, d.id, W, { summary: "s" });
  const patch = (cid: string, p: any) => contributorPatchCandidate(db, getDraft(db, d.id)!, cid, p);
  patch("c_01", { state: "accepted" });
  patch("c_02", { state: "accepted" });
  patch("c_04", { state: "accepted" });
  patch("c_05", { state: "open" });
  patch("c_07", { state: "rejected" });
  return getDraft(db, d.id)!;
}

describe("left open", () => {
  it("leftOpen: undecided cards, and accepted ones that need them; never 'known', never what needs a rejected card", () => {
    const db = freshDb();
    const d = scottsRead(db, contributor(db, "EV3", "probationary"));
    const open = leftOpen(d.candidates);
    assert.deepEqual([...open.keys()].sort(), ["c_03", "c_04", "c_05", "c_06", "c_09"]);
    assert.ok(!open.has("c_08"), "needs a rejected work");
    assert.ok(!open.has("c_10"), "'known' is never open");
    assert.ok(!open.has("c_02"), "accepted with an accepted node stands");
    // 'known' cannot be left open by hand either
    assert.throws(() => contributorPatchCandidate(db, d, "c_10", { state: "open" }), /cannot be open/);
  });

  it("Confirm keeps them; a pick-up decides them under the picker's name; the first reader is credited", async () => {
    const db = freshDb();
    const ev3 = contributor(db, "EV3", "auto");
    const iri = contributor(db, "Iri", "auto");
    const d = scottsRead(db, ev3);
    const r = await confirmDraft(db, d, ev3, { mirror });
    assert.equal(r.left_open, 5);
    assert.deepEqual(r.created_nodes, ["artwork:zoom"]);
    assert.equal(r.edges.length, 1, "c_04 waits with its work instead of being skipped");
    assert.deepEqual(r.skipped.map((s) => s.cid), []);
    const items = openItemsOf(db, d.id);
    assert.deepEqual(items.map((i) => [i.cid, i.reason, i.subject_node_id]), [
      ["c_03", "undecided", "practitioner:kim"], ["c_04", "undecided", "practitioner:kim"], ["c_05", "undecided", "practitioner:kim"],
      ["c_06", "undecided", "practitioner:kim"], ["c_09", "undecided", "practitioner:kim"],
    ]);
    assert.match(items.find((i) => i.cid === "c_09")!.label, /^question: Did Kim/);
    const reads = listOpenReads(db);
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.left_by, "EV3");
    assert.equal(reads[0]!.items, 5);
    assert.deepEqual(reads[0]!.subject, { id: "practitioner:kim", name: "Kim" });
    assert.equal(listOpenReads(db, { nodeId: "practitioner:other" }).length, 0);

    // Iri picks them up: the accepted work the question needs is now a link
    const p = createPickupDraft(db, iri.id, d.id);
    assert.equal(p.status, "ready");
    assert.equal(p.picked_from, d.id);
    assert.equal(p.subject_node_id, "practitioner:kim");
    assert.deepEqual(p.candidates.map((c) => c.cid).sort(), ["c_03", "c_04", "c_05", "c_06", "c_09"]);
    assert.ok(p.candidates.every((c) => c.state === "proposed" && !c.edited));
    const q = p.candidates.find((c) => c.cid === "c_09") as Extract<Candidate, { kind: "question" }>;
    assert.equal(q.question.if_yes.source, "artwork:zoom");
    assert.equal(q.question.if_yes.target, "cid:c_03");
    assert.match(p.summary!, /EV3's read of teh\.example/);
    assert.equal(createPickupDraft(db, iri.id, d.id).id, p.id, "picking up again returns the open draft");

    const patch = (cid: string, x: any) => contributorPatchCandidate(db, getDraft(db, p.id)!, cid, x);
    patch("c_03", { state: "accepted" });
    patch("c_04", { state: "accepted" });
    patch("c_05", { state: "rejected" });
    // c_06 needs the rejected c_05 now: it cannot stand, so it is decided with it
    // c_09 left open again
    const r2 = await confirmDraft(db, getDraft(db, p.id)!, iri, { mirror });
    assert.equal(r2.decided, 4);
    assert.equal(r2.left_open, 1);
    assert.deepEqual(r2.created_nodes, ["artwork:monogrid"]);
    const sig = db.prepare("SELECT submitted_by, provenance_chain FROM signals WHERE batch_id = ? AND title LIKE 'Create node:%'").get(p.id) as any;
    assert.equal(sig.submitted_by, "Iri");
    assert.deepEqual(JSON.parse(sig.provenance_chain).picked_from, { draft_id: d.id, by: "EV3" });
    const after = Object.fromEntries(openItemsOf(db, d.id).map((i) => [i.cid, [i.outcome, i.decided_by]]));
    assert.deepEqual(after, {
      c_03: ["accepted", iri.id], c_04: ["accepted", iri.id], c_05: ["rejected", iri.id], c_06: ["skipped", iri.id], c_09: [null, null],
    });
    assert.equal(openItemsOf(db, p.id).length, 0, "an item left open again stays where it is");
    assert.equal(listOpenReads(db)[0]!.items, 1);

    // EV3's receipt says who decided what; Iri's says where it came from
    const rc = batchReceipt(db, d.id) as any;
    assert.equal(rc.left_open.length, 5);
    assert.deepEqual(rc.left_open.find((i: any) => i.label.includes("monogrid") && i.kind === "node").decided.by, "Iri");
    assert.deepEqual((batchReceipt(db, p.id) as any).picked_from, { batch_id: d.id, source_domain: "teh.example", by: "EV3" });
  });

  it("a pick-up that only turns items down still confirms; a second pick-up of a decided item skips it", async () => {
    const db = freshDb();
    const ev3 = contributor(db, "EV3", "auto");
    const iri = contributor(db, "Iri", "auto");
    const gio = contributor(db, "Gio", "auto");
    const d = scottsRead(db, ev3);
    await confirmDraft(db, d, ev3, { mirror });
    const a = createPickupDraft(db, iri.id, d.id);
    const b = createPickupDraft(db, gio.id, d.id);
    contributorPatchCandidate(db, getDraft(db, b.id)!, "c_03", { state: "accepted" });
    contributorPatchCandidate(db, getDraft(db, b.id)!, "c_04", { state: "accepted" });
    for (const cid of ["c_03", "c_05"]) contributorPatchCandidate(db, getDraft(db, a.id)!, cid, { state: "rejected" });
    const ra = await confirmDraft(db, getDraft(db, a.id)!, iri, { mirror });
    assert.equal(ra.intake_ids.length, 0);
    assert.equal(ra.decided, 5, "c_03, c_05, and the two relations and the question that needed them");
    assert.equal((batchReceipt(db, a.id) as any).review_state, "nothing added");
    // Gio confirms afterwards: monogrid was turned down by Iri first
    await assert.rejects(confirmDraft(db, getDraft(db, b.id)!, gio, { mirror }), (e: any) => e.code === "already_decided");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id = 'artwork:monogrid'").get()!.n, 0);
    assert.throws(() => createPickupDraft(db, iri.id, d.id), (e: any) => e.code === "nothing_open");
  });

  it("a probationary read: the accepted work waits in review, so a pick-up carries it as a card", async () => {
    const db = freshDb();
    const ev3 = contributor(db, "EV3", "probationary");
    const iri = contributor(db, "Iri", "auto");
    const d = scottsRead(db, ev3);
    const r = await confirmDraft(db, d, ev3, { mirror });
    assert.equal(r.status, "review");
    const p = createPickupDraft(db, iri.id, d.id);
    // ZOOM (c_01) is not in the graph yet: it comes along for the question
    assert.ok(p.candidates.some((c) => c.cid === "c_01" && c.kind === "node"));
    contributorPatchCandidate(db, getDraft(db, p.id)!, "c_09", { answered_yes: false });
    const r2 = await confirmDraft(db, getDraft(db, p.id)!, iri, { mirror });
    assert.equal(r2.decided, 1);
    assert.equal(openItemsOf(db, p.id).length, 0, "the carried card is EV3's, already in review — never a new open item");
    // approving EV3's batch later still works
    const qid = (db.prepare("SELECT id FROM intake_queue WHERE status = 'pending'").get() as any).id;
    approveIntakeItem(db, qid, "curator");
    assert.ok(db.prepare("SELECT 1 FROM nodes WHERE id = 'artwork:zoom'").get());
  });
});

describe("left open over HTTP", () => {
  it("lists reads, picks one up, and shows it on the subject's page and in /history", async () => {
    const { initDb } = await import("../src/db.js");
    const { default: intake } = await import("../src/routes/intake.js");
    const { default: pages } = await import("../src/routes/pages.js");
    const { mintToken } = await import("../src/utils/token-mint.js");
    const db = initDb(":memory:");
    const t = mintToken(db, { contributorName: "Iri", createIfMissing: true, tier: "auto" });
    const iri = db.prepare("SELECT id, name, trust_tier FROM contributors WHERE name = 'Iri'").get() as any;
    const ev3 = contributor(db as any, "EV3", "auto");
    const d = scottsRead(db as any, ev3);
    await confirmDraft(db, d, ev3, { mirror });
    const app = express(); app.use(express.json()); app.use(intake); app.use(pages);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const call = (method: string, path: string, token?: string) => fetch(base + path, { method, redirect: "manual", headers: token ? { authorization: `Bearer ${token}` } : {} });
    try {
      assert.equal((await call("GET", "/api/intake/open")).status, 401);
      const list = await (await call("GET", "/api/intake/open?node=practitioner:kim", t.raw_token)).json() as any;
      assert.equal(list.reads.length, 1);
      assert.equal(list.reads[0].items, 5);
      // the subject's page tells a signed-in contributor, and only them
      const { ensureContributorForEmail, issueSession, cookieHeader } = await import("../src/intake/auth.js");
      const v = ensureContributorForEmail(db, { email: "v@x.org", name: "V", invite: true });
      const cookie = cookieHeader(issueSession(db, v.id).signed, 100, false).split(";")[0]!;
      const page = await (await fetch(base + "/practitioner/kim", { headers: { cookie } })).text();
      assert.match(page, new RegExp(`href="/contribute\\?open=${d.id}#open">5 items left open → pick up</a>`));
      assert.doesNotMatch(await (await call("GET", "/practitioner/kim")).text(), /left open/);
      const pick = await call("POST", `/api/intake/open/${d.id}/pickup`, t.raw_token);
      assert.equal(pick.status, 201);
      const { draft_id } = await pick.json() as any;
      assert.equal((await call("POST", "/api/intake/open/drf_nope/pickup", t.raw_token)).status, 404);
      // receipt lists what was left open
      assert.match(await (await call("GET", `/batch/${d.id}`)).text(), /Left open · 5/);
      // decide one and look at the history of the new work
      for (const cid of ["c_03", "c_04"]) contributorPatchCandidate(db, getDraft(db, draft_id)!, cid, { state: "accepted" });
      await confirmDraft(db, getDraft(db, draft_id)!, { ...iri, token_label: null, token_prefix: "t", scope: "write" }, { mirror });
      const receipt = await (await call("GET", `/batch/${d.id}`)).text();
      assert.match(receipt, /Left open · 5 \(3 still open\)/);
      assert.match(receipt, /added by Iri · \d{4}-\d{2}-\d{2}/);
      const hist = await (await call("GET", "/artwork/monogrid/history")).text();
      assert.match(hist, /by Iri/);
      assert.match(hist, new RegExp(`first proposed by EV3 in <a href='/batch/${d.id}'>`));
      assert.match(await (await call("GET", `/batch/${draft_id}`)).text(), /Picked up from <a href="\/batch\/drf_[0-9a-f]+">EV3&#39;s read of teh\.example|Picked up from <a href="\/batch\/drf_[0-9a-f]+">EV3's read of teh\.example/);
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      db.close();
    }
  });
});

describe("a link the reader could not open (#75)", () => {
  const failed = { url: "https://www.fxhash.xyz/generative/20567", status: null, reason: "dns", checked_at: "2026-10-14T11:40:00Z" };
  function read(db: ReturnType<typeof freshDb>, who: AuthedContributor) {
    insertNode(db, "practitioner:kim", "practitioner", "Kim");
    const d = createDraft(db, who.id, "https://teh.example/");
    claimJob(db, "w1");
    const r1 = runDraftTool(db, d.id, "w1", "propose_node", { type: "artwork", name: "ZOOM", ...pg, link_check: failed }) as any; // c_01
    runDraftTool(db, d.id, "w1", "propose_edge", { source: "cid:c_01", target: "practitioner:kim", edge_type: "CREATED_BY", confidence: "high", ...pg, link_check: failed }); // c_02
    runDraftTool(db, d.id, "w1", "propose_node", { type: "artwork", name: "monogrid", ...pg, link_check: { ...failed, url: "https://feralfile.example/x", status: 404, reason: "http" } }); // c_03
    runDraftTool(db, d.id, "w1", "propose_node", { type: "artwork", name: "PXLDEX", ...pg }); // c_04
    runDraftTool(db, d.id, "w1", "set_subject", { node_id: "practitioner:kim" });
    return { d, r1 };
  }

  it("starts rejected, stays the worker's to update, and does not bind it like a contributor's no", () => {
    const db = freshDb();
    const { d, r1 } = read(db, contributor(db, "EV3", "auto"));
    assert.equal(r1.state, "rejected");
    const cards = getDraft(db, d.id)!.candidates;
    assert.deepEqual(cards.map((c) => c.state), ["rejected", "rejected", "rejected", "proposed"]);
    assert.deepEqual(cards[0]!.link_check, failed);
    // the agent may still update it, but never invent or change a link_check
    runDraftTool(db, d.id, "w1", "update_candidate", { cid: "c_03", patch: { note: "listed on the home page", link_check: { ...failed, reason: "timeout" } } });
    assert.equal(getDraft(db, d.id)!.candidates[2]!.link_check!.reason, "http");
    // proposing the same relation again is not refused as "the contributor said no"
    runDraftTool(db, d.id, "w1", "remove_candidate", { cid: "c_02" });
    runDraftTool(db, d.id, "w1", "propose_edge", { source: "cid:c_01", target: "practitioner:kim", edge_type: "CREATED_BY", confidence: "high", ...pg }); // c_05
    // only node, edge and image cards carry one
    assert.throws(() => validateCandidate({ cid: "c_09", kind: "known", origin: "graph", known: { node_id: "practitioner:kim", summary: "k" }, link_check: failed }, []), /link_check is for node, edge and image/);
    assert.throws(() => validateCandidate({ cid: "c_09", kind: "node", node: { type: "artwork", name: "Y" }, evidence: pg, link_check: { ...failed, reason: "vibes" } }, []), /link_check.reason/);
  });

  it("untouched, it goes to the re-check list; a contributor's own Reject is final; a picker's Accept decides it", async () => {
    const db = freshDb();
    const ev3 = contributor(db, "EV3", "auto");
    const iri = contributor(db, "Iri", "auto");
    const { d } = read(db, ev3);
    finishPass(db, d.id, "w1", { summary: "s" });
    const patch = (id: string, cid: string, x: any) => contributorPatchCandidate(db, getDraft(db, id)!, cid, x);
    patch(d.id, "c_03", { state: "rejected" }); // EV3 checked: monogrid really is not there
    patch(d.id, "c_04", { state: "accepted" });
    const r = await confirmDraft(db, getDraft(db, d.id)!, ev3, { mirror });
    assert.equal(r.left_open, 2);
    assert.deepEqual(openItemsOf(db, d.id).map((i) => [i.cid, i.reason]), [["c_01", "link_failed"], ["c_02", "link_failed"]]);
    assert.equal(listOpenReads(db)[0]!.links_to_recheck, 2);

    const p = createPickupDraft(db, iri.id, d.id);
    assert.deepEqual(p.candidates.map((c) => [c.cid, c.state, !!c.link_check]), [["c_01", "rejected", true], ["c_02", "rejected", true]]);
    patch(p.id, "c_01", { state: "accepted" }); // Iri opened the link: it works
    patch(p.id, "c_02", { state: "accepted" });
    const r2 = await confirmDraft(db, getDraft(db, p.id)!, iri, { mirror });
    assert.equal(r2.decided, 2);
    assert.deepEqual(r2.created_nodes, ["artwork:zoom"]);
    assert.equal(listOpenReads(db).length, 0);
  });
});
