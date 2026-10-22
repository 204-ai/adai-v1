// Issue #83, the /field client (public/field/js-interface/activity.js): live
// or empty, never stale — with fake time. The controller takes its clock,
// fetch, timers and renderer as arguments; loaded without a DOM, the script
// only defines it.

import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../public/field/js-interface/activity.js", import.meta.url), "utf8");
const H = 3600_000;

function harness(answers: Array<() => any>) {
  let now = Date.parse("2026-10-27T12:00:00Z");
  let hidden = false;
  const timers: Array<{ at: number; f: () => void; id: number }> = [];
  let seq = 0;
  const renders: string[][] = [];
  let stopped = 0;
  let fetches = 0;
  const ctx: any = {};
  vm.runInNewContext(SRC, ctx);
  const feed = ctx.ADAI_ACTIVITY_CORE.create({
    fetchJson: async () => {
      const a = answers[Math.min(fetches, answers.length - 1)];
      fetches++;
      return a();
    },
    render: (events: any[]) => renders.push(Array.from(events, (e: any) => String(e.text))),
    stop: () => { stopped++; },
    now: () => now,
    setTimeout: (f: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, f, id }); return id; },
    clearTimeout: (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    hidden: () => hidden,
  });
  /** Move the clock, firing timers in order. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.f();
      await new Promise((r) => setImmediate(r));
    }
    now = end;
  };
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  return {
    feed, renders, advance, iso,
    get last() { return renders[renders.length - 1]; },
    get stopped() { return stopped; },
    get fetches() { return fetches; },
    setHidden(v: boolean) { hidden = v; feed.visibility(); },
    /** The clock moves while timers do not run (a suspended tab). */
    jump(ms: number) { now += ms; },
    get now() { return now; },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

it("each line leaves at its own 24 h mark, on a timer, without a new answer", async () => {
  let h!: ReturnType<typeof harness>;
  const answer = () => ({ enabled: true, events: [
    { at: h.iso(23.5 * H), text: "old" },
    { at: h.iso(1 * H), text: "new" },
  ] });
  // after the first answer the server is unreachable (but the timer must still expire lines)
  h = harness([answer, () => { throw new Error("offline"); }]);
  await h.feed.poll();
  assert.deepEqual(h.last, ["old", "new"]);
  // the timer path alone: no polling while hidden, then past "old"'s 24 h mark
  h.setHidden(true);
  await h.advance(31 * 60_000);
  assert.deepEqual(h.feed.events.map((e: any) => e.text), ["new"]);
  assert.deepEqual(h.last, ["new"], "expired by the timer, not by a poll");
});

it("coming back into view drops what expired while away, before asking again", async () => {
  let h!: ReturnType<typeof harness>;
  let n = 0;
  h = harness([() => (n++ === 0
    ? { enabled: true, events: [{ at: h.iso(23 * H), text: "almost gone" }] }
    : new Promise(() => {}))]); // the next answer never comes
  await h.feed.poll();
  assert.deepEqual(h.last, ["almost gone"]);
  h.setHidden(true);
  h.jump(2 * H); // the tab sleeps; its timers do not run
  h.setHidden(false);
  assert.deepEqual(h.last, [], "expired on return, before the (slow) answer");
  await flush();
});

it("an error, an HTTP failure or a malformed answer clears and hides the feed", async () => {
  for (const bad of [
    () => { throw new Error("network"); },
    () => { throw new Error("activity 500"); },
    () => ({ hello: "world" }),
    () => ({ enabled: true, events: "nope" }),
    () => null,
  ]) {
    let h!: ReturnType<typeof harness>;
    h = harness([() => ({ enabled: true, events: [{ at: h.iso(H), text: "live" }] }), bad]);
    await h.feed.poll();
    assert.deepEqual(h.last, ["live"]);
    await h.advance(60_000); // the next poll
    assert.deepEqual(h.last, [], String(bad));
  }
});

it("switched off: stops for good; hidden: no polling; visible again: polls at once", async () => {
  let h!: ReturnType<typeof harness>;
  h = harness([() => ({ enabled: true, events: [{ at: h.iso(H), text: "a" }] }), () => ({ enabled: false, events: [] })]);
  await h.feed.poll();
  h.setHidden(true);
  await h.advance(10 * 60_000);
  assert.equal(h.fetches, 1, "no requests while hidden");
  h.setHidden(false);
  await flush();
  assert.equal(h.fetches, 2, "one request on return");
  assert.equal(h.stopped, 1);
  await h.advance(10 * 60_000);
  assert.equal(h.fetches, 2, "off: no more requests");
});

it("pure helpers: the window and the next deadline", () => {
  const ctx: any = {};
  vm.runInNewContext(SRC, ctx);
  const { live, nextExpiry } = ctx.ADAI_ACTIVITY_CORE;
  const now = Date.parse("2026-10-27T12:00:00Z");
  const ev = [{ at: new Date(now - 25 * H).toISOString() }, { at: new Date(now - 23 * H).toISOString() }, { at: "garbage" }];
  assert.equal(live(ev, now).length, 1);
  assert.equal(nextExpiry(live(ev, now), now), H);
  assert.equal(nextExpiry([], now), null);
});
