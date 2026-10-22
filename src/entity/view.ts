// The entity view — the designed page of one node (issue #64). Rendered
// here, on the server, so that ONE component serves both surfaces:
//
//   - GET /<type>/<slug>        the page itself (direct link, indexable)
//   - GET /api/entity?id=<id>   the same article for the /field overlay
//                               (public/field/js-interface/entity-view.js)
//
// The back-office view of a node (contributions, provenance, raw relations)
// lives at /record/<type>/<slug>. Section classes (ev-*) are styled by
// public/field/css/entity-view.css, shared by both surfaces.
//
// Editorial rules: the hero is a SIGNATURE WORK, never a portrait; the
// source is stated at the bottom, AI-assisted showcase data says so.

import type { DatabaseSync } from "node:sqlite";
import { htmlEscape as esc } from "../templates.js";
import { notRetired } from "../utils/visibility.js";
import { formatArtworkYear, formatArtworkYearFromMetadata, YEAR_SQL_FRAGMENT } from "../utils/year.js";
import { sourceLabel } from "../utils/source-label.js";
import { rosterFor } from "../utils/roster.js";
import { heldWorks } from "../utils/held-works.js";
import { CLAIMABLE_TYPES } from "../claim/store.js";
import { approvedClaimsFor } from "../claim/store.js";
import { accountsSection } from "./accounts.js";
import { SHOWCASE, type Showcase, type ShowcaseWork } from "./showcase.js";
import { noteAuthor, notesByTriple, publicNotesFor, type RelationNote } from "../claim/notes.js";
import { tripleKey } from "../utils/claims.js";
import { edgeLabel } from "../utils/edge-labels.js";
import { fieldPath } from "../utils/site.js";
import { listOpenReads } from "../intake/open-items.js";
import { contributorNode, contributorsAs, type StandsFor } from "../utils/contributor-node.js";

export interface EntityNode {
  id: string;
  type: string;
  name: string;
  slug: string;
  metadata: string | null;
}

export interface EntityViewer {
  /** The signed-in contributor, if any (claim line). */
  contributorId: string | null;
  /** A curator: sees the link to the record view. */
  curator: boolean;
}

export interface EntityRender {
  /** The <article class="ev-article"> — the whole view, minus overlay chrome. */
  article: string;
  title: string;
  description: string;
  image: string | null;
}

const DERIVED_BY = "embedding-multimodal-v1";
const WORKS_TYPES = new Set(["practitioner", "collective", "concept", "scene"]);
const CONCEPT_WORKS_CAP = 24;

const pad = (n: number) => String(n).padStart(2, "0");
const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
const parse = (s: string | null | undefined): any => {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

export function nodePath(n: { type: string; slug: string }): string {
  return `/${encodeURIComponent(n.type)}/${encodeURIComponent(n.slug)}`;
}

// The page's one invitation (issue #57): empty sections are not rendered at all.
export const CONTRIB_LINK = `<a class="ev-contrib-link" href="/contribute" title="how to contribute to A(DAI)">add to this record ↗</a>`;

interface Peer {
  id: string;
  type: string;
  name: string;
  slug: string;
  image: string | null;
  year: string | null;
}

interface LiveEdge {
  edge_type: string;
  source_id: string;
  target_id: string;
  dir: "out" | "in";
  other: Peer;
}

/** Live, curated (not embedding-derived) edges touching the node, other end not retired. */
function liveEdges(db: DatabaseSync, nodeId: string): LiveEdge[] {
  const rows = db.prepare(
    `SELECT e.edge_type, e.source_id, e.target_id, n.id, n.type, n.name, n.slug,
            json_extract(n.metadata,'$.cdn_image_url') AS cdn_image_url,
            json_extract(n.metadata,'$.image_url') AS image_url,
            ${YEAR_SQL_FRAGMENT.replace(/metadata/g, "n.metadata")}
       FROM edges e
       JOIN nodes n ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
      WHERE e.valid_until IS NULL AND (e.source_id = ? OR e.target_id = ?)
        AND (e.created_by IS NULL OR e.created_by != '${DERIVED_BY}')
        AND n.id != ? AND ${notRetired("n")}
      ORDER BY e.valid_from ASC`
  ).all(nodeId, nodeId, nodeId, nodeId) as any[];
  return rows.map((r) => ({
    edge_type: r.edge_type,
    source_id: r.source_id,
    target_id: r.target_id,
    dir: r.source_id === nodeId ? "out" : "in",
    other: {
      id: r.id,
      type: r.type,
      name: r.name,
      slug: r.slug,
      image: isHttp(r.cdn_image_url) ? r.cdn_image_url : isHttp(r.image_url) ? r.image_url : null,
      year: r.type === "artwork" ? formatArtworkYear(r) : null,
    },
  }));
}

function nodeById(db: DatabaseSync, id: string): Peer | null {
  const r = db.prepare(
    `SELECT id, type, name, slug, json_extract(metadata,'$.cdn_image_url') AS cdn_image_url,
            json_extract(metadata,'$.image_url') AS image_url, ${YEAR_SQL_FRAGMENT}
       FROM nodes WHERE id = ? AND ${notRetired("nodes")}`
  ).get(id) as any;
  if (!r) return null;
  return {
    id: r.id, type: r.type, name: r.name, slug: r.slug,
    image: isHttp(r.cdn_image_url) ? r.cdn_image_url : isHttp(r.image_url) ? r.image_url : null,
    year: r.type === "artwork" ? formatArtworkYear(r) : null,
  };
}

// ---------- sections ----------

function breadcrumb(node: EntityNode): string {
  return `
      <div class="ev-breadcrumb">
        <a class="ev-bc-field" href="${esc(fieldPath(node))}">field/</a>
        <span class="ev-bc-type">[${esc(node.type)}]</span>
        <span class="ev-bc-sep">/</span>
        <span class="ev-bc-slug">n.${esc(node.type)}.${esc(node.slug)}</span>
      </div>`;
}

function title(node: EntityNode, meta: any, showcase: Showcase | null): string {
  const display = showcase?.name_display || node.name;
  const dateStr = showcase?.dates_compact || (node.type === "artwork" ? formatArtworkYearFromMetadata(meta) : null);
  const dates = dateStr ? `<span class="ev-dates">[${esc(dateStr)}]</span>` : "";
  return `<h1 class="ev-title">${esc(display)} ${dates}</h1>`;
}

/** Claimed badge, or "is this you?" (docs/CLAIM-SPEC.md §2.4). */
function claimLine(db: DatabaseSync, node: EntityNode, meta: any, viewer: EntityViewer): string {
  // The way back into the graph (issue #63); in the /field overlay it closes
  // the overlay onto the node instead (entity-view.js).
  const field = `<a class="ev-field-link" href="${esc(fieldPath(node))}">view in field →</a>`;
  if (!(CLAIMABLE_TYPES as readonly string[]).includes(node.type)) return field;
  const claimed = meta.claimed ?? null;
  const claimHref = `/claim/${encodeURIComponent(node.type)}/${encodeURIComponent(node.slug)}`;
  const parts: string[] = [];
  if (claimed) {
    // "claimed by @handle" (issue #68): the handle links to the page's
    // history, where the claimant's notes and the edits they answer live.
    const h = claimed.handle ? esc(String(claimed.handle)) : null;
    const by = Array.isArray(claimed.by) && claimed.by.length ? claimed.by.map((b: unknown) => esc(String(b))).join(", ") : null;
    parts.push(`<span class="ev-claimed">✓ claimed by ${h ? `<a href="/@${h}/history">@${h}</a>` : by ?? "its subject"}</span>`);
    if (h && by) parts.push(by);
  }
  const mine = viewer.contributorId ? approvedClaimsFor(db, node.id).some((c) => c.contributor_id === viewer.contributorId) : false;
  if (mine) {
    parts.push(`this is your page · <a href="/me?node=${encodeURIComponent(node.id)}">your log</a>`);
  } else if (!claimed || node.type !== "practitioner") {
    parts.push(`<a href="${claimHref}">${claimed ? "part of this? claim it too →" : "is this you? claim this page →"}</a>`);
  }
  parts.push(field);
  return parts.join(" · ");
}

function tagline(showcase: Showcase | null): string {
  if (!showcase) return "";
  const disc = (showcase.tagline_disciplines || []).map(esc).join(" · ");
  const cf = (showcase.tagline_cf || []).map(esc).join(" , ");
  if (!disc && !cf) return "";
  return `
      <div class="ev-tagline">
        ${disc ? `<span class="ev-tagline-disc">${disc}</span>` : ""}
        ${cf ? `<span class="ev-tagline-cf">cf. ${cf}</span>` : ""}
      </div>`;
}

function heroNode(db: DatabaseSync, node: EntityNode, meta: any, showcase: Showcase | null, works: Peer[]): { peer: Peer; drop: string } | null {
  if (showcase?.hero?.artwork_id) {
    const p = nodeById(db, showcase.hero.artwork_id);
    if (p?.image) return { peer: p, drop: showcase.hero.drop || "" };
  }
  if (node.type === "artwork") {
    const img = isHttp(meta.cdn_image_url) ? meta.cdn_image_url : isHttp(meta.image_url) ? meta.image_url : null;
    return img ? { peer: { id: node.id, type: node.type, name: node.name, slug: node.slug, image: img, year: null }, drop: "" } : null;
  }
  // A maker's first imaged work. Never a portrait.
  const w = works.find((p) => p.image);
  return w ? { peer: w, drop: "" } : null;
}

function hero(h: { peer: Peer; drop: string } | null): string {
  if (!h?.peer.image) return "";
  return `
      <figure class="ev-hero ev-hero--image">
        <img src="${esc(h.peer.image)}" alt="${esc(h.peer.name)}" crossorigin="anonymous">
        <figcaption class="ev-hero-cap"><span class="ev-mono-tag">img.hero · ${esc(h.peer.name)}</span>${h.drop ? `<br><span class="ev-mono-dim">drop: ${esc(h.drop)}</span>` : ""}</figcaption>
      </figure>`;
}

/** The node's own words: showcase bio, else what its metadata says it is. */
function bioText(meta: any, showcase: Showcase | null): string | null {
  const profile = meta.full_profile ?? meta;
  const candidates = [showcase?.bio, meta.summary, meta.description, profile?.practice_description?.practice_summary, meta.bio];
  const s = candidates.find((c) => typeof c === "string" && c.trim());
  return s ? String(s).trim() : null;
}

function bio(text: string | null): string {
  return text ? `<p class="ev-bio">&gt; ${esc(text)} <span class="ev-bio-mark">‖</span></p>` : "";
}

const ALIAS_LABEL: Record<string, string> = { wikidata: "wikidata", moma: "MoMA", met: "Met", artblocks: "Art Blocks", fxhash: "fxhash" };

function metadataRows(db: DatabaseSync, node: EntityNode, meta: any, showcase: Showcase | null): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (showcase) {
    if (showcase.born) rows.push(["born", `${esc(showcase.born.date)} · ${esc(showcase.born.place)}`]);
    if (showcase.died) rows.push(["died", `${esc(showcase.died.date)} · ${esc(showcase.died.place)}`]);
    if (showcase.nationality) rows.push(["nationality", esc(showcase.nationality)]);
    if (showcase.pronunciation) rows.push(["pronunciation", esc(showcase.pronunciation)]);
    if (showcase.disciplines_full?.length) rows.push(["disciplines", showcase.disciplines_full.map(esc).join(" · ")]);
    if (showcase.movements?.length) rows.push(["movements", showcase.movements.map(esc).join(" · ")]);
    return rows;
  }
  const profile = meta.full_profile ?? meta;
  const info = profile?.basic_info ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
  const kinds = Array.isArray(meta.kind) ? meta.kind.map(String) : null;
  if (node.type === "institution" && meta.kind) rows.push(["kind", kinds ? kinds.map(esc).join(" · ") : esc(String(meta.kind))]);
  const location = str(info.location) ?? str(meta.location) ?? [str(meta.city), str(meta.country)].filter(Boolean).join(", ");
  if (location) rows.push(["location", esc(location)]);
  const active = str(info.active_years) ?? str(meta.active_years);
  if (active && node.type !== "artwork") rows.push(["active", esc(active)]);
  const medium = str(profile?.practice_description?.medium) ?? str(meta.medium);
  if (medium) rows.push(["medium", esc(medium)]);
  if (str(meta.status)) rows.push(["status", esc(String(meta.status))]);
  const web = [info.url, meta.homepage, meta.website, meta.url].find(isHttp);
  if (web) rows.push(["web", `<a href="${esc(web)}" target="_blank" rel="noopener">${esc(web.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""))} ↗</a>`]);
  for (const a of db.prepare("SELECT source, external_id FROM node_aliases WHERE node_id = ? AND source NOT IN ('handle', 'slug') ORDER BY source").all(node.id) as any[]) {
    const label = ALIAS_LABEL[a.source] ?? a.source;
    const id = esc(String(a.external_id));
    rows.push([esc(label), a.source === "wikidata" ? `<a href="https://www.wikidata.org/wiki/${encodeURIComponent(a.external_id)}" target="_blank" rel="noopener">${id} ↗</a>` : id]);
  }
  return rows;
}

function metadata(rows: Array<[string, string]>): string {
  if (!rows.length) return "";
  const half = Math.ceil(rows.length / 2);
  const col = (rs: Array<[string, string]>) => rs.map(([k, v]) => `<dt class="ev-meta-k">${k}</dt><dd class="ev-meta-v">:${v}</dd>`).join("");
  return `<dl class="ev-meta"><div class="ev-meta-col">${col(rows.slice(0, half))}</div><div class="ev-meta-col">${col(rows.slice(half))}</div></dl>`;
}

function quote(showcase: Showcase | null): string {
  if (!showcase?.quote) return "";
  return `
      <blockquote class="ev-quote">
        <p class="ev-quote-text">«${esc(showcase.quote.text)}»</p>
        <p class="ev-quote-attr">— ${esc(showcase.quote.attribution)}</p>
      </blockquote>`;
}

/** Prose sections a legacy profile carries beyond its summary. */
function practiceSections(meta: any): string {
  const profile = meta.full_profile ?? meta;
  const blocks: Array<[string, unknown]> = [
    ["methodology", profile?.practice_description?.methodology],
    ["commons orientation", profile?.commons_orientation?.commons_summary],
    ["governance", profile?.governance_model?.governance_detail],
  ];
  return blocks
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([k, v]) => `
      <section class="ev-section">
        <h2 class="ev-h2">// ${esc(k)}</h2>
        <p class="ev-prose">${esc(String(v))}</p>
      </section>`)
    .join("");
}

interface WorkItem extends ShowcaseWork { peer: Peer | null }

/** A maker's works (CREATED_BY), a concept's works (EMBODIES), else showcase / legacy key works. */
function gatherWorks(db: DatabaseSync, node: EntityNode, meta: any, showcase: Showcase | null, edges: LiveEdge[]): { works: WorkItem[]; source: "graph" | "showcase" | "none"; total: number } {
  const conceptLike = node.type === "concept" || node.type === "scene";
  const want = conceptLike ? "EMBODIES" : "CREATED_BY";
  const seen = new Set<string>();
  let graphWorks: WorkItem[] = [];
  for (const e of edges) {
    if (e.edge_type !== want || e.dir !== "in" || e.other.type !== "artwork" || seen.has(e.other.id)) continue;
    seen.add(e.other.id);
    graphWorks.push({ slug: e.other.slug, title: e.other.name, year: e.other.year ?? undefined, graph_id: e.other.id, peer: e.other });
  }
  const graphTotal = graphWorks.length;
  if (conceptLike && graphWorks.length > CONCEPT_WORKS_CAP) {
    // Imaged works first when a concept has more than the panel shows.
    graphWorks = [...graphWorks.filter((w) => w.peer?.image), ...graphWorks.filter((w) => !w.peer?.image)].slice(0, CONCEPT_WORKS_CAP);
  }
  // Imaged graph works win over hand-curated stubs; showcase prose still renders.
  if (graphWorks.some((w) => w.peer?.image)) return { works: graphWorks, source: "graph", total: graphTotal };
  if (showcase?.works?.length) {
    return { works: showcase.works.map((w) => ({ ...w, peer: w.graph_id ? nodeById(db, w.graph_id) : null })), source: "showcase", total: showcase.works.length };
  }
  const profile = meta.full_profile ?? meta;
  if (!graphWorks.length && Array.isArray(profile?.key_works?.works) && profile.key_works.works.length) {
    return {
      works: profile.key_works.works.map((w: any) => ({ title: String(w.title ?? ""), year: w.year != null ? String(w.year) : undefined, blurb: typeof w.description === "string" ? w.description : undefined, peer: null })),
      source: "showcase",
      total: profile.key_works.works.length,
    };
  }
  return { works: graphWorks, source: graphWorks.length ? "graph" : "none", total: graphTotal };
}

function worksSection(node: EntityNode, gathered: ReturnType<typeof gatherWorks>): string {
  if (!WORKS_TYPES.has(node.type)) return "";
  const { works, source, total } = gathered;
  if (!works.length) return "";
  const items = works.map((w, i) => {
    const url = w.peer?.image ?? null;
    const slug = w.slug || (w.title || "").toLowerCase().replace(/\s+/g, "-").slice(0, 64);
    const desc = w.img_descriptor ? `<br>${esc(w.img_descriptor)}` : "";
    const imgBlock = url
      ? `<div class="ev-work-img"><img src="${esc(url)}" alt="${esc(w.title)}" crossorigin="anonymous" loading="lazy"><div class="ev-work-img-cap"><span class="ev-mono-tag">img.slot · ${esc(slug)}</span>${desc}</div></div>`
      : `<div class="ev-work-img ev-work-img--empty" data-hatch="1"><div class="ev-work-img-cap"><span class="ev-mono-tag">img.slot · ${esc(slug)}</span>${desc}</div></div>`;
    const yearTag = w.year ? `<span class="ev-work-year">[${esc(w.year)}]</span>` : "";
    const mediumLine = w.medium || w.method
      ? `<p class="ev-work-medium">${esc(w.medium || "")} ${w.method ? `· <span class="ev-work-method">method: ${esc(w.method)}</span>` : ""}</p>`
      : "";
    const blurb = w.blurb ? `<p class="ev-work-blurb">// ${esc(w.blurb)}</p>` : "";
    const titleHtml = w.peer
      ? `<a href="${nodePath(w.peer)}" data-node-id="${esc(w.peer.id)}">${esc(w.title)}</a>`
      : esc(w.title);
    return `
        <article class="ev-work">
          ${w.peer ? `<a class="ev-work-link" href="${nodePath(w.peer)}" data-node-id="${esc(w.peer.id)}" tabindex="-1" aria-hidden="true">${imgBlock}</a>` : imgBlock}
          <div class="ev-work-body">
            <h3 class="ev-work-title">w.${pad(i + 1)} <strong>${titleHtml}</strong> ${yearTag}</h3>
            ${mediumLine}
            ${blurb}
          </div>
        </article>`;
  }).join("");
  // Graph works are the norm and carry no tag; a hand-picked list says so,
  // like the other editorial lists (issue #66: no "awaiting" lines).
  const sourceTag = source === "showcase" ? '<span class="ev-h2-source">(editorial)</span>' : "";
  return `
      <section class="ev-section">
        <h2 class="ev-h2">// works <span class="ev-h2-count">/${pad(total)}</span>${sourceTag}</h2>
        <div class="ev-works">${items}</div>${total > works.length ? `
        <p class="ev-empty">${total - works.length} more — <a href="${esc(fieldPath(node))}">see them in the field</a></p>` : ""}
      </section>`;
}

/** The subject's word on a relation: an open contest, or context (docs/CLAIM-SPEC.md). */
function notesHtml(notes: RelationNote[]): string {
  return notes.map((n) => {
    // publicNotesFor has applied consent; an ended claim is no longer the subject.
    const a = noteAuthor(n);
    const who = esc(a.who);
    const words = n.withheld ? `<em>words kept off the public page</em>` : esc(n.note);
    return n.kind === "contest"
      ? `<div class="ev-rel-note ev-rel-note--contest">⚑ contested ${a.subject ? `by the subject (${who})` : `by ${who}`}: ${words}</div>`
      : `<div class="ev-rel-note">${n.withheld ? words : `“${words}”`} — ${who}</div>`;
  }).join("");
}

function relRow(p: { id: string; type: string; slug: string; name: string }, tag: string, nameHtml: string, qualifier: string, notes: RelationNote[] = []): string {
  return `
          <li><a class="ev-rel-row" href="${nodePath(p)}" data-node-id="${esc(p.id)}" title="open ${esc(p.name)}">
            <span class="ev-rel-leader">··········</span>
            <span class="ev-rel-tag">[${esc(tag)}]</span>
            <span class="ev-rel-name">${nameHtml}</span>
            <span class="ev-rel-qualifier">${esc(qualifier)}</span>
          </a>${notesHtml(notes)}</li>`;
}

// ---------- relations, read off the graph (issue #57) ----------
// Every live curated edge touching the node, grouped by relation type and
// direction, plus the relations one step behind its works and shows. Only
// groups with something in them render, so a relation type added tomorrow
// shows up here without a template change (it falls back to its edge label).

const SYMMETRIC = new Set(["COLLABORATES_WITH"]);

const GROUP_HEAD: Record<string, string> = {
  "via:HELD_BY": "in collections",
  "via:EXHIBITED_AT": "works exhibited at",
  "via:PRESENTED_BY": "shows presented by",
  "via:CURATED_BY": "shows curated by",
  "CREATED_BY:out": "created by", "CREATED_BY:in": "works",
  "HELD_BY:out": "held by", "HELD_BY:in": "works held",
  "EXHIBITED_AT:out": "exhibited at", "EXHIBITED_AT:in": "works exhibited here",
  "PARTICIPATED_IN:out": "shows", "PARTICIPATED_IN:in": "participants",
  "PRESENTED_BY:out": "presented by", "PRESENTED_BY:in": "shows presented",
  "CURATED_BY:out": "curated by", "CURATED_BY:in": "shows curated",
  "REPRESENTS:out": "represents", "REPRESENTS:in": "represented by",
  "COLLABORATES_WITH": "collaborates with",
  "BELONGS_TO:out": "belongs to", "BELONGS_TO:in": "members",
  "INFLUENCES:out": "influences", "INFLUENCES:in": "influenced by",
  "RESPONDS_TO:out": "responds to", "RESPONDS_TO:in": "responded to by",
  "PRACTICES:out": "practices", "PRACTICES:in": "practised by",
  "EMBODIES:out": "embodies", "EMBODIES:in": "embodied by",
  "USES_TECHNIQUE:out": "techniques", "USES_TECHNIQUE:in": "used in",
};

const GROUP_ORDER = [
  "via:HELD_BY", "via:EXHIBITED_AT", "PARTICIPATED_IN:out", "via:PRESENTED_BY", "via:CURATED_BY", "REPRESENTS:in",
  "CREATED_BY:out", "HELD_BY:out", "EXHIBITED_AT:out", "HELD_BY:in", "EXHIBITED_AT:in",
  "PRESENTED_BY:out", "CURATED_BY:out", "PARTICIPATED_IN:in", "PRESENTED_BY:in", "CURATED_BY:in", "REPRESENTS:out",
  "COLLABORATES_WITH", "BELONGS_TO:out", "BELONGS_TO:in", "INFLUENCES:in", "INFLUENCES:out", "RESPONDS_TO:out", "RESPONDS_TO:in",
  "PRACTICES:out", "EMBODIES:out", "USES_TECHNIQUE:out", "PRACTICES:in", "EMBODIES:in", "USES_TECHNIQUE:in", "CREATED_BY:in",
];

const GROUP_ROW_CAP = 100;

interface GroupItem { peer: Peer; qualifier: string; notes: RelationNote[] }
interface Group { key: string; head: string; items: GroupItem[] }

export function groupHead(key: string): string {
  if (GROUP_HEAD[key]) return GROUP_HEAD[key];
  const [type, dir] = key.split(":");
  return dir === "in" ? `${edgeLabel(type)} (from)` : edgeLabel(type);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Relations one step behind the node's works and shows: "in collections: X · 2 works". */
function twoHop(db: DatabaseSync, node: EntityNode): Map<string, GroupItem[]> {
  const out = new Map<string, GroupItem[]>();
  const add = (key: string, rows: any[], noun: string) => {
    if (!rows.length) return;
    out.set(key, rows.map((r) => ({ peer: { id: r.id, type: r.type, name: r.name, slug: r.slug, image: null, year: null }, qualifier: plural(r.n, noun), notes: [] })));
  };
  const notDerived = (a: string) => `(${a}.created_by IS NULL OR ${a}.created_by != '${DERIVED_BY}')`;
  if (node.type === "practitioner" || node.type === "collective") {
    const viaWorks = db.prepare(
      `SELECT x.edge_type AS via, n.id, n.type, n.name, n.slug, COUNT(DISTINCT x.source_id) AS n
         FROM edges c
         JOIN nodes w ON w.id = c.source_id AND w.type = 'artwork' AND ${notRetired("w")}
         JOIN edges x ON x.source_id = c.source_id AND x.valid_until IS NULL AND x.edge_type IN ('HELD_BY', 'EXHIBITED_AT') AND ${notDerived("x")}
         JOIN nodes n ON n.id = x.target_id AND ${notRetired("n")}
        WHERE c.target_id = ? AND c.edge_type = 'CREATED_BY' AND c.valid_until IS NULL AND ${notDerived("c")}
        GROUP BY x.edge_type, n.id
        ORDER BY n DESC, n.name`
    ).all(node.id) as any[];
    add("via:HELD_BY", viaWorks.filter((r) => r.via === "HELD_BY"), "work");
    add("via:EXHIBITED_AT", viaWorks.filter((r) => r.via === "EXHIBITED_AT"), "work");
  }
  if (node.type === "practitioner" || node.type === "collective" || node.type === "institution") {
    const viaShows = db.prepare(
      `SELECT x.edge_type AS via, n.id, n.type, n.name, n.slug, COUNT(DISTINCT p.target_id) AS n
         FROM edges p
         JOIN nodes s ON s.id = p.target_id AND ${notRetired("s")}
         JOIN edges x ON x.source_id = p.target_id AND x.valid_until IS NULL AND x.edge_type IN ('PRESENTED_BY', 'CURATED_BY') AND ${notDerived("x")}
         JOIN nodes n ON n.id = x.target_id AND n.id != p.source_id AND ${notRetired("n")}
        WHERE p.source_id = ? AND p.edge_type = 'PARTICIPATED_IN' AND p.valid_until IS NULL AND ${notDerived("p")}
        GROUP BY x.edge_type, n.id
        ORDER BY n DESC, n.name`
    ).all(node.id) as any[];
    add("via:PRESENTED_BY", viaShows.filter((r) => r.via === "PRESENTED_BY"), "show");
    add("via:CURATED_BY", viaShows.filter((r) => r.via === "CURATED_BY"), "show");
  }
  return out;
}

function relationGroups(db: DatabaseSync, node: EntityNode, edges: LiveEdge[], showcase: Showcase | null, notes: Map<string, RelationNote[]>, worksFromGraph: boolean): Group[] {
  const qualifiers = showcase?.relation_qualifiers ?? {};
  const byKey = new Map<string, Map<string, GroupItem>>();
  for (const e of edges) {
    // Lenses are listed on the regime's own record, not on every node they saw.
    if (e.edge_type === "CLASSIFIED_BY") continue;
    // A collection's holdings have their own section, with images and makers.
    if (e.edge_type === "HELD_BY" && e.dir === "in" && node.type === "institution") continue;
    // A maker's / concept's works have their own section (with images).
    if (worksFromGraph && e.other.type === "artwork" && e.dir === "in" && (e.edge_type === "CREATED_BY" || e.edge_type === "EMBODIES") && WORKS_TYPES.has(node.type)) continue;
    const key = SYMMETRIC.has(e.edge_type) ? e.edge_type : `${e.edge_type}:${e.dir}`;
    const group = byKey.get(key) ?? new Map<string, GroupItem>();
    const item = group.get(e.other.id) ?? { peer: e.other, qualifier: qualifiers[e.other.id] ?? e.other.year ?? "", notes: [] };
    item.notes.push(...(notes.get(tripleKey(e)) ?? []));
    group.set(e.other.id, item);
    byKey.set(key, group);
  }
  const groups: Group[] = [];
  for (const [key, items] of twoHop(db, node)) groups.push({ key, head: groupHead(key), items });
  for (const [key, items] of byKey) groups.push({ key, head: groupHead(key), items: [...items.values()] });
  const rank = (k: string) => {
    const i = GROUP_ORDER.indexOf(k);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  return groups.sort((a, b) => rank(a.key) - rank(b.key) || a.head.localeCompare(b.head));
}

function groupSection(g: Group): string {
  const rows = g.items.slice(0, GROUP_ROW_CAP).map((it) => relRow(it.peer, it.peer.type, esc(it.peer.name), it.qualifier, it.notes)).join("");
  const more = g.items.length > GROUP_ROW_CAP ? `<li class="ev-list-row ev-mono-dim">and ${g.items.length - GROUP_ROW_CAP} more</li>` : "";
  return `
      <section class="ev-section" data-group="${esc(g.key)}">
        <h2 class="ev-h2">// ${esc(g.head)} <span class="ev-h2-count">/${pad(g.items.length)}</span></h2>
        <ul class="ev-rel-list">${rows}${more}</ul>
      </section>`;
}

/** A gallery's / platform's artists, read off its shows and works (src/utils/roster.ts). */
function rosterSection(db: DatabaseSync, node: EntityNode): string {
  if (node.type !== "institution" && node.type !== "platform") return "";
  const roster = rosterFor(db, node.id);
  if (!roster.length) return "";
  const rows = roster.slice(0, 300).map((a) => {
    const why = [a.represented ? "represented" : "", a.shows ? `${a.shows} show${a.shows === 1 ? "" : "s"}` : "", a.works ? `${a.works} work${a.works === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    return relRow(a, a.type, `${esc(a.name)}${a.estate ? ' <span class="ev-mono-dim">(estate)</span>' : ""}`, why);
  }).join("");
  return `
      <section class="ev-section">
        <h2 class="ev-h2">// artists <span class="ev-h2-count">/${pad(roster.length)}</span></h2>
        <ul class="ev-rel-list">${rows}</ul>
      </section>`;
}

/** A collection's holdings (issue #58): image, title, year, artist — from incoming HELD_BY. */
function heldWorksSection(db: DatabaseSync, node: EntityNode): string {
  if (node.type !== "institution") return "";
  const works = heldWorks(db, node.id);
  if (!works.length) return "";
  const cards = works.map((w) => {
    const name = esc(w.name);
    const img = w.image
      ? `<img src="${esc(w.image)}" alt="${name}" loading="lazy" crossorigin="anonymous">`
      : `<div class="ev-emb-thumb-empty" data-hatch="1">${name.slice(0, 32)}</div>`;
    const by = w.artists.map((a) => esc(a.name)).join(", ");
    return `
          <a class="ev-emb-card ev-held-card" href="${nodePath(w)}" data-node-id="${esc(w.id)}" title="${name}">
            <div class="ev-emb-thumb">${img}</div>
            <div class="ev-emb-meta">
              <span class="ev-emb-name">${name}</span>
              <span class="ev-emb-row"><span class="ev-held-by">${by || "&nbsp;"}</span><span class="ev-emb-type">${w.year ? esc(w.year) : ""}</span></span>
            </div>
          </a>`;
  }).join("");
  return `
      <section class="ev-section" id="ev-held">
        <h2 class="ev-h2">// works held <span class="ev-h2-count">/${pad(works.length)}</span></h2>
        <div class="ev-emb-grid">${cards}</div>
      </section>`;
}

/** Filled by the client (/api/neighbours) — cosine search stays off the page's critical path. */
function embeddingsPlaceholder(): string {
  return `
      <section class="ev-section ev-embeddings" id="ev-embeddings">
        <h2 class="ev-h2">// embedding neighbours <span class="ev-h2-count" id="ev-emb-count">/··</span></h2>
        <p class="ev-empty adai-embed-loading" id="ev-emb-status"><span class="adai-spin"></span>computing cosine neighbours over the embedding space…</p>
      </section>`;
}

/** Hand-curated showcase lists (editorial, not yet edges). */
function listSection(label: string, items: Array<string | { year: string; title: string; venue?: string; body?: string }>): string {
  if (!items.length) return "";
  const rows = items.map((item, i) => {
    if (typeof item === "string") return `<li class="ev-list-row"><span class="ev-list-idx">${pad(i + 1)}</span> ${esc(item)}</li>`;
    const venue = item.venue || item.body || "";
    return `<li class="ev-list-row"><span class="ev-list-year">[${esc(item.year)}]</span> <strong>${esc(item.title)}</strong>${venue ? ` · ${esc(venue)}` : ""}</li>`;
  }).join("");
  return `
      <section class="ev-section">
        <h2 class="ev-h2">// ${esc(label)} <span class="ev-h2-count">/${pad(items.length)}</span></h2>
        <ul class="ev-list">${rows}</ul>
      </section>`;
}

/** Signed-in contributors: what reads about this page left open (issue #77). */
function openItemsLink(db: DatabaseSync, node: EntityNode, viewer: EntityViewer): string | null {
  if (!viewer.contributorId) return null;
  const reads = listOpenReads(db, { nodeId: node.id, limit: 20 });
  const n = reads.reduce((a, r) => a + r.items, 0);
  if (!n) return null;
  return `<a class="ev-prov-link" href="/contribute?open=${encodeURIComponent(reads[0]!.draft_id)}#open">${n} item${n === 1 ? "" : "s"} left open → pick up</a>`;
}

/** The nodes that contributors of this page stand for (issue #70), the page itself left out. */
function contributedByNodes(db: DatabaseSync, node: EntityNode): StandsFor[] {
  const by = db.prepare(
    `SELECT DISTINCT s.submitted_by FROM signals s JOIN intake_queue iq ON iq.signal_id = s.id
      WHERE iq.target_node = ? AND iq.status = 'approved' AND s.status = 'active'
        AND (s.consent_attribution IS NULL OR s.consent_attribution != 'anonymous')`
  ).all(node.id) as Array<{ submitted_by: string | null }>;
  const out = new Map<string, StandsFor>();
  for (const r of by) {
    const as = contributorNode(db, r.submitted_by);
    if (as && as.id !== node.id) out.set(as.id, as);
  }
  return [...out.values()];
}

function provenance(db: DatabaseSync, node: EntityNode, meta: any, showcase: Showcase | null, viewer: EntityViewer): string {
  const links: string[] = [];
  if (showcase) {
    links.push(`<span class="ev-prov-tag">source_origin: ${esc(showcase.source_origin || "unknown")}</span>`);
    links.push(`<span class="ev-prov-tag">confidence: ${esc(showcase.confidence || "unknown")}</span>`);
    if (showcase.review_pending) links.push(`<span class="ev-prov-tag ev-prov-warn">review pending</span>`);
    links.push(`<span class="ev-prov-tag">last_updated: ${esc(showcase.last_updated || "—")}</span>`);
  } else {
    const src = sourceLabel(meta) || "community contribution";
    const href = isHttp(meta.source_url) ? meta.source_url : /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(src) ? `https://${src}` : null;
    links.push(href
      ? `<a class="ev-prov-link" href="${esc(href)}" target="_blank" rel="noopener">source: ${esc(src)} ↗</a>`
      : `<span class="ev-prov-tag">source: ${esc(src)}</span>`);
  }
  // Contributors that are themselves nodes (issue #70): who posted this, and
  // on that node's own page, that it contributes.
  for (const as of contributedByNodes(db, node)) {
    links.push(`<span class="ev-prov-tag">contributed by <a class="ev-prov-link" href="${nodePath(as)}">${esc(as.name)}</a></span>`);
  }
  const base = nodePath(node);
  const as = contributorsAs(db, node.id);
  if (as.length) {
    const n = as.reduce((a, c) => a + c.signals, 0);
    links.push(`<a class="ev-prov-link" href="${base}/contributions">contributes to the commons as ${as.map((c) => esc(c.name)).join(", ")} · ${n} contribution${n === 1 ? "" : "s"}</a>`);
  }
  links.push(`<a class="ev-prov-link" href="${base}/history">history</a>`);
  if (viewer.curator) links.push(`<a class="ev-prov-link" href="/record${base}">record</a>`);
  const open = openItemsLink(db, node, viewer);
  if (open) links.push(open);
  links.push(`<span class="ev-prov-tag">${CONTRIB_LINK}</span>`);
  return `
      <footer class="ev-provenance">
        ${links.join(" · ")}
      </footer>`;
}

// ---------- the view ----------

export function renderEntityView(db: DatabaseSync, node: EntityNode, viewer: EntityViewer): EntityRender {
  const meta = parse(node.metadata);
  const showcase = SHOWCASE[node.id] ?? null;
  const edges = liveEdges(db, node.id);
  const gathered = gatherWorks(db, node, meta, showcase, edges);
  const h = heroNode(db, node, meta, showcase, gathered.works.map((w) => w.peer).filter((p): p is Peer => !!p));
  const bioTxt = bioText(meta, showcase);
  const claim = claimLine(db, node, meta, viewer);
  const retired = meta.retired === true
    ? `<p class="ev-empty ev-prov-warn">retired${typeof meta.retired_reason === "string" ? ` — ${esc(meta.retired_reason)}` : ""}: kept on record, hidden from listings.</p>`
    : "";

  const article = `
      <article class="ev-article" data-node-id="${esc(node.id)}" data-node-type="${esc(node.type)}" data-node-slug="${esc(node.slug)}">
        ${breadcrumb(node)}
        ${title(node, meta, showcase)}
        <p class="ev-mono-dim ev-claim" id="ev-claim">${claim}</p>
        ${retired}
        ${tagline(showcase)}
        ${hero(h)}
        <hr class="ev-hr">
        ${bio(bioTxt)}
        ${metadata(metadataRows(db, node, meta, showcase))}
        ${quote(showcase)}
        ${worksSection(node, gathered)}
        ${practiceSections(meta)}
        ${rosterSection(db, node)}
        ${heldWorksSection(db, node)}
        ${relationGroups(db, node, edges, showcase, notesByTriple(publicNotesFor(db, node.id)), gathered.source === "graph").map(groupSection).join("")}
        ${accountsSection(db, node)}
        ${embeddingsPlaceholder()}
        ${listSection("collections (editorial)", showcase?.collections ?? [])}
        ${listSection("exhibitions.selected (editorial)", showcase?.exhibitions_selected ?? [])}
        ${listSection("awards (editorial)", showcase?.awards ?? [])}
        ${provenance(db, node, meta, showcase, viewer)}
      </article>`;

  const year = node.type === "artwork" ? formatArtworkYearFromMetadata(meta) : null;
  const description = bioTxt
    ? (bioTxt.length > 280 ? bioTxt.slice(0, 277) + "…" : bioTxt)
    : `${node.name}${year ? ` (${year})` : ""} — ${node.type} in A(DAI), the digital arts knowledge commons.`;
  return { article, title: node.name, description, image: h?.peer.image ?? null };
}
