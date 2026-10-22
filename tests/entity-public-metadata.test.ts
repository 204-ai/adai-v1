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

it("externalLink: inherited object members are not builders; decimal ids stay strings", () => {
  for (const s of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(externalLink(s, "x"), null, s);
  }
  assert.deepEqual(externalLinks([{ source: "constructor", external_id: "1" }, { source: "__proto__", external_id: "2" }]), []);

  // leading zeros stripped as a string; huge ids never pass through Number()
  const huge = "123456789012345678901234567890";
  assert.ok(BigInt(huge) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(externalLink("fxhash", "0042")?.href, "https://www.fxhash.xyz/generative/42");
  assert.equal(externalLink("fxhash", huge)?.href, `https://www.fxhash.xyz/generative/${huge}`);
  assert.equal(externalLink("fxhash", "000"), null);
  assert.equal(externalLink("artblocks", "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270:0")?.href, "https://www.artblocks.io/project/0");
  assert.equal(externalLink("artblocks", "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270:007")?.href, "https://www.artblocks.io/project/7");
  assert.equal(externalLink("artblocks", `0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270:${huge}`)?.href, `https://www.artblocks.io/project/${huge}`);
  assert.equal(externalLink("superrare", "1-0x41a322b28d0ff354040e2cbc676f0320d8c8850d-00967")?.href, "https://superrare.com/0x41a322b28d0ff354040e2cbc676f0320d8c8850d/967");
  assert.equal(externalLink("superrare", `1-0x41a322b28d0ff354040e2cbc676f0320d8c8850d-${huge}`)?.href, `https://superrare.com/0x41a322b28d0ff354040e2cbc676f0320d8c8850d/${huge}`);
});

it("entity view: web links, hostile alias sources, the V&A label, showcase provenance in words", async () => {
  const db = initDb(":memory:");
  const node = db.prepare("INSERT INTO nodes (id, type, name, slug, metadata, updated_by) VALUES (?, ?, ?, ?, ?, 't')");
  const alias = db.prepare("INSERT INTO node_aliases (source, external_id, node_id) VALUES (?, ?, ?)");
  // web alias only → it becomes the web row; the V&A label is escaped
  node.run("collective:a", "collective", "Alias Web", "alias-web", JSON.stringify({}));
  alias.run("web", `https://example.org/a?x="1"&y=2`, "collective:a");
  alias.run("va", "O1248519", "collective:a");
  // metadata website wins over a web alias; a non-http alias is never a link
  node.run("collective:b", "collective", "Own Site", "own-site", JSON.stringify({ website: "https://own.example/" }));
  alias.run("web", "https://alias.example/", "collective:b");
  node.run("collective:c", "collective", "Bad Web", "bad-web", JSON.stringify({}));
  alias.run("web", "javascript:alert(1)", "collective:c");
  // sources that are Object.prototype members (the contributor API takes any string)
  node.run("practitioner:proto", "practitioner", "Proto", "proto", JSON.stringify({}));
  for (const s of ["constructor", "toString", "__proto__"]) alias.run(s, "x", "practitioner:proto");
  // the showcase node (src/entity/showcase.ts) gets the same strip and plain-words provenance
  node.run("practitioner:vera molnar", "practitioner", "Vera Molnár", "molnar-vera", JSON.stringify({}));
  alias.run("wikidata", "Q262249", "practitioner:vera molnar");

  const app = express();
  app.use(pages);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const both = async (type: string, slug: string, id: string) => {
    const p = await fetch(`${base}/${type}/${slug}`);
    const o = await fetch(`${base}/api/entity?id=${encodeURIComponent(id)}`);
    assert.equal(p.status, 200, `page ${id}`);
    assert.equal(o.status, 200, `overlay ${id}`);
    return [await p.text(), ((await o.json()) as any).html as string];
  };
  try {
    for (const html of await both("collective", "alias-web", "collective:a")) {
      assert.match(html, /<dt class="ev-meta-k">web<\/dt><dd class="ev-meta-v">:<a href="https:\/\/example\.org\/a\?x=&quot;1&quot;&amp;y=2" target="_blank" rel="noopener">example\.org\/a\?x=&quot;1&quot;&amp;y=2 ↗<\/a>/);
      assert.match(html, /<a href="https:\/\/collections\.vam\.ac\.uk\/item\/O1248519" target="_blank" rel="noopener">at the V&amp;A ↗<\/a>/);
    }
    for (const html of await both("collective", "own-site", "collective:b")) {
      assert.match(html, /href="https:\/\/own\.example\/"/);
      assert.doesNotMatch(html, /alias\.example/);
    }
    for (const html of await both("collective", "bad-web", "collective:c")) {
      assert.doesNotMatch(html, /javascript:/);
      assert.doesNotMatch(html, /ev-meta-k">web</);
    }
    for (const html of await both("practitioner", "proto", "practitioner:proto")) {
      assert.doesNotMatch(html, /ev-meta-k">elsewhere</);
    }
    for (const html of await both("practitioner", "molnar-vera", "practitioner:vera molnar")) {
      assert.match(html, /on Wikidata ↗/);
      assert.match(html, /AI-assisted profile/);
      assert.match(html, /not yet reviewed/);
      assert.doesNotMatch(html, /source_origin|confidence:|last_updated/);
    }
  } finally {
    server.close();
  }
});
