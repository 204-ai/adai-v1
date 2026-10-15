/**
 * A(DAI) — archivist launcher (the Reader, drop-in skill)
 *
 * The archivist is the Reader persona from the relational intelligence
 * protocol. Per vault philosophy (raw/references/reader.md), the Reader runs
 * in the visitor's OWN Claude — never on this frontend, and never with a key
 * pasted into the browser. The trust boundary is structural: keys, costs,
 * and contextual sovereignty stay with the user, not with us.
 *
 * This panel is the handoff surface. It explains what the archivist is and
 * gives the visitor three ways to drop the skill into Claude:
 *   1. Copy the skill text → paste into Claude.ai
 *   2. Download reader.md → save to ~/.claude/skills/ for Claude Code
 *   3. Open Claude.ai with a starter prompt
 *
 * The frontend hosts no chat. The frontend hosts the path TO the chat.
 */
(() => {
  const STATE = { open: false, copied: false, copiedIdx: null, skillText: null };
  const SKILL_URL = '/field-static/skills/reader.md';
  const PROTOCOL_URL = '/field-static/skills/relational-intelligence-protocol.md';

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- DOM ----------
  function ensurePanel() {
    let el = document.getElementById('chat-narrator');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'chat-narrator';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '';
    document.body.appendChild(el);
    return el;
  }

  function currentNodeName() {
    const id = window.ADAI_GRAPH_FIELD?.focusedId;
    if (!id) return null;
    return window.ADAI_GRAPH?.byId?.get(id)?.name || null;
  }

  // Starter prompts — each one exercises a different facet of the skill
  // (basic narration, wrong-story self-correction, bias declaration,
  // provenance honesty, contribute redirect). The first prompt is
  // context-aware — adapts to whoever the user has focused.
  function starterPrompts() {
    const name = currentNodeName();
    const lead = name
      ? { label: `Tell me about ${name}`, q: `Tell me about ${name}. Use the Reader protocol — name source origin if it matters, name what's left out, quote the edge types when you describe relations.` }
      : { label: 'What is the seed canon?', q: `What is A(DAI)'s seed canon? Fetch /api/stats for live counts, then narrate the shape — name what's foregrounded, name what's left out.` };
    return [
      lead,
      { label: "Who's the most important practitioner?", q: `Who is the most important practitioner in the seed canon? (This is a wrong-story trap — answer per the Reader's editorial position on contestation, not by ranking.)` },
      { label: "What's missing from the canon?", q: `What's missing from the seed canon? Be specific — name the source-coverage profile, name the underrepresented scenes and geographies, name what the institute has on its agenda but hasn't ingested yet.` },
      { label: 'How confident is the data?', q: `How confident is the data in the graph? Walk me through the source_origin typing (human_primary vs human_secondary vs ai_assisted) and what fraction of the seed sits at each level — and which platforms and museums the nodes are sourced from.` },
      { label: "I want to contribute my work", q: `I want to contribute my own work to the graph. How do I do that? (Test the contribute redirect — the Reader should hand off to /contribute, not draft on my behalf.)` },
    ];
  }

  // Build a compact live-graph snapshot from window.ADAI_GRAPH so Claude has
  // real data even when it's running in a surface without web fetch (most
  // commonly Claude.ai web). The skill instructs the Reader to use this
  // when present and to refuse to invent when it isn't.
  function buildSnapshot() {
    const g = window.ADAI_GRAPH;
    const stats = window.ADAI_GRAPH_STATS;
    if (!g) return '';
    const ts = new Date().toISOString();

    // Canon-level summary (always included).
    const counts = {};
    for (const n of g.byId.values()) counts[n.type] = (counts[n.type] || 0) + 1;
    const order = ['practitioner', 'artwork', 'concept', 'scene', 'institution', 'platform', 'collective', 'classification_regime'];
    const countLines = order
      .filter(t => counts[t])
      .map(t => `  ${t}: ${counts[t]}`)
      .join('\n');

    // Image coverage (artwork-side editorial fact).
    const renderable = (u) => /^https?:\/\//i.test(u || '');
    const artworks = g.byType.get('artwork') || [];
    const artImgCount = artworks.filter(a => renderable(a.cdn_image_url) || renderable(a.image_url)).length;

    let block = `## Live graph snapshot (frontend snapshot, ${ts})\n\n`;
    if (stats) block += `Totals: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.signals || 0} signals.\n`;
    block += `Counts by type:\n${countLines}\n`;
    block += `Artworks with renderable image (jpg/png/webp/gif): ${artImgCount} of ${artworks.length} (${Math.round(100*artImgCount/Math.max(1,artworks.length))}%).\n`;

    // Focused-entity 1-hop subgraph (when one is focused).
    const focusedId = window.ADAI_GRAPH_FIELD?.focusedId;
    if (focusedId && g.byId.has(focusedId)) {
      const node = g.byId.get(focusedId);
      block += `\n## Focused entity\n\n`;
      block += `id: ${node.id}\n`;
      block += `name: ${node.name}\n`;
      block += `type: ${node.type}\n`;
      if (node.slug) block += `slug: ${node.slug}\n`;
      // Real provenance label shipped on every graph node (sourceLabel() server
      // side, from metadata.source_url / va_maker_name).
      if (node.source) block += `source: ${node.source}\n`;
      // The editorial profile is server-rendered now (src/entity/view.ts):
      // point at it rather than snapshot it.
      if (node.slug) block += `profile: ${location.origin}/${node.type}/${node.slug}\n`;

      // Edges grouped by type
      const edges = g.edgesFor(focusedId);
      const byType = new Map();
      for (const e of edges) {
        if (e.type === 'CLASSIFIED_BY') continue;
        const otherId = e.source === focusedId ? e.target : e.source;
        const other = g.byId.get(otherId);
        if (!other) continue;
        const list = byType.get(e.type) || [];
        list.push(`${other.name} [${other.type}${e.confidence ? `, ${e.confidence}` : ''}]`);
        byType.set(e.type, list);
      }
      block += `\n1-hop edges (excluding CLASSIFIED_BY):\n`;
      for (const [t, items] of byType) {
        const cap = items.slice(0, 16);
        const more = items.length > 16 ? ` (+${items.length - 16} more)` : '';
        block += `  ${t}: ${cap.join(' · ')}${more}\n`;
      }

      // Showcase extras when present
      if (showcase?.works?.length) {
        block += `\nWorks (curated):\n`;
        showcase.works.forEach(w => block += `  - ${w.title} [${w.year}] · ${w.medium || ''}${w.method ? ` · method: ${w.method}` : ''}\n`);
      }
      if (showcase?.exhibitions_selected?.length) {
        block += `\nExhibitions (selected):\n`;
        showcase.exhibitions_selected.forEach(x => block += `  - [${x.year}] ${x.title} · ${x.venue || ''}\n`);
      }
      if (showcase?.awards?.length) {
        block += `\nAwards:\n`;
        showcase.awards.forEach(a => block += `  - [${a.year}] ${a.title}${a.body ? ` · ${a.body}` : ''}\n`);
      }
    }
    return block;
  }

  // Build the one-paste bundle that drops into Claude.ai: skill + live
  // snapshot + bridge + chosen question. User pastes this single block,
  // Claude reads the skill, has the data, and answers per the protocol.
  async function buildBundle(question) {
    const skill = await fetchSkill();
    if (!skill) return null;
    const snapshot = buildSnapshot();
    return `Use this skill for the rest of our conversation. You are A(DAI)'s archivist (the Reader persona). Read the skill below, then answer the question at the bottom. Stay in the institute's voice as defined in the skill.

---

${skill}

---

${snapshot}---

Question: ${question}`;
  }

  function render() {
    const el = ensurePanel();
    const name = currentNodeName();
    const focus = name
      ? `currently in view: <strong>${escapeHtml(name)}</strong>`
      : `nothing is focused right now — the archivist will narrate at canon level.`;
    const prompts = starterPrompts();
    const promptChips = prompts.map((p, i) => `
      <button class="cn-chip" data-cn="bundle" data-cn-idx="${i}" type="button">
        <span class="cn-chip-q">${escapeHtml(p.label)}</span>
        <span class="cn-chip-cta">${STATE.copiedIdx === i ? '✓ copied' : 'copy →'}</span>
      </button>
    `).join('');

    el.innerHTML = `
      <header class="cn-head">
        <div class="cn-title">
          <span class="cn-dot"></span>
          <span>archivist</span>
          <span class="cn-sub">read-only · runs in your own Claude</span>
        </div>
        <button class="cn-icon" data-cn="close" title="close (esc)" aria-label="close">×</button>
      </header>
      <div class="cn-wip">
        <strong>in progress</strong> — this surface is a drop-in skill, not a live two-way conversation. The Reader gets a snapshot of the graph at the moment you click a prompt; it can't follow up by fetching more. Workflow friction, frozen data, and the surface's own limitations are real. The production path is a server-side <code>/api/agent</code> endpoint or an MCP server (post-Basel). Voice, depth, and editorial guardrails are all <strong>tunable</strong> — flag what felt off and the skill gets sharper.
      </div>
      <div class="cn-body">
        <section class="cn-section">
          <h3 class="cn-h">try asking</h3>
          <p class="cn-context">${focus}</p>
          <p class="cn-p cn-p--dim cn-p--small">Click any prompt to copy a one-paste bundle (skill + question). Paste into a new Claude.ai conversation and the archivist will answer.</p>
          <div class="cn-chips">${promptChips}</div>
        </section>

        <section class="cn-section">
          <h3 class="cn-h">or just take the skill</h3>
          <p class="cn-p cn-p--dim cn-p--small">Power users: drop the skill into your Claude session and ask whatever you want.</p>
          <div class="cn-opt-actions">
            <button class="cn-btn" data-cn="copy-skill">${STATE.copied ? '✓ copied skill' : 'copy skill only'}</button>
            <a class="cn-btn cn-btn--ghost" href="https://claude.ai/new" target="_blank" rel="noopener">open Claude.ai →</a>
            <a class="cn-btn cn-btn--ghost" href="${SKILL_URL}" download="reader.md">download .md</a>
          </div>
          <p class="cn-p cn-p--dim cn-p--small">For Claude Code: save to <code>~/.claude/skills/reader.md</code>. <a class="cn-link" href="${PROTOCOL_URL}" download="relational-intelligence-protocol.md">+ companion protocol</a>.</p>
        </section>

        <section class="cn-section cn-section--small">
          <h3 class="cn-h">why your Claude, not this page</h3>
          <p class="cn-p cn-p--dim cn-p--small">The archivist is the Reader persona from A(DAI)'s <a class="cn-link" href="${PROTOCOL_URL}" target="_blank" rel="noopener">relational intelligence protocol</a> — public, read-only, narrates the graph but never writes to it. We don't host the conversation here because that would mean either holding your API key in a browser (bad practice) or paying for every visitor's questions on our key (unsustainable, and architecturally wrong — the merge boundary isn't on this page). Your Claude, your context, your cost, your sovereignty.</p>
        </section>

        <section class="cn-section cn-section--small">
          <h3 class="cn-h">what the archivist will not do</h3>
          <p class="cn-p cn-p--dim cn-p--small">It will not write to the graph. It will not propose edits, accept signals, or contest classifications. To do any of that, switch to the <em>/contribute</em> skill — the Gatherer, paired-trust, with auth. Same institute, opposite direction through the merge boundary.</p>
        </section>
      </div>
    `;
  }

  async function fetchSkill() {
    if (STATE.skillText) return STATE.skillText;
    try {
      const res = await fetch(SKILL_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      STATE.skillText = await res.text();
      return STATE.skillText;
    } catch (err) {
      console.warn('[archivist] failed to fetch skill', err);
      return null;
    }
  }

  async function copySkill() {
    const text = await fetchSkill();
    if (!text) {
      alert('Could not fetch the skill file. Open ' + SKILL_URL + ' directly to copy.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      STATE.copied = true;
      render();
      setTimeout(() => { STATE.copied = false; if (STATE.open) render(); }, 2000);
    } catch (err) {
      // Fallback: open the .md in a new tab so user can copy manually.
      window.open(SKILL_URL, '_blank');
    }
  }

  async function copyBundle(idx) {
    const prompts = starterPrompts();
    const prompt = prompts[idx];
    if (!prompt) return;
    const bundle = await buildBundle(prompt.q);
    if (!bundle) {
      alert('Could not assemble the bundle — open ' + SKILL_URL + ' directly to copy the skill, then paste your question manually.');
      return;
    }
    try {
      await navigator.clipboard.writeText(bundle);
      STATE.copiedIdx = idx;
      render();
      setTimeout(() => { STATE.copiedIdx = null; if (STATE.open) render(); }, 2200);
    } catch (err) {
      // Fallback: stash in a textarea + select for manual copy.
      console.warn('[archivist] clipboard.writeText failed; opening fallback', err);
      const ta = document.createElement('textarea');
      ta.value = bundle;
      ta.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:60vw;height:60vh;z-index:9999;';
      document.body.appendChild(ta);
      ta.select();
      alert('Clipboard blocked. Press Cmd/Ctrl+C to copy the highlighted text, then close this prompt.');
      setTimeout(() => ta.remove(), 100);
    }
  }

  // ---------- Open / close ----------
  function open() {
    STATE.open = true;
    const el = ensurePanel();
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    render();
  }
  function close() {
    STATE.open = false;
    const el = document.getElementById('chat-narrator');
    if (el) {
      el.classList.remove('is-open');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  // ---------- Events ----------
  document.addEventListener('click', (e) => {
    const action = e.target?.closest?.('[data-action]')?.dataset?.action;
    if (action === 'chat') {
      e.preventDefault(); e.stopPropagation();
      open();
      return;
    }
    if (!STATE.open) return;
    const cn = e.target?.closest?.('[data-cn]')?.dataset?.cn;
    if (cn === 'close') { e.preventDefault(); close(); }
    else if (cn === 'copy-skill') { e.preventDefault(); copySkill(); }
    else if (cn === 'bundle') {
      e.preventDefault();
      const idx = Number(e.target.closest('[data-cn-idx]')?.dataset?.cnIdx);
      if (!Number.isNaN(idx)) copyBundle(idx);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!STATE.open) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      close();
    }
  }, true);

  window.ADAI_CHAT_NARRATOR = { open, close, get isOpen() { return STATE.open; } };

  // ---------- Styles ----------
  const style = document.createElement('style');
  style.textContent = `
    #chat-narrator {
      position: fixed; right: 0; top: 0; bottom: 0;
      width: min(480px, 92vw);
      background: rgba(8, 8, 10, 0.97); backdrop-filter: blur(8px);
      border-left: 1px solid #2a2a2c; color: var(--text, #E8E6E1);
      font-family: var(--mono, 'SF Mono', 'Menlo', 'Consolas', monospace);
      z-index: 1200; display: none; flex-direction: column;
    }
    #chat-narrator.is-open { display: flex; }
    .cn-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px; border-bottom: 1px solid #2a2a2c; flex-shrink: 0;
    }
    .cn-wip {
      padding: 12px 18px; font-size: 11px; line-height: 1.55;
      color: #c4a868; background: rgba(196, 168, 104, 0.06);
      border-bottom: 1px solid rgba(196, 168, 104, 0.2);
      flex-shrink: 0;
    }
    .cn-wip strong { color: #d8c089; font-weight: 700; }
    .cn-wip code { background: #1a1a1c; padding: 1px 4px; border-radius: 2px; color: #d8c089; }
    .cn-title { display: flex; align-items: center; gap: 10px; font-size: 13px; }
    .cn-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--brand-color, #4169B0); box-shadow: 0 0 6px var(--brand-color, #4169B0);
    }
    .cn-sub { color: #6a6a6c; font-size: 11px; padding-left: 4px; }
    .cn-icon {
      width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: none; color: #8a8a8c; font-family: inherit;
      cursor: pointer; font-size: 16px;
    }
    .cn-icon:hover { color: var(--text); }
    .cn-body {
      flex: 1; overflow-y: auto; padding: 20px 18px 32px;
      display: flex; flex-direction: column; gap: 24px;
    }
    .cn-section { display: flex; flex-direction: column; gap: 8px; }
    .cn-section--small { padding-top: 8px; border-top: 1px solid #1a1a1c; }
    .cn-h {
      font-size: 11px; color: #8a8a8c; letter-spacing: 0.06em;
      text-transform: uppercase; font-weight: 400; margin-bottom: 4px;
    }
    .cn-p { font-size: 13px; line-height: 1.6; color: var(--text); }
    .cn-p--dim { color: #8a8a8c; }
    .cn-p em { color: var(--brand-color, #4169B0); font-style: normal; }
    .cn-link { color: var(--brand-color, #4169B0); text-decoration: underline; }
    .cn-link:hover { color: #5a85d0; }

    .cn-context {
      font-size: 12px; color: #8a8a8c; padding: 8px 10px;
      background: rgba(65, 105, 176, 0.06); border-left: 2px solid var(--brand-color, #4169B0);
    }
    .cn-context strong { color: var(--text); font-weight: 700; }

    .cn-options { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
    .cn-option {
      border: 1px solid #2a2a2c; padding: 14px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .cn-opt-title { font-size: 13px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 10px; }
    .cn-opt-num {
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; background: var(--brand-color, #4169B0);
      color: #0a0a0c; font-size: 11px; font-weight: 700; border-radius: 50%;
    }
    .cn-opt-body { font-size: 12px; color: #b4b4b6; line-height: 1.5; }
    .cn-opt-body code {
      background: #1a1a1c; padding: 1px 5px; border-radius: 2px; color: #c8c8ca;
      font-size: 11px;
    }
    .cn-opt-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .cn-btn {
      background: var(--brand-color, #4169B0); color: #0a0a0c;
      border: none; padding: 7px 12px; font-family: inherit; font-weight: 600;
      cursor: pointer; font-size: 12px; text-decoration: none;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .cn-btn:hover { background: #5a85d0; }
    .cn-btn--ghost {
      background: transparent; color: var(--text); border: 1px solid #3a3a3c;
    }
    .cn-btn--ghost:hover { background: rgba(255,255,255,0.04); border-color: #6a6a6c; }

    .cn-prompt {
      background: #0a0a0c; border: 1px solid #2a2a2c; padding: 10px 12px;
      font-size: 11px; color: #b4b4b6; max-height: 180px; overflow: auto;
      white-space: pre-wrap; word-break: break-word; line-height: 1.5;
    }

    .cn-p--small { font-size: 12px; }

    .cn-chips { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .cn-chip {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      width: 100%; padding: 10px 12px;
      background: rgba(65, 105, 176, 0.04); border: 1px solid #2a2a2c;
      color: var(--text, #E8E6E1); font-family: inherit; font-size: 13px;
      text-align: left; cursor: pointer; line-height: 1.4;
    }
    .cn-chip:hover {
      background: rgba(65, 105, 176, 0.10); border-color: var(--brand-color, #4169B0);
    }
    .cn-chip-q { flex: 1; }
    .cn-chip-cta {
      color: #6a6a6c; font-size: 11px; letter-spacing: 0.04em; flex-shrink: 0;
    }
    .cn-chip:hover .cn-chip-cta { color: var(--brand-color, #4169B0); }

    @media (max-width: 768px) {
      #chat-narrator { width: 100vw; }
    }
  `;
  document.head.appendChild(style);
})();
