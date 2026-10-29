// Server-rendered shells for the URL intake (docs/URL-INTAKE-SPEC.md §12):
// /contribute, /draft/:id, /batch/:id. Vanilla JS, no framework. The draft
// page is deliberately plain — the cards are where scope wants to grow.

import { htmlPage, htmlEscape } from "../templates.js";

const CSS = `
#intake { font-family: 'SF Mono','SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace; }
#intake .kicker { color: #6a6a6c; font-size: 12px; letter-spacing: 0.08em; margin-bottom: 10px; }
#intake h2 { font-size: 19px; color: #e8e6e1; margin: 0 0 8px; letter-spacing: 0.01em; }
#intake .lede { color: #8a8a8c; font-size: 13px; line-height: 1.65; max-width: 620px; }
#intake .lede a, #intake .card a, #intake .rail a { color: #7eb8da; }
#intake form { max-width: 560px; margin-top: 18px; }
#intake form label { margin-top: 12px; }
#intake .row { display: flex; gap: 8px; align-items: flex-end; }
#intake .row input { flex: 1; }
#intake .btn { font-family: inherit; font-size: 12px; }
#intake .btn.primary { border-color: #7eb8da; }
#intake .btn:disabled { opacity: 0.5; cursor: default; }
#intake .msg { font-size: 13px; }
#intake .drafts { list-style: none; margin-top: 18px; max-width: 620px; }
#intake .drafts li { border: 1px solid #1e1e20; padding: 10px 12px; margin-bottom: 8px; font-size: 12px; display: flex; gap: 12px; align-items: baseline; }
#intake .drafts li .dom { color: #e8e6e1; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#intake .pill { display: inline-block; border: 1px solid #333; padding: 1px 7px; border-radius: 9px; font-size: 11px; color: #9a9a9c; }
#intake .pill.ready { border-color: #2a5a3a; color: #6fbf8a; }
#intake .pill.running, #intake .pill.queued { border-color: #5a4a1a; color: #c4a944; }
#intake .pill.submitted { border-color: #2a3a5a; color: #7eb8da; }
#intake .pill.failed { border-color: #5a2a2a; color: #bf6f6f; }
#intake .pill.abandoned { border-color: #333; color: #666; }
/* draft page */
#intake .dhead { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: baseline; border-bottom: 1px solid #1e1e20; padding-bottom: 12px; margin-bottom: 14px; font-size: 12px; color: #8a8a8c; }
#intake .dhead .src { color: #e8e6e1; word-break: break-all; }
#intake .dhead .spacer { flex: 1; }
#intake .group h3 { font-size: 12px; color: #9a9a9c; letter-spacing: 0.06em; text-transform: uppercase; margin: 18px 0 8px; }
#intake .card { padding: 10px 12px; font-size: 12.5px; line-height: 1.55; border-radius: 3px; }
#intake .card.accepted { border-color: #2a5a3a; }
#intake .card.rejected { opacity: 0.55; }
#intake .card.rejected .title { text-decoration: line-through; }
#intake .card.context_only { opacity: 0.7; border-style: dashed; }
#intake .card.answered { border-color: #2a3a5a; }
#intake .card.open { border-style: dotted; border-color: #5a4a1a; }
#intake .card .actions .btn.held { background: #2a2416; border-color: #5a4a1a; color: #c4a944; }
#intake .openreads { list-style: none; margin-top: 8px; max-width: 620px; }
#intake .openreads li { border: 1px dashed #3a3220; padding: 10px 12px; margin-bottom: 8px; font-size: 12px; line-height: 1.55; }
#intake .openreads li.hit { border-color: #c4a944; }
#intake .openreads .btn { float: right; margin: 0 0 4px 8px; }
#intake .card.busy { opacity: 0.6; }
#intake .card.busy .actions::after { content: 'saving…'; color: #8a8a8c; font-size: 11px; margin-left: 4px; }
#intake .card .title { color: #e8e6e1; font-size: 13px; }
#intake .card .badge { display: inline-block; font-size: 10px; color: #7eb8da; background: #1a1a2e; padding: 0 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle; }
#intake .card .badge.ai { color: #c4a944; background: #2a2416; }
#intake .card .note { color: #9a9a9c; margin-top: 3px; }
#intake .card .quote { color: #b8b6b1; font-style: italic; margin-top: 5px; border-left: 2px solid #2a2a2c; padding-left: 8px; }
#intake .card .quote a { color: #6a8aa0; font-style: normal; font-size: 11px; margin-left: 6px; }
#intake .card .link { color: #8a8a8c; margin-top: 3px; font-size: 11.5px; }
#intake .card .actions { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
#intake .card .actions .btn { padding: 3px 9px; margin: 0; font-size: 11px; }
#intake .card .actions .btn.on { background: #1a2e1a; border-color: #2a5a3a; color: #6fbf8a; }
#intake .card .actions .btn.off { background: #2e1a1a; border-color: #5a2a2a; color: #bf6f6f; }
#intake .card .edit { margin-top: 8px; display: none; gap: 6px; flex-wrap: wrap; }
#intake .card .edit.open { display: flex; }
#intake .card .edit input, #intake .card .edit select { width: auto; flex: 1; min-width: 120px; padding: 3px 6px; font-size: 12px; font-family: inherit; }
#intake .card .edit textarea { width: 100%; min-height: 56px; font-family: inherit; font-size: 12px; }
#intake .card img.thumb { max-width: 160px; max-height: 120px; display: block; margin-top: 6px; border: 1px solid #222; }
#intake .card .diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; }
#intake .card .diff div { background: #111; padding: 6px 8px; border-radius: 3px; word-break: break-word; }
#intake .card .diff .k { color: #666; font-size: 10.5px; }
/* the agent (summary, survey, chat): a drawer reachable from every step (issue #76) */
#intake .rail { position: fixed; top: 0; right: 0; bottom: 0; width: min(400px, 100%); z-index: 40; background: #0f0f0f; border-left: 1px solid #2a2a2c; font-size: 12.5px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; padding: calc(14px + env(safe-area-inset-top, 0px)) calc(16px + env(safe-area-inset-right, 0px)) calc(14px + env(safe-area-inset-bottom, 0px)) 16px; transform: translateX(100%); transition: transform 180ms ease; visibility: hidden; }
#intake .rail.open { transform: none; visibility: visible; }
@media (prefers-reduced-motion: reduce) { #intake .rail { transition: none; } }
#intake .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 35; display: none; }
#intake .scrim.open { display: block; }
#intake .rail h3 { font-size: 12px; color: #9a9a9c; margin: 0 0 8px; letter-spacing: 0.06em; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center; flex: 0 0 auto; }
#intake .rail .log { flex: 1 1 auto; overflow: auto; min-height: 120px; }
#intake .rail .m { margin-bottom: 8px; white-space: pre-wrap; }
#intake .rail .m.user { color: #e8e6e1; }
#intake .rail .m.assistant { color: #b8b6b1; }
#intake .rail .m .who { color: #666; font-size: 10.5px; }
#intake .rail form { margin-top: 8px; display: flex; gap: 6px; max-width: none; flex: 0 0 auto; }
#intake .rail form textarea { min-height: 56px; font-family: inherit; font-size: 12px; flex: 1; }
#intake .rail details { flex: 0 0 auto; border-bottom: 1px solid #1e1e20; margin-bottom: 8px; }
#intake .rail details > summary { cursor: pointer; color: #9a9a9c; font-size: 10.5px; padding-bottom: 6px; }
#intake .rail #newmsg { align-self: center; margin-top: 6px; flex: 0 0 auto; }
#intake .rail #newmsg[hidden] { display: none; }
#intake .rail .summary { color: #9a9a9c; border-bottom: 1px solid #1e1e20; padding-bottom: 8px; margin-bottom: 8px; white-space: pre-wrap; flex: 0 1 auto; max-height: 30vh; overflow: auto; border-bottom: 0; margin-bottom: 0; padding-bottom: 4px; }
#intake .rail .survey { color: #9a9a9c; border-bottom: 1px solid #1e1e20; padding-bottom: 8px; margin-bottom: 8px; flex: 0 1 auto; max-height: 22vh; overflow: auto; border-bottom: 0; margin-bottom: 0; padding-bottom: 4px; }
#intake .rail .survey .who { color: #666; font-size: 10.5px; }
/* steps (issue #76): one kind of card at a time */
#intake .stepper { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: #0a0a0a; border-bottom: 1px solid #1e1e20; padding: 6px 0; margin-bottom: 16px; }
#intake .steps { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; list-style: none; margin: 0; padding: 0; }
#intake .steps::-webkit-scrollbar { display: none; }
#intake .steps li { flex: 1 0 auto; }
#intake .steps button { width: 100%; display: grid; gap: 1px; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 3px; padding: 6px 10px; cursor: pointer; color: #8a8a8c; font-family: inherit; }
#intake .steps button:hover { border-color: #2a2a2c; color: #b8b6b1; }
#intake .steps .n { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #6a6a6c; }
#intake .steps .label { font-size: 12.5px; white-space: nowrap; }
#intake .steps .state { font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
#intake .steps .state.todo { color: #c4a944; }
#intake .steps .state.done { color: #6fbf8a; }
#intake .steps li[aria-current="step"] button { border-color: #2a2a2c; background: #0f0f0f; color: #e8e6e1; }
#intake .steps li[aria-current="step"] .n { color: #7eb8da; }
#intake .sec-head { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; margin-bottom: 4px; }
#intake .sec-head h2 { font-size: 17px; margin: 0; text-wrap: balance; }
#intake .sec-head .count { color: #6a6a6c; font-size: 12px; font-variant-numeric: tabular-nums; }
#intake .sub { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #6a6a6c; margin: 16px 0 6px; }
#intake .cards { display: grid; gap: 6px; }
#intake .card .badge.wait { color: #c4a944; background: #2a2416; }
#intake .card.blocked { opacity: 0.45; border-style: dashed; }
#intake details.folded { color: #8a8a8c; font-size: 12px; border: 1px dashed #1e1e20; padding: 8px 12px; border-radius: 3px; margin-top: 12px; }
#intake details.folded summary { cursor: pointer; }
#intake details.folded .cards { margin-top: 8px; }
#intake .stepfoot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; border-top: 1px solid #1e1e20; margin-top: 22px; padding-top: 12px; }
#intake .stepfoot .left { color: #8a8a8c; font-size: 12px; font-variant-numeric: tabular-nums; }
#intake .stepfoot .right { display: flex; gap: 6px; flex-wrap: wrap; }
#intake .tally { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 6px; margin-bottom: 14px; }
#intake .tally div { border: 1px solid #1e1e20; background: #0f0f0f; padding: 10px 12px; border-radius: 3px; display: grid; gap: 2px; }
#intake .tally .k { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #6a6a6c; }
#intake .tally .v { font-size: 20px; color: #e8e6e1; font-variant-numeric: tabular-nums; }
#intake .tally .v.ok { color: #6fbf8a; } #intake .tally .v.no { color: #bf6f6f; } #intake .tally .v.open { color: #c4a944; }
#intake .tally .d { font-size: 11.5px; color: #8a8a8c; }
#intake .tablewrap { overflow-x: auto; margin-bottom: 14px; }
#intake table.per { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
#intake table.per th, #intake table.per td { text-align: right; padding: 5px 8px; border-bottom: 1px solid #1e1e20; }
#intake table.per th:first-child, #intake table.per td:first-child { text-align: left; }
#intake table.per th { color: #6a6a6c; font-weight: 400; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; }
#intake table.per a { color: #7eb8da; cursor: pointer; }
#intake .modal .box textarea { width: 100%; min-height: 64px; margin-top: 8px; font-family: inherit; font-size: 12.5px; }
#intake .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; align-items: center; justify-content: center; z-index: 50; }
#intake .modal.open { display: flex; }
#intake .modal .box { background: #0f0f0f; border: 1px solid #333; padding: 18px 20px; max-width: 460px; font-size: 13px; line-height: 1.6; }
#intake .progress { color: #9a9a9c; font-size: 12px; margin: 10px 0; }
#intake .ledger { font-size: 11.5px; color: #8a8a8c; }
#intake .ledger li { list-style: none; padding: 2px 0; border-bottom: 1px solid #141414; word-break: break-all; }
#intake .bulk { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 0; }
`;

export function shell(title: string, body: string, script = ""): string {
  return htmlPage(title, `<style>${CSS}</style><div id="intake">${body}</div>${script ? `<script>${script}</script>` : ""}`);
}

export const helpers = `
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let j = null; try { j = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, json: j };
}
function pill(s) { return '<span class="pill ' + esc(s) + '">' + esc(s) + '</span>'; }
// After a sign-in request (issue #72): a new contributor says how they'd like
// to appear. Shown to everyone, whatever the address, so it reveals nothing.
function requestDetails(el, email) {
  const box = document.createElement('form');
  box.className = 'request-details';
  box.innerHTML = '<p class="lede" style="margin-top:14px">New to A(DAI)? Tell the team how to credit you, so your invitation carries the right name.</p>' +
    '<label>how you&#39;d like to appear in the commons</label><input name="name" required minlength="2" maxlength="120" autocomplete="name" placeholder="Your name, studio or institution">' +
    '<label>about you <span class="lede">(optional)</span></label><textarea name="about" maxlength="1000" placeholder="Artist, curator, collector, institution… and what you would like to contribute" style="width:100%;min-height:60px"></textarea>' +
    '<button class="btn" type="submit">Send</button>';
  box.onsubmit = async (e) => {
    e.preventDefault();
    const r = await api('POST', '/api/intake/request-details', { email, name: box.elements.namedItem('name').value, about: box.elements.namedItem('about').value });
    box.innerHTML = r.ok ? '<p class="lede" style="margin-top:14px">Thank you, passed on with your request.</p>' : '<p class="lede">' + esc((r.json && r.json.message) || 'could not send') + '</p>';
  };
  el.appendChild(box);
}
`;

// ---- /contribute -----------------------------------------------------------------

export function contributePage(): string {
  const body = `
<div class="kicker">CONTRIBUTE FROM A WEBSITE</div>
<h2>Give A(DAI) a URL.</h2>
<p class="lede">Your portfolio, an exhibition page, a gallery roster or a programme. A(DAI) reads it and drafts what it could add: works, shows, people, relations — each with the sentence on the page that backs it. Nothing enters the commons until you review the draft and press Confirm. <a href="/contribute/signal">Prefer to write a signal by hand?</a> Have an access token for your own AI assistant? <a href="/contribute/assistant">Setup guide</a>.</p>
<div id="app"><p class="progress">loading…</p></div>`;
  const script = `${helpers}
const app = $('#app');
function loginForm(msg) {
  app.innerHTML = (msg ? '<div class="msg msg-ok">' + esc(msg) + '</div>' : '') +
    '<form id="f"><label>your email</label><div class="row"><input type="email" name="email" required placeholder="you@studio.example" autocomplete="email"><button class="btn primary" type="submit">Send me a link</button></div>' +
    '<p class="lede" style="margin-top:10px">No password. The URL intake is by invitation: invited addresses get a sign-in link that works once.</p></form>';
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const b = $('button', e.target); b.disabled = true;
    const email = e.target.email.value;
    const r = await api('POST', '/api/intake/login', { email });
    if (r.ok) { app.innerHTML = '<div class="msg msg-ok">If this address is invited, a sign-in link is on its way (valid for 15 minutes). If not, your request has been passed on to the A(DAI) team.</div>'; requestDetails(app, email); }
    else { b.disabled = false; alertMsg(r.json && r.json.message || 'could not send'); }
  };
}
function alertMsg(m) { const d = document.createElement('div'); d.className = 'msg msg-err'; d.textContent = m; app.prepend(d); setTimeout(() => d.remove(), 6000); }
function nameForm(me) {
  app.innerHTML = '<form id="n"><label>how should A(DAI) credit you?</label><div class="row"><input name="name" required maxlength="120" placeholder="Your name or studio" autocomplete="name"><button class="btn primary" type="submit">Continue</button></div>' +
    '<p class="lede" style="margin-top:10px">Shown on the public receipt and as the contributor of what you submit. Signed in as ' + esc(me.email) + '.</p></form>';
  $('#n').onsubmit = async (e) => {
    e.preventDefault();
    const r = await api('POST', '/api/intake/me', { name: e.target.name.value });
    if (r.ok) load(); else alertMsg(r.json && r.json.message || 'could not save');
  };
}
async function urlForm(me) {
  const drafts = await api('GET', '/api/intake/drafts');
  const list = ((drafts.json && drafts.json.drafts) || []).filter(d => d.status !== 'abandoned');
  app.innerHTML = '<form id="u"><label>website, portfolio, exhibition or programme URL</label><div class="row"><input type="url" name="source_url" required placeholder="https://" autocomplete="off"><button class="btn primary" type="submit">Go</button></div>' +
    '<p class="lede" style="margin-top:10px">Signed in as ' + esc(me.name) + ' &lt;' + esc(me.email) + '&gt; · tier ' + esc(me.trust_tier) + ' · <a href="#" id="out">sign out</a></p></form>' +
    (list.length ? '<ul class="drafts">' + list.map(d => '<li><span class="dom"><a href="/draft/' + esc(d.id) + '">' + esc(d.source_url) + '</a></span>' + pill(d.job_pending ? 'running' : d.status) + '<span>' + d.candidate_count + ' cards</span>' + (d.status === 'submitted' ? '<a href="/batch/' + esc(d.id) + '">receipt</a>' : '') + '</li>').join('') + '</ul>' : '');
  $('#out').onclick = async (e) => { e.preventDefault(); await api('POST', '/api/intake/logout'); load(); };
  openReads();
  $('#u').onsubmit = async (e) => {
    e.preventDefault();
    const b = $('button', e.target); b.disabled = true;
    const r = await api('POST', '/api/intake/drafts', { source_url: e.target.source_url.value });
    if (r.ok) {
      const dom = (() => { try { return new URL(e.target.source_url.value).hostname; } catch { return 'the site'; } })();
      app.innerHTML = '<div class="msg msg-ok">Processing ' + esc(dom) + '. This takes a few minutes. We will email you at ' + esc(me.email) + ' when the draft is ready.</div><p class="lede">Impatient? <a href="/draft/' + esc(r.json.draft_id) + '">Watch it happen.</a></p>';
    } else { b.disabled = false; alertMsg(r.json && r.json.message || ('error ' + r.status)); }
  };
}
// Left open (issue #77): what other reads could not decide, for anyone to pick up.
async function openReads() {
  const r = await api('GET', '/api/intake/open');
  const reads = (r.json && r.json.reads) || [];
  if (!reads.length) return;
  const want = new URLSearchParams(location.search).get('open');
  const sec = document.createElement('div');
  sec.id = 'open';
  sec.innerHTML = '<h3 class="kicker" style="margin-top:28px">LEFT OPEN · ' + reads.length + '</h3>' +
    '<p class="lede">Items other contributors read but could not decide. Pick one up to decide what you can; what you submit is yours, and the first reader is credited for proposing it.</p>' +
    '<ul class="openreads">' + reads.map(x => '<li class="' + (x.draft_id === want ? 'hit' : '') + '"><button class="btn" data-pick="' + esc(x.draft_id) + '">Pick up</button>' +
      '<a href="' + esc(x.source_url) + '" target="_blank" rel="noopener">' + esc(x.source_domain) + '</a>' + (x.subject ? ' · ' + esc(x.subject.name || x.subject.id) : '') +
      '<br>' + x.items + ' item' + (x.items === 1 ? '' : 's') + (x.links_to_recheck ? ' · ' + x.links_to_recheck + ' link' + (x.links_to_recheck === 1 ? '' : 's') + ' to re-check' : '') +
      ' · left by ' + esc(x.left_by || 'a contributor') + ', ' + esc(String(x.left_at).slice(0, 10)) + ' · <a href="/batch/' + esc(x.draft_id) + '">receipt</a></li>').join('') + '</ul>';
  app.appendChild(sec);
  sec.querySelectorAll('[data-pick]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'opening…';
    const p = await api('POST', '/api/intake/open/' + encodeURIComponent(b.dataset.pick) + '/pickup');
    if (p.ok) location.href = p.json.draft_url; else { b.disabled = false; b.textContent = 'Pick up'; alertMsg(p.json && p.json.message || ('error ' + p.status)); }
  });
  const hit = sec.querySelector('li.hit'); if (hit) hit.scrollIntoView({ block: 'center' });
}
async function load() {
  const me = await api('GET', '/api/intake/me');
  if (!me.ok) return loginForm();
  if (!me.json.name) return nameForm(me.json);
  urlForm(me.json);
}
load();`;
  return shell("Contribute", body, script);
}

// ---- /draft/:id ------------------------------------------------------------------

export function draftPage(draftId: string): string {
  const body = `
<div class="dhead" id="dhead"><span class="progress">loading draft…</span></div>
<nav class="stepper" id="stepper" aria-label="Draft steps" hidden><ol class="steps" id="steps"></ol></nav>
<div id="cards"></div>
<div class="scrim" id="scrim"></div>
<aside class="rail" id="rail" aria-label="Ask the agent" aria-hidden="true"></aside>
<div class="modal" id="modal"><div class="box" id="modalbox"></div></div>`;
  const script = `${helpers}
const ID = ${JSON.stringify(draftId)};
const VERBS = { CREATED_BY: 'was created by', EXHIBITED_AT: 'was exhibited at', HELD_BY: 'is held by', PARTICIPATED_IN: 'took part in', PRESENTED_BY: 'was presented by', CURATED_BY: 'was curated by', REPRESENTS: 'represents', USES_TECHNIQUE: 'uses the technique', EMBODIES: 'embodies', BELONGS_TO: 'belongs to', COLLABORATES_WITH: 'collaborates with', INFLUENCES: 'influences', RESPONDS_TO: 'responds to', DOCUMENTS: 'documents' };
const EDGE_TYPES = ['CREATED_BY','EXHIBITED_AT','HELD_BY','PARTICIPATED_IN','PRESENTED_BY','CURATED_BY','REPRESENTS','USES_TECHNIQUE','EMBODIES','BELONGS_TO','COLLABORATES_WITH','DOCUMENTS'];
const NODE_TYPES = ['practitioner','artwork','project','institution','collective','concept','platform'];
let D = null, timer = null, busy = false;
const byCid = () => Object.fromEntries((D.candidates||[]).map(c => [c.cid, c]));
function refName(ref) {
  if (!ref) return '?';
  if (ref.startsWith('cid:')) { const c = byCid()[ref.slice(4)]; return c && c.kind === 'node' ? c.node.name : ref; }
  const i = ref.indexOf(':'); return i > 0 ? ref.slice(i + 1).replace(/-/g, ' ') : ref;
}
function refLink(ref) {
  if (!ref) return '';
  if (ref.startsWith('cid:')) return '<b>' + esc(refName(ref)) + '</b> <span class="badge">new</span>';
  const t = ref.split(':')[0]; const rest = ref.slice(t.length + 1);
  return '<a href="/' + esc(t) + '/' + encodeURIComponent(rest.replace(/ /g, '-')) + '" target="_blank">' + esc(refName(ref)) + '</a>';
}
function groupOf(c) {
  if (c.kind === 'known') return 'Already in A(DAI)';
  if (c.kind === 'ended') return 'No longer listed';
  if (c.kind === 'question') return 'Questions';
  if (c.kind === 'patch') return 'Corrections';
  if (c.kind === 'image') return 'Images';
  if (c.kind === 'edge') return 'Relations';
  if (c.node.type === 'artwork') return 'Works';
  if (c.node.type === 'project' || c.node.type === 'institution') return 'Shows and venues';
  return 'People and organisations';
}
const ORDER = ['Questions','Works','Shows and venues','People and organisations','Relations','Images','Corrections','No longer listed','Already in A(DAI)'];
function evidence(c) {
  if (!c.evidence) return '';
  return '<div class="quote">“' + esc(c.evidence.quote) + '”<a href="' + esc(c.evidence.page_url) + '" target="_blank" rel="noopener">source ↗</a></div>';
}
// The reader could not open this item's own page (issue #75): the card
// starts rejected and, if nobody decides it, stays open for a re-check.
function linkUnchecked(c) { return !!c.link_check && c.state === 'rejected' && !c.edited; }
function linkNote(c) {
  const l = c.link_check; if (!l) return '';
  const why = l.status ? 'HTTP ' + l.status : l.reason === 'dns' ? 'the address did not resolve' : l.reason === 'timeout' ? 'it timed out' : 'nothing answered';
  return '<div class="link"><span class="badge ai">couldn’t open the link</span> <a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.url.replace('https://', '').replace('http://', '').slice(0, 60)) + ' ↗</a> (' + esc(why) + ')' +
    (linkUnchecked(c) ? ' — starts rejected; if you leave it, it stays open for someone to re-check. Open the link yourself and accept if it is right.' : '') + '</div>';
}
function originBadge(c) { return c.origin === 'embedding' ? '<span class="badge ai">sensed</span>' : c.origin === 'graph' ? '<span class="badge">graph</span>' : ''; }
function cardBody(c) {
  if (c.kind === 'node') {
    return '<div class="title">' + esc(c.node.name) + '<span class="badge">' + esc(c.node.type) + '</span>' + originBadge(c) + '</div>' +
      (c.resolves_to ? '<div class="link">links to existing: ' + refLink(c.resolves_to) + ' <span class="meta">(' + esc(c.resolution) + ')</span></div>' : '<div class="link">new ' + esc(c.node.type) + '</div>') +
      (c.node.metadata && Array.isArray(c.node.metadata.kind) ? '<div class="link">' + c.node.metadata.kind.map(k => '<span class="badge">' + esc(k) + '</span>').join(' ') + (c.node.metadata.kind_source ? ' <span class="meta">“' + esc(c.node.metadata.kind_source.quote) + '”</span>' : '') + '</div>' : '') +
      (c.node.metadata && (c.node.metadata.year || c.node.metadata.summary || c.node.metadata.description) ? '<div class="note">' + esc([c.node.metadata.year, c.node.metadata.summary || c.node.metadata.description].filter(Boolean).join(' · ')).slice(0, 300) + '</div>' : '') +
      (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '') + evidence(c) + linkNote(c);
  }
  if (c.kind === 'edge') {
    return '<div class="title">' + refLink(c.edge.source) + ' ' + esc(VERBS[c.edge.edge_type] || c.edge.edge_type.toLowerCase()) + ' ' + refLink(c.edge.target) + (c.edge.event_time ? ', ' + esc(c.edge.event_time) : '') + '<span class="badge">' + esc(c.edge.edge_type) + '</span>' + originBadge(c) + '</div>' +
      '<div class="link">confidence ' + esc(c.edge.confidence) + '</div>' + (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '') + evidence(c) + linkNote(c);
  }
  if (c.kind === 'image') {
    return '<div class="title">image for ' + refLink(c.image.for) + '</div><a href="' + esc(c.image.image_url) + '" target="_blank" rel="noopener"><img class="thumb" loading="lazy" src="' + esc(c.image.image_url) + '" alt="' + esc(c.image.alt || '') + '"></a>' +
      (c.image.alt ? '<div class="note">' + esc(c.image.alt) + '</div>' : '') + '<div class="link"><a href="' + esc(c.image.page_url) + '" target="_blank" rel="noopener">page ↗</a></div>' + linkNote(c);
  }
  if (c.kind === 'patch') {
    return '<div class="title">' + refLink(c.patch.node_id) + ' · ' + esc(c.patch.key) + '</div><div class="diff"><div><div class="k">A(DAI) has</div>' + esc(JSON.stringify(c.patch.existing)) + '</div><div><div class="k">site says</div>' + esc(JSON.stringify(c.patch.proposed)) + '</div></div>' +
      (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '') + evidence(c);
  }
  if (c.kind === 'question') {
    const e = c.question.if_yes;
    return '<div class="title">' + esc(c.question.text) + '</div><div class="link">if yes: ' + refLink(e.source) + ' ' + esc(VERBS[e.edge_type] || e.edge_type) + ' ' + refLink(e.target) + '</div>' + (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '') +
      (c.question.answered_yes !== undefined ? '<div class="note">you said ' + (e.edge_type === 'COLLABORATES_WITH' ? (c.question.answered_yes ? 'they worked together' : 'only shown together') : (c.question.answered_yes ? 'yes' : 'no')) + (c.question.answer ? ': ' + esc(c.question.answer) : '') + '</div>' : c.state === 'context_only' ? '<div class="note">you don’t know — left out</div>' : c.state === 'open' ? '<div class="note">left open — another contributor can answer it</div>' : '');
  }
  if (c.kind === 'ended') {
    const e = c.ended;
    return '<div class="title">' + refLink(e.source_id) + ' ' + esc(VERBS[e.edge_type] || e.edge_type.toLowerCase()) + ' ' + refLink(e.target_id) + '<span class="badge">' + esc(e.edge_type) + '</span></div>' +
      '<div class="link">the site no longer shows this' + (e.last_seen ? ' (attested ' + esc(e.last_seen) + ')' : '') + ' — accepting makes it historical; nothing is deleted</div>' +
      '<div class="note">' + esc(e.summary) + '</div>' + (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '') + evidence(c);
  }
  if (c.kind === 'known') {
    return '<div class="title">' + esc(c.known.summary) + originBadge(c) + '</div><div class="link">' + refLink(c.known.node_id) + (c.known.other_id ? ' · ' + esc(c.known.edge_type || '') + ' · ' + refLink(c.known.other_id) : '') + '</div>' + (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '');
  }
  return esc(JSON.stringify(c));
}
function actions(c) {
  if (D.status !== 'ready') return '';
  if (c.kind === 'known') return '';
  if (c.kind === 'question') {
    // "Did they work together, or show together?" — a shared show is already
    // in the graph (PARTICIPATED_IN); only "worked together" adds a relation.
    const collab = c.question.if_yes.edge_type === 'COLLABORATES_WITH';
    return '<div class="actions"><button class="btn ' + (c.question.answered_yes === true ? 'on' : '') + '" data-a="yes">' + (collab ? 'Worked together' : 'Yes') + '</button><button class="btn ' + (c.question.answered_yes === false ? 'off' : '') + '" data-a="no">' + (collab ? 'Only shown together' : 'No') + '</button><button class="btn ' + (c.state === 'open' ? 'held' : '') + '" data-a="open" title="Not sure: keep it for another contributor to answer">Leave open</button><button class="btn" data-a="edit">Add a note</button></div>' +
      '<div class="edit"><textarea data-f="answer" placeholder="In your own words — this becomes the record.">' + esc(c.question.answer || '') + '</textarea><button class="btn" data-a="save">Save note</button></div>';
  }
  const s = c.state;
  let edit = '';
  if (c.kind === 'node') edit = '<input data-f="name" value="' + esc(c.node.name) + '"><select data-f="type">' + NODE_TYPES.map(t => '<option' + (t === c.node.type ? ' selected' : '') + '>' + t + '</option>').join('') + '</select><input data-f="year" placeholder="year" value="' + esc(c.node.metadata && c.node.metadata.year || '') + '">' + (c.resolves_to ? '<button class="btn" data-a="unlink">create new instead</button>' : '') + '<button class="btn" data-a="save">Save</button>';
  else if (c.kind === 'edge') edit = '<select data-f="edge_type">' + EDGE_TYPES.map(t => '<option' + (t === c.edge.edge_type ? ' selected' : '') + '>' + t + '</option>').join('') + '</select><input data-f="event_time" placeholder="year" value="' + esc(c.edge.event_time || '') + '"><button class="btn" data-a="save">Save</button>';
  else if (c.kind === 'patch') edit = '<input data-f="proposed" value="' + esc(typeof c.patch.proposed === 'string' ? c.patch.proposed : JSON.stringify(c.patch.proposed)) + '"><button class="btn" data-a="save">Save</button>';
  else if (c.kind === 'image') edit = '<input data-f="alt" placeholder="caption" value="' + esc(c.image.alt || '') + '"><button class="btn" data-a="save">Save</button>';
  return '<div class="actions"><button class="btn ' + (s === 'accepted' ? 'on' : '') + '" data-a="accepted">Accept</button><button class="btn ' + (s === 'rejected' && !linkUnchecked(c) ? 'off' : '') + '" data-a="rejected">Reject</button><button class="btn ' + (s === 'open' ? 'held' : '') + '" data-a="open" title="Not sure: keep it for another contributor to decide">Leave open</button><button class="btn ' + (s === 'context_only' ? 'on' : '') + '" data-a="context_only">Context only</button>' + (edit ? '<button class="btn" data-a="edit">Edit</button>' : '') + '</div>' + (edit ? '<div class="edit">' + edit + '</div>' : '');
}
// What stays open at Confirm — the client copy of leftOpen() in
// src/intake/open-items.ts; keep the two in step.
function cardDeps(c) {
  const refs = c.kind === 'edge' ? [c.edge.source, c.edge.target] : c.kind === 'image' ? [c.image.for] : c.kind === 'question' ? [c.question.if_yes.source, c.question.if_yes.target] : [];
  return refs.filter(r => r && r.startsWith('cid:')).map(r => r.slice(4));
}
function ownOpen(c) { return c.kind !== 'known' && (c.state === 'proposed' || c.state === 'open' || linkUnchecked(c)); }
function leftOpenCids() {
  const by = byCid(), open = new Set();
  for (const c of D.candidates) if (c.kind === 'node' && ownOpen(c)) open.add(c.cid);
  for (const c of D.candidates) {
    if (c.kind === 'node' || c.kind === 'known') continue;
    const ds = cardDeps(c).map(x => by[x]);
    if (ds.some(d => !d || ((d.state === 'rejected' || d.state === 'context_only') && !open.has(d.cid)))) continue;
    if (ownOpen(c) || (c.state === 'accepted' && ds.some(d => open.has(d.cid)))) open.add(c.cid);
  }
  return open;
}
// Steps (issue #76): one kind of card at a time. A step with no cards is
// not shown; the last step is the review and the only place to Confirm.
const STEPS = [
  { key: 'questions', label: 'Questions', groups: ['Questions'], lede: 'Answer these first: each answer adds a relation or leaves it out. Leave open what you cannot answer; another contributor can pick it up.' },
  { key: 'nodes', label: 'Works and people', groups: ['Works', 'Shows and venues', 'People and organisations'], lede: 'Each card is a page A(DAI) would add, or link to when it already has it. Accept what the site shows, reject what is wrong, leave open what you cannot judge.' },
  { key: 'relations', label: 'Relations', groups: ['Relations'], lede: 'Grouped by the work or show they are about. A relation goes in only when what it connects goes in.' },
  { key: 'images', label: 'Images', groups: ['Images'], lede: 'Images the site shows. Each is copied to A(DAI) when you confirm.' },
  { key: 'changes', label: 'Corrections', groups: ['Corrections', 'No longer listed'], lede: 'Where the site and A(DAI) disagree, and relations the site no longer shows. Ending a relation keeps it on record, with the date it ended.' },
  { key: 'confirm', label: 'Review and confirm', groups: [], lede: 'Everything you decided, in one place. What you did not decide stays open for the next contributor.' },
];
let step = null;
const stepOf = (c) => { const g = groupOf(c); const s = STEPS.find(x => x.groups.includes(g)); return s ? s.key : null; };
// A card that needs a card turned down cannot stand (Confirm leaves it out).
function blockers(c, open) {
  const by = byCid();
  return cardDeps(c).map(x => by[x]).filter(d => !d || ((d.state === 'rejected' || d.state === 'context_only') && !open.has(d.cid)));
}
const undecided = (c) => c.kind !== 'known' && (c.state === 'proposed' || linkUnchecked(c));
function stepCards(key, open) { return D.candidates.filter(c => stepOf(c) === key && !blockers(c, open).length); }
function visibleSteps(open) { return STEPS.filter(s => s.key === 'confirm' || D.candidates.some(c => stepOf(c) === s.key)); }
// Relations by the new work or show they are about, else by their source.
function relationGroup(c) {
  const by = byCid();
  const ref = [c.edge.source, c.edge.target].find(r => r && r.startsWith('cid:') && by[r.slice(4)] && by[r.slice(4)].kind === 'node') || c.edge.source;
  return refName(ref);
}
function cardHtml(c, open) {
  const by = byCid();
  const waits = c.state === 'accepted' && open.has(c.cid) ? cardDeps(c).map(x => by[x]).filter(d => d && open.has(d.cid)) : [];
  const wait = waits.length ? '<div class="link"><span class="badge wait">waits for ' + waits.map(d => esc(d.kind === 'node' ? d.node.name : d.cid)).join(', ') + '</span> it stays open with ' + (waits.length === 1 ? 'it' : 'them') + '</div>' : '';
  return '<div class="card ' + esc(c.state) + '" data-cid="' + esc(c.cid) + '">' + cardBody(c) + wait + actions(c) + '</div>';
}
function decidedCount(open) {
  const acc = D.candidates.filter(c => c.state === 'accepted' && !open.has(c.cid)).length + D.candidates.filter(c => c.kind === 'question' && c.question.answered_yes === true).length;
  // A pick-up may confirm only "no"s: turning an item down is a decision too.
  return D.picked_from ? D.candidates.filter(c => !open.has(c.cid) && c.kind !== 'known' && c.state !== 'proposed' && c.state !== 'open' && !linkUnchecked(c)).length : acc;
}
function renderSteps(open) {
  const nav = $('#stepper');
  if (!D.candidates.length) { nav.hidden = true; return; }
  nav.hidden = false;
  const vis = visibleSteps(open);
  if (!vis.some(s => s.key === step)) {
    const h = location.hash.slice(1);
    step = vis.some(s => s.key === h) ? h : (vis.find(s => s.key !== 'confirm' && stepCards(s.key, open).some(undecided)) || vis[0]).key;
  }
  $('#steps').innerHTML = vis.map((s, i) => {
    let state;
    if (s.key === 'confirm') state = '<span class="state">' + decidedCount(open) + ' to confirm</span>';
    else { const cs = stepCards(s.key, open), todo = cs.filter(undecided).length; state = todo ? '<span class="state todo">' + todo + ' of ' + cs.length + ' undecided</span>' : '<span class="state done">' + cs.length + ' decided ✓</span>'; }
    return '<li' + (s.key === step ? ' aria-current="step"' : '') + '><button type="button" data-step="' + s.key + '"><span class="n">step ' + (i + 1) + '</span><span class="label">' + esc(s.label) + '</span>' + state + '</button></li>';
  }).join('');
}
function goStep(key) {
  step = key;
  try { history.replaceState(null, '', '#' + key); } catch (e) { /* ignore */ }
  renderAll();
  window.scrollTo(0, 0);
}
function renderCards() {
  const el = $('#cards');
  const open = leftOpenCids();
  renderSteps(open);
  if (!D.candidates.length) { el.innerHTML = '<p class="progress">' + (D.job_pending ? 'The agent is reading the site. Cards appear here as it goes (' + D.pages.length + ' pages so far).' : (D.status === 'failed' ? 'Nothing could be read: ' + esc(D.error || '') : 'No candidates.')) + '</p>'; return; }
  const vis = visibleSteps(open);
  const i = vis.findIndex(s => s.key === step), S = vis[i];
  let html = '<div class="sec-head"><h2>' + esc(S.label) + '</h2>';
  if (S.key !== 'confirm') { const cs = stepCards(S.key, open); html += '<span class="count">' + cs.length + ' card' + (cs.length === 1 ? '' : 's') + ' · ' + cs.filter(undecided).length + ' undecided</span>'; }
  html += '</div><p class="lede">' + esc(S.lede) + (D.job_pending ? ' The agent is still reading; new cards appear as it goes.' : '') + '</p>';
  if (S.key === 'confirm') html += confirmStep(open);
  else {
    const cs = stepCards(S.key, open);
    if (D.status === 'ready' && S.key !== 'questions' && cs.some(c => c.state === 'proposed')) html += '<div class="bulk"><button class="btn" id="acceptall" type="button">Accept all source-backed in this step</button><span class="meta" id="counts"></span></div>';
    const groups = new Map();
    for (const c of cs) { const g = S.key === 'relations' ? relationGroup(c) : S.groups.length > 1 ? groupOf(c) : ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    const keys = S.key === 'relations' ? [...groups.keys()] : S.groups.length > 1 ? S.groups.filter(g => groups.has(g)) : [''];
    for (const g of keys) {
      if (g) html += '<div class="sub">' + esc(g) + ' · ' + groups.get(g).length + '</div>';
      html += '<div class="cards">' + groups.get(g).map(c => cardHtml(c, open)).join('') + '</div>';
    }
    const gone = D.candidates.filter(c => stepOf(c) === S.key && blockers(c, open).length);
    if (gone.length) {
      const names = [...new Set(gone.flatMap(c => blockers(c, open).map(d => d ? (d.kind === 'node' ? d.node.name : d.cid) : 'a removed card')))];
      html += '<details class="folded"><summary>' + gone.length + ' left out: ' + (gone.length === 1 ? 'it needs ' : 'they need ') + names.map(esc).join(', ') + ', which you turned down</summary><div class="cards">' + gone.map(c => '<div class="card blocked"><div class="title">' + (c.kind === 'edge' ? refLink(c.edge.source) + ' ' + esc(VERBS[c.edge.edge_type] || c.edge.edge_type.toLowerCase()) + ' ' + refLink(c.edge.target) : c.kind === 'image' ? 'image for ' + refLink(c.image.for) : esc(c.cid)) + '</div></div>').join('') + '</div></details>';
    }
  }
  const prev = vis[i - 1], next = vis[i + 1];
  const todo = S.key === 'confirm' ? 0 : stepCards(S.key, open).filter(undecided).length;
  html += '<div class="stepfoot"><span class="left">' + (S.key === 'confirm' ? '' : todo ? todo + ' undecided here stay open if you move on' : 'Everything here is decided') + '</span><span class="right">' +
    (prev ? '<button class="btn" type="button" data-step="' + prev.key + '">← ' + esc(prev.label) + '</button>' : '') +
    (next ? '<button class="btn primary" type="button" data-step="' + next.key + '">Next: ' + esc(next.label) + ' →</button>' : '') + '</span></div>';
  el.innerHTML = html;
  const ca = $('#acceptall'); if (ca) ca.onclick = acceptAll;
  const cf = $('#confirm'); if (cf) cf.onclick = confirmDraftNow;
  const mb = $('#more'); if (mb) mb.onclick = moreModal;
  const ab = $('#abandon'); if (ab) ab.onclick = abandonModal;
  el.querySelectorAll('.card[data-cid]').forEach(card => {
    card.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(card, b.dataset.a));
  });
}
function confirmStep(open) {
  const live = D.candidates.filter(c => c.kind !== 'known');
  const gone = live.filter(c => blockers(c, open).length);
  const stand = live.filter(c => !blockers(c, open).length);
  const goes = stand.filter(c => !open.has(c.cid) && (c.state === 'accepted' || (c.kind === 'question' && c.question.answered_yes === true)));
  const down = stand.filter(c => !open.has(c.cid) && !goes.includes(c));
  const waiting = stand.filter(c => open.has(c.cid) && c.state === 'accepted');
  const n = (k) => goes.filter(c => c.kind === k).length;
  const kinds = [['node', 'pages'], ['edge', 'relations'], ['image', 'images'], ['patch', 'corrections'], ['ended', 'ended'], ['question', 'attested answers']].filter(([k]) => n(k)).map(([k, l]) => n(k) + ' ' + l).join(' · ');
  const live2 = D.trust_tier === 'auto' || D.trust_tier === 'reviewed';
  let h = '<div class="tally">' +
    '<div><span class="k">goes in</span><span class="v ok">' + goes.length + '</span><span class="d">' + (goes.length ? esc(kinds) + '. ' + (live2 ? 'Live now, attributed to you as one batch.' : 'One batch for curator review; you get a receipt either way.') : 'nothing yet') + '</span></div>' +
    '<div><span class="k">turned down</span><span class="v no">' + (down.length + gone.length) + '</span><span class="d">' + (gone.length ? gone.length + ' of them needed a card you turned down. ' : '') + 'A later read will not propose them to you again.</span></div>' +
    '<div><span class="k">stays open</span><span class="v open">' + open.size + '</span><span class="d">' + (waiting.length ? waiting.length + ' accepted but waiting for an open card. ' : '') + 'Any contributor can pick these up from the contribute page.</span></div>' +
    '</div>';
  h += '<div class="tablewrap"><table class="per"><thead><tr><th>step</th><th>goes in</th><th>turned down</th><th>stays open</th><th></th></tr></thead><tbody>' +
    visibleSteps(open).filter(s => s.key !== 'confirm').map(s => {
      const cs = live.filter(c => stepOf(c) === s.key);
      const a = cs.filter(c => goes.includes(c)).length, o = cs.filter(c => open.has(c.cid)).length;
      return '<tr><td>' + esc(s.label) + '</td><td>' + a + '</td><td>' + (cs.length - a - o) + '</td><td>' + o + '</td><td><a data-step="' + s.key + '" role="button" tabindex="0">review</a></td></tr>';
    }).join('') + '</tbody></table></div>';
  const known = D.candidates.filter(c => c.kind === 'known');
  if (known.length) h += '<details class="folded"><summary>Already in A(DAI) · ' + known.length + ' (nothing to decide)</summary><div class="cards">' + known.map(c => '<div class="card">' + cardBody(c) + '</div>').join('') + '</div></details>';
  const decided = decidedCount(open);
  h += '<div id="confirmerr"></div><div class="bulk" style="margin-top:14px">' +
    (D.status === 'ready' ? '<button class="btn primary" id="confirm" type="button"' + (decided ? '' : ' disabled') + '>Confirm ' + (D.picked_from ? decided + ' decision' + (decided === 1 ? '' : 's') : goes.length + ' item' + (goes.length === 1 ? '' : 's')) + '</button>' : '') +
    ((D.status === 'ready' || D.status === 'failed') && !D.job_pending ? '<button class="btn" id="more" type="button">Read more of the site</button>' : '') +
    (D.status !== 'submitted' && D.status !== 'abandoned' ? '<button class="btn" id="abandon" type="button">Abandon</button>' : '') +
    '</div>';
  return h;
}
async function patch(cid, body) {
  const r = await api('PATCH', '/api/intake/drafts/' + ID + '/candidates/' + cid, body);
  if (!r.ok) { alert((r.json && (r.json.message || r.json.error)) || 'error'); return false; }
  const i = D.candidates.findIndex(c => c.cid === cid); if (i >= 0) D.candidates[i] = r.json.candidate;
  return true;
}
// A card answers the click at once (issue #74): the new state shows and its
// buttons lock while the PATCH is in flight; a refusal puts the card back.
function setBusy(card, on) {
  card.classList.toggle('busy', on);
  card.querySelectorAll('button, input, select, textarea').forEach(b => { b.disabled = on; });
  const cb = $('#confirm'); if (cb && on) cb.disabled = true; // renderAll re-enables it
}
async function act(card, a) {
  const cid = card.dataset.cid; const c = byCid()[cid];
  if (a === 'edit') { card.querySelector('.edit').classList.toggle('open'); return; }
  if (card.classList.contains('busy')) return;
  let body = null, shown = null;
  if (a === 'accepted' || a === 'rejected' || a === 'context_only' || a === 'open') { shown = c.state === a && !linkUnchecked(c) ? 'proposed' : a; body = { state: shown }; }
  else if (a === 'yes' || a === 'no') { shown = 'answered'; body = { answered_yes: a === 'yes' }; }
  else if (a === 'unlink') body = { patch: { resolves_to: null } };
  else if (a === 'save') {
    const ed = card.querySelector('.edit'); const f = (n) => { const x = ed.querySelector('[data-f="' + n + '"]'); return x ? x.value : undefined; };
    if (c.kind === 'node') body = { patch: { name: f('name'), type: f('type'), metadata: f('year') ? { year: f('year') } : {} } };
    else if (c.kind === 'edge') body = { patch: { edge_type: f('edge_type'), event_time: f('event_time') || '' } };
    else if (c.kind === 'patch') body = { patch: { proposed: f('proposed') } };
    else if (c.kind === 'image') body = { patch: { alt: f('alt') } };
    else if (c.kind === 'question') body = { answer: f('answer') };
  }
  if (!body) return;
  if (shown) {
    card.classList.remove(c.state); card.classList.add(shown);
    card.querySelectorAll('.actions [data-a]').forEach(b => {
      const x = b.dataset.a;
      b.classList.toggle('on', x === a && (x === 'yes' || ((x === 'accepted' || x === 'context_only') && shown === x)));
      b.classList.toggle('off', x === a && (x === 'no' || (x === 'rejected' && shown === x)));
      b.classList.toggle('held', x === a && x === 'open' && shown === x);
    });
  }
  setBusy(card, true);
  await patch(cid, body);
  renderAll();
}
async function acceptAll() {
  // Ending a relation is always a deliberate, one-by-one decision.
  const open = leftOpenCids();
  const todo = stepCards(step, open).filter(c => !(c.origin !== 'site' || c.kind === 'question' || c.kind === 'known' || c.kind === 'ended' || c.state !== 'proposed' || (c.kind === 'edge' && c.edge.confidence === 'low')));
  const b = $('#acceptall'); if (b) b.disabled = true;
  const n = $('#counts');
  let done = 0;
  for (const c of todo) {
    if (n) n.textContent = 'accepting ' + (++done) + ' of ' + todo.length + '…';
    const card = document.querySelector('.card[data-cid="' + c.cid + '"]'); if (card) setBusy(card, true);
    const ok = await patch(c.cid, { state: 'accepted' });
    if (card) { setBusy(card, false); if (ok) { card.classList.remove('proposed'); card.classList.add('accepted'); } }
    if (!ok) break;
  }
  renderAll();
}
function renderHead() {
  const msgs = (D.messages || []).length;
  $('#dhead').innerHTML = '<span class="src">' + esc(D.source_url) + '</span>' +
    (D.picked_from ? '<span>picked up from <a href="/batch/' + esc(D.picked_from) + '">an earlier read</a></span>' : '') +
    '<span>subject: ' + (D.subject_node_id ? refLink(D.subject_node_id) : '<span class="meta">none yet</span>') + '</span>' +
    pill(D.job_pending ? 'running' : D.status) + '<span>' + D.pages.length + ' pages</span><span class="spacer"></span>' +
    '<button class="btn" id="askagent" type="button">Ask the agent' + (D.job_pending ? ' · working…' : msgs ? ' · ' + msgs : '') + '</button>' +
    // Before there are cards, the review step (and its buttons) does not exist yet.
    (!D.candidates.length && (D.status === 'ready' || D.status === 'failed') && !D.job_pending ? '<button class="btn" id="morehead" type="button">Read more of the site</button>' : '') +
    (!D.candidates.length && D.status !== 'submitted' && D.status !== 'abandoned' ? '<button class="btn" id="abandonhead" type="button">Abandon</button>' : '') +
    (D.status === 'submitted' ? '<a class="btn" href="/batch/' + esc(D.id) + '">Receipt</a>' : '');
  $('#askagent').onclick = () => drawer(true);
  const mb = $('#morehead'); if (mb) mb.onclick = moreModal;
  const ab = $('#abandonhead'); if (ab) ab.onclick = abandonModal;
}
const railFolded = {};
function drawer(open) {
  $('#rail').classList.toggle('open', open); $('#rail').setAttribute('aria-hidden', String(!open));
  $('#scrim').classList.toggle('open', open);
  if (!open) document.querySelectorAll('#rail details[data-r]').forEach(d => { if (d.open && !railFolded[d.dataset.r]) { d.open = false; } railFolded[d.dataset.r] = true; railOpen[d.dataset.r] = d.open; });
  if (open) { const log = $('#rail .log'); if (log) log.scrollTop = log.scrollHeight; const t = $('#rail textarea'); if (t) t.focus(); }
}
$('#scrim').onclick = () => drawer(false);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').classList.contains('open')) drawer(false);
  const t = e.target.closest && e.target.closest('a[data-step]');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goStep(t.dataset.step); }
});
document.addEventListener('click', (e) => { const t = e.target.closest('[data-step]'); if (t) goStep(t.dataset.step); });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (D && h && h !== step && STEPS.some(s => s.key === h)) { step = h; renderAll(); } });
// In-page modals, never window.confirm(): in-app browsers (and Chrome after
// "prevent this page from creating additional dialogs") answer it 'no'
// without showing anything, which reads as a dead button.
function openModal(html) { $('#modalbox').innerHTML = html; $('#modal').classList.add('open'); $('#cancel').onclick = () => $('#modal').classList.remove('open'); }
function modalError(r) { const m = $('#modalerr'); if (m) m.innerHTML = '<div class="msg msg-err">' + esc(r.json && (r.json.message || r.json.error) || ('error ' + r.status)) + '</div>'; }
function abandonModal() {
  openModal('<div class="kicker">ABANDON</div><p>Drop this draft' + (D.job_pending ? ' and stop the agent' : '') + '? Nothing from it enters A(DAI). This cannot be undone.</p><div id="modalerr"></div>' +
    '<div class="actions"><button class="btn primary" id="go">Abandon draft</button> <button class="btn" id="cancel">Back</button></div>');
  $('#go').onclick = async () => { $('#go').disabled = true; const r = await api('POST', '/api/intake/drafts/' + ID + '/abandon'); if (r.ok) location.href = '/contribute'; else { modalError(r); $('#go').disabled = false; } };
}
function moreModal() {
  const S = D.survey;
  openModal('<div class="kicker">READ MORE OF THE SITE</div><p>The agent reads pages it has not read yet, knowing what it already proposed and what you rejected.' + (S && S.remaining ? ' Not covered so far: ' + esc(S.remaining) : '') + '</p>' +
    '<textarea id="focus" placeholder="Optional: where to look — e.g. the 2019–2021 exhibitions; Auriea Harvey; the editions archive"></textarea><div id="modalerr"></div>' +
    '<div class="actions"><button class="btn primary" id="go">Start</button> <button class="btn" id="cancel">Back</button></div>');
  $('#go').onclick = async () => { $('#go').disabled = true; const r = await api('POST', '/api/intake/drafts/' + ID + '/continue', { focus: $('#focus').value }); if (r.ok) { $('#modal').classList.remove('open'); await load(); } else { modalError(r); $('#go').disabled = false; } };
}
function surveyBlock() {
  const S = D.survey; if (!S) return '';
  const inv = (S.inventory || []).map(i => esc(i.label) + (i.count != null ? ' · ' + i.count : '')).join('<br>');
  return '<details data-r="survey"' + (railOpen.survey === undefined || railOpen.survey ? ' open' : '') + '><summary>what the site holds (' + esc(S.site_kind) + ')</summary><div class="rbody survey">' + inv +
    (S.covered ? '<div class="who" style="margin-top:8px">covered</div>' + esc(S.covered) : '') +
    (S.remaining ? '<div class="who" style="margin-top:8px">not covered yet</div>' + esc(S.remaining) : '') + '</div></details>';
}
let railSig = null, railOpen = {}, railUnseen = false;
function renderRail() {
  const rail = $('#rail');
  const msgs = D.messages || [];
  // Nothing changed since the last render: leave the drawer alone, so a poll
  // never touches the reader's scroll position, selection or typing.
  const sig = JSON.stringify([D.summary || '', D.survey || null, msgs, !!D.job_pending, D.status]);
  if (sig === railSig && rail.querySelector('.log')) return;
  const oldLog = rail.querySelector('.log');
  const wasNearBottom = !oldLog || (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40);
  const oldTop = oldLog ? oldLog.scrollTop : 0;
  const oldCount = oldLog ? oldLog.querySelectorAll('.m').length : 0;
  const regionTop = {}; const hadRegion = {};
  rail.querySelectorAll('details[data-r]').forEach(d => { railOpen[d.dataset.r] = d.open; regionTop[d.dataset.r] = d.querySelector('.rbody') ? d.querySelector('.rbody').scrollTop : 0; hadRegion[d.dataset.r] = true; });
  const tae = rail.querySelector('textarea');
  const kept = tae ? tae.value : '';
  const hadFocus = !!tae && document.activeElement === tae;
  const selS = tae ? tae.selectionStart : 0, selE = tae ? tae.selectionEnd : 0;
  const det = (key, label, inner) => '<details data-r="' + key + '"' + (railOpen[key] === undefined || railOpen[key] ? ' open' : '') + '><summary>' + label + '</summary><div class="rbody ' + key + '">' + inner + '</div></details>';
  rail.innerHTML = '<h3>Ask the agent <button class="btn" id="closeagent" type="button">Close</button></h3>' + (D.summary ? det('summary', 'summary', esc(D.summary)) : '') + surveyBlock() +
    '<div class="log">' + msgs.map(m => '<div class="m ' + esc(m.role) + '"><div class="who">' + (m.role === 'user' ? 'you' : 'agent') + '</div>' + esc(m.text) + '</div>').join('') + (D.job_pending ? '<div class="m assistant"><div class="who">agent</div>thinking…</div>' : '') + '</div>' +
    '<button class="btn" id="newmsg" type="button" hidden>new messages ↓</button>' +
    (D.status === 'ready' || D.status === 'failed' ? '<form id="chat"><textarea name="message" placeholder="e.g. the 2021 show was at a different gallery; or: add my collaborator X"></textarea><button class="btn" type="submit">Send</button></form>' : '');
  // Summary and survey start open; closing the drawer once folds them away (see drawer()), leaving the log the room.
  rail.querySelectorAll('details[data-r]').forEach(d => { const k = d.dataset.r; if (true) {} d.addEventListener('toggle', () => { railOpen[k] = d.open; }); });
  rail.querySelectorAll('details[data-r]').forEach(d => { const rb = d.querySelector('.rbody'); if (rb && regionTop[d.dataset.r]) rb.scrollTop = regionTop[d.dataset.r]; });
  const f = $('#chat'); if (f) f.onsubmit = async (e) => { e.preventDefault(); const t = f.message.value.trim(); if (!t) return; f.querySelector('button').disabled = true; const r = await api('POST', '/api/intake/drafts/' + ID + '/chat', { message: t }); if (!r.ok) { alert(r.json && r.json.message || 'error'); f.querySelector('button').disabled = false; return; } f.message.value = ''; railSend = true; await load(); };
  const ta = rail.querySelector('textarea'); if (ta) { if (kept) ta.value = kept; if (hadFocus) { ta.focus(); try { ta.setSelectionRange(selS, selE); } catch (e) {} } }
  $('#closeagent').onclick = () => drawer(false);
  const log = rail.querySelector('.log');
  const nb = $('#newmsg');
  const grew = log && log.querySelectorAll('.m').length > oldCount;
  if (log) {
    // Follow the conversation only if the reader was already at the bottom (or just sent something).
    if (wasNearBottom || railSend) { log.scrollTop = log.scrollHeight; railUnseen = false; }
    else { log.scrollTop = oldTop; if (grew) railUnseen = true; }
    railSend = false;
    log.addEventListener('scroll', () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 40) { railUnseen = false; nb.hidden = true; } });
    nb.hidden = !railUnseen;
    nb.onclick = () => { log.scrollTop = log.scrollHeight; railUnseen = false; nb.hidden = true; };
  }
  railSig = sig;
}
let railSend = false;
function renderAll() { renderHead(); renderCards(); renderRail(); }
// The review step is the confirmation: Confirm there submits.
async function confirmDraftNow() {
  const b = $('#confirm'); b.disabled = true; b.textContent = 'Confirming…';
  const r = await api('POST', '/api/intake/drafts/' + ID + '/confirm');
  if (r.ok) { location.href = '/batch/' + ID; return; }
  $('#confirmerr').innerHTML = '<div class="msg msg-err">' + esc(r.json && (r.json.message || r.json.error) || ('error ' + r.status)) + '</div>';
  await load();
}
async function load() {
  const r = await api('GET', '/api/intake/drafts/' + ID);
  if (r.status === 401) { location.href = '/contribute'; return; }
  if (!r.ok) { $('#dhead').innerHTML = '<span class="msg msg-err">' + esc(r.json && r.json.message || 'not found') + '</span>'; return; }
  D = r.json.draft; D.trust_tier = r.json.trust_tier;
  renderAll();
  clearTimeout(timer);
  if (D.job_pending || D.status === 'running' || D.status === 'queued') timer = setTimeout(load, 3000);
}
load();`;
  return shell("Draft", body, script);
}

// ---- /batch/:id -------------------------------------------------------------------

/** "Left open": what this read did not decide, and who has decided it since. */
function leftOpenGroup(receipt: Record<string, any>): string {
  const items = (receipt.left_open as any[] | undefined) ?? [];
  if (!items.length) return "";
  const still = items.filter((i) => !i.decided).length;
  const OUTCOME: Record<string, string> = { accepted: "added", answered: "answered", rejected: "turned down", context_only: "kept as context", skipped: "dropped" };
  const row = (i: any) => `<div class="card${i.decided ? "" : " open"}"><div class="title">${htmlEscape(String(i.label))}${i.reason === "link_failed" ? '<span class="badge ai">link to re-check</span>' : ""}</div><div class="link">${i.decided ? `${htmlEscape(OUTCOME[i.decided.outcome] ?? String(i.decided.outcome))} by ${htmlEscape(String(i.decided.by ?? "a contributor"))} · ${htmlEscape(String(i.decided.at).slice(0, 10))}${i.decided.in ? ` · <a href="/batch/${htmlEscape(String(i.decided.in))}">receipt</a>` : ""}` : "open: any contributor can pick it up from <a href=\"/contribute#open\">contribute</a>"}</div></div>`;
  return `<div class="group"><h3>Left open · ${items.length}${still !== items.length ? ` (${still} still open)` : ""}</h3>${items.map(row).join("")}</div>`;
}

export function batchPage(receipt: Record<string, any>, isOwner: boolean, adminEmails: string[], claimPrompt = ""): string {
  const VERBS: Record<string, string> = { CREATED_BY: "was created by", EXHIBITED_AT: "was exhibited at", HELD_BY: "is held by", PARTICIPATED_IN: "took part in", PRESENTED_BY: "was presented by", CURATED_BY: "was curated by", REPRESENTS: "represents", USES_TECHNIQUE: "uses the technique", EMBODIES: "embodies", BELONGS_TO: "belongs to", COLLABORATES_WITH: "collaborates with", INFLUENCES: "influences", RESPONDS_TO: "responds to", DOCUMENTS: "documents" };
  const link = (id: string) => {
    const t = id.split(":")[0] ?? "";
    const rest = id.slice(t.length + 1);
    return `<a href="/${htmlEscape(t)}/${encodeURIComponent(rest.replace(/ /g, "-"))}">${htmlEscape(rest.replace(/-/g, " "))}</a>`;
  };
  const sigs = (receipt.signals as any[]).filter((s) => !(s.title || "").startsWith("URL intake:"));
  const nodeSigs = sigs.filter((s) => (s.title || "").startsWith("Create node:"));
  const imgSigs = sigs.filter((s) => (s.title || "").startsWith("Upload image"));
  const patchSigs = sigs.filter((s) => (s.title || "").startsWith("Patch "));
  // The snapshot date: when the pages were read, which is what the claims describe.
  const reads = ((receipt.pages as any[]) ?? []).map((p) => String(p.fetched_at ?? "").slice(0, 10)).filter(Boolean).sort();
  const readRange = reads.length ? (reads[0] === reads[reads.length - 1] ? reads[0]! : `${reads[0]} – ${reads[reads.length - 1]}`) : "";
  const endSigs = sigs.filter((s) => (s.title || "").startsWith("End edge "));
  const endedEdges = (receipt.ended as any[] | undefined) ?? [];
  const edges = receipt.edges as any[];
  const mailto = `mailto:${encodeURIComponent(adminEmails.join(","))}?subject=${encodeURIComponent(`Retire batch ${receipt.batch_id}`)}&body=${encodeURIComponent(`Please retire batch ${receipt.batch_id} (${receipt.source_domain ?? ""}).\n\nReason: `)}`;
  const body = `
<div class="kicker">RECEIPT · ${htmlEscape(String(receipt.batch_id))}</div>
<h2>${htmlEscape(String(receipt.contributor ?? "A contributor"))} · ${htmlEscape(String(receipt.source_domain ?? ""))}</h2>
<p class="lede">${readRange ? `Site read ${htmlEscape(readRange)} · ` : ""}Submitted ${htmlEscape(String(receipt.submitted_at ?? ""))} · state <span class="pill ${htmlEscape(String(receipt.review_state).replace(/ /g, "-"))}">${htmlEscape(String(receipt.review_state))}</span>${receipt.source_url ? ` · <a href="${htmlEscape(String(receipt.source_url))}" rel="noopener" target="_blank">source ↗</a>` : ""}${receipt.subject_node_id && !String(receipt.subject_node_id).startsWith("cid:") ? ` · subject ${link(String(receipt.subject_node_id))}` : ""}</p>
${receipt.picked_from ? `<p class="lede">Picked up from <a href="/batch/${htmlEscape(String(receipt.picked_from.batch_id))}">${htmlEscape(String(receipt.picked_from.by ?? "a contributor"))}'s read of ${htmlEscape(String(receipt.picked_from.source_domain))}</a>: what it left open, decided here.</p>` : ""}
${claimPrompt}
${nodeSigs.length ? `<div class="group"><h3>Nodes · ${nodeSigs.length}</h3>${nodeSigs.map((s) => `<div class="card"><div class="title">${htmlEscape(String(s.title).replace(/^Create node: /, ""))}${s.status === "revoked" ? '<span class="badge">retired</span>' : ""}</div>${s.content ? `<div class="quote">“${htmlEscape(String(s.content).slice(0, 300))}”${s.source_url ? `<a href="${htmlEscape(String(s.source_url))}" target="_blank" rel="noopener">source ↗</a>` : ""}</div>` : ""}</div>`).join("")}</div>` : ""}
${edges.length ? `<div class="group"><h3>Relations · ${edges.length}</h3>${edges.map((e) => `<div class="card"><div class="title">${link(e.source_id)} ${htmlEscape(VERBS[e.edge_type] ?? e.edge_type)} ${link(e.target_id)}<span class="badge">${htmlEscape(e.edge_type)}</span>${e.live ? "" : '<span class="badge">superseded</span>'}</div></div>`).join("")}</div>` : ""}
${imgSigs.length ? `<div class="group"><h3>Images · ${imgSigs.length}</h3>${imgSigs.map((s) => { let c: any = {}; try { c = JSON.parse(s.content); } catch { /* */ } return `<div class="card"><div class="title">${c.node_id ? link(c.node_id) : ""}</div>${c.key ? `<img class="thumb" loading="lazy" crossorigin="anonymous" src="${htmlEscape(`${process.env.R2_PUBLIC_BASE ?? ""}/${c.key}`)}" alt="">` : ""}</div>`; }).join("")}</div>` : ""}
${patchSigs.length ? `<div class="group"><h3>Corrections · ${patchSigs.length}</h3>${patchSigs.map((s) => `<div class="card"><div class="title">${htmlEscape(String(s.title))}</div>${s.content ? `<div class="quote">“${htmlEscape(String(s.content).slice(0, 300))}”</div>` : ""}</div>`).join("")}</div>` : ""}
${endSigs.length ? `<div class="group"><h3>No longer listed · ${endSigs.length}</h3>${endSigs.map((s) => `<div class="card"><div class="title">${htmlEscape(String(s.title).replace(/^End edge /, ""))}</div>${s.content ? `<div class="quote">${htmlEscape(String(s.content).slice(0, 400))}${s.source_url ? `<a href="${htmlEscape(String(s.source_url))}" target="_blank" rel="noopener">source ↗</a>` : ""}</div>` : ""}</div>`).join("")}${endedEdges.length ? `<p class="lede">${endedEdges.length} relation(s) now historical — kept, with the date they ended.</p>` : ""}</div>` : ""}
${leftOpenGroup(receipt)}
${(receipt.intake as any[]).some((i) => i.status !== "approved") ? `<div class="group"><h3>Review</h3>${(receipt.intake as any[]).map((i) => `<div class="card"><div class="title">${htmlEscape(i.status)}${i.reviewed_at ? ` · ${htmlEscape(i.reviewed_at)}` : ""}</div>${i.rejection_reason ? `<div class="note">${htmlEscape(i.rejection_reason)}</div>` : ""}</div>`).join("")}</div>` : ""}
${isOwner ? `<div class="group"><h3>Source material</h3><ul class="ledger">${(receipt.pages as any[]).map((p) => `<li>${htmlEscape(p.final_url)} · read ${htmlEscape(String(p.fetched_at ?? "").slice(0, 16).replace("T", " "))} · ${htmlEscape(String(p.status))} · ${p.chars} chars · ${htmlEscape(String(p.sha256).slice(0, 12))}</li>`).join("") || "<li>none recorded</li>"}</ul>
<p class="lede" style="margin-top:14px">Something wrong? <a href="${mailto}">Ask a curator to retire this batch</a>. Corrections stay bi-temporal: nothing is deleted.</p></div>` : ""}`;
  return shell("Receipt", body);
}
