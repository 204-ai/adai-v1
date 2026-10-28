// Server-side node dedupe on (type, slug): legacy nodes keep their spaced id
// (`practitioner:patrick tresset`) with the hyphen form in their slug column,
// so a create of the same name — by name, by explicit slug, approved from
// /review or confirmed from a URL-intake draft — resolves to that node
// (created:false + a warning) instead of minting `practitioner:patrick-tresset`.
// Also: mergeNodes repoints the local links (token byline node, invite self node).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import contributorApi from "../src/routes/contributor-api.js";
import { mintToken } from "../src/utils/token-mint.js";
import { approveIntakeItem } from "../src/utils/review.js";
import { insertIntake, insertSignal, materialiseCreateNode } from "../src/utils/contribution.js";
import { mergeNodes } from "../src/utils/admin-actions.js";
import { freshDb, insertNode } from "./helpers.js";
import { createDraft, claimJob, finishPass, getDraft, runDraftTool, contributorPatchCandidate, confirmDraft } from "../src/intake/draft.js";
import type { AuthedContributor } from "../src/auth.js";

const LEGACY = "practitioner:patrick tresset";
const DUP = "practitioner:patrick-tresset";

function seedLegacy(db: any) {
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, 'practitioner', 'Patrick Tresset', 'patrick-tresset', '{}', 'seed')").run(LEGACY);
}
const count = (db: any, id: string) => (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id = ?").get(id) as any).n;

async function withApi(db: any, fn: (post: (tok: string, body: unknown) => Promise<{ status: number; json: any }>) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(contributorApi);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (tok: string, body: unknown) => {
    const r = await fetch(`${base}/api/v1/nodes`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  try { await fn(post); } finally { server.close(); }
}

describe("node dedupe on (type, slug)", () => {
  it("POST /api/v1/nodes: by name and by explicit slug, resolves to the legacy spaced id", async () => {
    const db = initDb(":memory:");
    seedLegacy(db);
    const tok = mintToken(db, { contributorName: "Curator", createIfMissing: true, tier: "auto" } as any);
    await withApi(db, async (post) => {
      const a = await post(tok.raw_token, { type: "practitioner", name: "Patrick Tresset" });
      assert.equal(a.status, 200);
      assert.equal(a.json.node_id, LEGACY);
      assert.equal(a.json.created, false);
      assert.ok(a.json.warnings.some((w: string) => w.includes("already exists") && w.includes(LEGACY)));
      const b = await post(tok.raw_token, { type: "practitioner", name: "P. Tresset", slug: "patrick-tresset" });
      assert.equal(b.json.node_id, LEGACY);
      assert.equal(b.json.created, false);
      // another type at the same slug is a different node
      const c = await post(tok.raw_token, { type: "artwork", name: "Patrick Tresset" });
      assert.equal(c.json.node_id, "artwork:patrick-tresset");
      assert.equal(c.json.created, true);
    });
    assert.equal(count(db, DUP), 0);
  });

  it("a retired node at the slug does not capture the create", async () => {
    const db = initDb(":memory:");
    db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, 'practitioner', 'Patrick Tresset', 'patrick-tresset', '{\"retired\":true}', 'seed')").run(LEGACY);
    const tok = mintToken(db, { contributorName: "Curator", createIfMissing: true, tier: "auto" } as any);
    await withApi(db, async (post) => {
      const a = await post(tok.raw_token, { type: "practitioner", name: "Patrick Tresset" });
      assert.equal(a.json.node_id, DUP);
      assert.equal(a.json.created, true);
    });
  });

  it("probationary create queued, legacy node appears, /review approval makes no duplicate", async () => {
    const db = initDb(":memory:");
    const tok = mintToken(db, { contributorName: "Newcomer", createIfMissing: true, tier: "probationary" } as any);
    let intakeId = "";
    await withApi(db, async (post) => {
      const a = await post(tok.raw_token, { type: "practitioner", name: "Patrick Tresset" });
      assert.equal(a.json.status, "pending");
      intakeId = a.json.intake_id;
    });
    seedLegacy(db); // the node exists by the time a curator approves
    assert.equal(approveIntakeItem(db, intakeId, "curator").ok, true);
    assert.equal(count(db, DUP), 0);
    assert.equal(count(db, LEGACY), 1);
  });

  it("materialiseCreateNode dedupes, and a queued item's edges follow the existing node", () => {
    const db = freshDb();
    seedLegacy(db);
    insertNode(db, "artwork:robot-sketch", "artwork", "Robot Sketch");
    const r = materialiseCreateNode(db, { op: "create_node", type: "practitioner", name: "Patrick Tresset", slug: "patrick-tresset" }, { signalId: null, createdBy: "t" });
    assert.deepEqual(r, { node_id: LEGACY, created: false, deduped_from: DUP });

    const contributor: AuthedContributor = { id: "contributor:p", name: "P", trust_tier: "probationary", token_label: null, token_prefix: "t", scope: "write" } as any;
    db.prepare("INSERT INTO contributors (id, name, type, trust_tier, contributions, approved_count) VALUES ('contributor:p', 'P', 'human', 'probationary', 0, 0)").run();
    const signalId = insertSignal(db, { contributor, title: "t", content: "c", pending: true } as any);
    const { intake_id } = insertIntake(db, {
      contributor,
      signal_id: signalId,
      target_node: DUP,
      proposed_nodes: [{ op: "create_node", type: "practitioner", name: "Patrick Tresset", slug: "patrick-tresset" }],
      proposed_edges: [{ source_id: "artwork:robot-sketch", target_id: DUP, edge_type: "CREATED_BY" } as any],
    });
    assert.equal(approveIntakeItem(db, intake_id, "curator").ok, true);
    assert.equal(count(db, DUP), 0);
    const e = db.prepare("SELECT target_id FROM edges WHERE source_id = 'artwork:robot-sketch' AND valid_until IS NULL").all() as any[];
    assert.deepEqual(e.map((x) => x.target_id), [LEGACY]);
  });

  it("URL-intake Confirm links to the legacy node instead of creating", async () => {
    const db = freshDb();
    seedLegacy(db);
    const id = "contributor:auto-tester";
    db.prepare("INSERT INTO contributors (id, name, type, trust_tier, contributions, approved_count) VALUES (?, 'auto tester', 'human', 'auto', 0, 0)").run(id);
    const c: AuthedContributor = { id, name: "auto tester", trust_tier: "auto", token_label: null, token_prefix: "t", scope: "write" } as any;
    const d = createDraft(db, c.id, "https://tresset.example/");
    claimJob(db, "w1");
    const pg = { page_url: "https://tresset.example/works", quote: "Human Study #1 by Patrick Tresset." };
    runDraftTool(db, d.id, "w1", "propose_node", { type: "artwork", name: "Human Study 1", ...pg }); // c_01
    runDraftTool(db, d.id, "w1", "propose_node", { type: "practitioner", name: "Patrick Tresset", ...pg }); // c_02
    runDraftTool(db, d.id, "w1", "propose_edge", { source: "cid:c_01", target: "cid:c_02", edge_type: "CREATED_BY", confidence: "high", ...pg }); // c_03
    finishPass(db, d.id, "w1", { summary: "s" });
    let dr = getDraft(db, d.id)!;
    const c02 = dr.candidates.find((x) => x.cid === "c_02") as any;
    if (c02.resolves_to) assert.equal(c02.resolves_to, LEGACY); // validator may already link it
    for (const cid of ["c_01", "c_02", "c_03"]) contributorPatchCandidate(db, dr, cid, { state: "accepted" });
    dr = getDraft(db, d.id)!;
    const r = await confirmDraft(db, dr, c);
    assert.equal(r.status, "live");
    assert.ok(r.linked_nodes.includes(LEGACY));
    assert.ok(!r.created_nodes.includes(DUP));
    assert.equal(count(db, DUP), 0);
    const e = db.prepare("SELECT target_id FROM edges WHERE source_id = 'artwork:human-study-1' AND edge_type = 'CREATED_BY' AND valid_until IS NULL").get() as any;
    assert.equal(e.target_id, LEGACY);
  });
});

describe("mergeNodes repoints local links", () => {
  it("contributor_tokens.node_id and contributor_emails.self_node_id follow the kept node", () => {
    const db = freshDb();
    seedLegacy(db);
    insertNode(db, DUP, "practitioner", "Patrick Tresset");
    insertNode(db, "practitioner:someone-else", "practitioner", "Someone Else");
    db.prepare("INSERT INTO contributor_tokens (token_hash, token_prefix, contributor_id, node_id) VALUES ('h1', 'adai_aaa', 'contributor:a', ?)").run(DUP);
    db.prepare("INSERT INTO contributor_tokens (token_hash, token_prefix, contributor_id, node_id) VALUES ('h2', 'adai_bbb', 'contributor:b', 'practitioner:someone-else')").run();
    db.prepare("INSERT INTO contributor_emails (email, contributor_id, self_node_id) VALUES ('p@x.y', 'contributor:a', ?)").run(DUP);

    const dry = mergeNodes(db, DUP, LEGACY, { reason: "same person", by: "op", dryRun: true });
    assert.equal(dry.tokens_repointed, 1);
    assert.equal(dry.emails_repointed, 1);
    assert.equal((db.prepare("SELECT node_id FROM contributor_tokens WHERE token_hash = 'h1'").get() as any).node_id, DUP, "a dry run writes nothing");

    const r = mergeNodes(db, DUP, LEGACY, { reason: "same person", by: "op" });
    assert.equal(r.tokens_repointed, 1);
    assert.equal(r.emails_repointed, 1);
    assert.equal((db.prepare("SELECT node_id FROM contributor_tokens WHERE token_hash = 'h1'").get() as any).node_id, LEGACY);
    assert.equal((db.prepare("SELECT node_id FROM contributor_tokens WHERE token_hash = 'h2'").get() as any).node_id, "practitioner:someone-else");
    assert.equal((db.prepare("SELECT self_node_id FROM contributor_emails WHERE email = 'p@x.y'").get() as any).self_node_id, LEGACY);
  });
});
