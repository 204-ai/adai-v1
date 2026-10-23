/**
 * A(DAI) — live activity (issue #83)
 *
 * A small, quiet, collapsible trace of the past 24 hours in /field:
 * "X added a work", "Y claimed their page". Live or empty, never stale:
 * nothing shows when the feed is switched off (GET /api/activity says
 * enabled:false), when nothing happened in the window, or when the feed
 * cannot be read (an error clears it rather than leaving old lines up).
 * Events also expire here, on the client: each line goes at its own 24 h
 * mark, on a timer, and again whenever the tab comes back into view.
 *
 * Polls once a minute, and not at all while the tab is hidden. Styles live
 * in /field-static/css/activity.css (one element, a few classes: easy to
 * restyle). A line opens the entity overlay when there is one, else the page.
 *
 * The controller (window.ADAI_ACTIVITY_CORE.create) takes its clock, fetch,
 * timers and renderer as arguments: tests/activity-client.test.ts drives it
 * with fake time.
 */
(function (root) {
  const POLL_MS = 60_000;
  const WINDOW_MS = 24 * 3600_000;

  /** The events still inside the window at `now`. */
  function live(events, now) {
    return events.filter((e) => {
      const t = Date.parse(e && e.at);
      return Number.isFinite(t) && now - t < WINDOW_MS;
    });
  }

  /** When the next of them leaves the window (ms from now), or null. */
  function nextExpiry(events, now) {
    let soonest = null;
    for (const e of events) {
      const left = Date.parse(e.at) + WINDOW_MS - now;
      if (soonest === null || left < soonest) soonest = left;
    }
    return soonest === null ? null : Math.max(0, soonest);
  }

  function valid(j) {
    return j && typeof j === 'object' && (j.enabled === false || (j.enabled === true && Array.isArray(j.events)));
  }

  /**
   * @param o.fetchJson  () => Promise<object>   GET /api/activity (rejects on network / HTTP error)
   * @param o.render     (events[]) => void       [] hides the element
   * @param o.stop       () => void               the feed is off: remove everything
   * @param o.now, o.setTimeout, o.clearTimeout, o.hidden () => boolean
   */
  function create(o) {
    let events = [];
    let pollTimer = null;
    let expiryTimer = null;
    let stopped = false;
    let generation = 0; // each request's number: only the latest one's answer counts

    function show() {
      events = live(events, o.now());
      o.render(events);
      if (expiryTimer) { o.clearTimeout(expiryTimer); expiryTimer = null; }
      const next = nextExpiry(events, o.now());
      if (next !== null && !stopped) expiryTimer = o.setTimeout(show, next + 1);
    }

    function schedule() {
      if (stopped || pollTimer || o.hidden()) return;
      pollTimer = o.setTimeout(poll, POLL_MS);
    }

    async function poll() {
      // an immediate poll (refresh, the tab coming back) replaces the scheduled one
      if (pollTimer) { o.clearTimeout(pollTimer); pollTimer = null; }
      if (stopped || o.hidden()) return;
      const mine = ++generation;
      let j = null;
      try { j = await o.fetchJson(); } catch { j = null; }
      // A newer request was made since, or the feed stopped meanwhile: this
      // answer is stale — it may neither resurrect nor clear anything.
      if (stopped || mine !== generation) return;
      if (j && j.enabled === false) {
        stopped = true;
        events = [];
        if (expiryTimer) { o.clearTimeout(expiryTimer); expiryTimer = null; }
        o.stop();
        return;
      }
      // An error or a malformed answer clears the feed: never old lines.
      events = valid(j) ? j.events : [];
      show();
      schedule();
    }

    function visibility() {
      if (o.hidden()) {
        if (pollTimer) { o.clearTimeout(pollTimer); pollTimer = null; }
        return;
      }
      if (stopped) return;
      show(); // drop what expired while the tab was away, before asking again
      poll();
    }

    return { poll, visibility, show, get events() { return events; }, get stopped() { return stopped; } };
  }

  root.ADAI_ACTIVITY_CORE = { create, live, nextExpiry, WINDOW_MS, POLL_MS };

  // ---- the DOM (skipped when loaded without one, as in tests) ----
  if (typeof document === 'undefined' || !document.body) return;
  const OPEN_KEY = 'adai:activity-open';
  let el = null;

  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return 'now';
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${Math.round(s / 3600)} h`;
  }

  function ensure() {
    if (el) return el;
    el = document.createElement('aside');
    el.id = 'adai-activity';
    el.className = 'adai-activity';
    el.hidden = true;
    el.setAttribute('aria-label', 'live activity, past 24 hours');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'adai-activity-toggle';
    btn.innerHTML = '<span class="adai-activity-dot" aria-hidden="true"></span>live <span class="adai-activity-count"></span>';
    const list = document.createElement('ol');
    list.className = 'adai-activity-list';
    el.append(btn, list);
    let open = false;
    try { open = localStorage.getItem(OPEN_KEY) === '1'; } catch { /* storage blocked */ }
    const setOpen = (v) => {
      open = v;
      el.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* storage blocked */ }
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); });
    list.addEventListener('click', (e) => {
      e.stopPropagation(); // never a click on the field behind
      const a = e.target.closest && e.target.closest('a[data-node-id]');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const ev = window.ADAI_ENTITY_VIEW;
      if (ev && typeof ev.open === 'function' && !document.body.classList.contains('ev-page')) {
        e.preventDefault();
        ev.open(a.dataset.nodeId);
      }
    });
    setOpen(open);
    document.body.appendChild(el);
    return el;
  }

  function render(events) {
    if (!events.length && !el) return;
    const box = ensure();
    const list = box.querySelector('.adai-activity-list');
    list.textContent = '';
    for (const e of events) {
      const li = document.createElement('li');
      const what = document.createElement(e.href ? 'a' : 'span');
      what.className = 'adai-activity-what';
      what.textContent = e.text;
      if (e.href) {
        what.href = e.href;
        if (e.id) what.dataset.nodeId = e.id;
      }
      const when = document.createElement('time');
      when.className = 'adai-activity-when';
      when.dateTime = e.at;
      when.textContent = ago(e.at);
      li.append(what, ' ', when);
      list.appendChild(li);
    }
    box.querySelector('.adai-activity-count').textContent = String(events.length);
    box.hidden = events.length === 0; // live or empty
  }

  const feed = create({
    fetchJson: async () => {
      const r = await fetch('/api/activity', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`activity ${r.status}`);
      return r.json();
    },
    render,
    stop: () => { if (el) { el.remove(); el = null; } },
    now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (t) => clearTimeout(t),
    hidden: () => document.hidden,
  });
  document.addEventListener('visibilitychange', () => feed.visibility());
  window.ADAI_ACTIVITY = { refresh: feed.poll };
  feed.poll();
})(typeof window !== 'undefined' ? window : globalThis);
