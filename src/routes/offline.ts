// GET /offline — the commons on your own machine (issue #82): how to download
// the public snapshot (src/snapshot/build.ts), open it, and read the graph
// from a script; and how to fork it — pull the public cr-sqlite change stream
// (GET /api/sync/*, src/routes/sync.ts) into a database of your own with
// `npm run fork:pull` and keep it up to date. The download URL is
// configuration (SNAPSHOT_URL); until it is set, the page says the snapshot
// is not published yet.

import { Router } from "express";
import { HTML_HEADERS, htmlEscape as esc, htmlPage } from "../templates.js";

const router = Router();

/** The public image mirror (R2), for the note on images. */
const R2_PUBLIC = "https://pub-ebd869876a824a5e83dbb2fe42d03211.r2.dev";

export function offlinePage(snapshotUrl: string | null, siteBase = "https://adai-basel.fly.dev"): string {
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

<h2 id="fork">Fork the commons</h2>
<p>The snapshot is a copy; a <em>fork</em> stays in step. The commons is stored as a CRDT (<a href="https://github.com/vlcn-io/cr-sqlite">cr-sqlite</a>), and its change stream is public: pull it into a database of your own, run the site on it, and pull again whenever you like — you get only what changed since.</p>
<h3>1. Pull</h3>
<pre>git clone https://github.com/a-digital-arts-institute/adai-v1 &amp;&amp; cd adai-v1
npm install
npm run fork:pull -- --from ${esc(siteBase)} --db ./fork.db</pre>
<p class='meta'>The first pull creates <code>fork.db</code> with the site's own schema and fetches everything; it stores where it came from (the source's site id) and how far it got in the file's <code>settings</code> table. Run the same command again to catch up. It refuses to pull into a database that is a fork of another source, or that already holds data of its own (<code>--force</code> to do it anyway), and a source whose schema differs from your code's (update the code first).</p>
<h3>2. Run the site on it</h3>
<pre>DB_PATH=./fork.db npm run dev     # http://localhost:8080</pre>
<h3>The endpoints</h3>
<ul>
  <li><a href="/api/sync/info"><code>GET /api/sync/info</code></a> — the source's site id, its current <code>db_version</code>, the hash of its CRR schema and the tables in the stream.</li>
  <li><code>GET /api/sync/changes?since=&lt;cursor&gt;&amp;limit=&lt;n&gt;</code> — the changes after a cursor (<code>0</code> = everything), as cr-sqlite's own <code>crsql_changes</code> rows <code>[table, pk, cid, val, col_version, db_version, site_id, cl, seq]</code>; <code>pk</code> is base64, <code>site_id</code> hex, values keep their SQLite type. Pass the page's <code>next</code> as the next <code>since</code> until <code>more</code> is false. Pages end on whole transactions (one bigger than the limit is split in order). gzip, no key, rate-limited.</li>
</ul>
<h3>What a fork gets — and when</h3>
<ul>
  <li>The same five tables as the snapshot, as live CRDT tables: <code>nodes</code>, <code>edges</code>, <code>signals</code>, <code>contributors</code>, <code>node_aliases</code>. What the commons does not publish is never in them: words given as <em>structural only</em>, revoked or still in review, anonymous contributors' names, the values an edit replaced, email addresses, tokens, the review queue.</li>
  <li><strong>Deletions and consent changes reach a fork only when it pulls again.</strong> A revocation or a restriction is a change like any other: the next pull blanks the words in your copy too. Pull often, and do not republish an old pull.</li>
  <li>No embeddings: the similarity vectors are not in the stream. Run <code>npm run embed:backfill</code> with your own key (<code>GEMINI_API_KEY</code>, or an OpenAI-compatible endpoint — see <a href="https://github.com/a-digital-arts-institute/adai-v1/blob/main/CLAUDE.md#embeddings">Embeddings</a>), then <code>npm run embed:derive</code>, for the similarity layer.</li>
  <li>Changes you make to your fork stay there; they do not flow back. To add to the commons, <a href="/contribute">contribute</a> on the live site.</li>
</ul>

<h3>Licence</h3>
<p>The software is licensed <strong>Apache-2.0</strong> (<a href="https://github.com/a-digital-arts-institute/adai-v1/blob/main/LICENSE">LICENSE</a>). The knowledge graph — the snapshot and the change stream alike — is licensed <strong>CC BY-SA 4.0</strong> (attribution, share-alike) — the full statement is in the snapshot's <code>meta</code> table and in <a href="https://github.com/a-digital-arts-institute/adai-v1/blob/main/LICENSE-DATA">LICENSE-DATA</a>. Mirrored artwork images are <strong>not</strong> covered: copyright stays with the artists and holding institutions; a fork links to them, it does not license them.</p>

<h3>Contributing</h3>
<p>Changes you make to your copy stay on your machine. To add to the commons — a work, a relation, your own account — use the live site: <a href="/contribute">contribute</a>.</p>`;
  return htmlPage("Offline", body);
}

router.get("/offline", (_req, res) => {
  const base = (process.env.ADAI_BASE_URL || "https://adai-basel.fly.dev").replace(/\/+$/, "");
  res.set(HTML_HEADERS).send(offlinePage(process.env.SNAPSHOT_URL || null, base));
});

export default router;
