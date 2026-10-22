// Issue #85: the address bar follows the open profile in /field.
// public/field/js-interface/field-address.js is a plain browser script; it is
// run here in a vm with a fake window whose history behaves like a browser's
// (a stack of entries, push truncates forward, back/forward fire popstate).

import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../public/field/js-interface/field-address.js", import.meta.url), "utf8");

const NODES: Record<string, { type: string; slug: string }> = {
  "institution:the outlier collection": { type: "institution", slug: "the-outlier-collection" },
  "practitioner:william mapan": { type: "practitioner", slug: "william-mapan" },
  "artwork:anticyclone": { type: "artwork", slug: "anticyclone" },
};
const bySlugPath = (path: string) => {
  const m = path.match(/^\/field\/([a-z_]+)\/([^/?#]+)/);
  if (!m) return null;
  return Object.keys(NODES).find((id) => NODES[id].type === m[1] && NODES[id].slug === decodeURIComponent(m[2])) ?? null;
};

function harness(start: string) {
  const entries: Array<{ url: string; state: any }> = [{ url: start, state: null }];
  let index = 0;
  const listeners: Array<(e: any) => void> = [];
  const timers: Array<() => void> = [];
  const location = {} as any;
  const setLoc = () => {
    const u = new URL(entries[index].url, "http://x.test");
    location.pathname = u.pathname;
    location.search = u.search;
    location.hash = u.hash;
  };
  setLoc();
  const go = (d: number) => {
    const next = index + d;
    if (next < 0 || next >= entries.length) return;
    index = next;
    setLoc();
    // browsers fire popstate asynchronously
    timers.push(() => listeners.forEach((f) => f({ state: entries[index].state })));
  };
  const history = {
    get state() { return entries[index].state; },
    pushState(state: any, _t: string, url: string) {
      entries.splice(index + 1);
      entries.push({ url, state: structuredClone(state) });
      index++;
      setLoc();
    },
    replaceState(state: any, _t: string, url: string) {
      entries[index] = { url, state: structuredClone(state) };
      setLoc();
    },
    back: () => go(-1),
    forward: () => go(1),
  };
  const win = {
    location,
    history,
    addEventListener: (t: string, f: any) => { if (t === "popstate") listeners.push(f); },
    setTimeout: (f: () => void) => { timers.push(f); return timers.length; },
    clearTimeout: () => {},
  };
  const ctx: any = { window: win, URLSearchParams };
  vm.runInNewContext(SRC, ctx);
  // the screen: what is focused, which profile is open
  const screen = { focusId: null as string | null, profileId: null as string | null };
  const applied: any[] = [];
  const addr = ctx.window.ADAI_FIELD_ADDRESS.create({
    win,
    settleMs: 1e9,
    nodeFor: (id: string) => NODES[id] ?? null,
    read: () => ({ ...screen }),
    idFromLocation: (l: any) => bySlugPath(l.pathname),
    apply: (s: any) => {
      applied.push(s);
      screen.profileId = s.profile ? s.id : null;
      if (s.focus) screen.focusId = s.focus;
      else if (!s.profile) screen.focusId = null;
      addr.changed(); // what the field's own hooks would report
    },
  });
  const flush = () => { while (timers.length) timers.shift()!(); };
  return {
    addr, screen, applied, flush,
    get url() { return entries[index].url; },
    get length() { return entries.length; },
    get index() { return index; },
    back() { history.back(); flush(); },
    forward() { history.forward(); flush(); },
    set(focusId: string | null, profileId: string | null = screen.profileId) {
      screen.focusId = focusId;
      screen.profileId = profileId;
      addr.changed();
      flush();
    },
  };
}

const MAPAN = "/field/practitioner/william-mapan";
const OUTLIER = "/field/institution/the-outlier-collection";

it("field address: a deep link settles in place; focusing and opening a profile are steps; Back/Forward re-apply", () => {
  const h = harness(OUTLIER);
  // landing on the deep link: held until the focus arrives, then no new step
  h.addr.expect(h.addr.urlFor("institution:the outlier collection"));
  h.addr.landing();
  h.set(null); // an unrelated early repaint must not rewrite the address
  assert.equal(h.url, OUTLIER);
  h.set("institution:the outlier collection");
  assert.equal(h.url, OUTLIER);
  assert.equal(h.length, 1);

  // open William Mapan's profile over the Outlier focus (the issue's example)
  h.set("institution:the outlier collection", "practitioner:william mapan");
  assert.equal(h.url, MAPAN);
  assert.equal(h.length, 2);

  // closing it goes back to the address it was opened over — no extra step
  h.set("institution:the outlier collection", null);
  assert.equal(h.url, OUTLIER);
  assert.equal(h.index, 0);
  assert.equal(h.screen.profileId, null);

  // Forward re-opens the profile, without pushing
  h.forward();
  assert.equal(h.url, MAPAN);
  assert.equal(h.screen.profileId, "practitioner:william mapan");
  assert.equal(h.length, 2);

  // Back closes it again
  h.back();
  assert.equal(h.url, OUTLIER);
  assert.equal(h.screen.profileId, null);
  assert.equal(h.screen.focusId, "institution:the outlier collection");
});

it("field address: focus changes push once; re-focusing the same node adds nothing; unfocus is /field", () => {
  const h = harness("/field?lens=1");
  h.set("practitioner:william mapan");
  assert.equal(h.url, `${MAPAN}?lens=1`, "other parameters are kept");
  h.set("practitioner:william mapan");
  h.set("practitioner:william mapan", "practitioner:william mapan"); // its profile, over it: same address
  assert.equal(h.length, 2);
  assert.equal(h.url, `${MAPAN}?lens=1`);
  h.set("practitioner:william mapan", null);
  assert.equal(h.length, 2);
  h.set("artwork:anticyclone");
  assert.equal(h.url, "/field/artwork/anticyclone?lens=1");
  h.set(null);
  assert.equal(h.url, "/field?lens=1");
  assert.equal(h.length, 4);

  h.back();
  assert.equal(h.screen.focusId, "artwork:anticyclone");
  h.back();
  assert.equal(h.screen.focusId, "practitioner:william mapan");
  assert.equal(h.screen.profileId, null);
  h.back(); // the landing entry, which we never wrote: read from its path
  assert.equal(h.url, "/field?lens=1");
  assert.equal(h.screen.focusId, null);
  assert.equal(h.length, 4, "popstate never pushes");
});

it("field address: legacy ?node= and a replayed reading settle without extra steps", () => {
  const h = harness("/field?node=william-mapan");
  h.addr.expect(h.addr.urlFor("practitioner:william mapan"));
  h.addr.landing();
  h.set("practitioner:william mapan");
  assert.equal(h.url, MAPAN, "?node= is dropped once the address is ours");
  assert.equal(h.length, 1);

  // a reading replays hop by hop: one step in all
  h.addr.beginBatch();
  h.set("artwork:anticyclone");
  h.set("institution:the outlier collection");
  h.addr.endBatch();
  h.flush();
  assert.equal(h.url, OUTLIER);
  assert.equal(h.length, 2);

  // a #hash step on the same address changes nothing on screen
  const before = h.applied.length;
  h.addr.onPopState({ state: null });
  assert.equal(h.applied.length, before);
});
