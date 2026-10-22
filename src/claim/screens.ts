// The claimant's pages: /claim/:type/:slug and /me (docs/CLAIM-SPEC.md §2–4).
// Same shell and helpers as the URL intake; all state comes from the JSON
// endpoints in src/routes/claim.ts, so an assistant with a bearer token can
// do everything these pages do.

import type { DatabaseSync } from "node:sqlite";
import { shell, helpers } from "../intake/pages.js";
import { htmlEscape } from "../templates.js";
import { CLAIMABLE_TYPES, approvedClaimsFor, claimsOf, suggestHandle } from "./store.js";

const CSS = `<style>
#intake .rel { border-bottom: 1px solid #1a1a1c; padding: 9px 0; font-size: 12.5px; }
#intake .rel .line { color: #e8e6e1; }
#intake .rel .src { color: #6a6a6c; font-size: 11px; margin-top: 2px; }
#intake .rel .acts { margin-top: 5px; display: flex; gap: 4px; flex-wrap: wrap; }
#intake .rel .acts .btn { padding: 2px 8px; font-size: 11px; margin: 0; }
#intake .rel form { margin-top: 6px; max-width: 560px; }
#intake .rel textarea, #intake .item textarea { width: 100%; min-height: 54px; font-family: inherit; font-size: 12px; }
#intake .n-contest { color: #d4a574; font-size: 11.5px; margin-top: 3px; }
#intake .n-context { color: #9a9a9c; font-size: 11.5px; margin-top: 3px; }
#intake .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 4px; }
#intake .tabs a { border: 1px solid #333; padding: 2px 9px; border-radius: 9px; font-size: 11.5px; color: #9a9a9c; text-decoration: none; }
#intake .tabs a.on { border-color: #7eb8da; color: #e8e6e1; }
#intake section { margin-top: 22px; }
#intake section h3 { font-size: 12px; color: #9a9a9c; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 6px; }
#intake .item { border: 1px solid #1e1e20; padding: 8px 10px; margin-bottom: 6px; font-size: 12px; }
#intake .ev { font-size: 11.5px; color: #8a8a8c; padding: 3px 0; border-bottom: 1px solid #141414; }
#intake .ev b { color: #b8b6b1; font-weight: normal; }
#intake .ok { color: #6fbf8a; } #intake .bad { color: #bf6f6f; }
</style>`;

const LOGIN = `
function loginForm(el, redirect, lead) {
  el.innerHTML = '<p class="lede">' + lead + '</p><form id="lf"><label>your email</label><div class="row"><input type="email" name="email" required autocomplete="email"><button class="btn primary" type="submit">Send me a link</button></div></form>';
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const email = e.target.email.value;
    await api('POST', '/api/intake/login', { email, redirect });
    el.innerHTML = '<div class="msg msg-ok">If this address may sign in, a link is on its way (valid 15 minutes).</div>';
    requestDetails(el, email);
  };
}
function nameForm(el, me, then) {
  el.innerHTML = '<form id="nf"><label>how should A(DAI) credit you?</label><div class="row"><input name="name" required maxlength="120" autocomplete="name"><button class="btn primary" type="submit">Continue</button></div><p class="lede">Shown with your claim and your notes. Signed in as ' + esc(me.email) + '.</p></form>';
  $('#nf').onsubmit = async (e) => { e.preventDefault(); const r = await api('POST', '/api/intake/me', { name: e.target.name.value }); if (r.ok) then(); };
}
function handleInput(name, value, node) {
  return '<label>handle — your short link, a(dai)/@handle</label><div class="row"><input name="' + name + '" value="' + esc(value || '') + '" maxlength="30" autocomplete="off" pattern="[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]"><span class="hcheck lede" style="min-width:130px"></span></div>';
}
function wireHandle(form, node) {
  const inp = form.querySelector('input[name=handle]'); const out = form.querySelector('.hcheck');
  if (!inp) return;
  let t = null;
  const check = async () => {
    const h = inp.value.trim().toLowerCase().replace(/^@/, '');
    if (!h) { out.textContent = ''; return; }
    const r = await api('GET', '/api/claims/handle?h=' + encodeURIComponent(h) + '&node=' + encodeURIComponent(node));
    out.innerHTML = r.json && r.json.ok ? '<span class="ok">@' + esc(r.json.handle) + ' is free</span>' : '<span class="bad">' + esc((r.json && r.json.reason) || 'not available') + '</span>';
  };
  inp.oninput = () => { clearTimeout(t); t = setTimeout(check, 300); };
  check();
}
`;

export function claimPage(node: { id: string; type: string; name: string; slug: string; suggested: string | null }): string {
  const href = `/${encodeURIComponent(node.type)}/${encodeURIComponent(node.slug)}`;
  const body = `${CSS}
<div class="kicker">CLAIM A PAGE</div>
<h2>${htmlEscape(node.name)} <span class="pill">${htmlEscape(node.type)}</span></h2>
<p class="lede">Claiming says “this page is me” (or “mine”, for a collective or an institution). A claimed page shows a badge and a short <b>@handle</b> link, and gives you a log of everything the commons holds about it, where you can add context, contest what is wrong, and invite the people at the other end. You do not edit the page directly — curators still review changes. <a href="${href}">Back to the page</a>.</p>
<div id="app"><p class="progress">loading…</p></div>`;
  const script = `${helpers}${LOGIN}
const NODE = ${JSON.stringify(node).replace(/</g, "\\u003c")};
const app = $('#app');
function alertMsg(m) { const d = document.createElement('div'); d.className = 'msg msg-err'; d.textContent = m; app.prepend(d); setTimeout(() => d.remove(), 7000); }
function signedOut() {
  app.innerHTML = '<form id="so"><label>your email</label><input type="email" name="email" required autocomplete="email">' +
    '<label>how can a curator tell this is you?</label><textarea name="evidence" maxlength="4000" placeholder="A link to your website or a bio page that names you, your role in the collective…" style="width:100%;min-height:70px"></textarea>' +
    '<button class="btn primary" type="submit">Continue</button><p class="lede">If your address is already invited to A(DAI) you get a sign-in link that brings you back here. If not, the A(DAI) team gets your request and replies by email.</p></form>';
  $('#so').onsubmit = async (e) => {
    e.preventDefault();
    const email = e.target.email.value;
    const r = await api('POST', '/api/claims/request', { email, evidence: e.target.evidence.value, node_id: NODE.id });
    if (r.ok) { app.innerHTML = '<div class="msg msg-ok">Thank you. Check your inbox: either a sign-in link, or a note from the team once they have looked.</div>'; requestDetails(app, email); }
    else alertMsg((r.json && r.json.message) || 'could not send');
  };
}
function claimForm(me) {
  const instant = me.self_node_id === NODE.id;
  app.innerHTML = '<form id="cf">' +
    (instant ? '<p class="lede ok">Your invitation names this page: claiming it is immediate.</p>' :
      '<label>how can a curator tell this is you?</label><textarea name="evidence" maxlength="4000" style="width:100%;min-height:70px" placeholder="A link to your website or a bio page that names you; your role in the collective…"></textarea>' +
      '<p class="lede">A curator reviews claims; you will get an email either way.</p>') +
    handleInput('handle', NODE.suggested, NODE.id) +
    '<label style="display:flex;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" name="public_name" checked style="width:auto"> show my name (' + esc(me.name) + ') on the badge</label>' +
    '<button class="btn primary" type="submit" style="margin-top:12px">Claim this page</button></form>';
  wireHandle($('#cf'), NODE.id);
  $('#cf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const r = await api('POST', '/api/claims', { node_id: NODE.id, evidence: f.evidence ? f.evidence.value : '', handle: f.handle.value, public_name: f.public_name.checked });
    if (r.ok) load(); else alertMsg((r.json && r.json.message) || ('error ' + r.status));
  };
}
function approved(me, c) {
  app.innerHTML = '<div class="msg msg-ok">This page is yours' + (c.handle ? ' — <a href="/@' + esc(c.handle) + '">@' + esc(c.handle) + '</a>' : '') + '.</div>' +
    '<p class="lede"><a href="/me?node=' + encodeURIComponent(NODE.id) + '">Open your log</a> · <a href="/field/' + encodeURIComponent(NODE.type) + '/' + encodeURIComponent(NODE.slug) + '?lens=1">See yourself in the field</a></p>' +
    '<form id="hf">' + handleInput('handle', c.handle || NODE.suggested, NODE.id) + '<button class="btn" type="submit">' + (c.handle ? 'Change handle' : 'Set handle') + '</button><p class="lede">A handle can change once every 30 days; old ones keep working as links.</p></form>' +
    '<p class="lede" style="margin-top:20px"><a href="#" id="wd">Withdraw my claim</a></p>';
  wireHandle($('#hf'), NODE.id);
  $('#hf').onsubmit = async (e) => { e.preventDefault(); const r = await api('POST', '/api/claims/handle', { node_id: NODE.id, handle: e.target.handle.value }); if (r.ok) load(); else alertMsg((r.json && r.json.message) || 'could not save'); };
  $('#wd').onclick = async (e) => { e.preventDefault(); if (!confirm('Withdraw your claim on this page?')) return; await api('POST', '/api/claims/' + c.claim_id + '/withdraw', {}); load(); };
}
async function load() {
  const me = await api('GET', '/api/intake/me');
  if (!me.ok) return signedOut();
  if (!me.json.name) return nameForm(app, me.json, load);
  const c = (me.json.claims || []).find(x => x.id === NODE.id);
  if (!c) return claimForm(me.json);
  if (c.claim_status === 'pending') {
    app.innerHTML = '<div class="msg msg-ok">Your claim is with a curator. You will get an email when they decide.</div><p class="lede"><a href="#" id="wd">Withdraw it</a></p>';
    $('#wd').onclick = async (e) => { e.preventDefault(); await api('POST', '/api/claims/' + c.claim_id + '/withdraw', {}); load(); };
    return;
  }
  approved(me.json, c);
}
load();`;
  return shell(`Claim ${node.name}`, body, script);
}

export function mePage(): string {
  const body = `${CSS}
<div class="kicker">YOUR LOG</div>
<div id="app"><p class="progress">loading…</p></div>`;
  const script = `${helpers}${LOGIN}
const app = $('#app');
const params = new URLSearchParams(location.search);
const VERBS = { CREATED_BY: 'was created by', EXHIBITED_AT: 'was exhibited at', HELD_BY: 'is held by', PARTICIPATED_IN: 'took part in', PRESENTED_BY: 'was presented by', CURATED_BY: 'was curated by', REPRESENTS: 'represents', USES_TECHNIQUE: 'uses the technique', EMBODIES: 'embodies', BELONGS_TO: 'belongs to', COLLABORATES_WITH: 'collaborates with', INFLUENCES: 'influences', RESPONDS_TO: 'responds to', PRACTICES: 'practices', CLASSIFIED_BY: 'is classified by' };
let L = null;
let N = null;
function href(id, slug) { const t = id.split(':')[0]; return '/' + t + '/' + encodeURIComponent(slug || id.slice(t.length + 1).replace(/ /g, '-')); }
function alertMsg(m, ok) { const d = document.createElement('div'); d.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err'); d.textContent = m; app.prepend(d); setTimeout(() => d.remove(), 7000); }
function relLine(r) {
  const me = '<b>' + esc(L.node.name) + '</b>';
  const other = '<a href="' + href(r.other.id, r.other.slug) + '">' + esc(r.other.name) + '</a>';
  const verb = esc(VERBS[r.relation.edge_type] || r.relation.edge_type.toLowerCase().replace(/_/g, ' '));
  return r.direction === 'out' ? me + ' ' + verb + ' ' + other : other + ' ' + verb + ' ' + me;
}
function noteHtml(n, mine) {
  const who = n.handle ? '@' + n.handle : (n.by || 'the subject');
  const state = mine ? ' <span class="pill">' + esc(n.state) + '</span>' + (['open','pending','live'].includes(n.state) ? ' <a href="#" data-wd="' + esc(n.signal_id) + '">withdraw</a>' : '') : '';
  return '<div class="' + (n.kind === 'contest' ? 'n-contest' : 'n-context') + '">' + (n.kind === 'contest' ? '⚑ contested' : '“') + (n.kind === 'contest' ? ' by ' + esc(who) + ': ' : '') + esc(n.note) + (n.kind === 'context' ? '” — ' + esc(who) : '') + state + '</div>';
}
function relRow(r, i) {
  const pub = r.notes.filter(n => !r.my_notes.some(m => m.signal_id === n.signal_id));
  return '<div class="rel" data-i="' + i + '"><div class="line">' + relLine(r) + '</div>' +
    '<div class="src">' + (r.sources.length ? 'claimed by ' + r.sources.map(esc).join(', ') : '') + (r.since ? ' · since ' + esc(r.since.slice(0, 10)) : '') + '</div>' +
    pub.map(n => noteHtml(n, false)).join('') + r.my_notes.map(n => noteHtml(n, true)).join('') +
    '<div class="acts"><button class="btn" data-act="confirm">Confirm</button><button class="btn" data-act="context">Add context</button><button class="btn" data-act="contest">Contest</button>' + (r.can_invite ? '<button class="btn" data-act="invite">Invite ' + esc(r.other.name) + '</button>' : '') + '</div><div class="slot"></div></div>';
}
function openForm(row, act) {
  const r = L.relations[+row.dataset.i];
  const slot = $('.slot', row);
  if (act === 'invite') {
    slot.innerHTML = '<form><label>their email</label><input type="email" name="email" required><label>a note from you (optional)</label><textarea name="message" maxlength="1000"></textarea><button class="btn primary" type="submit">Send invite</button> <span class="lede">' + L.invites_left + ' of ' + L.invites_per_week + ' invites left this week. They can claim ' + esc(r.other.name) + ' straight away.</span></form>';
  } else if (act === 'confirm') {
    // Confirming is your word on the record (issue #81): a context note, so it
    // shows with the relation like any other.
    slot.innerHTML = '<form><textarea name="note" required maxlength="2000">I confirm this.</textarea><button class="btn primary" type="submit">Confirm</button> <span class="lede">Shown with the relation, in your name. Add when, how, what it meant if you like.</span></form>';
  } else {
    slot.innerHTML = '<form><textarea name="note" required maxlength="2000" placeholder="' + (act === 'contest' ? 'What is wrong with this relation? A curator reads this and decides; until then it shows as contested.' : 'Context for this relation: when, how, what it meant.') + '"></textarea><button class="btn primary" type="submit">' + (act === 'contest' ? 'Contest' : 'Add context') + '</button></form>';
  }
  $('form', slot).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const res = act === 'invite'
      ? await api('POST', '/api/me/invite', { node_id: r.other.id, email: f.email.value, message: f.message.value })
      : await api('POST', '/api/me/' + (act === 'confirm' ? 'context' : act), { node_id: L.node.id, relation: r.relation, note: f.note.value });
    if (res.ok) { alertMsg(act === 'invite' ? 'Invite sent.' : act === 'contest' ? 'Contest filed — it shows on the page now; a curator decides.' : (res.json.note.state === 'live' ? 'Context added.' : 'Context sent to a curator.'), true); load(); }
    else alertMsg((res.json && res.json.message) || ('error ' + res.status));
  };
}
function pendingRow(p) {
  const what = p.edges.map(e => esc(e.names[0]) + ' <span class="pill">' + esc(e.edge_type) + '</span> ' + esc(e.names[1])).join('<br>') + (p.patches.length ? '<br>edit: ' + p.patches.map(x => x.keys.map(esc).join(', ')).join('; ') : '');
  return '<div class="item" data-q="' + esc(p.queue_id) + '"><div>' + (p.title ? esc(p.title) + '<br>' : '') + what + '</div><div class="lede">proposed by ' + esc(p.submitted_by) + ' · ' + esc((p.created_at || '').slice(0, 10)) + (p.source_url ? ' · <a href="' + esc(p.source_url) + '" target="_blank" rel="noopener">source</a>' : '') + '</div>' +
    p.my_objections.map(o => '<div class="n-contest">your objection: ' + esc(o.note) + ' <span class="pill">' + esc(o.state) + '</span></div>').join('') +
    (p.my_objections.some(o => o.state === 'open') ? '' : '<form class="obj"><textarea name="note" required maxlength="2000" placeholder="Object: tell the curator what is wrong before they decide."></textarea><button class="btn" type="submit">Object</button></form>') + '</div>';
}
function evRow(e) {
  if (e.kind === 'note') {
    return '<div class="ev">' + esc((e.at || '').slice(0, 10)) + ' · <b>' + (e.note_kind === 'contest' ? 'contested' : 'context') + '</b> <span class="pill">' + esc(e.state) + '</span> ' + esc(e.note) + (e.by ? ' · by ' + esc(e.by) : '') + '</div>';
  }
  if (e.kind === 'relation') {
    const verb = esc(VERBS[e.edge_type] || e.edge_type);
    const o = '<a href="' + href(e.other.id, e.other.slug) + '">' + esc(e.other.name || e.other.id) + '</a>';
    return '<div class="ev">' + esc((e.at || '').slice(0, 10)) + ' · relation <b>' + (e.change === 'added' ? 'added' : 'ended') + '</b>: ' + (e.direction === 'out' ? 'you ' + verb + ' ' + o : o + ' ' + verb + ' you') + (e.by ? ' · by ' + esc(e.by) : '') + '</div>';
  }
  const sid = e.source && e.source.signal_id;
  return '<div class="ev">' + esc((e.at || '').slice(0, 10)) + ' · <b>' + esc(e.op) + '</b> ' + e.changes.map(c => esc(c.key)).join(', ') + (e.by ? ' · by ' + esc(e.by) : '') +
    (sid && e.op !== 'retire_node' ? ' · ' + e.changes.filter(c => c.key !== 'claimed').map(c => '<a href="#" data-edit-key="' + esc(c.key) + '" data-edit-sig="' + esc(sid) + '">contest ' + esc(c.key) + '</a>').join(' ') : '') + '</div>';
}
function render() {
  if (!L.nodes.length) {
    app.innerHTML = '<h2>You have not claimed a page yet.</h2><p class="lede">Find your page — in the <a href="/field">field</a> or by its address, e.g. /practitioner/your-name — and press “Is this you? Claim this page”. Or <a href="/contribute">give A(DAI) your website</a>; afterwards it asks whether one of the pages it read is you.</p>';
    return;
  }
  const tabs = '<div class="tabs">' + L.nodes.map(n => '<a href="/me?node=' + encodeURIComponent(n.id) + '" class="' + (L.node && n.id === L.node.id ? 'on' : '') + '">' + esc(n.name) + (n.claim_status === 'pending' ? ' (pending)' : '') + '</a>').join('') + '</div>';
  if (!L.node) { app.innerHTML = tabs + '<p class="lede">Your claim is with a curator. Your log opens once it is approved.</p>'; return; }
  const n = L.node;
  let h = tabs + '<h2>' + esc(n.name) + ' <span class="pill">' + esc(n.type) + '</span>' + (n.handle ? ' <a href="/@' + esc(n.handle) + '" style="font-size:13px">@' + esc(n.handle) + '</a>' : '') + '</h2>' +
    '<p class="lede"><a href="' + href(n.id, n.slug) + '">page</a> · <a href="' + href(n.id, n.slug) + '/history">full history</a> · <a href="/field/' + encodeURIComponent(n.type) + '/' + encodeURIComponent(n.slug) + '?lens=1">field</a> · <a href="/claim/' + esc(n.type) + '/' + encodeURIComponent(n.slug) + '">handle &amp; claim</a></p>' +
    '<p class="lede">Curators approve every change to the commons. Here you speak for this page: add context to a relation, contest one that is wrong (it shows as contested until a curator decides), object to proposals still in review, and invite the people at the other end.</p>';
  h += '<section><h3>Relations (' + L.relations.length + ')</h3>' + (L.relations.map(relRow).join('') || '<p class="lede">None yet.</p>') + '</section>';
  h += '<section><h3>In review about you (' + L.pending.length + ')</h3>' + (L.pending.map(pendingRow).join('') || '<p class="lede">Nothing pending.</p>') + '</section>';
  h += '<section><h3>Your notes</h3>' + (L.my_notes.map(x => '<div class="ev"><span class="pill">' + esc(x.kind) + '</span> <span class="pill">' + esc(x.state) + '</span> ' + esc(x.note) + (x.resolution ? ' — <i>' + esc(x.resolution) + '</i>' : '') + '</div>').join('') || '<p class="lede">None yet.</p>') + '</section>';
  h += '<section><h3>Invites (' + L.invites_left + ' left this week)</h3>' + (L.invites.map(x => '<div class="ev">' + esc(x.name) + ' · ' + esc(x.invitee || '') + ' · ' + esc((x.created_at || '').slice(0, 10)) + ' <span class="pill">' + esc(x.status) + '</span></div>').join('') || '<p class="lede">None sent.</p>') + '</section>';
  h += '<section><h3>History</h3>' + (L.history.map(evRow).join('') || '<p class="lede">Nothing yet.</p>') + '</section>';
  h += '<section><h3>Email me</h3><p class="lede">When someone adds a relation, an edit or a note about a page you claimed (not your own contributions).</p><form id="notif">' +
    [['immediate', 'as it happens'], ['daily', 'once a day (digest)'], ['off', 'never']].map(([v, t]) => '<label style="display:block"><input type="radio" name="email" value="' + v + '"' + (N && N.email === v ? ' checked' : '') + '> ' + t + '</label>').join('') + '</form></section>';
  app.innerHTML = h;
  const nf = $('#notif');
  if (nf) nf.onchange = async () => {
    const v = nf.querySelector('input[name=email]:checked');
    const r = v && await api('POST', '/api/me/notifications', { email: v.value });
    if (r && r.ok) { N = r.json; alertMsg('Saved.', true); } else alertMsg('could not save');
  };
  app.querySelectorAll('.rel [data-act]').forEach(b => b.onclick = () => openForm(b.closest('.rel'), b.dataset.act));
  app.querySelectorAll('[data-wd]').forEach(a => a.onclick = async (e) => { e.preventDefault(); await api('POST', '/api/me/notes/' + encodeURIComponent(a.dataset.wd) + '/withdraw', {}); load(); });
  app.querySelectorAll('form.obj').forEach(f => f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await api('POST', '/api/me/objection', { node_id: L.node.id, queue_id: f.closest('.item').dataset.q, note: f.note.value });
    if (r.ok) { alertMsg('Objection sent to the curator.', true); load(); } else alertMsg((r.json && r.json.message) || 'could not send');
  });
  app.querySelectorAll('[data-edit-key]').forEach(a => a.onclick = (e) => {
    e.preventDefault();
    const note = prompt('What is wrong with this value of “' + a.dataset.editKey + '”? A curator decides; upholding puts back the value from before that edit.');
    if (!note) return;
    api('POST', '/api/me/contest', { node_id: L.node.id, edit: { key: a.dataset.editKey, signal_id: a.dataset.editSig }, note }).then(r => { if (r.ok) { alertMsg('Contest filed.', true); load(); } else alertMsg((r.json && r.json.message) || 'could not send'); });
  });
}
async function load() {
  const me = await api('GET', '/api/intake/me');
  if (!me.ok) return loginForm(app, location.pathname + location.search, 'Sign in to see your log.');
  if (!me.json.name) return nameForm(app, me.json, load);
  const r = await api('GET', '/api/me/log' + (params.get('node') ? '?node=' + encodeURIComponent(params.get('node')) : ''));
  if (!r.ok) return alertMsg('could not load your log');
  L = r.json;
  const n = await api('GET', '/api/me/notifications');
  N = n.ok ? n.json : null;
  render();
}
load();`;
  return shell("Your log", body, script);
}

// ---- after a URL read: "is one of these you?" (§6) ------------------------------------

/**
 * Candidates on a receipt: the draft's subject first, then the batch's
 * people / collectives / institutions (cap 8) — minus pages the contributor
 * already claims and practitioners someone else claimed.
 */
export function postIntakeCandidates(db: DatabaseSync, contributorId: string, receipt: Record<string, any>): Array<{ id: string; name: string; type: string; handle: string | null }> {
  const mine = new Set(claimsOf(db, contributorId, ["approved", "pending"]).map((c) => c.node_id));
  const ids: string[] = [];
  const push = (id: unknown) => { if (typeof id === "string" && id && !id.startsWith("cid:") && !ids.includes(id)) ids.push(id); };
  push(receipt.subject_node_id);
  for (const e of (receipt.edges as any[]) ?? []) { push(e.source_id); push(e.target_id); }
  const out: Array<{ id: string; name: string; type: string; handle: string | null }> = [];
  for (const id of ids) {
    if (out.length >= 8) break;
    if (mine.has(id)) continue;
    const n = db.prepare("SELECT id, name, type FROM nodes WHERE id = ?").get(id) as any;
    if (!n || !(CLAIMABLE_TYPES as readonly string[]).includes(n.type)) continue;
    if (n.type === "practitioner" && approvedClaimsFor(db, id).length) continue;
    out.push({ id: n.id, name: n.name, type: n.type, handle: suggestHandle(db, n.id) });
  }
  return out;
}

export function postIntakeClaimPrompt(db: DatabaseSync, contributorId: string, draftId: string, receipt: Record<string, any>): string {
  const cands = postIntakeCandidates(db, contributorId, receipt);
  if (!cands.length) return "";
  const hasClaim = claimsOf(db, contributorId, ["approved"]).length > 0;
  const rows = cands
    .map((c, i) => `<div class="row" style="align-items:center;margin:4px 0"><label style="display:flex;gap:6px;align-items:center;flex:1;margin:0"><input type="checkbox" name="c${i}" value="${htmlEscape(c.id)}" style="width:auto"${i === 0 && !hasClaim ? " checked" : ""}> ${htmlEscape(c.name)} <span class="pill">${htmlEscape(c.type)}</span></label><input name="h${i}" value="${htmlEscape(c.handle ?? "")}" placeholder="handle" style="max-width:200px"></div>`)
    .join("");
  const evidence = `Read ${String(receipt.source_url ?? receipt.source_domain ?? "")} through the URL intake (batch ${draftId}).`;
  return `<div class="group" id="claim-prompt" style="border:1px solid #2a3a5a;padding:10px 12px;border-radius:3px;margin:12px 0">
<h3 style="margin-top:0">${hasClaim ? "Add another page you represent?" : "Is one of these you?"}</h3>
<p class="lede">Claim the page that is you (or yours — your collective, your gallery). It gets a badge and a short @handle, and you get a log of what the commons holds about it. Your invitation's own page is yours at once; any other claim goes to a curator, with this read as your evidence.</p>
<form id="cp">${rows}<div class="row" style="margin-top:8px"><button class="btn primary" type="submit">Claim selected</button><a href="#" id="cp-later" class="lede" style="margin-left:12px">not now</a></div></form><div id="cp-out"></div></div>
<script>
(function(){
  var esc = function (v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var KEY = 'adai-claim-prompt-' + ${JSON.stringify(draftId)};
  var box = document.getElementById('claim-prompt');
  try { if (localStorage.getItem(KEY) === 'later') { box.style.display = 'none'; return; } } catch (e) {}
  document.getElementById('cp-later').onclick = function (e) { e.preventDefault(); try { localStorage.setItem(KEY, 'later'); } catch (x) {} box.style.display = 'none'; };
  document.getElementById('cp').onsubmit = async function (e) {
    e.preventDefault();
    var f = e.target, out = document.getElementById('cp-out'), lines = [];
    for (var i = 0; i < ${cands.length}; i++) {
      var cb = f['c' + i]; if (!cb || !cb.checked) continue;
      var r = await fetch('/api/claims', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: cb.value, handle: f['h' + i].value, via: 'post_intake', evidence: ${JSON.stringify(evidence).replace(/</g, "\\u003c")} }) });
      var j = {}; try { j = await r.json(); } catch (x) {}
      var name = esc(cb.parentNode.textContent.trim());
      lines.push(r.ok ? (j.claim.status === 'approved' ? '✓ ' + name + ' is yours — <a href="/me?node=' + encodeURIComponent(cb.value) + '">open your log</a>' : '… ' + name + ': sent to a curator') : '✗ ' + name + ': ' + esc(j.message || r.status));
    }
    out.innerHTML = '<div class="msg msg-ok">' + (lines.join('<br>') || 'Nothing selected.') + '</div>';
    if (lines.length) f.style.display = 'none';
  };
})();
</script>`;
}
