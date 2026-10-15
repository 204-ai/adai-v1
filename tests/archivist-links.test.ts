// The archivist's links are checked against the graph (issue #62): invented
// domains become site paths, slugs derived from names resolve to the node the
// tools returned, links to nodes that don't exist lose their link.

import { it } from "node:test";
import assert from "node:assert/strict";
import { freshDb, insertNode } from "./helpers.js";
import { collectNodes, resolveLinks, type SeenNode } from "../src/archivist/links.js";

it("archivist links: domains, derived slugs, missing nodes", () => {
  const db = freshDb();
  insertNode(db, "practitioner:ben laposky", "practitioner", "Ben Laposky");
  db.prepare("UPDATE nodes SET slug = 'ben-laposky' WHERE id = 'practitioner:ben laposky'").run();
  insertNode(db, "institution:kunsthalle-zurich", "institution", "Kunsthalle Zürich");
  db.prepare("UPDATE nodes SET slug = 'kunsthalle-zürich' WHERE id = 'institution:kunsthalle-zurich'").run();
  insertNode(db, "artwork:fidenza", "artwork", "Fidenza");

  const seen: SeenNode[] = [];
  collectNodes({ node: { id: "x", type: "artwork", name: "Fidenza", slug: "fidenza" }, edges: [{ other: { id: "practitioner:ben laposky", type: "practitioner", name: "Ben Laposky", slug: "ben-laposky" } }] }, seen);
  assert.equal(seen.length, 2);

  const text = [
    "[Fidenza](/artwork/fidenza)",                                   // fine — not in the map
    "[Ben F. Laposky](https://adai.is/practitioner/ben-f-laposky)",   // domain + derived slug
    "[Fidenza](/practitioner/fidenza)",                               // wrong type segment
    "[Kunsthalle Zürich](/institution/kunsthalle-zurich)",            // legacy slug kept accents
    "[Nobody](/artwork/nobody-at-all)",                               // no such node
    "[whitepaper](https://digitalartsinstitute.io/whitepaper)",       // own host, not a node
    "[elsewhere](https://example.com/x)",                             // someone else's page
  ].join(" ");
  assert.deepEqual(resolveLinks(db, text, seen), {
    "https://adai.is/practitioner/ben-f-laposky": "/practitioner/ben-laposky",
    "/practitioner/fidenza": "/artwork/fidenza",
    "/institution/kunsthalle-zurich": `/institution/${encodeURIComponent("kunsthalle-zürich")}`,
    "/artwork/nobody-at-all": null,
    "https://digitalartsinstitute.io/whitepaper": "/whitepaper",
  });
});
