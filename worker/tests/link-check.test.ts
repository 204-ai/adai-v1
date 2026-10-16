// fetch_page retries a transient failure once and records what still failed;
// a card's link_check comes only from that record (issue #75).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTool, type ToolContext } from "../src/tools.js";
import { newPolicy, FetchRefused, type FetchedPage } from "../src/browser.js";

const page = (url: string, status = 200): FetchedPage => ({
  url, final_url: url, status, title: "t", text: "Works: ZOOM", links: [], images: [], via: "browser", sha256: "ab".repeat(32), chars: 11,
});

function ctx(fetchPage: ToolContext["fetchPage"]): ToolContext & { sent: Array<{ name: string; input: any }>; slept: number[] } {
  const sent: Array<{ name: string; input: any }> = [];
  const slept: number[] = [];
  const policy = newPolicy("https://teh.example/", { maxPages: 50 });
  policy.offsiteAllowed.add("https://www.fxhash.xyz/generative/20567");
  return {
    draftId: "drf_x", policy, sent, slept, fetchPage,
    addPage: async () => {},
    sleep: async (ms) => { slept.push(ms); },
    draftTool: async (_d, name, input) => { sent.push({ name, input }); return { ok: true, result: { ok: true, cid: "c_01" } }; },
  };
}

describe("fetch_page: retry and failure record", () => {
  it("a DNS failure is retried once; a success clears it", async () => {
    let n = 0;
    const c = ctx(async (url) => { if (n++ === 0) throw new Error("getaddrinfo ENOTFOUND www.fxhash.xyz"); return page(url); });
    const r = await runTool(c, "fetch_page", { url: "https://www.fxhash.xyz/generative/20567" });
    assert.equal(r.is_error, false);
    assert.equal(n, 2);
    assert.equal(c.slept.length, 1);
    assert.equal(c.linkFailures?.size ?? 0, 0);
  });

  it("a DNS failure twice is recorded as dns; a 404 page as http 404; a 5xx is retried first", async () => {
    const c = ctx(async (url) => {
      if (url.includes("fxhash")) throw new Error("net::ERR_NAME_NOT_RESOLVED");
      if (url.endsWith("/gone")) return page(url, 404);
      return page(url, 502);
    });
    assert.equal((await runTool(c, "fetch_page", { url: "https://www.fxhash.xyz/generative/20567" })).is_error, true);
    assert.equal((await runTool(c, "fetch_page", { url: "https://teh.example/gone" })).is_error, false);
    await runTool(c, "fetch_page", { url: "https://teh.example/flaky" });
    const f = Object.fromEntries([...c.linkFailures!.values()].map((x) => [x.url, [x.status, x.reason]]));
    assert.deepEqual(f, {
      "https://www.fxhash.xyz/generative/20567": [null, "dns"],
      "https://teh.example/gone": [404, "http"],
      "https://teh.example/flaky": [502, "http"],
    });
    assert.equal(c.slept.length, 2, "DNS and 5xx retried once each; a 404 is not");
  });

  it("a policy refusal is neither retried nor recorded", async () => {
    let n = 0;
    const c = ctx(async () => { n++; throw new FetchRefused("robots.txt disallows this path", "robots"); });
    await runTool(c, "fetch_page", { url: "https://teh.example/private" });
    assert.equal(n, 1);
    assert.equal(c.linkFailures?.size ?? 0, 0);
  });
});

describe("link_url on a card", () => {
  it("attaches the worker's own record, and nothing the model claims", async () => {
    const c = ctx(async () => { throw new Error("getaddrinfo EAI_AGAIN www.fxhash.xyz"); });
    await runTool(c, "fetch_page", { url: "https://www.fxhash.xyz/generative/20567" });
    const ev = { page_url: "https://teh.example/", quote: "Works: ZOOM" };
    await runTool(c, "propose_node", { type: "artwork", name: "ZOOM", ...ev, link_url: "https://www.fxhash.xyz/generative/20567/" });
    const r = await runTool(c, "propose_node", { type: "artwork", name: "Other", ...ev, link_url: "https://teh.example/fine", link_check: { url: "x", status: 404, reason: "http" } });
    assert.equal(c.sent[0]!.input.link_check.reason, "dns");
    assert.equal(c.sent[0]!.input.link_check.url, "https://www.fxhash.xyz/generative/20567");
    assert.ok(!("link_url" in c.sent[0]!.input));
    assert.ok(!("link_check" in c.sent[1]!.input), "a link that did not fail, and a link_check from the model, are dropped");
    assert.match(String(r.content), /did not fail this pass/);
  });
});
