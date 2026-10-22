// Issue #86: the public entity view (page and /api/entity overlay) does not
// print stored metadata verbatim. metadata.status — a free-form import label —
// stays on /record; platform ids become plain labelled links, or nothing.

import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initDb } from "../src/db.js";
import pages from "../src/routes/pages.js";
import { externalLink, externalLinks } from "../src/entity/external-links.js";

it("externalLink: builds a URL only from an id shape it recognises", () => {
  const tz = "tz1eJF2r9JsfDLAswoo5iCDk6Qv2yWt6fbMX";
  assert.deepEqual(externalLink("fxhash", `user:${tz}`), { label: "on fxhash", href: `https://www.fxhash.xyz/u/${tz}` });
  assert.deepEqual(externalLink("fxhash", "2418"), { label: "on fxhash", href: "https://www.fxhash.xyz/generative/2418" });
  assert.equal(externalLink("artblocks", "0x99a9b7c1116f9ceeb1652de04d5969cce509b069:470")?.href, "https://www.artblocks.io/project/470");
  assert.equal(externalLink("artblocks", "0x1111111111111111111111111111111111111111:470"), null, "an unknown contract has no shared numbering");
  assert.equal(externalLink("superrare", "1-0x41a322b28d0ff354040e2cbc676f0320d8c8850d-3363")?.href, "https://superrare.com/0x41a322b28d0ff354040e2cbc676f0320d8c8850d/3363");
  assert.equal(externalLink("superrare_artist", "0x79f7c440b359dece7f2a74813a94c36e3aba740e")?.label, "on SuperRare");
  assert.equal(externalLink("va", "O1248519")?.href, "https://collections.vam.ac.uk/item/O1248519");
  assert.equal(externalLink("wikidata", "Q4888685")?.href, "https://www.wikidata.org/wiki/Q4888685");

  // names, vocabulary and junk stay off the page
  assert.equal(externalLink("artblocks_artist", "william mapan"), null);
  assert.equal(externalLink("va_maker", "lillian schwartz"), null);
  assert.equal(externalLink("term", "Algorave"), null);
  assert.equal(externalLink("folksonomy_tag", "glitch"), null);
  assert.equal(externalLink("wikidata", "NO WD ITEM"), null);
  assert.equal(externalLink("fxhash", "user:tz1<script>"), null);
  assert.equal(externalLink("fxhash", "javascript:alert(1)"), null);
  assert.equal(externalLink("nobody-knows", "x"), null);

  // one link per URL
  assert.equal(externalLinks([
    { source: "superrare_artist", external_id: "0x79f7c440b359dece7f2a74813a94c36e3aba740e" },
    { source: "superrare_artist", external_id: "0x79F7C440B359DECE7F2A74813A94C36E3ABA740E" },
  ]).length, 1);
});

it("entity view: no raw status or import ids on the public page; /record keeps them", async () => {
  const db = initDb(":memory:");
  const tz = "tz1eJF2r9JsfDLAswoo5iCDk6Qv2yWt6fbMX";
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, 't')").run(
    "practitioner:william mapan", "practitioner", "William Mapan", "william-mapan",
    JSON.stringify({ summary: "Generative artist.", status: "confirmed", claimed: { at: "2026-10-01T00:00:00Z", handle: "mapan", by: [] } }),
  );
  db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, 't')").run(
    "practitioner:nobody", "practitioner", "Nobody", "nobody", JSON.stringify({ status: "seed" }),
  );
  const alias = db.prepare("INSERT INTO node_aliases (source, external_id, node_id) VALUES (?, ?, ?)");
  alias.run("fxhash", `user:${tz}`, "practitioner:william mapan");
  alias.run("artblocks_artist", "william mapan", "practitioner:william mapan");
  alias.run("superrare_artist", "0x79f7c440b359dece7f2a74813a94c36e3aba740e", "practitioner:william mapan");
  alias.run("va_maker", "nobody", "practitioner:nobody");

  const app = express();
  app.use(pages);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const page = await (await fetch(`${base}/practitioner/william-mapan`)).text();
    const overlay = ((await (await fetch(`${base}/api/entity?id=${encodeURIComponent("practitioner:william mapan")}`)).json()) as any).html as string;
    for (const html of [page, overlay]) {
      assert.doesNotMatch(html, />status</, "no status row");
      assert.doesNotMatch(html, /confirmed/);
      assert.doesNotMatch(html, new RegExp(`user:${tz}`), "no raw fxhash id");
      assert.doesNotMatch(html, />artblocks_artist</);
      assert.match(html, new RegExp(`<a href="https://www\\.fxhash\\.xyz/u/${tz}" target="_blank" rel="noopener">on fxhash ↗</a>`));
      assert.match(html, /<a href="https:\/\/superrare\.com\/0x79f7c440b359dece7f2a74813a94c36e3aba740e" [^>]*>on SuperRare ↗<\/a>/);
      assert.match(html, /<dt class="ev-meta-k">elsewhere<\/dt>/);
      // what the system does know: the claim
      assert.match(html, /✓ claimed by <a href="\/@mapan\/history">@mapan<\/a>/);
    }

    // an alias that makes no link leaves no row at all
    const nobody = await (await fetch(`${base}/practitioner/nobody`)).text();
    assert.doesNotMatch(nobody, /ev-meta-k">(status|elsewhere|va_maker)</);
    assert.doesNotMatch(nobody, />seed</);

    // the back office keeps everything
    const record = await (await fetch(`${base}/record/practitioner/william-mapan`)).text();
    assert.match(record, /Status: <span class='tag'>confirmed<\/span>/);
    assert.match(record, new RegExp(`user:${tz}`));
    assert.match(record, /william mapan/);
  } finally {
    server.close();
  }
});
