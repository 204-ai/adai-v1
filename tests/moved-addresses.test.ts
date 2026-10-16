// Merging a duplicate node (#69) and rewriting old slugs (#67): nothing is
// deleted, provenance stays, and every old address 301s to the current one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mergeNodes, migrateSlugs, currentSlugFor } from "../src/utils/admin-actions.js";
import { movedTo } from "../src/utils/moved.js";
import { nodeHistory } from "../src/utils/history.js";

async function setup() {
  const { initDb } = await import("../src/db.js");
  const db = initDb(":memory:");
  const node = (id: string, type: string, name: string, slug: string, meta: object) =>
    db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, 'seed')").run(id, type, name, slug, JSON.stringify(meta));
  const edge = (id: string, s: string, t: string, type: string, by: string, sig: string, evt: string | null = null) =>
    db.prepare("INSERT INTO edges (id, source_id, target_id, edge_type, signal_id, confidence, created_by, event_time, valid_from) VALUES (?, ?, ?, ?, ?, 'high', ?, ?, '2026-05-31T00:00:00Z')").run(id, s, t, type, sig, by, evt);
  node("practitioner:william mapan", "practitioner", "William Mapan", "william-mapan", { source_url: "https://lerandom.art/x", status: "confirmed" });
  node("practitioner:williamapan", "practitioner", "williamapan", "williamapan", { fxhash_user_id: "tz1abc", source_url: "https://fxhash.xyz/u/tz1abc" });
  node("artwork:dragons", "artwork", "Dragons", "dragons--fxhash-2613", {});
  node("artwork:anticyclone", "artwork", "Anticyclone", "anticyclone", {});
  node("concept:generative art", "concept", "generative art", "generative-art", {});
  edge("e-dragons", "artwork:dragons", "practitioner:williamapan", "CREATED_BY", "contributor:migration", "signal:fxhash", "2021");
  edge("e-anti", "artwork:anticyclone", "practitioner:william mapan", "CREATED_BY", "contributor:migration", "signal:artblocks");
  edge("e-anti-dup", "artwork:anticyclone", "practitioner:williamapan", "CREATED_BY", "contributor:migration", "signal:fxhash");
  edge("e-loop", "practitioner:williamapan", "practitioner:william mapan", "COLLABORATES_WITH", "api-x", "signal:x");
  edge("e-gen", "practitioner:williamapan", "concept:generative art", "PRACTICES", "api-x", "signal:y");
  db.prepare("INSERT INTO node_aliases (source, external_id, node_id) VALUES ('fxhash', 'user:tz1abc', 'practitioner:williamapan')").run();
  node("artwork:idle", "artwork", "Idle/Interludes", "idle/interludes", {});
  node("artwork:ls1", "artwork", "Light Speculation #1", "light-speculation-#1", {});
  node("artwork:va", "artwork", "Contribution to V&A's 150th anniversary album", "contribution-to-v&as-150th-anniversary-album--va-o1171127", {});
  node("collective:dunne", "collective", "Dunne & Raby", "dunne-&-raby", {});
  node("collective:dunne2", "collective", "Dunne and Raby", "dunne-and-raby", {}); // the new slug is taken
  return db;
}

describe("merge a duplicate node (#69)", () => {
  it("moves live relations with their provenance, copies missing keys, moves aliases, retires the duplicate", async () => {
    const db = await setup();
    const dry = mergeNodes(db, "practitioner:williamapan", "practitioner:william mapan", { reason: "same person", by: "op", dryRun: true });
    assert.equal(dry.edges_moved.length, 2);
    assert.deepEqual(dry.edges_ended.sort(), ["e-anti-dup", "e-loop"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM edges WHERE valid_until IS NOT NULL").get() as any).n, 0, "a dry run writes nothing");

    const r = mergeNodes(db, "practitioner:williamapan", "practitioner:william mapan", { reason: "same person", by: "op" });
    assert.deepEqual(r.keys_copied, ["fxhash_user_id"]);
    assert.deepEqual(r.keys_kept, ["source_url"]);
    assert.deepEqual(r.aliases_moved, [{ source: "fxhash", external_id: "user:tz1abc" }]);
    const live = db.prepare("SELECT source_id, target_id, edge_type, signal_id, created_by, event_time, confidence FROM edges WHERE valid_until IS NULL ORDER BY source_id").all() as any[];
    assert.deepEqual(live.map((e) => ({ ...e })), [
      { source_id: "artwork:anticyclone", target_id: "practitioner:william mapan", edge_type: "CREATED_BY", signal_id: "signal:artblocks", created_by: "contributor:migration", event_time: null, confidence: "high" },
      { source_id: "artwork:dragons", target_id: "practitioner:william mapan", edge_type: "CREATED_BY", signal_id: "signal:fxhash", created_by: "contributor:migration", event_time: "2021", confidence: "high" },
      { source_id: "practitioner:william mapan", target_id: "concept:generative art", edge_type: "PRACTICES", signal_id: "signal:y", created_by: "api-x", event_time: null, confidence: "high" },
    ]);
    const old = db.prepare("SELECT valid_until, invalidated_by FROM edges WHERE id = 'e-dragons'").get() as any;
    assert.ok(old.valid_until, "the old relation is ended, not deleted");
    assert.equal(old.invalidated_by, r.edges_moved.find((m) => m.old === "e-dragons")!.new);
    assert.equal((db.prepare("SELECT invalidated_by FROM edges WHERE id = 'e-anti-dup'").get() as any).invalidated_by, "e-anti", "the same claim already on the kept node");
    assert.equal((db.prepare("SELECT invalidated_by FROM edges WHERE id = 'e-loop'").get() as any).invalidated_by, r.admin_signal_id);
    const kept = JSON.parse((db.prepare("SELECT metadata FROM nodes WHERE id = 'practitioner:william mapan'").get() as any).metadata);
    assert.equal(kept.fxhash_user_id, "tz1abc");
    assert.equal(kept.source_url, "https://lerandom.art/x");
    const dup = JSON.parse((db.prepare("SELECT metadata FROM nodes WHERE id = 'practitioner:williamapan'").get() as any).metadata);
    assert.equal(dup.retired, true);
    assert.equal(dup.merged_into, "practitioner:william mapan");
    assert.equal((db.prepare("SELECT node_id FROM node_aliases WHERE source = 'fxhash'").get() as any).node_id, "practitioner:william mapan");
    // both pages' history say what happened
    const h = nodeHistory(db, "practitioner:william mapan")!;
    assert.ok(h.events.some((e: any) => e.kind === "metadata" && e.op === "merge_node" && e.changes[0].key === "fxhash_user_id" && e.changes[0].before === null && e.changes[0].after === "tz1abc"));
    assert.deepEqual(movedTo(db, "practitioner", "williamapan"), { id: "practitioner:william mapan", type: "practitioner", slug: "william-mapan" });
    // refusals
    assert.throws(() => mergeNodes(db, "practitioner:williamapan", "practitioner:william mapan", { reason: "x", by: "op" }), (e: any) => e.code === "already_retired");
    assert.throws(() => mergeNodes(db, "artwork:dragons", "practitioner:william mapan", { reason: "x", by: "op" }), (e: any) => e.code === "type_mismatch");
    db.prepare("INSERT INTO node_claims (id, node_id, contributor_id, status, via) VALUES ('c1', 'artwork:anticyclone', 'contributor:x', 'approved', 'invite')").run();
    assert.throws(() => mergeNodes(db, "artwork:anticyclone", "artwork:dragons", { reason: "x", by: "op" }), (e: any) => e.code === "claimed");
  });
});

describe("rewrite old slugs (#67)", () => {
  it("slugify(name) with the source suffix kept; a taken slug is left; the old slug is kept as an alias", async () => {
    const db = await setup();
    assert.equal(currentSlugFor("contribution-to-v&as-150th-anniversary-album--va-o1171127", "Contribution to V&A's 150th anniversary album"), "contribution-to-vandas-150th-anniversary-album--va-o1171127");
    const dry = migrateSlugs(db, { by: "op", dryRun: true });
    assert.deepEqual(dry.renamed.map((x) => [x.old, x.new]).sort(), [
      ["contribution-to-v&as-150th-anniversary-album--va-o1171127", "contribution-to-vandas-150th-anniversary-album--va-o1171127"],
      ["idle/interludes", "idle-interludes"],
      ["light-speculation-#1", "light-speculation-1"],
    ]);
    assert.deepEqual(dry.collisions.map((x) => [x.old, x.taken_by]), [["dunne-&-raby", "collective:dunne2"]]);
    assert.equal((db.prepare("SELECT slug FROM nodes WHERE id = 'artwork:idle'").get() as any).slug, "idle/interludes");
    const r = migrateSlugs(db, { by: "op" });
    assert.equal(r.renamed.length, 3);
    assert.equal((db.prepare("SELECT slug FROM nodes WHERE id = 'artwork:idle'").get() as any).slug, "idle-interludes");
    assert.deepEqual(movedTo(db, "artwork", "idle/interludes"), { id: "artwork:idle", type: "artwork", slug: "idle-interludes" });
    assert.equal(movedTo(db, "artwork", "idle-interludes"), null, "the current address is not moved");
    const h = nodeHistory(db, "artwork:ls1")!;
    const ev = h.events.find((e: any) => e.kind === "metadata" && e.op === "rename_slug") as any;
    assert.deepEqual(ev.changes, [{ key: "slug", before: "light-speculation-#1", after: "light-speculation-1" }]);
    assert.equal(migrateSlugs(db, { by: "op" }).renamed.length, 0, "idempotent");
  });
});

describe("old addresses over HTTP", () => {
  it("301 to the current page, on every page that takes a slug, query kept", async () => {
    const db = await setup();
    mergeNodes(db, "practitioner:williamapan", "practitioner:william mapan", { reason: "same person", by: "op" });
    migrateSlugs(db, { by: "op" });
    const { default: pages } = await import("../src/routes/pages.js");
    const app = express(); app.use(pages);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const go = async (p: string) => { const r = await fetch(base + p, { redirect: "manual" }); return [r.status, r.headers.get("location")]; };
    try {
      assert.deepEqual(await go("/practitioner/williamapan"), [301, "/practitioner/william-mapan"]);
      assert.deepEqual(await go("/practitioner/williamapan/history"), [301, "/practitioner/william-mapan/history"]);
      assert.deepEqual(await go("/record/practitioner/williamapan"), [301, "/record/practitioner/william-mapan"]);
      assert.deepEqual(await go("/field/practitioner/williamapan?x=1"), [301, "/field/practitioner/william-mapan?x=1"]);
      assert.deepEqual(await go("/artwork/idle/interludes"), [301, "/artwork/idle-interludes"]);
      assert.deepEqual(await go("/artwork/idle%2Finterludes/data"), [301, "/artwork/idle-interludes/data"]);
      assert.deepEqual(await go("/artwork/light-speculation-%231"), [301, "/artwork/light-speculation-1"]);
      assert.deepEqual(await go("/neighbours/artwork/light-speculation-%231"), [301, "/neighbours/artwork/light-speculation-1"]);
      assert.equal((await go("/artwork/idle-interludes"))[0], 200);
      assert.equal((await go("/practitioner/william-mapan"))[0], 200);
      assert.equal((await go("/collective/dunne-&-raby"))[0], 200, "left as it was");
      assert.equal((await go("/artwork/nothing-here"))[0], 404);
    } finally {
      server.close();
    }
  });
});
