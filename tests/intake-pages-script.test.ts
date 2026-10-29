// The intake pages ship their JavaScript inside TypeScript template literals,
// where an escape like \' collapses to a bare quote in the served script.
// One such slip left every /draft/:id stuck on "loading draft…" while every
// other test passed — so parse every inline script the pages serve.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contributePage, draftPage, batchPage } from "../src/intake/pages.js";
import { assistantGuidePage } from "../src/intake/assistant-guide.js";

function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).filter((s) => s.trim());
}

describe("intake page scripts parse", () => {
  const pages: Array<[string, string]> = [
    ["/contribute", contributePage()],
    ["/draft/:id", draftPage("drf_0123456789abcdef")],
    ["/batch/:id", batchPage({ batch_id: "drf_x", signals: [], edges: [], ended: [], intake: [], pages: [], review_state: "live" }, true, ["a@b.c"])],
  ];
  for (const [name, html] of pages) {
    it(name, () => {
      for (const s of scriptsOf(html)) assert.doesNotThrow(() => new Function(s), `${name}: inline script does not parse`);
    });
  }
  it("the draft page actually has a script", () => assert.ok(scriptsOf(draftPage("drf_x")).length > 0));
});

describe("assistant setup guide", () => {
  it("/contribute links to /contribute/assistant, not the field overlay", () => {
    assert.match(contributePage(), /href="\/contribute\/assistant"/);
    assert.doesNotMatch(contributePage(), /field#assistant/);
  });
  it("renders the seven steps on a page of its own", () => {
    const html = assistantGuidePage();
    assert.match(html, /Set up once\. Then just talk\./);
    for (const n of ["01", "02", "03", "04", "05", "06", "07"]) assert.match(html, new RegExp(`<div class="no">${n}</div>`));
    assert.match(html, /href="\/skill\.md"/);
  });
});

describe("draft drawer scroll (#101)", () => {
  const html = draftPage("drf_0123456789abcdef");
  it("only follows the conversation when the reader is near the bottom", () => {
    assert.match(html, /scrollHeight - oldLog\.scrollTop - oldLog\.clientHeight < 40/);
    assert.match(html, /log\.scrollTop = oldTop/);
  });
  it("skips the rebuild when nothing changed", () => {
    assert.match(html, /if \(sig === railSig && rail\.querySelector\('\.log'\)\) return;/);
  });
  it("keeps summary and survey in details, and offers a new-messages button", () => {
    assert.match(html, /<details data-r="survey"/);
    assert.match(html, /id="newmsg"/);
  });
  it("no longer forces the log to the bottom on every render", () => {
    assert.doesNotMatch(html, /const log = rail\.querySelector\('\.log'\); if \(log\) log\.scrollTop = log\.scrollHeight;/);
  });
});
