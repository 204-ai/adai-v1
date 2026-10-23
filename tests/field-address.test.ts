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

type Entry = { url: string; state: any; external?: boolean };
/**
 * `external`: a page of another site before this one (going back to it
 * leaves the document: no popstate). `session`: the history of an earlier
 * harness, to load the page again over it (a reload).
 */
function harness(start: string, opts: { external?: boolean; session?: { entries: Entry[]; index: number }; settleMs?: number } = {}) {
  const session = opts.session ?? { entries: [...(opts.external ? [{ url: "https://elsewhere.test/", state: null, external: true }] : []), { url: start, state: null }], index: opts.external ? 1 : 0 };
  const entries: Entry[] = session.entries;
  let index = session.index;
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
  let left = false; // went back to another site: this document is gone
  const go = (d: number) => {
    // A traversal is asynchronous, as in browsers: the index moves (and
    // location / state change) only when the event fires.
    timers.push(() => {
      const next = index + d;
      if (next < 0 || next >= entries.length) return;
      index = next;
      session.index = index;
      if (entries[index].external) { left = true; return; }
      setLoc();
      listeners.forEach((f) => f({ state: entries[index].state }));
    });
  };
  const history = {
    get state() { return entries[index].state; },
    pushState(state: any, _t: string, url: string) {
      entries.splice(index + 1);
      entries.push({ url, state: structuredClone(state) });
      index++;
      session.index = index;
      setLoc();
    },
    replaceState(state: any, _t: string, url: string) {
      entries[index] = { url, state: structuredClone(state) };
      setLoc();
    },
    back: () => go(-1),
    go: (d: number) => go(d),
    forward: () => go(1),
  };
  const win = {
    location,
    history,
    addEventListener: (t: string, f: any) => { if (t === "popstate") listeners.push(f); },
    setTimeout: (f: () => void) => { timers.push(f); return f; },
    clearTimeout: (f: any) => { const i = timers.indexOf(f); if (i >= 0) timers.splice(i, 1); },
  };
  const ctx: any = { window: win, URLSearchParams };
  vm.runInNewContext(SRC, ctx);
  // the screen: what is focused, which profile is open
  const screen = { focusId: null as string | null, profileId: null as string | null };
  const applied: any[] = [];
  let interrupted = 0;
  const addr = ctx.window.ADAI_FIELD_ADDRESS.create({
    interrupted: () => { interrupted++; },
    win,
    settleMs: opts.settleMs ?? 1e9,
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
  // what graph-field.js does at start: a reload picks its entry up again
  const restored = addr.rehydrate();
  if (restored) {
    screen.focusId = restored.focus;
    screen.profileId = restored.profile ? restored.id : null;
    addr.changed();
  }
  const flush = () => { while (timers.length) timers.shift()!(); };
  return {
    addr, screen, applied, flush, session, restored, timers,
    get left() { return left; },
    get state() { return entries[index].state; },
    get interrupted() { return interrupted; },
    get url() { return entries[index].url; },
    get length() { return entries.length; },
    get index() { return index; },
    back() { history.back(); flush(); },
    /** A traversal that fires right away, ahead of anything queued (the visitor's own Back). */
    traverseNow(d: number) {
      index += d; session.index = index; setLoc();
      listeners.forEach((f) => f({ state: entries[index].state }));
    },
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

  // its close button goes back to the address it was opened over — no extra step
  h.screen.profileId = null;
  h.addr.profileDismissed();
  h.flush();
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

it("field address: dismissing a profile reached from another profile's link goes back to where the chain began", () => {
  const h = harness(OUTLIER);
  h.addr.expect(h.addr.urlFor("institution:the outlier collection"));
  h.addr.landing();
  h.set("institution:the outlier collection");
  // the Outlier's profile, over its own focus: no step
  h.set("institution:the outlier collection", "institution:the outlier collection");
  assert.equal(h.length, 1);

  // a relation link in that profile, in the overlay's real order:
  // field.zoomTo(Mapan) first, then open(Mapan) — one coalesced pass
  h.screen.focusId = "practitioner:william mapan";
  h.addr.changed();
  h.screen.profileId = "practitioner:william mapan";
  h.addr.changed();
  h.flush();
  assert.equal(h.url, MAPAN);
  assert.equal(h.length, 2);

  // and on to a third profile from there
  h.screen.focusId = "artwork:anticyclone";
  h.screen.profileId = "artwork:anticyclone";
  h.addr.changed();
  h.flush();
  assert.equal(h.length, 3);

  // the close button: focus is Anticyclone now, yet the address goes back
  // to the Outlier, focused there, profile closed
  h.screen.profileId = null;
  h.addr.profileDismissed();
  h.flush();
  assert.equal(h.url, OUTLIER);
  assert.equal(h.index, 0);
  assert.equal(h.screen.profileId, null);
  assert.equal(h.screen.focusId, "institution:the outlier collection");
  assert.equal(h.length, 3, "nothing pushed: Forward still leads into the profiles");

  // Forward restores Mapan's profile, then Anticyclone's
  h.forward();
  assert.equal(h.url, MAPAN);
  assert.equal(h.screen.profileId, "practitioner:william mapan");
  h.forward();
  assert.equal(h.screen.profileId, "artwork:anticyclone");

  // "view in field" (not a dismissal) settles where the field is: Anticyclone
  h.screen.profileId = null;
  h.addr.changed();
  h.flush();
  assert.equal(h.url, "/field/artwork/anticyclone");
  assert.equal(h.index, 2);
  assert.equal(h.screen.profileId, null);
});

it("field address: a dismissal with nothing pushed just closes in place", () => {
  const h = harness(MAPAN);
  h.set("practitioner:william mapan");
  h.set("practitioner:william mapan", "practitioner:william mapan");
  h.screen.profileId = null;
  h.addr.profileDismissed();
  h.flush();
  assert.equal(h.url, MAPAN);
  assert.equal(h.length, 1);
});

it("field address: Back during a replayed reading drops its batch; only the owner ends it", () => {
  const h = harness("/field");
  const batch = h.addr.beginBatch();
  h.set("institution:the outlier collection");
  h.set("practitioner:william mapan");
  assert.equal(h.length, 2, "a reading is one step");
  h.back();
  assert.equal(h.interrupted, 1, "the field is told, so the replay stops");
  assert.equal(h.url, "/field");
  assert.equal(h.screen.focusId, null);
  h.addr.endBatch(batch); // the stale owner's end is harmless
  assert.equal(h.length, 2);
  h.forward();
  assert.equal(h.url, MAPAN, "Forward still holds the reading's end");
  // a new batch is not ended by the old token
  const b2 = h.addr.beginBatch();
  h.addr.endBatch(batch);
  h.set("artwork:anticyclone");
  h.set("institution:the outlier collection");
  assert.equal(h.length, 3, "still batched: one step for the second reading");
  h.addr.endBatch(b2);
});

// ---- second review round ------------------------------------------------------------------

const ANTI = "/field/artwork/anticyclone";
/** O focused, its profile, then Mapan's and Anticyclone's profiles from links (zoomTo → open). */
function chain(h: ReturnType<typeof harness>) {
  h.addr.expect(h.addr.urlFor("institution:the outlier collection"));
  h.addr.landing();
  h.set("institution:the outlier collection");
  h.set("institution:the outlier collection", "institution:the outlier collection");
  for (const id of ["practitioner:william mapan", "artwork:anticyclone"]) {
    h.screen.focusId = id; h.addr.changed();
    h.screen.profileId = id; h.addr.changed();
    h.flush();
  }
}

it("replay interrupted: its batch is dropped at once, the interruption is its own step (transition, dwell, snapshot)", () => {
  // during the dwell: A was written, then the visitor focuses B
  let h = harness("/field");
  let batch = h.addr.beginBatch();
  h.set("institution:the outlier collection");
  assert.equal(h.length, 2);
  h.addr.dropBatch(batch); // cancelReplay, synchronously
  h.set("practitioner:william mapan");
  assert.equal(h.length, 3, "B is a step: A's entry is not overwritten");
  h.addr.endBatch(batch); // the replay's finally, later: harmless
  h.back();
  assert.equal(h.url, OUTLIER, "Back finds the reading's hop");

  // during the transition wait: the hop's write had not happened yet
  h = harness("/field");
  batch = h.addr.beginBatch();
  h.screen.focusId = "institution:the outlier collection"; h.addr.changed(); // hop scheduled, not synced
  h.addr.dropBatch(batch);
  h.set("practitioner:william mapan");
  assert.equal(h.length, 2);
  assert.equal(h.url, MAPAN);

  // a shift-click snapshot during a replay: the jump is its own step
  h = harness("/field");
  batch = h.addr.beginBatch();
  h.set("institution:the outlier collection");
  h.set("practitioner:william mapan");
  h.addr.dropBatch(batch); // the snapshot's replayPath cancels the running one
  h.set("artwork:anticyclone");
  assert.equal(h.length, 3);
  h.back();
  assert.equal(h.url, MAPAN);
});

it("dismissal: the override applies only to the entry it meant; another traversal cancels it", () => {
  const h = harness(OUTLIER);
  chain(h);
  assert.equal(h.length, 3);
  h.screen.profileId = null;
  h.addr.profileDismissed();
  h.addr.sync(); // the dismissal's go(-2) is queued …
  h.traverseNow(-1); // … and the visitor's own Back lands first, on Mapan's entry
  assert.equal(h.screen.profileId, "practitioner:william mapan", "that entry restores its own state");
  h.flush(); // (the queued go(-2) from there leads nowhere)
  assert.equal(h.url, MAPAN);
  assert.equal(h.screen.profileId, "practitioner:william mapan");
  h.back(); // the Outlier entry, reached later, is not overridden: the intent was cancelled
  assert.equal(h.url, OUTLIER);
  assert.equal(h.screen.profileId, "institution:the outlier collection", "its own state (profile open), not the dismissal's");

  // the normal case still works: × from the end of the chain
  h.forward(); h.forward();
  assert.equal(h.url, ANTI);
  h.screen.profileId = null;
  h.addr.profileDismissed();
  h.flush();
  assert.equal(h.url, OUTLIER);
  assert.equal(h.screen.profileId, null);
  assert.equal(h.screen.focusId, "institution:the outlier collection");
});

it("reload mid-chain and at its end: the entry comes back with its chain; × and Back/Forward still work", () => {
  const h = harness(OUTLIER, { external: true });
  chain(h);
  // reload at the end
  let r = harness("", { session: h.session });
  assert.deepEqual({ ...r.restored }, { id: "artwork:anticyclone", profile: true, focus: "artwork:anticyclone" });
  r.flush();
  assert.equal(r.length, 4, "nothing written on reload");
  r.screen.profileId = null;
  r.addr.profileDismissed();
  r.flush();
  assert.equal(r.url, OUTLIER);
  assert.equal(r.screen.profileId, null);
  r.forward();
  assert.equal(r.screen.profileId, "practitioner:william mapan");

  // reload mid-chain (on Mapan's profile)
  r = harness("", { session: r.session });
  assert.equal(r.restored?.id, "practitioner:william mapan");
  r.flush();
  r.screen.profileId = null;
  r.addr.profileDismissed();
  r.flush();
  assert.equal(r.url, OUTLIER);
  r.forward(); r.forward();
  assert.equal(r.url, ANTI, "Forward still reaches the end of the chain");
  // back past the landing leaves the site: no popstate, nothing applied
  r.back(); r.back(); r.back();
  assert.equal(r.left, true);
});

it("a stale state does not rehydrate; a new arrival is stamped and lands by its path", () => {
  const h = harness(MAPAN);
  assert.equal(h.restored, null);
  assert.equal(h.state.adai, "field");
  assert.ok(h.state.key);
  assert.equal(h.state.focus, "practitioner:william mapan");
  // a state whose address does not match the location is not trusted
  const s = { entries: [{ url: MAPAN, state: { adai: "field", key: "k1", id: "artwork:anticyclone", profile: true, focus: "artwork:anticyclone" } }], index: 0 };
  const r = harness("", { session: s });
  assert.equal(r.restored, null);
});

it("branching after Back: a new step drops the old forward entries", () => {
  const h = harness("/field", { external: true });
  h.set("institution:the outlier collection");
  h.set("practitioner:william mapan");
  h.back();
  assert.equal(h.url, OUTLIER);
  h.set("artwork:anticyclone");
  assert.equal(h.url, ANTI);
  assert.equal(h.length, 4);
  h.forward();
  assert.equal(h.url, ANTI, "nothing forward any more");
  h.back(); h.back();
  assert.equal(h.url, "/field");
});

it("dismissal: when its step back never comes, the intent lapses (bounded)", () => {
  const h = harness(OUTLIER, { settleMs: 0 });
  chain(h);
  h.screen.profileId = null;
  h.addr.profileDismissed();
  h.addr.sync();
  h.timers.length = 0; // the go(-2) never fires
  h.traverseNow(-2); // much later, the visitor goes back there by hand
  assert.equal(h.screen.profileId, "institution:the outlier collection", "its own state: the lapsed intent does not apply");
});

it("superseding the initial navigation: cancelLanding drops the awaited address and the replace allowance", () => {
  // landing on A's deep link; the visitor focuses B before the landing fires
  let h = harness(OUTLIER);
  h.addr.expect(h.addr.urlFor("institution:the outlier collection"));
  h.addr.landing();
  h.addr.cancelLanding(); // what graph-field does when the visitor's focus supersedes it
  h.set("practitioner:william mapan");
  assert.equal(h.url, MAPAN, "B's address at once");
  assert.equal(h.length, 2, "its own history step (no leaked replace allowance)");
  h.back();
  assert.equal(h.url, OUTLIER);

  // without the cancel, the expectation would hold B's address back
  h = harness(OUTLIER);
  h.addr.expect(h.addr.urlFor("institution:the outlier collection"));
  h.set("practitioner:william mapan");
  assert.equal(h.url, OUTLIER, "(the bug: still waiting for A)");

  // a reload of a saved profile entry, superseded the same way
  const first = harness(OUTLIER);
  chain(first);
  const r = harness("", { session: first.session });
  assert.ok(r.restored);
  r.addr.cancelLanding();
  r.screen.profileId = null;
  r.set("practitioner:william mapan", null);
  assert.equal(r.url, MAPAN);
  assert.equal(r.length, 4, "a step after the restored entry");
});
