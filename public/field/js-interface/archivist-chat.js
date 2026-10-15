/**
 * A(DAI) — floating archivist chat (server-hosted).
 *
 * Different from chat-narrator.js (the Reader handoff): this is the
 * server-hosted archivist that talks to Anthropic via /api/archivist/chat
 * and can drive the field view through client tools (focus_node,
 * highlight_nodes, set_field_mode, clear_focus).
 *
 * Self-contained: mounts one <div id="archivist-bar"> sibling to #chrome,
 * never edits other modules. Keyboard: Shift+? to toggle focus.
 *
 * Conversation state lives in memory + sessionStorage (per-tab, lost on
 * tab close). Server is stateless on history — we replay the last ~20
 * turns every chat.
 */
(() => {
  if (window.ADAI_ARCHIVIST) return; // idempotent

  const SESSION_HISTORY_KEY = 'adai_archivist_history';
  const DOCK_KEY = 'adai_archivist_dock';
  const PANEL_OPEN_KEY = 'adai_archivist_panel_open';
  const DOCKS = ['center', 'right', 'left'];
  const MAX_HISTORY = 20;

  const STATE = {
    open: false,
    busy: false,
    helpOpen: false,  // ? button toggles a help/tips overlay in the log
    online: null,     // null = unknown; true/false set after /session call
    quota: null,
    /** Wire-form history: array of { role, content } where content is either
     *  a string (user/assistant text) or a list of structured blocks
     *  (assistant tool_use + user tool_result). */
    history: [],
    /** UI-form turns: array of { role: 'user'|'assistant', html, chips: [] }
     *  used purely for rendering — separate from wire history because we
     *  collapse tool_use blocks into chips. */
    turns: [],
    pendingAssistant: null, // current assistant UI turn while streaming
    currentToolCalls: new Map(), // tool_use_id -> chip element
  };

  // ---------- session storage ----------
  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(SESSION_HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.history) && Array.isArray(parsed.turns)) {
        STATE.history = parsed.history.slice(-MAX_HISTORY);
        STATE.turns = parsed.turns.slice(-MAX_HISTORY);
      }
    } catch {}
  }
  function saveHistory() {
    try {
      sessionStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify({
        history: STATE.history.slice(-MAX_HISTORY),
        turns: STATE.turns.slice(-MAX_HISTORY),
      }));
    } catch {}
  }
  function loadPanelOpen() {
    // Default closed: the archivist must not auto-open on entering the graph.
    // It only opens on explicit user action; that choice is then remembered
    // for the rest of the browser session (sessionStorage clears on tab close).
    try {
      const saved = sessionStorage.getItem(PANEL_OPEN_KEY);
      return saved == null ? false : saved !== '0';
    } catch {
      return false;
    }
  }
  function savePanelOpen(open) {
    try { sessionStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0'); } catch {}
  }

  // ---------- helpers ----------
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Minimal markdown — paragraphs, bullets, numbered lists, headings (shown
  // as a bold line), bold, italic, inline code, links. Intentionally NOT a
  // full parser; it walks lines so a paragraph followed by a list in the
  // same block still renders as both.
  // `links` is the server's correction map for this reply ({ href → path |
  // null }, src/archivist/links.ts): a slug the model derived from a name is
  // swapped for the real one, a node that doesn't exist loses its link.
  function renderMarkdown(src, links) {
    if (!src) return '';
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => {
      if (para.length) out.push('<p>' + para.map((l) => inline(l, links)).join('<br>') + '</p>');
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>` + list.items.map((i) => '<li>' + inline(i, links) + '</li>').join('') + `</${list.tag}>`);
      list = null;
    };
    for (const raw of src.replace(/\r\n/g, '\n').split('\n')) {
      const line = raw.trim();
      let m;
      if (!line) { flushPara(); flushList(); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flushPara(); flushList(); continue; }
      if ((m = /^#{1,6}\s+(.*)$/.exec(line))) {
        flushPara(); flushList();
        out.push('<p><strong>' + inline(m[1].replace(/^\*\*(.*)\*\*$/, '$1'), links) + '</strong></p>');
        continue;
      }
      const bullet = /^[-*•]\s+(.*)$/.exec(line);
      const num = bullet ? null : /^\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || num) {
        const tag = bullet ? 'ul' : 'ol';
        flushPara();
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((bullet || num)[1]);
        continue;
      }
      if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += ' ' + line; continue; }
      flushList();
      para.push(line);
    }
    flushPara();
    flushList();
    return out.join('');
  }

  // Hosts that are this site: a model-written https://<host>/type/slug is a
  // site path (it has written https://adai.is/… before).
  const OWN_HOSTS = new Set([
    'adai.is', 'www.adai.is', 'digitalartsinstitute.io', 'www.digitalartsinstitute.io',
    'adai-basel.fly.dev', 'adai-staging.fly.dev', location.host,
  ]);

  function emphasis(escaped) {
    return escaped
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // italic: *foo* (bold already replaced)
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  // A link's target, or null to show the label alone. Only single-leading-
  // slash same-origin paths survive. Reject protocol-relative ('//evil.com'),
  // backslash variants ('/\evil.com'), AND tab/LF/CR variants ('/\t/evil.com'):
  // per WHATWG URL parsing, browsers strip ASCII TAB, LF and CR from `href`
  // BEFORE resolving, so '/\t/evil.com' would navigate to '//evil.com'. A
  // model influenced by prompt injection in canon content could otherwise
  // emit clickable cross-origin links; someone else's page shows as its
  // label, unlinked.
  function linkTarget(href, links) {
    let target = href;
    if (links && Object.prototype.hasOwnProperty.call(links, href)) {
      target = links[href];
    } else if (/^https?:\/\//i.test(href)) {
      try {
        const u = new URL(href);
        target = OWN_HOSTS.has(u.host.toLowerCase()) ? u.pathname + u.search : null;
      } catch { target = null; }
    }
    if (typeof target !== 'string' || target[0] !== '/' || target.length < 2) return null;
    if (/[\/\\\t\n\r]/.test(target[1]) || /[\t\n\r]/.test(target)) return null;
    return target;
  }

  function inline(s, links) {
    // Links are lifted out first (their hrefs must be matched raw, before
    // escaping), then the rest is escaped and formatted, so **[a](/b)** works.
    const anchors = [];
    const withTokens = String(s).replace(/\u0000/g, '').replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
      const target = linkTarget(href, links);
      const labelHtml = emphasis(escapeHtml(label));
      anchors.push(target ? `<a href="${escapeHtml(target)}">${labelHtml}</a>` : labelHtml);
      return `\u0000${anchors.length - 1}\u0000`;
    });
    return emphasis(escapeHtml(withTokens)).replace(/\u0000(\d+)\u0000/g, (_m, i) => anchors[Number(i)]);
  }

  // ---------- DOM ----------
  function ensureRoot() {
    let el = document.getElementById('archivist-bar');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'archivist-bar';
    el.setAttribute('aria-label', 'archivist chat');
    el.innerHTML = `
      <button type="button" class="arch-panel-minimize" data-arch-panel-minimize title="minimize panel" aria-label="minimize archivist panel">−</button>
      <div class="arch-log" id="arch-log" role="log" aria-live="polite"></div>
      <div class="arch-bar">
        <span class="arch-prompt" aria-hidden="true">⟁</span>
        <textarea class="arch-input" id="arch-input" rows="1"
          placeholder="ask the archivist…" autocomplete="off"
          spellcheck="false"></textarea>
        <button type="button" class="arch-iconbtn" id="arch-help" title="help / what can I ask?" aria-label="help">?</button>
        <button type="button" class="arch-iconbtn" id="arch-reset" title="reset conversation" aria-label="reset conversation">×</button>
        <button type="button" class="arch-iconbtn" id="arch-minimize" title="hide log" aria-label="hide log">−</button>
        <button type="button" class="arch-iconbtn" id="arch-dock" title="move (cycle dock)" aria-label="move">⇄</button>
        <button type="button" class="arch-send" id="arch-send">send</button>
        <span class="arch-keyhint" aria-hidden="true">⇧?</span>
      </div>
      <div class="arch-status" id="arch-status">…</div>
    `;
    document.body.appendChild(el);
    return el;
  }

  // ---------- help / empty state ----------
  // The archivist is more capable than the bar suggests; without this hint
  // visitors only ever try "who is X" and never learn it can drive the
  // view, see what they're looking at, or open the rich profile.
  const HELP_HTML = `
    <div class="arch-help">
      <div class="arch-commons-framing">A(DAI) is a partial commons of digital art, not a definitive canon. The empty space is the invitation: gaps are where the commons asks for contributions, adding context and layers of nuance over time.</div>
      <div class="arch-help-lead">a server-hosted archivist with read-only access to the A(DAI) graph.</div>
      <div class="arch-help-section">
        <div class="arch-help-h">what to ask</div>
        <ul>
          <li><em>who is Casey Reas?</em> &nbsp;·&nbsp; <em>what's Fidenza?</em> &nbsp;·&nbsp; <em>what concepts live near generative art?</em></li>
          <li><em>tell me about this</em> / <em>what's near it</em> — it sees the node you're focused on in /field</li>
          <li><em>show me X</em> — zooms the field to X &nbsp;·&nbsp; <em>tell me everything about X</em> — opens the full profile panel</li>
          <li><em>highlight works tagged glitch</em> &nbsp;·&nbsp; <em>switch to embeddings view</em> &nbsp;·&nbsp; <em>zoom out</em></li>
          <li><em>what's missing about X?</em> — it'll point you toward contributing when the canon thins</li>
        </ul>
      </div>
      <div class="arch-help-section">
        <div class="arch-help-h">it can act on /field</div>
        <ul>
          <li>focus on a node, highlight a set, open the full profile panel, swap between curatorial and embeddings views</li>
          <li>any <a href="#" onclick="return false;" class="arch-help-fake-link">[node link]</a> in a reply opens the profile in-place — cmd-click to open the standalone page in a new tab</li>
        </ul>
      </div>
      <div class="arch-help-section">
        <div class="arch-help-h">controls</div>
        <ul>
          <li><kbd>⇧?</kbd> focus / toggle &nbsp;·&nbsp; <kbd>esc</kbd> close &nbsp;·&nbsp; <kbd>enter</kbd> send &nbsp;·&nbsp; <kbd>shift+enter</kbd> newline</li>
          <li><span class="arch-help-btn">×</span> reset chat &nbsp;·&nbsp; <span class="arch-help-btn">−</span> minimize panel &nbsp;·&nbsp; <span class="arch-help-btn">⇄</span> move (center / right / left) &nbsp;·&nbsp; <span class="arch-help-btn">?</span> this panel</li>
        </ul>
      </div>
      <div class="arch-help-foot">read-only by design — it can't add nodes, edges, or signals. To contribute, use the <a href="/contribute">contribute</a> page.</div>
    </div>`;

  function renderLog() {
    const root = ensureRoot();
    const log = root.querySelector('#arch-log');
    if (!log) return;
    // (The minimize button lives in the bar SHELL, not in this scrollable
    // log — an absolutely-positioned child of an overflow container scrolls
    // away with the content, which is exactly the "collapse button
    // disappears when you scroll" review bug.)
    // Help panel takes precedence over both the empty state and the
    // ongoing log — it's modal-ish within the surface.
    if (STATE.helpOpen) {
      log.innerHTML = HELP_HTML;
      return;
    }
    if (STATE.turns.length === 0) {
      log.innerHTML = HELP_HTML;
      return;
    }
    log.innerHTML = STATE.turns.map((t, i) => renderTurn(t, i)).join('');
    log.scrollTop = log.scrollHeight;
  }
  function renderTurn(turn /*, idx */) {
    const cls = `arch-msg arch-msg-${turn.role}`;
    if (turn.role === 'user') {
      return `<div class="${cls}">${renderMarkdown(turn.text || '', null)}</div>`;
    }
    const chipsHtml = (turn.chips && turn.chips.length)
      ? `<div class="arch-chips">${turn.chips.map(chipHtml).join('')}</div>`
      : '';
    return `<div class="${cls}">${renderMarkdown(turn.text || '', turn.links)}${chipsHtml}</div>`;
  }
  function chipHtml(c) {
    const cls = ['arch-chip'];
    if (c.done) cls.push('arch-chip-done');
    if (c.client) cls.push('arch-chip-client');
    if (c.error) cls.push('arch-chip-error');
    return `<span class="${cls.join(' ')}">${escapeHtml(c.label)}</span>`;
  }

  function setBusy(busy, status) {
    STATE.busy = !!busy;
    const root = ensureRoot();
    root.classList.toggle('is-busy', !!busy);
    const sEl = root.querySelector('#arch-status');
    if (sEl) sEl.textContent = status || '';
    const send = root.querySelector('#arch-send');
    if (send) send.disabled = !!busy;
  }
  function syncPanelButtons() {
    const root = ensureRoot();
    const isOpen = root.classList.contains('is-open');
    const minBtn = root.querySelector('#arch-minimize');
    if (!minBtn) return;
    minBtn.textContent = isOpen ? '−' : '+';
    minBtn.title = isOpen ? 'minimize panel' : 'show panel';
    minBtn.setAttribute('aria-label', isOpen ? 'minimize panel' : 'show panel');
  }
  function open(options = {}) {
    STATE.open = true;
    const root = ensureRoot();
    root.classList.add('is-open');
    savePanelOpen(true);
    syncPanelButtons();
    renderLog();
    const input = root.querySelector('#arch-input');
    if (input && options.focus !== false) input.focus();
  }
  function close(options = {}) {
    STATE.open = false;
    const root = ensureRoot();
    root.classList.remove('is-open');
    savePanelOpen(false);
    syncPanelButtons();
    const input = root.querySelector('#arch-input');
    if (input && options.blur !== false) input.blur();
  }
  function toggle() { STATE.open ? close() : open(); }
  function clear() {
    STATE.history = [];
    STATE.turns = [];
    STATE.pendingAssistant = null;
    STATE.currentToolCalls = new Map();
    saveHistory();
    renderLog();
  }

  // ---------- dock (move) ----------
  function loadDock() {
    try {
      const v = sessionStorage.getItem(DOCK_KEY);
      return DOCKS.includes(v) ? v : 'center';
    } catch { return 'center'; }
  }
  function applyDock(name) {
    const root = ensureRoot();
    for (const d of DOCKS) root.classList.remove('dock-' + d);
    root.classList.add('dock-' + name);
    try { sessionStorage.setItem(DOCK_KEY, name); } catch {}
  }
  function cycleDock() {
    const cur = loadDock();
    const next = DOCKS[(DOCKS.indexOf(cur) + 1) % DOCKS.length];
    applyDock(next);
  }

  // ---------- visitor context ----------
  // Snapshot of what /field is currently showing — focused node, zoom
  // level, mode, and the recent-focus trail. We ship this with each
  // /api/archivist/chat POST so the archivist can resolve deictic
  // phrases ("this", "what's near it") to the node on screen. Defensive
  // because window.ADAI_GRAPH_FIELD may not be initialised yet (the
  // archivist loads with `defer`, but the user could still send before
  // the field bundle is ready).
  function snapshotVisitorContext() {
    try {
      const field = window.ADAI_GRAPH_FIELD;
      if (!field) return null;
      const trail = Array.isArray(field.history)
        ? field.history
            .map((h) => h && typeof h.focusedId === 'string' ? h.focusedId : null)
            .filter(Boolean)
            .slice(-5)
        : [];
      const ctx = {
        focused_id: typeof field.focusedId === 'string' ? field.focusedId : null,
        // Default to '30k' (the overview) when the field hasn't set a level —
        // at rest bundle.viewLevel is undefined, and we want the server to
        // always know the visitor is at the overview rather than receive a
        // null it has to guess about. Must stay within the server's
        // ALLOWED_VIEW_LEVELS ('30k' | 'field-focus' | 'field-reveal').
        view_level: typeof field.viewLevel === 'string' ? field.viewLevel : '30k',
        field_mode: typeof field.fieldMode === 'string' ? field.fieldMode : null,
        recent_focus_ids: trail,
      };
      // Drop the whole snapshot if nothing useful is on screen — keeps
      // the server-side check (`!ctx` short-circuit) tidy.
      if (!ctx.focused_id && !ctx.view_level && !ctx.field_mode && trail.length === 0) {
        return null;
      }
      return ctx;
    } catch {
      return null;
    }
  }

  // ---------- session bootstrap ----------
  async function ensureSession() {
    if (STATE.online !== null) return STATE.online;
    try {
      const r = await fetch('/api/archivist/session', { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) { STATE.online = false; return false; }
      const j = await r.json();
      STATE.online = j.online !== false;
      STATE.quota = j.quota ?? null;
      return STATE.online;
    } catch {
      STATE.online = false;
      return false;
    }
  }

  // ---------- send + stream ----------
  async function send(text) {
    if (!text || STATE.busy) return;
    // Dismiss the help overlay on first real send — it's a starter hint,
    // not a permanent companion.
    if (STATE.helpOpen) {
      STATE.helpOpen = false;
      ensureRoot().querySelector('#arch-help')?.classList.remove('is-active');
    }
    const online = await ensureSession();
    if (!online) {
      STATE.turns.push({ role: 'assistant', text: '*the archivist is offline (no API key configured).*', chips: [] });
      renderLog();
      return;
    }
    // Add user turn (both UI and wire).
    STATE.turns.push({ role: 'user', text });
    STATE.history.push({ role: 'user', content: text });
    STATE.pendingAssistant = { role: 'assistant', text: '', chips: [] };
    STATE.turns.push(STATE.pendingAssistant);
    STATE.currentToolCalls = new Map();
    setBusy(true, 'thinking…');
    renderLog();

    const visitorContext = snapshotVisitorContext();
    let resp;
    try {
      resp = await fetch('/api/archivist/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({
          messages: STATE.history.slice(-MAX_HISTORY),
          ...(visitorContext ? { context: visitorContext } : {}),
        }),
      });
    } catch (e) {
      finishWithError('network error: ' + (e?.message || e));
      return;
    }
    if (!resp.ok) {
      let detail = '';
      try { detail = JSON.stringify(await resp.json()); } catch {}
      if (resp.status === 429) {
        finishWithError('rate-limited — slow down and try again in a few minutes.');
      } else if (resp.status === 503) {
        finishWithError('the archivist is resting (daily budget reached).');
      } else {
        finishWithError(`server returned ${resp.status}. ${detail}`);
      }
      return;
    }
    if (!resp.body) {
      finishWithError('no response body from server.');
      return;
    }
    try {
      await consumeSse(resp.body);
    } catch (e) {
      finishWithError('stream interrupted: ' + (e?.message || e));
      return;
    }
    // On done: record the assistant turn in wire history. If Claude emitted
    // text only (no tool calls outside the loop), a single string content
    // is enough; the model can resume next turn without seeing the chips.
    if (STATE.pendingAssistant && STATE.pendingAssistant.text) {
      STATE.history.push({ role: 'assistant', content: STATE.pendingAssistant.text });
    } else if (STATE.pendingAssistant) {
      // Empty assistant turn — drop it from history but keep the UI bubble
      // (with chips) so the user sees what happened.
      STATE.history.push({ role: 'assistant', content: '(no response)' });
      STATE.pendingAssistant.text = '*the archivist returned no text.*';
    }
    saveHistory();
    STATE.pendingAssistant = null;
    setBusy(false, '');
    renderLog();
  }

  function finishWithError(msg) {
    if (STATE.pendingAssistant) {
      STATE.pendingAssistant.text = '*' + msg + '*';
    } else {
      STATE.turns.push({ role: 'assistant', text: '*' + msg + '*', chips: [] });
    }
    // Keep wire-history alternation intact. send() already pushed the user
    // turn; without a matching assistant entry, the next send POSTs two
    // consecutive user roles and the Anthropic SDK rejects every retry
    // with `messages: must alternate between user and assistant`. Because
    // STATE.history is persisted to sessionStorage, that wedge survives
    // reloads until the visitor hits "reset". Match the success path's
    // contract (line 392-397) and record the failure on the wire too.
    const last = STATE.history[STATE.history.length - 1];
    if (last && last.role === 'user') {
      STATE.history.push({ role: 'assistant', content: '(error: ' + msg + ')' });
    }
    STATE.pendingAssistant = null;
    setBusy(false, '');
    saveHistory();
    renderLog();
  }

  // Manual SSE parser — splits on double newline, then per-line on the
  // 'event:' and 'data:' prefixes. EventSource doesn't support POST, so
  // we roll this ourselves.
  async function consumeSse(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let currentEvent = '';
    let dataParts = [];
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) buf += decoder.decode(value, { stream: !done });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line === '') {
          // dispatch
          if (dataParts.length > 0) {
            const dataStr = dataParts.join('\n');
            let payload = null;
            try { payload = JSON.parse(dataStr); } catch {}
            dispatchSse(currentEvent || 'message', payload);
          }
          currentEvent = '';
          dataParts = [];
          continue;
        }
        if (line.startsWith(':')) continue; // comment / heartbeat
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataParts.push(line.slice(5).trimStart());
        }
      }
    }
  }

  function chipLabelFor(name, input) {
    const labels = {
      search_nodes: input && input.query ? `searching: "${input.query}"` : 'searching',
      get_node: input && input.slug ? `reading: ${input.slug}` : 'reading node',
      get_neighbours: input && input.slug ? `neighbours: ${input.slug}` : 'neighbours',
      get_component: input && input.slug ? `component: ${input.slug}` : 'component',
      get_stats: 'graph stats',
      list_recent_additions: 'recent additions',
      focus_node: input && input.slug ? `→ focusing ${input.slug}` : '→ focus',
      highlight_nodes: input && Array.isArray(input.slugs) ? `→ highlight ×${input.slugs.length}` : '→ highlight',
      set_field_mode: input && input.mode ? `→ mode: ${input.mode}` : '→ mode',
      clear_focus: '→ zoom out',
      open_entity_view: input && input.slug ? `→ open ${input.slug}` : '→ open node',
    };
    return labels[name] || name;
  }

  function dispatchSse(event, data) {
    if (!data) return;
    const a = STATE.pendingAssistant;
    if (!a) return;
    if (event === 'text_delta' && typeof data.text === 'string') {
      a.text += data.text;
      renderLog();
    } else if (event === 'tool_use_start') {
      const chip = { id: data.tool_use_id, name: data.name, label: chipLabelFor(data.name, null), done: false };
      a.chips.push(chip);
      STATE.currentToolCalls.set(data.tool_use_id, chip);
      renderLog();
    } else if (event === 'tool_use_end') {
      const chip = STATE.currentToolCalls.get(data.tool_use_id);
      if (chip) {
        chip.done = true;
        if (!data.ok) chip.error = true;
      }
      renderLog();
    } else if (event === 'client_tool') {
      // The matching tool_use_start already pushed a placeholder chip; we
      // refine that chip in-place with the input-derived label (e.g.
      // "→ highlight ×6") and the gold "client" tint. Falling back to a
      // new chip only if the start event never arrived for some reason.
      const id = data.tool_use_id;
      let chip = id ? STATE.currentToolCalls.get(id) : null;
      if (chip) {
        chip.label = chipLabelFor(data.name, data.input);
        chip.client = true;
        chip.done = true;
      } else {
        chip = { name: data.name, label: chipLabelFor(data.name, data.input), client: true, done: true };
        a.chips.push(chip);
      }
      dispatchClientTool(data.name, data.input || {});
      renderLog();
    } else if (event === 'links' && data.links && typeof data.links === 'object') {
      a.links = data.links;
      renderLog();
    } else if (event === 'stop') {
      // record reason silently; UI cleanup happens in send()
    } else if (event === 'error') {
      const msg = (data && data.error) || 'unknown error';
      a.chips.push({ name: 'error', label: 'error: ' + String(msg).slice(0, 80), error: true, done: true });
      renderLog();
    } else if (event === 'done') {
      // end-of-stream marker; consumeSse will exit naturally after this.
    }
  }

  // ---------- client tool dispatch ----------
  function findNodeIdBySlug(slug) {
    const g = window.ADAI_GRAPH;
    if (!g || !g.byId) return null;
    // Slugs are unique per the canonical seed. Search byId for a matching slug.
    for (const n of g.byId.values()) {
      if (n.slug === slug) return n.id;
    }
    return null;
  }
  function dispatchClientTool(name, input) {
    const api = window.ADAI_GRAPH_FIELD;
    if (!api) return;
    try {
      if (name === 'focus_node') {
        const id = findNodeIdBySlug(input.slug);
        if (id && typeof api.zoomTo === 'function') api.zoomTo(id);
      } else if (name === 'highlight_nodes') {
        const slugs = Array.isArray(input.slugs) ? input.slugs : [];
        const ids = slugs.map(findNodeIdBySlug).filter(Boolean);
        if (ids.length && typeof api.highlightNodes === 'function') {
          api.highlightNodes(ids);
        }
      } else if (name === 'clear_focus') {
        if (typeof api.zoomToHome === 'function') api.zoomToHome();
        if (typeof api.clearHighlights === 'function') api.clearHighlights();
      } else if (name === 'set_field_mode') {
        const mode = input && input.mode;
        if ((mode === 'curatorial' || mode === 'embeddings') && typeof api.setMode === 'function') {
          api.setMode(mode);
        }
      } else if (name === 'open_entity_view') {
        // Open the rich detailed overlay (the same panel the 'i' key
        // triggers). We zoom the field first so closing the overlay
        // leaves the visitor on the right node — entity-view doesn't
        // touch field focus on its own.
        const id = findNodeIdBySlug(input.slug);
        const ev = window.ADAI_ENTITY_VIEW;
        if (id) {
          if (typeof api.zoomTo === 'function') {
            try { api.zoomTo(id); } catch { /* non-fatal */ }
          }
          if (ev && typeof ev.open === 'function') ev.open(id);
        }
      }
    } catch (e) {
      console.warn('[archivist] client-tool dispatch failed:', name, e);
    }
  }

  // ---------- event wiring ----------
  function onSendClick() {
    const root = ensureRoot();
    const input = root.querySelector('#arch-input');
    if (!input) return;
    const v = (input.value || '').trim();
    if (!v) return;
    input.value = '';
    autoresize();
    send(v);
  }
  function autoresize() {
    const root = ensureRoot();
    const input = root.querySelector('#arch-input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
  }

  // Build the DOM up-front so the bar is always visible. The log starts
  // collapsed (display:none in the empty state) and expands on first turn.
  function init() {
    loadHistory();
    ensureRoot();
    renderLog();
    const root = ensureRoot();

    applyDock(loadDock());
    if (loadPanelOpen()) open({ focus: false });
    else close({ blur: false });

    const sendBtn = root.querySelector('#arch-send');
    const input = root.querySelector('#arch-input');
    const helpBtn = root.querySelector('#arch-help');
    const resetBtn = root.querySelector('#arch-reset');
    const minBtn = root.querySelector('#arch-minimize');
    const dockBtn = root.querySelector('#arch-dock');
    sendBtn?.addEventListener('click', onSendClick);
    helpBtn?.addEventListener('click', () => {
      STATE.helpOpen = !STATE.helpOpen;
      // The help panel only renders if the log is visible — pop the bar
      // open so first-time visitors don't click "?" into a no-op.
      if (STATE.helpOpen) open({ focus: false });
      const r2 = ensureRoot();
      r2.querySelector('#arch-help')?.classList.toggle('is-active', STATE.helpOpen);
      renderLog();
    });
    resetBtn?.addEventListener('click', () => {
      // Confirm only if there's anything to lose. Cheap protection against an
      // accidental click mid-thread; click again immediately if you mean it.
      if (STATE.turns.length === 0) { clear(); return; }
      if (typeof window.confirm === 'function' && !window.confirm('Reset this conversation?')) return;
      clear();
    });
    minBtn?.addEventListener('click', () => {
      const root2 = ensureRoot();
      if (root2.classList.contains('is-open')) close();
      else open();
    });
    root.addEventListener('click', (e) => {
      if (!e.target?.closest?.('[data-arch-panel-minimize]')) return;
      e.preventDefault();
      close();
    });
    dockBtn?.addEventListener('click', cycleDock);
    input?.addEventListener('input', autoresize);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSendClick();
      } else if (e.key === 'Escape') {
        // Collapse the log (and blur via close()) — matches the visible
        // "esc close" hint and avoids the dead-air state of just-blurred.
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    input?.addEventListener('focus', () => {
      if (!STATE.open) open({ focus: false });
    });

    // Intercept clicks on profile-page links the archivist emits inside its
    // replies (e.g. [Casey Reas](/practitioner/casey-reas)). Instead of
    // navigating to the standalone server-rendered profile, we zoom the
    // field to the node AND open the rich entity-view overlay on top —
    // the visitor's expectation when clicking a name is "show me this in
    // detail", and the overlay is the in-page version of that. The model
    // distinction stays intact: focus_node is still zoom-only, this is
    // user-initiated. Modifier-click (cmd/ctrl/shift) and middle-click
    // are left alone so "open in new tab → reach the server page" still
    // works for visitors who want it.
    const KNOWN_NODE_PREFIXES = new Set([
      'practitioner', 'artwork', 'concept', 'scene', 'collective',
      'institution', 'platform', 'publication', 'project',
      'classification_regime', 'event', 'related',
    ]);
    root.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return; // ignore middle/right
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // honour new-tab/window
      const a = e.target?.closest?.('a[href]');
      if (!a || !root.contains(a)) return;
      const href = a.getAttribute('href') || '';
      // Same-origin path of form /<type>/<slug>; reject deeper paths, query
      // strings, fragments — those aren't profile-page links.
      const m = /^\/([a-z_]+)\/([^\/?#]+)$/.exec(href);
      if (!m) return;
      if (!KNOWN_NODE_PREFIXES.has(m[1])) return;
      const slug = decodeURIComponent(m[2]);
      const id = findNodeIdBySlug(slug);
      const api = window.ADAI_GRAPH_FIELD;
      const ev = window.ADAI_ENTITY_VIEW;
      if (!id) {
        // Slug not in the loaded graph — fall through to the browser
        // default so the visitor still reaches the standalone page.
        return;
      }
      // We have a node; we'll prevent the navigation regardless. Zoom the
      // field first (so closing the overlay lands the visitor on the
      // right node), then open the entity-view overlay if available. If
      // neither bundle is ready, fall back to navigation.
      if (!api?.zoomTo && !ev?.open) return;
      e.preventDefault();
      if (api && typeof api.zoomTo === 'function') {
        try { api.zoomTo(id); } catch (err) { console.warn('[archivist] zoomTo failed:', err); }
      }
      if (ev && typeof ev.open === 'function') {
        try { ev.open(id); } catch (err) { console.warn('[archivist] entity-view open failed:', err); }
      }
    });

    // Global keyboard — Shift+? focuses the input from anywhere except
    // when the user is already typing in any input (including this one;
    // otherwise typing "?" inside the chat would toggle the chat closed).
    document.addEventListener('keydown', (e) => {
      if (e.key === '?' && e.shiftKey) {
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        const isTyping = tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable;
        if (isTyping) return;
        e.preventDefault();
        toggle();
      }
    });

    // Kick off the session in the background — no UI dependency.
    ensureSession().catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.ADAI_ARCHIVIST = {
    open, close, toggle, send, clear,
    get isOpen() { return STATE.open; },
    get isBusy() { return STATE.busy; },
  };
})();
