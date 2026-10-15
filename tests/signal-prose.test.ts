// Contributions read as sentences, never as the JSON body of the request
// that made them (issue #59).

import { it } from "node:test";
import assert from "node:assert/strict";
import { freshDb, insertNode } from "./helpers.js";
import { contributionCards, contributionLines, contributionByline, type ContributionRow } from "../src/utils/signal-prose.js";

const row = (over: Partial<ContributionRow>): ContributionRow => ({
  title: null, content: null, source_url: null, source_type: null, submitted_by: "aiio",
  created_at: "2026-10-13T10:00:00Z", consent_attribution: "attributed", proposed_nodes: null, proposed_edges: null, ...over,
});

it("signal prose: edges, creates, patches, images and human text", () => {
  const db = freshDb();
  insertNode(db, "artwork:oscillon-1184", "artwork", "Oscillon 1184");
  insertNode(db, "institution:the-outlier-collection", "institution", "The Outlier Collection");
  db.prepare("UPDATE nodes SET slug = substr(id, instr(id, ':') + 1)").run();

  const edge = row({
    source_type: "api_edge",
    content: JSON.stringify({ source_id: "artwork:oscillon-1184", target_id: "institution:the-outlier-collection", edge_type: "HELD_BY" }),
    proposed_edges: JSON.stringify([{ source_id: "artwork:oscillon-1184", target_id: "institution:the-outlier-collection", edge_type: "HELD_BY" }]),
  });
  assert.deepEqual(contributionLines(db, edge), [
    "<a href='/artwork/oscillon-1184'>Oscillon 1184</a> → held by → <a href='/institution/the-outlier-collection'>The Outlier Collection</a>",
  ]);
  assert.equal(contributionByline(db, edge), "contributed by aiio · 13 Oct 2026");

  const patch = row({ source_type: "api_node", content: "{\"node_id\":\"x\"}", proposed_nodes: JSON.stringify([{ op: "patch_node", node_id: "artwork:oscillon-1184", metadata: { year: "1952", medium: null } }]) });
  const [p] = contributionLines(db, patch);
  assert.match(p, /^updated <a href='\/artwork\/oscillon-1184'>Oscillon 1184<\/a>/);
  assert.match(p, /year:<\/span> 1952/);
  assert.match(p, /medium:<\/span> <span class='meta'>\(removed\)/);

  const human = row({ title: "Shown at Palazzo Diedo", content: "Part of Strange Rules.", source_url: "https://www.example.org/x", consent_attribution: "anonymous" });
  assert.deepEqual(contributionLines(db, human), ["<strong>Shown at Palazzo Diedo</strong>", "Part of Strange Rules."]);
  assert.equal(contributionByline(db, human), "contributed anonymously · 13 Oct 2026 · <a href='https://www.example.org/x' target='_blank' rel='noopener'>example.org ↗</a>");

  const html = contributionCards(db, [edge, patch, human, row({ title: "Add edge X", content: "{\"source_id\":\"a\"}" })]);
  assert.doesNotMatch(html, /source_id|edge_type|\{"/);
});
