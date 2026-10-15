// A slug is a URL path segment (issue #61): accents transliterate, reserved
// punctuation never survives, repeats collapse. Nodes slugged under the old
// rules stay findable through legacySlugify / slugForCreate.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugify, legacySlugify, slugForCreate, nodeId } from "../src/utils/slug.js";

describe("slugify", () => {
  it("lowercases and dash-separates", () => {
    assert.equal(slugify("Casey Reas"), "casey-reas");
    assert.equal(slugify("HOLLY HERNDON"), "holly-herndon");
  });

  it("strips punctuation the seed treats as decorative", () => {
    assert.equal(slugify("Forensic Architecture (Studio)"), "forensic-architecture-studio");
    assert.equal(slugify("R.U.R."), "rur");
    assert.equal(slugify("don't"), "dont");
    assert.equal(slugify("don’t"), "dont");
  });

  it("expands & to 'and' (mirrors the seed convention)", () => {
    assert.equal(slugify("Holly Herndon & Mat Dryhurst"), "holly-herndon-and-mat-dryhurst");
    assert.equal(slugify("pls&ty"), "plsandty");
  });

  it("collapses repeats and trims the ends", () => {
    assert.equal(slugify("foo  bar"), "foo-bar");
    assert.equal(slugify("foo_-bar"), "foo-bar");
    assert.equal(slugify("  — foo — "), "foo");
  });

  it("drops URL-reserved characters and non-hyphen dashes", () => {
    assert.equal(slugify("Aaron at Tsukuba, #6 22/5/85"), "aaron-at-tsukuba-6-22-5-85");
    assert.equal(slugify("32 Blaue Quadrate – 32 carrés bleus"), "32-blaue-quadrate-32-carres-bleus");
    assert.equal(slugify("What? Why!"), "what-why");
    assert.equal(slugify("idle/interludes"), "idle-interludes");
    assert.match(slugify("a#b,c/d?e(f)g–h—i"), /^[a-z0-9-]+$/);
  });

  it("transliterates accents and Latin letters to ASCII", () => {
    assert.equal(slugify("Toujours là"), "toujours-la");
    assert.equal(slugify("Kunsthalle Zürich"), "kunsthalle-zurich");
    assert.equal(slugify("Straße"), "strasse");
    assert.equal(slugify("Łódź Ørsted"), "lodz-orsted");
  });

  it("keeps letters of other scripts instead of erasing the name", () => {
    assert.equal(slugify("草間 彌生"), "草間-彌生");
    assert.equal(slugify("#?!"), "");
  });
});

describe("legacy slugs", () => {
  it("legacySlugify reproduces the pre-October-2026 rules", () => {
    assert.equal(legacySlugify("Toujours là"), "toujours-là");
    assert.equal(legacySlugify("Light Speculation #1"), "light-speculation-#1");
  });

  it("slugForCreate reuses a node made under the old rules", () => {
    const ids = new Set(["artwork:toujours-là"]);
    const exists = (id: string) => ids.has(id);
    assert.equal(slugForCreate(exists, "artwork", "Toujours là"), "toujours-là");
    assert.equal(slugForCreate(exists, "artwork", "Kunsthalle Zürich"), "kunsthalle-zurich");
    ids.add("artwork:toujours-la");
    assert.equal(slugForCreate(exists, "artwork", "Toujours là"), "toujours-la");
  });
});

describe("nodeId", () => {
  it("composes type:slug", () => {
    assert.equal(nodeId("practitioner", "Casey Reas"), "practitioner:casey-reas");
    assert.equal(nodeId("artwork", "Fidenza"), "artwork:fidenza");
  });
});
