/**
 * A(DAI) — entity view (the "1k" tier)
 *
 * The view itself is rendered on the server (src/entity/view.ts) — one
 * component for two surfaces:
 *
 *   - /<type>/<slug>  the standalone page (body.ev-page): this script fills
 *                     the embedding neighbours and wires the audience toggle;
 *                     links navigate normally.
 *   - /field          the overlay: 'i' (or clicking the focused node) fetches
 *                     /api/entity?id=… and lays the same article over the
 *                     graph; ESC dismisses back to the previous zoom. Links
 *                     to other nodes re-open the overlay on them (cmd/ctrl-
 *                     click still opens the standalone page in a new tab).
 *
 * Styles: /field-static/css/entity-view.css (shared).
 */
(() => {
  const PAGE = document.body?.classList.contains('ev-page') ?? false;
  const STATE = { open: false, currentId: null, seq: 0 };

  // ---------- DOM bootstrap ----------
  function ensureContainer() {
    let el = document.getElementById('entity-view');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'entity-view';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '';
    document.body.appendChild(el);
    return el;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function openContributePanel() {
    window.location.href = '/contribute';
  }

  // ---------- "Who is this for" toggle (style-kin panel) ----------
  // A small, non-rotating tab toggle under the style-kin description that
  // swaps one value line depending on who's reading. Default = Everyone.
  const AUDIENCE_ORDER = ['everyone', 'curators', 'artists', 'collectors'];
  const AUDIENCE_LABEL = {
    everyone: 'Everyone',
    curators: 'Curators',
    artists: 'Artists',
    collectors: 'Collectors',
  };
  const AUDIENCE_LINE = {
    everyone: 'Resemblances to explore: leads to follow, not claims to trust.',
    curators: 'Threads for a show, and a compass to the gaps worth researching.',
    artists: 'See who you rhyme with, then claim, correct, or follow it.',
    collectors: 'Kindred work across platforms, and the tradition a piece sits near.',
  };
  function renderAudienceToggle() {
    const tabs = AUDIENCE_ORDER.map((k, i) =>
      `<button type="button" class="ev-aud-tab" data-aud="${k}" aria-pressed="${i === 0 ? 'true' : 'false'}">${escapeHtml(AUDIENCE_LABEL[k])}</button>`
    ).join('');
    return `
      <div class="ev-aud" data-aud-current="everyone">
        <div class="ev-aud-tabs" role="group" aria-label="Who is this for">${tabs}</div>
        <p class="ev-aud-line" aria-live="polite" title="tap to cycle">${escapeHtml(AUDIENCE_LINE.everyone)}</p>
      </div>
    `;
  }

  // ---------- Overlay chrome ----------
  function renderHeaderIcons() {
    // Top-right: search, zoom, bookmark, plus, chat (chat = narrator, wired in next phase).
    return `
      <nav class="ev-header-icons" aria-label="entity actions">
        <button class="ev-icon" data-action="search" title="search" aria-label="search">⌕</button>
        <button class="ev-icon" data-action="zoom" title="zoom" aria-label="zoom">⊕</button>
        <button class="ev-icon" data-action="bookmark" title="bookmark" aria-label="bookmark">★</button>
        <button class="ev-icon" data-action="add" title="contribute" aria-label="contribute">+</button>
        <button class="ev-icon ev-icon--chat" data-action="chat" title="ask the archivist" aria-label="open chat narrator">◉</button>
      </nav>
    `;
  }

  function renderClose() {
    return `
      <button class="ev-close" data-action="close" aria-label="close entity view (esc)">
        <span class="ev-close-x">×</span>
        <span class="ev-close-key">esc</span>
      </button>
    `;
  }

  function renderRecCounter() {
    // Cosmetic — picks a stable hash-derived 5-digit number from the id.
    const id = STATE.currentId || '';
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const num = String(Math.abs(h) % 100000).padStart(5, '0');
    return `<aside class="ev-rec" aria-hidden="true">REC<br>.${num}</aside>`;
  }

  function chrome() {
    return `${renderClose()}${renderRecCounter()}${renderHeaderIcons()}`;
  }

  // ---------- Embedding sections ----------
  // Fetched async from /api/neighbours/:type/:slug once the article is in the
  // DOM. The server lays down the placeholder section; fillEmbeddings fills it.
  function nodeHref(n) {
    return n.type && n.slug ? `/${encodeURIComponent(n.type)}/${encodeURIComponent(n.slug)}` : null;
  }

  function renderEmbeddingNeighbour(n) {
    const url = n.cdn_image_url || n.image_url || '';
    const sim = (typeof n.similarity === 'number') ? n.similarity.toFixed(3) : '—';
    const name = escapeHtml(n.name || n.node_id);
    const type = escapeHtml(n.type || '?');
    const img = url
      ? `<img src="${escapeHtml(url)}" alt="${name}" loading="lazy" crossorigin="anonymous">`
      : `<div class="ev-emb-thumb-empty" data-hatch="1">${name.slice(0, 32)}</div>`;
    const href = nodeHref(n);
    const inner = `
        <div class="ev-emb-thumb">${img}</div>
        <div class="ev-emb-meta">
          <span class="ev-emb-name">${name}</span>
          <span class="ev-emb-row">
            <span class="ev-emb-type">[${type}]</span>
            <span class="ev-emb-sim">${sim}</span>
          </span>
        </div>`;
    return href
      ? `<a class="ev-emb-card" href="${escapeHtml(href)}" data-node-id="${escapeHtml(n.node_id)}" title="${name}">${inner}</a>`
      : `<div class="ev-emb-card" title="${name}">${inner}</div>`;
  }

  function renderEmbeddingsBody(payload) {
    const sections = payload?.sections || [];
    if (!sections.length) return '';
    const total = sections.reduce((acc, s) => acc + (s.neighbours?.length || 0), 0);
    const blocks = sections.map((s) => {
      const cards = (s.neighbours || []).map(renderEmbeddingNeighbour).join('');
      const blurb = s.blurb ? `<p class="ev-emb-blurb">${escapeHtml(s.blurb)}</p>` : '';
      const keyTag = s.key ? `<span class="ev-emb-key">[${escapeHtml(s.key)}]</span>` : '';
      // Only the style-kin panel carries the audience toggle for now.
      const toggle = s.key === 'style_kin' ? renderAudienceToggle() : '';
      return `
        <div class="ev-emb-group" data-key="${escapeHtml(s.key || '')}">
          <h3 class="ev-emb-h3">${escapeHtml(s.title)} ${keyTag} <span class="ev-h3-count">/${String(s.neighbours.length).padStart(2, '0')}</span></h3>
          ${blurb}
          ${toggle}
          <div class="ev-emb-grid">${cards}</div>
        </div>
      `;
    }).join('');
    return `<div class="ev-emb-total" data-total="${total}"></div>${blocks}`;
  }

  // `node` = { id, type, slug }. In the overlay, bail when the visitor has
  // moved on to another node by the time the fetch resolves.
  async function fillEmbeddings(node) {
    const root = document.getElementById('ev-embeddings');
    if (!root) return;
    const stale = () => !PAGE && STATE.currentId !== node.id;
    // Timeout the fetch so a stalled connection (Safari especially) surfaces a
    // retry instead of an endless spinner. The neighbours are server-computed
    // (cosine over precomputed vectors), so this is purely a network wait.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const showRetry = (label) => {
      const status = root.querySelector('#ev-emb-status');
      if (!status) return;
      status.className = 'ev-empty adai-embed-retry';
      status.textContent = `${label} — retry`;
      status.onclick = (e) => {
        // Belt-and-suspenders with field.js's isUiClick guard: keep the retry
        // click from bubbling to the document-level zoomTo handler.
        e.stopPropagation();
        if (stale()) return;
        status.className = 'ev-empty adai-embed-loading';
        status.innerHTML = '<span class="adai-spin"></span>computing cosine neighbours over the embedding space…';
        fillEmbeddings(node);
      };
    };
    try {
      const r = await fetch(`/api/neighbours/${encodeURIComponent(node.type)}/${encodeURIComponent(node.slug)}`, {
        headers: { 'accept': 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        showRetry(`embedding neighbours unavailable (${r.status})`);
        return;
      }
      const payload = await r.json();
      if (stale()) return;
      const sections = payload.sections || [];
      if (!sections.length) {
        // No vector / no centroid — empty by design for some node types
        // (institution, publication, classification_regime). Say nothing.
        root.remove();
        return;
      }
      const total = sections.reduce((acc, s) => acc + (s.neighbours?.length || 0), 0);
      const countEl = root.querySelector('#ev-emb-count');
      const statusEl = root.querySelector('#ev-emb-status');
      if (countEl) countEl.textContent = `/${String(total).padStart(2, '0')}`;
      if (statusEl) statusEl.remove();
      const body = document.createElement('div');
      body.innerHTML = renderEmbeddingsBody(payload);
      root.appendChild(body);
    } catch (err) {
      clearTimeout(timer);
      if (stale()) return;
      showRetry(err && err.name === 'AbortError'
        ? 'embedding neighbours slow to respond'
        : 'embedding neighbours unavailable (network error)');
      console.warn('[entity-view] /api/neighbours fetch failed', err);
    }
  }

  function articleNode(scope) {
    const a = scope.querySelector('.ev-article[data-node-id]');
    return a ? { id: a.dataset.nodeId, type: a.dataset.nodeType, slug: a.dataset.nodeSlug } : null;
  }

  // ---------- Overlay: open / close ----------
  async function open(id) {
    if (!id) return;
    const el = ensureContainer();
    const seq = ++STATE.seq;
    STATE.open = true;
    STATE.currentId = id;
    const name = window.ADAI_GRAPH?.byId?.get(id)?.name || id;
    el.innerHTML = `${chrome()}<article class="ev-article"><p class="ev-empty adai-embed-loading"><span class="adai-spin"></span>opening ${escapeHtml(name)}…</p></article>`;
    // Re-opens kept the previous scroll position — navigating from a card
    // halfway down one profile landed halfway down the next (review note 5).
    el.scrollTop = 0;
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    // Lock body scroll while open.
    document.body.classList.add('ev-locked');
    // Focus the close button so ESC works without click.
    setTimeout(() => el.querySelector('.ev-close')?.focus(), 0);
    let html;
    try {
      const r = await fetch(`/api/entity?id=${encodeURIComponent(id)}`, { headers: { 'accept': 'application/json' } });
      if (seq !== STATE.seq || !STATE.open) return;
      if (!r.ok) throw new Error(r.status === 404 ? 'node not found' : `server responded ${r.status}`);
      html = (await r.json()).html;
    } catch (err) {
      if (seq !== STATE.seq || !STATE.open) return;
      console.error('[entity-view] open failed for', id, err);
      html = `
        <article class="ev-article">
          <p class="ev-empty">profile failed to load for <span class="ev-mono-tag">${escapeHtml(id)}</span> —
          <span class="ev-mono-dim">${escapeHtml((err && err.message) || 'unknown error')}</span>.
          press esc and retry; if it persists, it's ours to fix.</p>
        </article>
      `;
    }
    if (seq !== STATE.seq || !STATE.open) return;
    el.innerHTML = `${chrome()}${html}`;
    el.scrollTop = 0;
    setTimeout(() => el.querySelector('.ev-close')?.focus(), 0);
    const node = articleNode(el);
    if (node) fillEmbeddings(node);
  }

  function close() {
    const el = document.getElementById('entity-view');
    if (!el) return;
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '';
    STATE.open = false;
    STATE.currentId = null;
    STATE.seq++;
    document.body.classList.remove('ev-locked');
  }

  // ---------- Triggers ----------
  function getCurrentFocusedId() {
    const b = window.ADAI_GRAPH_FIELD;
    return b?.focusedId || null;
  }

  function handleAudience(e) {
    // "Who is this for" toggle: tab buttons set the audience; tapping the
    // value line cycles to the next (the mobile affordance).
    const audTab = e.target?.closest?.('.ev-aud-tab');
    const audLine = e.target?.closest?.('.ev-aud-line');
    if (!audTab && !audLine) return false;
    e.preventDefault();
    e.stopPropagation();
    const wrap = (audTab || audLine).closest('.ev-aud');
    if (wrap) {
      let next;
      if (audTab) {
        next = audTab.dataset.aud;
      } else {
        const cur = wrap.dataset.audCurrent || 'everyone';
        next = AUDIENCE_ORDER[(AUDIENCE_ORDER.indexOf(cur) + 1) % AUDIENCE_ORDER.length];
      }
      wrap.dataset.audCurrent = next;
      wrap.querySelectorAll('.ev-aud-tab').forEach((b) =>
        b.setAttribute('aria-pressed', b.dataset.aud === next ? 'true' : 'false')
      );
      const line = wrap.querySelector('.ev-aud-line');
      if (line) line.textContent = AUDIENCE_LINE[next] || '';
    }
    return true;
  }

  if (PAGE) {
    // Standalone page: the article is already here. Links navigate as links.
    document.addEventListener('click', handleAudience);
    const node = articleNode(document);
    if (node) fillEmbeddings(node);
    window.ADAI_ENTITY_VIEW = { open: (id) => { window.location.href = `/field?node=${encodeURIComponent(id)}`; }, close() {}, get isOpen() { return true; } };
    return;
  }

  document.addEventListener('keydown', (e) => {
    if (STATE.open) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      return;
    }
    // 'i' opens entity view for the currently focused node — but NOT while
    // the visitor is typing into an input/textarea, otherwise every word
    // containing "i" pops the overlay over whatever they're writing
    // (notably the archivist chat).
    if ((e.key === 'i' || e.key === 'I') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      const isTyping = tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable;
      if (isTyping) return;
      const id = getCurrentFocusedId();
      if (id) {
        e.preventDefault();
        open(id);
      }
    }
  });

  // Click handler — close button, header-icon actions, the contribute CTA,
  // and every link to another node (re-open the overlay on it).
  document.addEventListener('click', (e) => {
    if (!STATE.open) return;
    if (!e.target?.closest?.('#entity-view')) return;
    // Contribute CTA → the URL intake at /contribute. Handled first so it
    // never bubbles to the field's zoom/navigation.
    if (e.target?.closest?.('.ev-contrib-link')) {
      e.preventDefault();
      e.stopPropagation();
      openContributePanel();
      return;
    }
    if (handleAudience(e)) return;
    // "view in field →": we are in the field — close onto the node.
    if (e.target?.closest?.('.ev-field-link') && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      e.preventDefault();
      e.stopPropagation();
      const id = STATE.currentId;
      close();
      const field = window.ADAI_GRAPH_FIELD;
      if (id && field && typeof field.zoomTo === 'function' && field.focusedId !== id) {
        try { field.zoomTo(id); } catch { /* non-fatal */ }
      }
      return;
    }
    // Links to other nodes (relations, works, embedding cards). A modified
    // click keeps the browser's new-tab behaviour on the standalone page.
    const link = e.target?.closest?.('a[data-node-id]');
    if (link && link.dataset.nodeId) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const nextId = link.dataset.nodeId;
      // Also drive the underlying field's focus so the breadcrumb + zoom
      // state stay coherent when the user closes the overlay.
      const field = window.ADAI_GRAPH_FIELD;
      if (field && typeof field.zoomTo === 'function' && nextId !== STATE.currentId) {
        try { field.zoomTo(nextId); } catch { /* non-fatal */ }
      }
      open(nextId);
      return;
    }
    const action = e.target?.closest?.('[data-action]')?.dataset?.action;
    if (action === 'close') {
      e.preventDefault(); close();
    } else if (action === 'add') {
      // The + header icon → the URL intake at /contribute.
      e.preventDefault();
      openContributePanel();
    } else if (action === 'chat') {
      e.preventDefault();
      // Narrator wired in next phase — placeholder.
      console.log('[entity-view] chat narrator not yet wired');
    }
  });

  // Public API.
  window.ADAI_ENTITY_VIEW = { open, close, get isOpen() { return STATE.open; } };
})();
