/**
 * A(DAI) — the field's address (issue #85)
 *
 * The field READS clean URLs (/field/<type>/<slug>, issue #71); this makes it
 * WRITE them too. The address is derived from what is on screen:
 *
 *   profile open on Y   → /field/<Y type>/<Y slug>
 *   else node X focused → /field/<X type>/<X slug>
 *   else                → /field
 *
 * Whenever that changes, the address follows with a history step (pushState);
 * when it does not (the same node re-focused, its profile opened over it) the
 * entry's state is updated in place and no duplicate step is added. Closing a
 * profile whose step we pushed goes BACK to the address it was opened over,
 * so open/close is one step, as Back/Forward are. popstate re-applies an
 * entry (focus + profile) through `apply` without pushing again.
 *
 * Every entry we write carries { adai: 'field', id, profile, focus, prev }.
 * Other query parameters (lens, seed, …) and the hash are kept; the legacy
 * ?node= and the one-shot ?reading= are dropped once the address is ours.
 *
 * Plain script, no DOM: graph-field.js wires it to the field and the entity
 * view (window.ADAI_FIELD_ADDRESS.create), tests/field-address.test.ts drives
 * it with a fake window.
 */
(function (root) {
  const DROP_PARAMS = ['node', 'reading'];

  function fieldPathFor(node) {
    if (!node || !node.type || !node.slug) return null;
    return `/field/${encodeURIComponent(node.type)}/${encodeURIComponent(node.slug)}`;
  }

  /**
   * @param {object} o
   * @param {Window} o.win              location + history + timers
   * @param {(id: string) => ({type: string, slug: string}|null)} o.nodeFor
   * @param {() => {focusId: string|null, profileId: string|null}} o.read
   * @param {(s: {id: string|null, profile: boolean, focus: string|null}) => void} o.apply
   * @param {(loc: Location) => string|null} o.idFromLocation  for entries we did not write
   * @param {number} [o.settleMs]       how long a requested address may take to land
   */
  function create(o) {
    const win = o.win;
    const settleMs = o.settleMs ?? 4000;
    const now = () => Date.now();
    let pending = null;      // { url, until }: an address being applied (popstate / landing)
    let landingUntil = 0;    // writes before this replace instead of push
    let batch = null;        // { wrote } — a replayed reading is ONE step
    let timer = null;

    function currentUrl() {
      const l = win.location;
      return `${l.pathname}${l.search}${l.hash}`;
    }

    function urlFor(id) {
      let path = '/field';
      if (id) {
        path = fieldPathFor(o.nodeFor(id));
        if (!path) return null;
      }
      const params = new URLSearchParams(win.location.search);
      for (const p of DROP_PARAMS) params.delete(p);
      const qs = params.toString();
      return `${path}${qs ? `?${qs}` : ''}${win.location.hash || ''}`;
    }

    function wanted() {
      const s = o.read() || {};
      const focus = s.focusId || null;
      const profileId = s.profileId || null;
      return { id: profileId || focus, profile: !!profileId, focus };
    }

    const same = (a, b) => !!a && !!b && a.id === b.id && a.profile === b.profile && a.focus === b.focus;

    function sync() {
      timer = null;
      const want = wanted();
      const url = urlFor(want.id);
      if (!url) return;
      if (pending) {
        if (url !== pending.url && now() < pending.until) return; // still landing there
        if (url === pending.url && url === currentUrl()) landingUntil = 0; // landed where the address already says
        pending = null;
      }
      const cur = currentUrl();
      const prevState = win.history.state;
      const ours = prevState && prevState.adai === 'field';
      if (url === cur) {
        if (!ours || !same(prevState, want)) {
          win.history.replaceState({ adai: 'field', ...want, prev: ours ? prevState.prev ?? null : null, pushed: ours ? !!prevState.pushed : false }, '', url);
        }
        return;
      }
      // A profile we pushed, closed back onto the address it was opened over:
      // step back rather than add a step (popstate then finds it all in place).
      if (ours && prevState.pushed && prevState.profile && !want.profile && prevState.prev === url && !batch) {
        pending = { url, until: now() + settleMs };
        win.history.back();
        return;
      }
      const replace = now() < landingUntil || (batch && batch.wrote);
      if (batch) batch.wrote = true;
      if (replace) {
        landingUntil = 0;
        win.history.replaceState({ adai: 'field', ...want, prev: ours ? prevState.prev ?? null : null, pushed: ours ? !!prevState.pushed : false }, '', url);
      } else {
        win.history.pushState({ adai: 'field', ...want, prev: cur, pushed: true }, '', url);
      }
    }

    /** Something on screen changed: follow it once things settle (coalesced). */
    function changed() {
      if (timer) return;
      timer = win.setTimeout(sync, 0);
    }

    function onPopState(e) {
      const st = e && e.state;
      let target;
      if (st && st.adai === 'field') {
        target = { id: st.id ?? null, profile: !!st.profile, focus: st.focus ?? (st.profile ? null : st.id ?? null) };
      } else {
        // An entry we did not write: the landing page, or a #hash step.
        // A hash step on the address we already show changes nothing.
        const want = wanted();
        const here = urlFor(want.id);
        const l = win.location;
        if (here && here.split('#')[0] === `${l.pathname}${l.search}`) return;
        const id = o.idFromLocation(l);
        target = { id, profile: false, focus: id };
      }
      if (timer) { win.clearTimeout(timer); timer = null; }
      batch = null;
      landingUntil = 0;
      const url = urlFor(target.profile ? target.id : target.focus);
      pending = url ? { url, until: now() + settleMs } : null;
      o.apply(target);
      changed();
    }

    win.addEventListener('popstate', onPopState);

    return {
      changed,
      sync,
      onPopState,
      /** The page is landing on an address it named (deep link, your own node):
       *  the next write replaces the entry instead of adding a step. */
      landing(ms = settleMs) { landingUntil = now() + ms; },
      /** Hold the address where it is until the screen reaches `url` (or a timeout). */
      expect(url, ms = settleMs) { pending = { url, until: now() + ms }; },
      /** A replayed reading: its first write is a step, the rest follow in place. */
      beginBatch() { batch = { wrote: false }; },
      endBatch() { batch = null; changed(); },
      urlFor,
    };
  }

  root.ADAI_FIELD_ADDRESS = { create, fieldPathFor };
})(typeof window !== 'undefined' ? window : globalThis);
