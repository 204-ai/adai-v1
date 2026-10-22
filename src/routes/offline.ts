// GET /offline — the commons on your own machine (issue #82): how to download
// the public snapshot (src/snapshot/build.ts), open it, and read the graph
// from a script. The download URL is configuration (SNAPSHOT_URL); until it
// is set, the page says the snapshot is not published yet.

import { Router } from "express";
import { HTML_HEADERS, htmlEscape as esc, htmlPage } from "../templates.js";

const router = Router();

/** The public image mirror (R2), for the note on images. */
const R2_PUBLIC = "https://pub-ebd869876a824a5e83dbb2fe42d03211.r2.dev";

export function offlinePage(snapshotUrl: string | null): string {
  const url = snapshotUrl && /^https?:\/\//i.test(snapshotUrl) ? snapshotUrl : null;
  const download = url
    ? `<p><a href="${esc(url)}"><strong>Download the snapshot</strong></a> <span class='meta'>(one SQLite file, refreshed nightly)</span></p>
       <pre>curl -LO ${esc(url)}</pre>`
    : `<p class='meta'><strong>Not published yet.</strong> The snapshot is built, but the nightly download has not been switched on. Check back soon — this page will carry the link.</p>`;
  const file = url ? esc(url.split("/").pop() || "adai-latest.sqlite") : "adai-latest.sqlite";
  const body = `
<h2>The commons, offline</h2>
<p>The whole public graph of A(DAI) — practitioners, works, concepts, institutions, the relations between them and the contributions behind them — as one file you can keep, open and build on. A sandbox: break things freely, the live commons is not touched.</p>

<h3>1. Download</h3>
${download}

<h3>2. Open it</h3>
<p>It is a plain SQLite file: no server, no extension.</p>
<pre>sqlite3 ${file}
sqlite&gt; .tables
contributors  edges  meta  node_aliases  nodes  signals
sqlite&gt; SELECT value FROM meta WHERE key = 'readme';</pre>
<p class='meta'>Python and Node have SQLite built in (<code>import sqlite3</code>; <code>node:sqlite</code>); DB Browser for SQLite or Datasette work too.</p>

<h3>3. Read the graph from a script</h3>
<p>Nodes are things; edges are relations between them. Edges are <em>bi-temporal</em>: the current graph is the edges <code>WHERE valid_until IS NULL</code> — ended relations stay in the file as history.</p>
<pre>import sqlite3, json

db = sqlite3.connect("${file}")
works = db.execute("""
  SELECT w.name, json_extract(w.metadata, '$.cdn_image_url')
    FROM edges e
    JOIN nodes w ON w.id = e.source_id
    JOIN nodes p ON p.id = e.target_id
   WHERE e.edge_type = 'CREATED_BY'
     AND e.valid_until IS NULL
     AND p.slug = ?
   ORDER BY w.name""", ("vera-molnar",)).fetchall()
for name, image in works:
    print(name, image or "")</pre>
<p class='meta'>Every node's page on the site has its address: <code>/&lt;type&gt;/&lt;slug&gt;</code>. Edge types: CREATED_BY, EXHIBITED_AT, HELD_BY, COLLABORATES_WITH, PARTICIPATED_IN, REPRESENTS, EMBODIES, … (see the <a href="/skill.md">contributor contract</a>).</p>

<h3>What is in it — and what is not</h3>
<ul>
  <li>Five tables: <code>nodes</code>, <code>edges</code>, <code>signals</code> (the contributions), <code>contributors</code>, <code>node_aliases</code>, plus <code>meta</code> (when, from where, licence).</li>
  <li>Consent as on the site: a contribution given as <em>structural only</em> keeps the fact without its words; an anonymous one names no one; a revoked one keeps its row without its words.</li>
  <li>Nothing private: no email addresses, sign-in tokens, sessions, drafts in progress, review notes or notification settings.</li>
  <li>Images are not in the file. <code>metadata.cdn_image_url</code> points at the public image mirror (<code>${esc(R2_PUBLIC)}</code>); <code>image_url</code> keeps the upstream source.</li>
  <li>No embedding vectors (yet).</li>
</ul>

<h3>Licence</h3>
<p>The knowledge graph is licensed <strong>CC BY-SA 4.0</strong> (attribution, share-alike) — the full statement is in the file's <code>meta</code> table and in <a href="https://github.com/a-digital-arts-institute/adai-v1/blob/main/LICENSE-DATA">LICENSE-DATA</a>. Mirrored artwork images are <strong>not</strong> covered: copyright stays with the artists and holding institutions.</p>

<h3>Contributing</h3>
<p>Changes you make to your copy stay on your machine. To add to the commons — a work, a relation, your own account — use the live site: <a href="/contribute">contribute</a>.</p>`;
  return htmlPage("Offline", body);
}

router.get("/offline", (_req, res) => {
  res.set(HTML_HEADERS).send(offlinePage(process.env.SNAPSHOT_URL || null));
});

export default router;
