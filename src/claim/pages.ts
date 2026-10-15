// Server-rendered pieces for claims (docs/CLAIM-SPEC.md): the curator's
// review cards, the profile badge / claim button / relation notes, and the
// claimant's pages (/claim/:type/:slug, /me). Vanilla JS like the intake.

import type { DatabaseSync } from "node:sqlite";
import { htmlEscape } from "../templates.js";
import { collapseClaims, CLAIM_COLS } from "../utils/claims.js";
import { approvedClaimsFor, CLAIMABLE_TYPES, claimByQueueId } from "./store.js";
import { noteByQueueId, objectionsFor, type RelationNote } from "./notes.js";

const esc = (v: unknown): string => htmlEscape(String(v ?? ""));

function parse(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function nodeHref(id: string, slug?: string | null): string {
  const t = id.split(":")[0] ?? "";
  const sl = slug ?? id.slice(t.length + 1).replace(/ /g, "-");
  return `/${encodeURIComponent(t)}/${encodeURIComponent(sl)}`;
}

function nodeLink(db: DatabaseSync, id: string): string {
  const n = db.prepare("SELECT name, slug FROM nodes WHERE id = ?").get(id) as any;
  return `<a href='${nodeHref(id, n?.slug)}'>${esc(n?.name ?? id)}</a>`;
}

/** Hosts a node names as its own (website / url fields), www. dropped. */
export function nodeHosts(metadata: any): string[] {
  const m = metadata ?? {};
  const urls = [m.website, m.url, m.homepage, m.basic_info?.url, m.full_profile?.basic_info?.url, m.profile?.basic_info?.url, m.links?.website];
  const out: string[] = [];
  for (const u of urls) {
    if (typeof u !== "string") continue;
    try {
      const h = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
      if (h && !out.includes(h)) out.push(h);
    } catch { /* not a URL */ }
  }
  return out;
}

export function curatorSignIn(signedIn: boolean): string {
  if (signedIn) {
    return `<h2>Review Queue</h2><p>Your account is not a curator. Curators are listed in <code>ADMIN_EMAILS</code> or hold an admin token.</p>`;
  }
  return `<h2>Review Queue</h2><p class='meta'>Curators only. Sign in with your email; the link brings you back here.</p>
<form id='cs' style='max-width:420px'><input type='email' name='email' required placeholder='you@example.org'><button class='btn' type='submit'>Send me a link</button></form>
<p id='cs-msg' class='meta'></p>
<script>
document.getElementById('cs').onsubmit=async function(e){e.preventDefault();
await fetch('/api/intake/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e.target.email.value,redirect:'/review'})});
document.getElementById('cs-msg').textContent='If this address may sign in, a link is on its way.';};
</script>`;
}

function buttons(id: string, approve: string, reject: string): string {
  return `<div style='margin-top:0.5rem'>
<button class='btn btn-approve' onclick="reviewAction('${esc(id)}','approve')">${esc(approve)}</button>
<button class='btn btn-reject' onclick="reviewAction('${esc(id)}','reject')">${esc(reject)}</button>
<input type='text' id='reason-${esc(id)}' placeholder='Reason (required to reject)…' style='width:auto;display:inline-block;margin-left:0.5rem;padding:0.4rem'>
</div>`;
}

function relationLine(db: DatabaseSync, r: { source_id: string; edge_type: string; target_id: string }): string {
  return `${nodeLink(db, r.source_id)} <span class='edge-type'>${esc(r.edge_type)}</span> ${nodeLink(db, r.target_id)}`;
}

/** The pending claim / contest / context cards on /review. */
export function claimReviewCards(db: DatabaseSync, kind: "claim" | "contest" | "context"): string {
  const items = db
    .prepare("SELECT id, target_node, submitted_by, trust_tier, created_at FROM intake_queue WHERE status = 'pending' AND kind = ? ORDER BY created_at ASC")
    .all(kind) as any[];
  let html = "";
  for (const item of items) {
    html += `<div class='card' id='item-${esc(item.id)}'>`;
    if (kind === "claim") {
      const c = claimByQueueId(db, item.id);
      if (!c) { html += `<p class='meta'>claim row missing</p></div>`; continue; }
      const node = db.prepare("SELECT id, type, name, slug, metadata FROM nodes WHERE id = ?").get(c.node_id) as any;
      const email = (db.prepare("SELECT email FROM contributor_emails WHERE contributor_id = ? ORDER BY created_at ASC LIMIT 1").get(c.contributor_id) as any)?.email ?? "";
      const domain = email.split("@")[1] ?? "";
      const hosts = nodeHosts(parse(node?.metadata));
      const domainMatch = domain && hosts.some((h) => h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`));
      const drafts = db
        .prepare("SELECT id, source_url, source_domain, status FROM drafts WHERE contributor_id = ? ORDER BY created_at DESC LIMIT 20")
        .all(c.contributor_id) as any[];
      const siteDrafts = drafts.filter((d) => hosts.some((h) => String(d.source_domain).replace(/^www\./, "") === h));
      const others = approvedClaimsFor(db, c.node_id);
      const handle = (parse((db.prepare("SELECT proposed_nodes FROM intake_queue WHERE id = ?").get(item.id) as any)?.proposed_nodes) ?? [])[0]?.handle;
      html += `<h3>${esc(item.submitted_by)} claims ${nodeLink(db, c.node_id)} <span class='tag'>${esc(node?.type)}</span></h3>
<p class='meta'>via ${esc(c.via)} · trust <span class='tag'>${esc(item.trust_tier)}</span> · email domain <strong>${esc(domain || "?")}</strong>${domainMatch ? " <span class='tag' style='color:#6fbf8a'>matches the page's website</span>" : ""} · ${esc(item.created_at)}${handle ? ` · wants <strong>@${esc(handle)}</strong>` : ""}</p>`;
      if (hosts.length) html += `<p class='meta'>Page website: ${hosts.map(esc).join(", ")}</p>`;
      if (c.evidence) html += `<p>${esc(c.evidence)}</p>`;
      if (siteDrafts.length) html += `<p class='meta'>Read that site through the URL intake: ${siteDrafts.map((d) => `<a href='/draft/${esc(d.id)}'>${esc(d.source_url)}</a> (${esc(d.status)})`).join(", ")}</p>`;
      if (others.length) {
        const names = others.map((o) => (db.prepare("SELECT name FROM contributors WHERE id = ?").get(o.contributor_id) as any)?.name ?? o.contributor_id);
        html += `<p class='msg msg-err'>Already claimed by ${names.map(esc).join(", ")}${node?.type === "practitioner" ? " — a practitioner is one person; approving adds a second claimant." : "."}</p>`;
      }
      html += buttons(item.id, "Approve claim", "Reject");
    } else {
      const n = noteByQueueId(db, item.id);
      if (!n) { html += `<p class='meta'>note row missing</p></div>`; continue; }
      const who = `${esc(n.by ?? item.submitted_by)}${n.handle ? ` (@${esc(n.handle)})` : ""}, claimant of ${nodeLink(db, n.node_id)}`;
      if (n.relation) {
        html += `<h3>${relationLine(db, n.relation)}</h3>`;
        const sources = collapseClaims(db
          .prepare(`SELECT ${CLAIM_COLS} FROM edges e LEFT JOIN signals s ON s.id = e.signal_id WHERE e.source_id = ? AND e.edge_type = ? AND e.target_id = ? AND e.valid_until IS NULL`)
          .all(n.relation.source_id, n.relation.edge_type, n.relation.target_id) as any[]);
        const origins = sources[0]?.origins ?? [];
        if (origins.length) html += `<p class='meta'>Claimed by ${origins.length} source${origins.length === 1 ? "" : "s"}: ${origins.map((o: { label: string }) => esc(o.label)).join(", ")}</p>`;
      } else if (n.meta_key) {
        html += `<h3>${nodeLink(db, n.node_id)} · <code>${esc(n.meta_key)}</code></h3><p class='meta'>Written by signal <code>${esc(n.edit_signal_id)}</code>. Upholding restores the value from before that edit, when one was recorded.</p>`;
      }
      html += `<p class='meta'>${kind === "contest" ? "Contested" : "Note"} by ${who} · ${esc(item.created_at)}</p><blockquote style='border-left:2px solid #444;padding-left:0.8rem;margin:0.5rem 0'>${esc(n.note)}</blockquote>`;
      html += kind === "contest"
        ? buttons(item.id, n.relation ? "Uphold — end the relation" : "Uphold — restore the value", "Dismiss")
        : buttons(item.id, "Publish note", "Reject");
    }
    html += `</div>`;
  }
  return html;
}

/** Signed-out claim requests: uninvited addresses that asked to claim a page (§2.3). */
export function accessClaimCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM intake_access_requests WHERE node_id IS NOT NULL").get() as any).n);
}

export function accessClaimCards(db: DatabaseSync): string {
  const rows = db
    .prepare("SELECT email, node_id, evidence, first_at, last_at FROM intake_access_requests WHERE node_id IS NOT NULL ORDER BY last_at ASC")
    .all() as any[];
  if (!rows.length) return "";
  let html = `<h3 style='margin-top:1.5rem'>Not yet invited (${rows.length})</h3><p class='meta'>Approving invites the address and approves the claim at once; they get a sign-in link to their log. Their credit defaults to the page's name.</p>`;
  for (const r of rows) {
    const id = `acc-${Buffer.from(r.email).toString("hex")}`;
    const node = db.prepare("SELECT name, type FROM nodes WHERE id = ?").get(r.node_id) as any;
    const domain = String(r.email).split("@")[1] ?? "";
    const hosts = nodeHosts(parse((db.prepare("SELECT metadata FROM nodes WHERE id = ?").get(r.node_id) as any)?.metadata));
    const match = hosts.some((h) => h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`));
    html += `<div class='card' id='${id}'><h3>${esc(r.email)} claims ${nodeLink(db, r.node_id)} <span class='tag'>${esc(node?.type)}</span></h3>
<p class='meta'>${esc(r.last_at)}${match ? " · <span class='tag' style='color:#6fbf8a'>email domain matches the page's website</span>" : hosts.length ? ` · page website: ${hosts.map(esc).join(", ")}` : ""}</p>
${r.evidence ? `<p>${esc(r.evidence)}</p>` : "<p class='meta'>No evidence given.</p>"}
<div style='margin-top:0.5rem'><button class='btn btn-approve' data-acc='approve' data-email='${esc(r.email)}' data-card='${id}'>Invite + approve claim</button>
<button class='btn btn-reject' data-acc='reject' data-email='${esc(r.email)}' data-card='${id}'>Drop the claim</button></div></div>`;
  }
  html += `<script>
document.querySelectorAll('[data-acc]').forEach(function(b){b.onclick=function(){
fetch('/api/review/access/'+b.dataset.acc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:b.dataset.email})})
.then(function(r){return r.json().then(function(j){var el=document.getElementById(b.dataset.card);el.style.opacity='0.4';el.innerHTML+='<p class="meta">'+(r.ok?b.dataset.acc+'d':(j.message||j.error||'failed'))+'</p>';});});};});
</script>`;
  return html;
}

/** Objections a claimant filed against a pending item, for its /review card. */
export function objectionsBlock(db: DatabaseSync, queueId: string): string {
  const obs = objectionsFor(db, queueId).filter((o) => o.state === "open");
  if (!obs.length) return "";
  return obs
    .map((o) => `<div class='msg msg-err'><strong>Objection from the subject</strong> — ${esc(o.by ?? "")}${o.handle ? ` (@${esc(o.handle)})` : ""}, claimant of ${nodeLink(db, o.node_id)}: ${esc(o.note)}</div>`)
    .join("");
}

// ---- profile -------------------------------------------------------------------------

/** The badge under a claimed node's name; the claim button for an unclaimed one. */
export function profileClaimBlock(db: DatabaseSync, node: { id: string; type: string; slug: string; metadata?: string | null }, viewerId: string | null): string {
  if (!(CLAIMABLE_TYPES as readonly string[]).includes(node.type)) return "";
  const claimed = (parse(node.metadata) ?? {}).claimed ?? null;
  const mine = viewerId ? approvedClaimsFor(db, node.id).some((c) => c.contributor_id === viewerId) : false;
  const claimHref = `/claim/${encodeURIComponent(node.type)}/${encodeURIComponent(node.slug)}`;
  let html = "";
  if (claimed) {
    const by = Array.isArray(claimed.by) && claimed.by.length ? ` by ${claimed.by.map(esc).join(", ")}` : "";
    html += `<p class='claim-badge' style='margin:0.3rem 0 0.8rem'><span class='tag' style='border-color:#2a5a3a;color:#6fbf8a'>✓ claimed${claimed.handle ? ` by <a href='/@${esc(claimed.handle)}/history'>@${esc(claimed.handle)}</a>` : ""}</span><span class='meta'>${by}</span></p>`;
  }
  if (mine) {
    html += `<p class='meta' style='margin-bottom:0.8rem'>This is your page · <a href='/me?node=${encodeURIComponent(node.id)}'>your log</a> · <a href='${claimHref}'>handle</a> · <a href='/field?node=${encodeURIComponent(node.id)}&lens=1'>see in field</a></p>`;
  } else if (!claimed || node.type !== "practitioner") {
    html += `<p class='meta' style='margin-bottom:0.8rem'><a href='${claimHref}'>${claimed ? "Part of this? Claim it too" : "Is this you? Claim this page"}</a></p>`;
  }
  return html;
}

/** Contest / context lines under one relation on a profile. */
export function relationNotesHtml(notes: RelationNote[] | undefined): string {
  if (!notes?.length) return "";
  return notes
    .map((n) => {
      const who = n.handle ? `@${esc(n.handle)}` : esc(n.by ?? "the subject");
      return n.kind === "contest"
        ? `<div class='meta' style='color:#d4a574'>⚑ contested by the subject (${who}): ${esc(n.note)}</div>`
        : `<div class='meta'>“${esc(n.note)}” — ${who}</div>`;
    })
    .join("");
}

