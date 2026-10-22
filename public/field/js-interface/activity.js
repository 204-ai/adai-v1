/**
 * A(DAI) — live activity (issue #83)
 *
 * A small, quiet, collapsible trace of the past 24 hours in /field:
 * "X added a work", "Y claimed their page". Live or empty, never stale:
 * nothing shows when the feed is switched off (GET /api/activity says
 * enabled:false) or when nothing happened in the window.
 *
 * Polls once a minute, and not at all while the tab is hidden. Styles live
 * in /field-static/css/activity.css (one element, a few classes: easy to
 * restyle). A line opens the entity overlay when there is one, else the page.
 */
(() => {
  const POLL_MS = 60_000;
  const OPEN_KEY = 'adai:activity-open';
  let timer = null;
  let el = null;
  let stopped = false;

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

  async function poll() {
    timer = null;
    if (stopped || document.hidden) return;
    try {
      const r = await fetch('/api/activity', { headers: { accept: 'application/json' } });
      const j = r.ok ? await r.json() : null;
      if (j && j.enabled === false) {
        // Switched off: no element, no more requests.
        stopped = true;
        if (el) el.remove();
        return;
      }
      if (j && Array.isArray(j.events)) render(j.events);
    } catch { /* offline: keep what is shown; the next poll retries */ }
    schedule();
  }

  function schedule() {
    if (stopped || timer || document.hidden) return;
    timer = setTimeout(poll, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (timer) { clearTimeout(timer); timer = null; }
    } else if (!stopped) {
      poll();
    }
  });

  window.ADAI_ACTIVITY = { refresh: poll };
  poll();
})();
