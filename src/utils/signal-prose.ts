// A contribution, read as a sentence (issue #59). API signals carry the
// request body as their `content` — `{"source_id":…,"edge_type":"HELD_BY"}` —
// which is what profile pages used to print. The structured ops on the
// signal's intake row say what actually happened, so the sentence is built
// from those: "Oscillon 1184 → held by → The Outlier Collection". A human
// contribution keeps its own title and text.

import type { DatabaseSync } from "node:sqlite";
import { htmlEscape } from "../templates.js";
import { edgeLabel } from "./edge-labels.js";
import { signalAuthorNode } from "./contributor-node.js";

export interface ContributionRow {
  id?: string | null;
  title: string | null;
  content: string | null;
  source_url: string | null;
  source_type: string | null;
  submitted_by: string | null;
  created_at: string | null;
  consent_attribution: string | null;
  batch_id?: string | null;
  proposed_nodes: string | null;
  proposed_edges: string | null;
}

const parse = (s: string | null): any[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** "13 Oct 2026" from an ISO timestamp. */
export function proseDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

/** Renders node ids as links with their names, looked up once per id. */
function nodeLinker(db: DatabaseSync): (id: string) => string {
  const stmt = db.prepare("SELECT type, slug, name FROM nodes WHERE id = ?");
  const cache = new Map<string, string>();
  return (id: string) => {
    let html = cache.get(id);
    if (html === undefined) {
      const n = stmt.get(id) as { type: string; slug: string; name: string } | undefined;
      html = n
        ? `<a href='/${encodeURIComponent(n.type)}/${encodeURIComponent(n.slug)}'>${htmlEscape(n.name)}</a>`
        : htmlEscape(id);
      cache.set(id, html);
    }
    return html;
  };
}

function valueProse(v: unknown): string {
  if (v === null) return "<span class='meta'>(removed)</span>";
  if (typeof v === "string") return htmlEscape(v.length > 220 ? v.slice(0, 217) + "…" : v);
  if (typeof v === "number" || typeof v === "boolean") return htmlEscape(String(v));
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return htmlEscape(v.join(", "));
  if (v && typeof v === "object" && typeof (v as any).title === "string") return htmlEscape((v as any).title);
  return "<span class='meta'>(details in history)</span>";
}

/** The sentences of one contribution, as HTML lines. */
export function contributionLines(db: DatabaseSync, c: ContributionRow, link = nodeLinker(db)): string[] {
  const lines: string[] = [];
  for (const op of parse(c.proposed_nodes)) {
    if (op?.op === "create_node") {
      lines.push(`added ${htmlEscape(String(op.type))} ${link(`${op.type}:${op.slug}`)}`);
    } else if (op?.op === "patch_node") {
      const patch = op.metadata && typeof op.metadata === "object" ? op.metadata : {};
      const keys = Object.keys(patch);
      if (!keys.length) continue;
      lines.push(`updated ${link(String(op.node_id))}<ul class='edge-list'>` +
        keys.map((k) => `<li><span class='meta'>${htmlEscape(k.replace(/_/g, " "))}:</span> ${valueProse(patch[k])}</li>`).join("") +
        `</ul>`);
    } else if (op?.op === "attach_image") {
      const src = isHttp(op.cdn_image_url) ? op.cdn_image_url : isHttp(op.image_url) ? op.image_url : null;
      lines.push(`added an image to ${link(String(op.node_id))}` +
        (src ? `<br><img src='${htmlEscape(src)}' alt='' loading='lazy' style='max-width:120px;max-height:120px;margin-top:0.4rem;border-radius:3px'>` : ""));
    } else if (op?.op === "end_edge") {
      const e = db.prepare("SELECT source_id, target_id, edge_type FROM edges WHERE id = ?").get(String(op.edge_id)) as any;
      lines.push(e
        ? `ended ${link(e.source_id)} → ${htmlEscape(edgeLabel(e.edge_type))} → ${link(e.target_id)} <span class='meta'>(no longer shown by the source)</span>`
        : `ended a relation <span class='meta'>(no longer shown by the source)</span>`);
    }
  }
  for (const e of parse(c.proposed_edges)) {
    if (!e?.source_id || !e?.target_id || !e?.edge_type) continue;
    lines.push(`${link(String(e.source_id))} → ${htmlEscape(edgeLabel(String(e.edge_type)))} → ${link(String(e.target_id))}` +
      (e.event_time ? ` <span class='meta'>(${htmlEscape(String(e.event_time))})</span>` : "") +
      (e.supersedes_edge_id ? ` <span class='meta'>— replaces an earlier relation</span>` : ""));
  }
  if (!lines.length) {
    // A human contribution, or an API one with nothing structured: its own
    // words — never a JSON body.
    const looksJson = (s: string | null) => !!s && /^\s*[{[]/.test(s);
    if (c.title) lines.push(`<strong>${htmlEscape(c.title)}</strong>`);
    if (c.content && !looksJson(c.content)) lines.push(htmlEscape(c.content));
  }
  return lines;
}

/** Who and when: "contributed by aiio · 13 Oct 2026 · source ↗". */
export function contributionByline(db: DatabaseSync, c: ContributionRow): string {
  const parts: string[] = [];
  if (c.consent_attribution === "anonymous") parts.push("contributed anonymously");
  else if (c.submitted_by) {
    const named = db.prepare("SELECT name FROM contributors WHERE id = ?").get(c.submitted_by) as { name: string } | undefined;
    const who = htmlEscape(named?.name ?? c.submitted_by);
    // linked by who actually wrote it, never by the typed name (signalAuthorNode)
    const as = signalAuthorNode(db, c);
    parts.push(`contributed by ${as ? `<a href='/${encodeURIComponent(as.type)}/${encodeURIComponent(as.slug)}'>${who}</a>` : who}`);
  }
  const day = proseDate(c.created_at);
  if (day) parts.push(day);
  if (isHttp(c.source_url)) {
    let host = c.source_url;
    try { host = new URL(c.source_url).host.replace(/^www\./, ""); } catch { /* keep the url */ }
    parts.push(`<a href='${htmlEscape(c.source_url)}' target='_blank' rel='noopener'>${htmlEscape(host)} ↗</a>`);
  }
  return parts.join(" · ");
}

/** A list of contributions as cards: sentences, then the byline. */
export function contributionCards(db: DatabaseSync, rows: ContributionRow[]): string {
  const link = nodeLinker(db);
  let html = "";
  for (const c of rows) {
    const lines = contributionLines(db, c, link);
    if (!lines.length) continue;
    html += `<div class='card'>${lines.map((l) => `<div style='margin-bottom:0.3rem'>${l}</div>`).join("")}<p class='meta'>${contributionByline(db, c)}</p></div>`;
  }
  return html;
}
