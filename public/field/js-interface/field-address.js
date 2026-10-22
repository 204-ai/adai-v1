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
 * entry's state is updated in place and no duplicate step is added.
 *
 * Profiles chain: opening one, then another from its links, are steps; each
 * profile entry remembers the field address the chain started from (`base`)
 * and how many steps it is from there (`depth`). Dismissing the profile (its
 * close button: `profileDismissed`) goes BACK those steps, to that address
 * and its focus, with the profile closed — whatever the field focused in
 * between — so Forward brings the profile back. Other ways of closing
 * ("view in field", Esc) settle where the field now is. popstate re-applies
 * an entry (focus + profile) through `apply` without pushing again, and
 * tells the field (`interrupted`) so a running reading replay stops.
 *
 * Every entry we write carries { adai: 'field', id, profile, focus, prev,
 * pushed, base, depth }.
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
    let dismiss = false;     // the next sync follows an explicit profile dismissal
    let restoring = null;    // { focus }: the base a dismissal is going back to

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

    /** The state to write for `want`. `pushing`: a new entry after `cur`. */
    function entry(want, prevState, cur, pushing) {
      const ours = prevState && prevState.adai === 'field';
      const chained = ours && prevState.profile && prevState.base;
      const st = {
        adai: 'field', ...want,
        prev: pushing ? cur : ours ? prevState.prev ?? null : null,
        pushed: pushing ? true : ours ? !!prevState.pushed : false,
      };
      if (want.profile) {
        if (chained) {
          st.base = prevState.base;
          st.depth = (prevState.depth || 0) + (pushing ? 1 : 0);
        } else if (pushing) {
          st.base = { url: cur, focus: ours ? prevState.focus ?? null : o.idFromLocation(win.location) };
          st.depth = 1;
        } else {
          st.base = { url: cur, focus: want.focus };
          st.depth = 0;
        }
      }
      return st;
    }

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
      // The profile's close button: back to where the profile chain began.
      if (dismiss) {
        dismiss = false;
        if (!want.profile && ours && prevState.profile && prevState.pushed && prevState.base && prevState.depth > 0) {
          restoring = { focus: prevState.base.focus ?? null };
          pending = { url: prevState.base.url, until: now() + settleMs };
          win.history.go(-prevState.depth);
          return;
        }
      }
      if (url === cur) {
        if (!ours || !same(prevState, want)) {
          win.history.replaceState(entry(want, prevState, cur, false), '', url);
        }
        return;
      }
      const replace = now() < landingUntil || (batch && batch.wrote);
      if (batch) batch.wrote = true;
      if (replace) {
        landingUntil = 0;
        win.history.replaceState(entry(want, prevState, cur, false), '', url);
      } else {
        win.history.pushState(entry(want, prevState, cur, true), '', url);
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
      if (o.interrupted) o.interrupted();
      if (restoring) {
        // Our own step back from a dismissed profile: its base, profile closed.
        target = { id: restoring.focus, profile: false, focus: restoring.focus };
        restoring = null;
      } else if (st && st.adai === 'field') {
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
      /** The profile was closed by its own close button (not "view in field", not Esc). */
      profileDismissed() { dismiss = true; changed(); },
      /** A replayed reading: its first write is a step, the rest follow in place.
       *  Returns the batch; only that batch's owner ends it (a popstate drops it). */
      beginBatch() { batch = { wrote: false }; return batch; },
      endBatch(token) { if (token && token !== batch) return; batch = null; changed(); },
      urlFor,
    };
  }

  root.ADAI_FIELD_ADDRESS = { create, fieldPathFor };
})(typeof window !== 'undefined' ? window : globalThis);
