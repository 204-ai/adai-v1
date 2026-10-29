import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb } from "../db.js";
import { htmlPage, htmlEscape, CSS, HTML_HEADERS, PRIVATE_HTML_HEADERS } from "../templates.js";
import { fieldPath } from "../utils/site.js";
import { topKByNodeId, withMetadata, type Neighbour } from "../embed/neighbours.js";
import { buildEmbeddingSections } from "../embed/sections.js";
import { formatArtworkYearFromMetadata, formatArtworkYear, YEAR_SQL_FRAGMENT } from "../utils/year.js";
import { NODE_NOT_RETIRED } from "../utils/visibility.js";
import { sourceLabel } from "../utils/source-label.js";
import { edgeLabel } from "../utils/edge-labels.js";
import { contributionCards, type ContributionRow } from "../utils/signal-prose.js";
import { rosterFor } from "../utils/roster.js";
import { heldWorks } from "../utils/held-works.js";
import { collapseClaims, CLAIM_COLS, tripleKey } from "../utils/claims.js";
import { nodeHistory, type HistoryEvent } from "../utils/history.js";
import { readSession } from "../intake/auth.js";
import { accessClaimCards, accessClaimCount, claimReviewCards, curatorSignIn, objectionsBlock, profileClaimBlock, relationNoteAuditHtml, relationNotesHtml } from "../claim/pages.js";
import { auditNotesFor, notesByTriple, publicNotesFor } from "../claim/notes.js";
import { renderEntityView, nodePath, type EntityNode, type EntityViewer } from "../entity/view.js";
import { entityPage } from "../entity/page.js";
import { movedTo } from "../utils/moved.js";
import { contributorsAs } from "../utils/contributor-node.js";
import { ownedBySql } from "../utils/authorship.js";
import { skillZip, SKILL_FOLDER } from "../utils/zip.js";
import { ACCOUNTS_SHOWN, accountItems, accountsPage, decodeCursor, encodeCursor } from "../entity/accounts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");

const router = Router();

// GET /skill.md — serve SKILL.md verbatim as text/markdown so a Claude can
// `curl $ADAI_BASE/skill.md` and bootstrap itself into the contributor API.
// File is read on every request (small, ~6 KB) so editing it doesn't require
// a server restart in dev.
router.get("/skill.md", (_req, res) => {
  const skillPath = path.join(PROJECT_ROOT, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    res.status(404).type("text/plain").send("SKILL.md not found");
    return;
  }
  res
    .set({
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    })
    .send(fs.readFileSync(skillPath, "utf-8"));
});

// GET /adai-contribute.zip — the same SKILL.md packed the way Claude's skill
// uploader takes it (Customize → Skills → Upload wants a .zip holding
// `adai-contribute/SKILL.md`), so an artist downloads one file and uploads it
// as is. Built per request from the file on disk: it can never drift from
// /skill.md. `/skill.zip` is a short alias.
router.get(["/adai-contribute.zip", "/skill.zip"], (_req, res) => {
  const skillPath = path.join(PROJECT_ROOT, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    res.status(404).type("text/plain").send("SKILL.md not found");
    return;
  }
  const zip = skillZip(fs.readFileSync(skillPath), fs.statSync(skillPath).mtime);
  res
    .set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${SKILL_FOLDER}.zip"`,
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    })
    .send(zip);
});

const ENTITY_TYPES_EXCLUDE = "('related', 'concept', 'scene', 'classification_regime')";

const ALIAS_SOURCE_LABEL: Record<string, string> = {
  wikidata: "Wikidata",
  moma: "MoMA",
  met: "Met",
  artblocks: "Art Blocks",
  fxhash: "fxhash",
};

function aliasLink(source: string, externalId: string): string {
  if (source === "wikidata") return `https://www.wikidata.org/wiki/${encodeURIComponent(externalId)}`;
  return "";
}

// GET / — the field is the front door. The old stats/listing home was retired
// when /field became the primary experience (June 2026). /field stays as an
// alias so existing links/bookmarks keep working.
router.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "field", "index.html"));
});

const NODE_ROUTE_TYPES = ["practitioner", "artwork", "concept", "scene", "collective", "institution", "platform", "publication", "project", "classification_regime"];

/** A node by its address: (type, slug) first — slugs repeat across types — then slug alone. */
function nodeAt(db: any, type: string, slug: string): EntityNode | undefined {
  return (db.prepare("SELECT id, name, type, slug, metadata FROM nodes WHERE type = ? AND slug = ?").get(type, slug)
    ?? db.prepare("SELECT id, name, type, slug, metadata FROM nodes WHERE slug = ?").get(slug)) as EntityNode | undefined;
}

function viewerOf(db: any, req: any): EntityViewer {
  const session = readSession(db, req);
  return { contributorId: session?.contributor.id ?? null, curator: session?.contributor.scope === "admin" };
}

const notFoundPage = () => htmlPage("Not Found", "<h2>Not Found</h2><p>No node with that slug.</p>");

// A node's old address (a rewritten slug, or a duplicate merged into it —
// src/utils/moved.ts) 301s to its current one, on every page that takes a
// slug. Registered before those routes. The slug may hold a "/" when it
// predates the current slugifier (`idle/interludes`).
const MOVED_PATH = new RegExp(`^/(record/|field/|neighbours/)?(${NODE_ROUTE_TYPES.join("|")})/(.+?)(/history\\.json|/history|/data|/contributions)?$`);
router.get(MOVED_PATH, (req, res, next) => {
  const m = MOVED_PATH.exec(req.path);
  if (!m) return next();
  let slug: string;
  try { slug = decodeURIComponent(m[3]!); } catch { return next(); }
  const to = movedTo(getDb(), m[2]!, slug);
  if (!to) return next();
  const q = req.originalUrl.indexOf("?");
  res.redirect(301, `/${m[1] ?? ""}${encodeURIComponent(to.type)}/${encodeURIComponent(to.slug)}${m[4] ?? ""}${q >= 0 ? req.originalUrl.slice(q) : ""}`);
});

// GET /:type/:slug — the entity view (src/entity/view.ts), the designed page
// of a node: what invitations link to and search engines index. The same
// article opens as the /field overlay through /api/entity. An address whose
// type segment is wrong redirects to the node's own.
function entityHandler(type: string) {
  return (req: any, res: any) => {
    const db = getDb();
    const node = nodeAt(db, type, req.params.slug);
    if (!node) {
      res.status(404).set(HTML_HEADERS).send(notFoundPage());
      return;
    }
    if (node.type !== type) {
      res.redirect(301, nodePath(node));
      return;
    }
    res.set(HTML_HEADERS).send(entityPage(node, renderEntityView(db, node, viewerOf(db, req))));
  };
}

// GET /api/entity?id=<node id> — the entity view's article for the /field
// overlay (public/field/js-interface/entity-view.js).
router.get("/api/entity", (req, res) => {
  const db = getDb();
  const id = typeof req.query.id === "string" ? req.query.id : "";
  const node = id ? db.prepare("SELECT id, name, type, slug, metadata FROM nodes WHERE id = ?").get(id) as EntityNode | undefined : undefined;
  if (!node) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const r = renderEntityView(db, node, viewerOf(db, req));
  res.set("Cache-Control", "no-store").json({ id: node.id, type: node.type, slug: node.slug, name: node.name, html: r.article });
});

// GET /api/entity/accounts?id=&after=&limit= — the next page of the accounts
// section (src/entity/accounts.ts): list items to append, and the cursor after
// them. Public, like the article it extends.
router.get("/api/entity/accounts", (req, res) => {
  const db = getDb();
  const id = typeof req.query.id === "string" ? req.query.id : "";
  const node = id ? db.prepare("SELECT id, name FROM nodes WHERE id = ?").get(id) as { id: string; name: string } | undefined : undefined;
  if (!node) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const page = accountsPage(db, node.id, { after: decodeCursor(req.query.after), limit: Number.isFinite(limit) ? limit : ACCOUNTS_SHOWN });
  res.set("Cache-Control", "no-store").json({
    html: accountItems(page.accounts, node),
    count: page.accounts.length,
    next: encodeCursor(page.next),
  });
});

// GET /record/:type/:slug — the record view: the back office of one node —
// every field, contribution, relation and its provenance. Linked from the
// entity view for curators and from the review queue.
function profileHandler(req: any, res: any) {
  const db = getDb();
  const node = nodeAt(db, req.params.type, req.params.slug) as any;
  if (!node) {
    res.status(404).set(PRIVATE_HTML_HEADERS).send(notFoundPage());
    return;
  }
  const slug = node.slug;

  const escName = htmlEscape(String(node.name));
  const escType = htmlEscape(String(node.type));
  const fieldHref = fieldPath(node);
  let body = `<h2>${escName}</h2><span class='tag'>${escType}</span>`;
  body += ` <span class='meta'><a href='${htmlEscape(fieldHref)}'>view in field →</a> · <a href='${nodePath(node)}'>entity view →</a></span>`;
  // Claimed: the badge (+ the claimant's own links); unclaimed: "Is this you?"
  body += profileClaimBlock(db, node, readSession(db, req)?.contributor.id ?? null);

  // For artworks, surface the year prominently right under the title.
  // The same display string is exposed by the API on artwork nodes, so
  // graph/field hovers stay consistent.
  if (node.type === "artwork" && node.metadata) {
    try {
      const yearMeta = JSON.parse(node.metadata);
      const yr = formatArtworkYearFromMetadata(yearMeta);
      if (yr) body += ` <span class='tag'>${htmlEscape(yr)}</span>`;
    } catch { /* metadata not JSON, skip */ }
  }

  if (node.type === "classification_regime") {
    const { count: classifiedCount } = db
      .prepare("SELECT COUNT(*) as count FROM edges WHERE target_id = ? AND edge_type = 'CLASSIFIED_BY' AND valid_until IS NULL")
      .get(node.id) as any;
    body += `<p class='meta' style='margin-top:0.5rem'>A lens — a body of research, an institution's collection, a platform's taxonomy, or a self-report framework — through which other entities were seen. ${classifiedCount} entities declare <code>CLASSIFIED_BY</code> this regime.</p>`;
  }

  const aliases = db
    .prepare("SELECT source, external_id FROM node_aliases WHERE node_id = ? ORDER BY source")
    .all(node.id) as any[];
  if (aliases.length > 0) {
    body += `<div style='margin:0.6rem 0'>`;
    for (const a of aliases) {
      const label = ALIAS_SOURCE_LABEL[a.source] ?? a.source;
      const url = aliasLink(a.source, a.external_id);
      const idTxt = htmlEscape(String(a.external_id));
      body += url
        ? `<span class='tag'>${htmlEscape(label)}: <a href='${htmlEscape(url)}' target='_blank' rel='noopener'>${idTxt}</a></span>`
        : `<span class='tag'>${htmlEscape(label)}: ${idTxt}</span>`;
    }
    body += `</div>`;
  }

  if (node.metadata) {
    try {
      const meta = JSON.parse(node.metadata);
      const profile = meta.full_profile ?? meta;

      const imgSrc = meta.cdn_image_url || meta.image_url;
      if (imgSrc) {
        const isPortrait = node.type === "practitioner" || node.type === "collective";
        const maxW = isPortrait ? "240px" : "480px";
        const altText = htmlEscape(`${node.name} — ${node.type}`);
        body += `<figure style='margin:1rem 0;max-width:${maxW}'>` +
          `<img src='${htmlEscape(String(imgSrc))}' alt='${altText}' crossorigin='anonymous' ` +
          `style='width:100%;height:auto;border-radius:6px;display:block' loading='lazy' />`;
        if (meta.image_source || meta.image_license) {
          const parts: string[] = [];
          if (meta.image_source) parts.push(`source: ${htmlEscape(String(meta.image_source))}`);
          if (meta.image_license) parts.push(htmlEscape(String(meta.image_license)));
          body += `<figcaption class='meta' style='font-size:0.8rem;margin-top:0.3rem'>${parts.join(" · ")}</figcaption>`;
        }
        body += `</figure>`;
      }

      if (meta.status) {
        body += `<p class='meta'>Status: <span class='tag'>${htmlEscape(String(meta.status))}</span></p>`;
      }

      // What the organisation says it is (src/utils/org-kinds.ts): several
      // kinds from a fixed list, with its own words when we have them. A
      // legacy free-text kind is shown as the description it is.
      if (node.type === "institution" && meta.kind) {
        const src = meta.kind_source && typeof meta.kind_source === "object" ? meta.kind_source : null;
        const kinds = Array.isArray(meta.kind) ? meta.kind.map(String) : null;
        body += `<p class='meta'>` +
          (kinds ? kinds.map((k: string) => `<span class='tag'>${htmlEscape(k)}</span>`).join(" ") : `“${htmlEscape(String(meta.kind))}”`) +
          (src?.quote ? ` <span class='meta'>— “${htmlEscape(String(src.quote))}”${typeof src.page_url === "string" && /^https?:\/\//i.test(src.page_url) ? ` <a href='${htmlEscape(src.page_url)}' target='_blank' rel='noopener'>source</a>` : ""}</span>` : "") +
          `</p>`;
      }

      // Upstream provenance — same label the field's entity-view footer shows
      // (sourceLabel on source_url / va_maker_name), linked to the exact page
      // when a valid http(s) source_url exists. V&A makers carry a label but
      // no URL → plain text.
      {
        const srcLabelTxt = sourceLabel(meta);
        if (srcLabelTxt) {
          const su = typeof meta.source_url === "string" && /^https?:\/\//i.test(meta.source_url)
            ? meta.source_url
            : null;
          body += su
            ? `<p class='meta'>Source: <a href='${htmlEscape(su)}' target='_blank' rel='noopener'>${htmlEscape(srcLabelTxt)}</a></p>`
            : `<p class='meta'>Source: ${htmlEscape(srcLabelTxt)}</p>`;
        }
      }

      if (node.type === "classification_regime" && meta.description) {
        body += `<p style='margin-top:0.5rem'>${htmlEscape(String(meta.description))}</p>`;
      }

      if (profile.basic_info) {
        const info = profile.basic_info;
        body += `<div style='margin:1rem 0'>`;
        if (info.location) body += `<p class='meta'>Location: ${htmlEscape(String(info.location))}</p>`;
        if (info.active_years) body += `<p class='meta'>Active: ${htmlEscape(String(info.active_years))}</p>`;
        if (info.url) body += `<p class='meta'>Web: <a href='${htmlEscape(String(info.url))}' target='_blank' rel='noopener'>${htmlEscape(String(info.url))}</a></p>`;
        body += `</div>`;
      }

      if (profile.practice_description) {
        const practice = profile.practice_description;
        if (practice.practice_summary) {
          body += `<h3>practice</h3><p>${htmlEscape(String(practice.practice_summary))}</p>`;
        }
        if (practice.medium) {
          body += `<div style='margin:0.5rem 0'>`;
          for (const m of String(practice.medium).split(",")) {
            body += `<span class='tag'>${htmlEscape(m.trim())}</span>`;
          }
          body += `</div>`;
        }
        if (practice.methodology) {
          body += `<h3>methodology</h3><p>${htmlEscape(String(practice.methodology))}</p>`;
        }
      }

      if (profile.key_works?.works) {
        body += `<h3>key works</h3>`;
        for (const work of profile.key_works.works) {
          body += `<div class='card'><strong>${htmlEscape(String(work.title ?? ""))}</strong>`;
          if (work.year != null) body += ` <span class='meta'>(${htmlEscape(String(work.year))})</span>`;
          if (work.description) body += `<p style='margin-top:0.4rem'>${htmlEscape(String(work.description))}</p>`;
          body += `</div>`;
        }
      }

      if (profile.commons_orientation?.commons_summary) {
        body += `<h3>commons orientation</h3><p>${htmlEscape(String(profile.commons_orientation.commons_summary))}</p>`;
      }

      if (profile.governance_model?.governance_detail) {
        body += `<h3>governance</h3><p>${htmlEscape(String(profile.governance_model.governance_detail))}</p>`;
      }
    } catch {
      // metadata not valid JSON, skip
    }
  }

  // A gallery / venue / platform page leads with its artists. Derived from
  // live edges at read time (src/utils/roster.ts) — never stored as edges.
  if (node.type === "institution" || node.type === "platform") {
    const roster = rosterFor(db, node.id);
    if (roster.length) {
      const LIMIT = 300;
      body += `<h3>artists (${roster.length})</h3><p class='meta'>Read off this graph: represented here, in shows presented here, or with works shown or held here.</p><ul class='edge-list'>`;
      for (const a of roster.slice(0, LIMIT)) {
        const why = [
          a.represented ? (a.estate ? "estate represented" : "represented") : "",
          a.shows ? `${a.shows} show${a.shows === 1 ? "" : "s"}` : "",
          a.works ? `${a.works} work${a.works === 1 ? "" : "s"}` : "",
        ].filter(Boolean).join(" · ");
        body += `<li><a href='/${htmlEscape(a.type)}/${encodeURIComponent(a.slug)}'>${htmlEscape(a.name)}</a>${a.estate ? " <span class='meta'>(estate)</span>" : ""} <span class='meta'>${htmlEscape(why)}</span></li>`;
      }
      if (roster.length > LIMIT) body += `<li class='meta'>and ${roster.length - LIMIT} more</li>`;
      body += `</ul>`;
    }
  }

  // A collection's holdings: from incoming HELD_BY, with year, image, makers.
  if (node.type === "institution") {
    const held = heldWorks(db, node.id);
    if (held.length) {
      body += `<h3>works held (${held.length})</h3><ul class='edge-list'>`;
      for (const w of held) {
        const thumb = w.image
          ? `<img src='${htmlEscape(w.image)}' alt='' loading='lazy' style='width:48px;height:48px;object-fit:cover;border-radius:3px;vertical-align:middle;margin-right:0.6rem'>`
          : `<span style='display:inline-block;width:48px;height:48px;background:#181818;border-radius:3px;vertical-align:middle;margin-right:0.6rem'></span>`;
        const by = w.artists.map((a) => `<a href='/record/${encodeURIComponent(a.type)}/${encodeURIComponent(a.slug)}'>${htmlEscape(a.name)}</a>`).join(", ");
        body += `<li>${thumb}<a href='/record/${encodeURIComponent(w.type)}/${encodeURIComponent(w.slug)}'>${htmlEscape(w.name)}</a>${w.year ? ` <span class='meta'>(${htmlEscape(w.year)})</span>` : ""}${by ? ` <span class='meta'>— ${by}</span>` : ""}</li>`;
      }
      body += `</ul>`;
    }
  }

  // Honor consent_scope='structural_only': the contributor was promised
  // "only the edge counts, not the content" — so we hide title/summary/
  // content for those signals here too. Their edges are still rendered
  // from the edges table below; this only suppresses the narrative body.
  // NULL/other consent_scope values pass through (allow-by-default).
  const contribs = db
    .prepare(
      "SELECT s.id, s.batch_id, s.title, s.content, s.source_url, s.source_type, s.submitted_by, s.created_at, s.consent_attribution, iq.proposed_nodes, iq.proposed_edges FROM signals s JOIN intake_queue iq ON iq.signal_id = s.id WHERE iq.target_node = ? AND iq.status = 'approved' AND (s.consent_scope IS NULL OR s.consent_scope != 'structural_only') AND COALESCE(s.status, 'active') != 'revoked' ORDER BY s.created_at DESC"
    )
    .all(node.id) as unknown as ContributionRow[];

  if (contribs.length > 0) {
    body += `<h3>community contributions (${contribs.length})</h3>`;
    body += contributionCards(db, contribs);
  }

  // One line per relation; several claims of it (different sources) collapse
  // into "claimed by N sources" (src/utils/claims.ts).
  const edges = collapseClaims(db
    .prepare(
      `SELECT e.id, ${CLAIM_COLS}, e.confidence, n1.name as source_name, n1.slug as source_slug, n1.type as source_node_type, n2.name as target_name, n2.slug as target_slug, n2.type as target_node_type FROM edges e LEFT JOIN signals s ON s.id = e.signal_id LEFT JOIN nodes n1 ON e.source_id = n1.id LEFT JOIN nodes n2 ON e.target_id = n2.id WHERE e.valid_until IS NULL AND (e.source_id = ? OR e.target_id = ?) ORDER BY e.valid_from ASC`
    )
    .all(node.id, node.id) as any[]);

  // The subject's word on its relations: open contests, context notes. The
  // record is public: everyone gets the public filter, except a curator, who
  // gets the full audit view of every note below the relations.
  const curator = viewerOf(db, req).curator;
  const notes = notesByTriple(publicNotesFor(db, node.id));
  if (edges.length > 0) {
    const grouped = new Map<string, any[]>();
    for (const e of edges) {
      const key = e.edge_type || "";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(e);
    }
    body += `<h3>connections (${edges.length})</h3>`;
    for (const [etype, list] of grouped) {
      const label = edgeLabel(etype);
      body += `<div style='margin-top:0.8rem'><span class='edge-type'>${htmlEscape(etype)}</span> <span class='meta'>— ${htmlEscape(label)} (${list.length})</span><ul class='edge-list'>`;
      for (const e of list) {
        const otherName = e.source_id === node.id ? e.target_name : e.source_name;
        const otherSlug = e.source_id === node.id ? e.target_slug : e.source_slug;
        const otherType = e.source_id === node.id ? e.target_node_type : e.source_node_type;
        if (!otherSlug) continue;
        const claimed = e.origins.length > 1
          ? ` <span class='meta'>— claimed by ${e.origins.length} sources: ${e.origins.map((o: { label: string }) => htmlEscape(o.label)).join(", ")}</span>`
          : "";
        body += `<li><a href='/record/${encodeURIComponent(otherType)}/${encodeURIComponent(otherSlug)}'>${htmlEscape(String(otherName ?? otherSlug))}</a>${claimed}${relationNotesHtml(notes.get(tripleKey(e)))}</li>`;
      }
      body += `</ul></div>`;
    }
  }

  if (curator) {
    const audit = auditNotesFor(db, node.id);
    if (audit.length) {
      body += `<h3>notes — curator audit (${audit.length})</h3><p class='meta'>Every note on this page's relations and values, as stored. The public sees only live context, open contests and live readings (while their relation stands), with the consent below applied.</p>`;
      body += audit.map(relationNoteAuditHtml).join("");
    }
  }

  // Same consent_scope filter as the contribs query above — structural_only
  // contributors were promised "only the edge counts, not the content", and
  // `s.title` rendered in the provenance block (see below) is content. The
  // edges themselves stay live in the graph; only the signal row's title /
  // origin metadata is suppressed for structural_only signals.
  const provenance = db
    .prepare(
      `SELECT DISTINCT s.id, s.title, s.source_origin, s.batch_id, s.consent_scope, s.status
       FROM signals s
       JOIN edges e ON e.signal_id = s.id
       WHERE e.valid_until IS NULL AND (e.source_id = ? OR e.target_id = ?)
         AND (s.consent_scope IS NULL OR s.consent_scope != 'structural_only')`
    )
    .all(node.id, node.id) as any[];

  if (provenance.length > 0) {
    body += `<h3>provenance</h3><p class='meta'>Signal(s) whose live edges touch this node — source, consent, status.</p><ul class='edge-list'>`;
    for (const p of provenance) {
      const parts = [
        `<strong>${htmlEscape(String(p.title ?? p.id))}</strong>`,
        p.source_origin ? `<span class='tag'>${htmlEscape(String(p.source_origin))}</span>` : "",
        p.consent_scope ? `<span class='tag'>consent: ${htmlEscape(String(p.consent_scope))}</span>` : "",
        p.status ? `<span class='tag'>${htmlEscape(String(p.status))}</span>` : "",
        p.batch_id ? `<span class='meta'>batch: ${htmlEscape(String(p.batch_id))}</span>` : "",
      ].filter(Boolean);
      body += `<li>${parts.join(" ")}</li>`;
    }
    body += `</ul>`;
  }

  // ----- Embedding-derived sections ------------------------------------
  // Each section is gated on the node having an appropriate vector; nodes
  // with no embedding (e.g. institution, publication, regime) get nothing
  // here, no errors.
  body += renderEmbeddingSections(db, node);

  body += `<p style='margin-top:2rem'><a href='/${encodeURIComponent(node.type)}/${encodeURIComponent(slug)}/data' class='btn'>Export JSON</a></p>`;

  // Direct deep-link into the similarity browser for any node with an
  // embedding. Cheap to add — it's a query-param page, no per-node cost.
  body += ` <a href='/neighbours/${encodeURIComponent(node.type)}/${encodeURIComponent(slug)}' class='btn'>Find neighbours</a>`;

  // Shareable deep-link into the field view, zoomed straight to this node —
  // the URL contributors send around ("look at what I added").
  body += ` <a href='${htmlEscape(fieldPath(node))}' class='btn'>View in field</a>`;
  body += ` <a href='/${encodeURIComponent(node.type)}/${encodeURIComponent(slug)}/history' class='btn'>History</a>`;

  // a curator sees the audit view on this same URL: never cached for anyone
  res.set(PRIVATE_HTML_HEADERS).send(htmlPage(node.name, body, "", { fieldNode: node }));
}

// Render the "Style kin", "Visually affine", and "AI-suggested attributions"
// sections that hang off a profile page. The section selection + neighbour
// computation lives in `src/embed/sections.ts` and is shared with the JSON
// endpoint `/api/neighbours/:type/:slug` consumed by the /field overlays,
// so the HTML and JSON surfaces can never drift apart.
function renderEmbeddingSections(db: any, node: any): string {
  const sections = buildEmbeddingSections(db, node);
  let html = "";
  for (const s of sections) {
    if (s.key === "ai_attributions") {
      // Slightly different chrome for the attribution proposals — the count
      // is the headline and the blurb links into /review.
      html += `<h3 style='margin-top:2rem'>${htmlEscape(s.title)} <span class='tag'>${s.neighbours.length}</span></h3>`;
      html += `<p class='meta'>Unattributed artworks the embedding pipeline thinks may be by ${htmlEscape(String(node.name))}. Review at <a href='/review?kind=ai_suggestion'>/review</a>.</p>`;
      html += renderNeighbourList(s.neighbours);
      continue;
    }
    html += renderNeighbourSection(s.title, s.blurb, s.neighbours);
  }
  return html;
}

function renderNeighbourSection(title: string, blurb: string, neighbours: Neighbour[]): string {
  let s = `<h3 style='margin-top:2rem'>${htmlEscape(title)} <span class='tag'>${neighbours.length}</span></h3>`;
  s += `<p class='meta'>${htmlEscape(blurb)}</p>`;
  s += renderNeighbourList(neighbours);
  return s;
}

function renderNeighbourList(neighbours: Neighbour[]): string {
  // Compact grid: thumbnail (for artworks) + name + type tag + similarity.
  let s = `<div style='display:flex;flex-wrap:wrap;gap:0.8rem;margin-top:0.5rem'>`;
  for (const n of neighbours) {
    const url = n.slug && n.type ? `/${encodeURIComponent(n.type)}/${encodeURIComponent(n.slug)}` : "#";
    const img = n.cdn_image_url || n.image_url;
    const sim = n.similarity.toFixed(3);
    const nameEsc = htmlEscape(String(n.name ?? n.node_id));
    const typeEsc = htmlEscape(String(n.type ?? "?"));
    const thumb = img
      ? `<img src='${htmlEscape(String(img))}' alt='${nameEsc}' crossorigin='anonymous' style='width:96px;height:96px;object-fit:cover;border-radius:4px;display:block' loading='lazy' />`
      : `<div style='width:96px;height:96px;background:#181818;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:#666;text-align:center;padding:0.4rem;box-sizing:border-box'>${nameEsc.slice(0, 40)}</div>`;
    const yearTag = n.year ? ` <span class='meta'>(${htmlEscape(String(n.year))})</span>` : "";
    s += `<a href='${url}' style='display:block;width:108px;text-decoration:none;color:inherit'>
${thumb}
<div style='font-size:0.78rem;margin-top:0.3rem;line-height:1.2'>${nameEsc}${yearTag}</div>
<div class='meta' style='font-size:0.7rem;margin-top:0.15rem'>${typeEsc} · <span class='tag'>${sim}</span></div>
</a>`;
  }
  s += `</div>`;
  return s;
}

for (const t of NODE_ROUTE_TYPES) router.get(`/${t}/:slug`, entityHandler(t));
router.get("/record/:type/:slug", profileHandler);

// JSON data export — polymorphic over node type, slug-only resolution.
function dataHandler(req: any, res: any) {
  const db = getDb();
  const slug = req.params.slug;

  const node = db
    .prepare("SELECT id, name, type, slug, metadata, created_at, updated_by FROM nodes WHERE slug = ?")
    .get(slug) as any;
  if (!node) {
    res.status(404).json({ error: "not found" });
    return;
  }

  let parsedMetadata = null;
  if (node.metadata) {
    try {
      parsedMetadata = JSON.parse(node.metadata);
    } catch {
      parsedMetadata = null;
    }
  }

  const edgeRows = db
    .prepare("SELECT id, source_id, target_id, edge_type, confidence FROM edges WHERE source_id = ? OR target_id = ?")
    .all(node.id, node.id) as any[];

  // Same consent_scope filter as the HTML profile path above — don't
  // expose structural_only contributors' titles through the data API.
  const signalRows = db
    .prepare(
      "SELECT s.id, s.title, s.submitted_by FROM signals s JOIN intake_queue iq ON iq.signal_id = s.id WHERE iq.target_node = ? AND iq.status = 'approved' AND (s.consent_scope IS NULL OR s.consent_scope != 'structural_only')"
    )
    .all(node.id) as any[];

  res.json({
    node: {
      id: node.id,
      name: node.name,
      type: node.type,
      slug: node.slug,
      created_at: node.created_at,
      updated_by: node.updated_by,
      metadata: parsedMetadata,
    },
    edges: edgeRows.map((e: any) => ({
      id: e.id,
      source_id: e.source_id,
      target_id: e.target_id,
      edge_type: e.edge_type,
      confidence: e.confidence,
    })),
    signals: signalRows.map((s: any) => ({
      id: s.id,
      title: s.title,
      submitted_by: s.submitted_by,
    })),
    // Derived at read time, never stored as edges (src/utils/roster.ts).
    ...(node.type === "institution" || node.type === "platform" ? { roster: rosterFor(db, node.id) } : {}),
  });
}

router.get("/practitioner/:slug/data", dataHandler);
router.get("/artwork/:slug/data", dataHandler);
router.get("/concept/:slug/data", dataHandler);
router.get("/scene/:slug/data", dataHandler);
router.get("/collective/:slug/data", dataHandler);
router.get("/institution/:slug/data", dataHandler);
router.get("/platform/:slug/data", dataHandler);
router.get("/publication/:slug/data", dataHandler);
router.get("/project/:slug/data", dataHandler);
router.get("/classification_regime/:slug/data", dataHandler);

// GET /:type/:slug/history — every metadata write and every relation that
// started or ended, newest first, each with the signal behind it
// (src/utils/history.ts). history.json is the same data. Slug-only
// resolution like /data; retired nodes stay reachable here too.
function historyFor(req: any): ReturnType<typeof nodeHistory> {
  const db = getDb();
  const row = db.prepare("SELECT id FROM nodes WHERE slug = ?").get(req.params.slug) as any;
  return row ? nodeHistory(db, row.id) : null;
}

const historyValue = (v: unknown): string => {
  if (v === null || v === undefined) return "<span class='meta'>(none)</span>";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const short = s.length > 160 ? s.slice(0, 157) + "…" : s;
  return /^https?:\/\//i.test(s) && s === short
    ? `<a href='${htmlEscape(s)}' target='_blank' rel='noopener'>${htmlEscape(short)}</a>`
    : `<code>${htmlEscape(short)}</code>`;
};

const HISTORY_OP_LABEL: Record<string, string> = {
  patch_node: "edited",
  attach_image: "image attached",
  retire_node: "retired",
  apply_image_patch: "image resized",
  merge_node: "merged with a duplicate",
  rename_slug: "address changed",
};

function renderHistoryEvent(e: HistoryEvent): string {
  const day = e.at ? htmlEscape(e.at.slice(0, 10)) : "undated";
  let what: string;
  if (e.kind === "metadata") {
    what = `<strong>${htmlEscape(HISTORY_OP_LABEL[e.op] ?? e.op)}</strong><ul class='edge-list'>` +
      e.changes.map((c) =>
        `<li>${htmlEscape(c.key)}: ${e.before_recorded ? `${historyValue(c.before)} → ` : ""}${historyValue(c.after)}</li>`
      ).join("") + `</ul>`;
    if (!e.before_recorded) what += `<p class='meta'>Earlier value not recorded (written before before-images were kept).</p>`;
  } else if (e.kind === "note") {
    const target = e.relation
      ? `<code>${htmlEscape(e.relation.source_id)}</code> <span class='edge-type'>${htmlEscape(e.relation.edge_type)}</span> <code>${htmlEscape(e.relation.target_id)}</code>`
      : `<code>${htmlEscape(e.meta_key ?? "")}</code>`;
    const label = e.note_kind === "contest" ? `contested by the subject` : e.note_kind === "reading" ? `a reading` : `context from the subject`;
    const outcome = e.note_kind === "contest" && e.state !== "open"
      ? ` <span class='tag'>${htmlEscape(e.state)}${e.resolved_at ? ` ${htmlEscape(e.resolved_at.slice(0, 10))}` : ""}</span>${e.resolution ? ` <span class='meta'>${htmlEscape(e.resolution)}</span>` : ""}`
      : e.state === "withdrawn" ? " <span class='tag'>withdrawn</span>" : "";
    what = `<strong>${label}</strong> ${target}${outcome}${e.note ? `<p>“${htmlEscape(e.note)}”</p>` : ""}`;
  } else {
    const other = e.other.slug && e.other.type
      ? `<a href='/${encodeURIComponent(e.other.type)}/${encodeURIComponent(e.other.slug)}'>${htmlEscape(e.other.name ?? e.other.id)}</a>`
      : htmlEscape(e.other.name ?? e.other.id);
    const rel = e.direction === "out" ? `<span class='edge-type'>${htmlEscape(e.edge_type)}</span> → ${other}` : `${other} → <span class='edge-type'>${htmlEscape(e.edge_type)}</span>`;
    what = `<strong>${e.change === "added" ? "relation added" : "relation ended"}</strong> ${rel}${e.event_time ? ` <span class='meta'>(${htmlEscape(e.event_time)})</span>` : ""}`;
  }
  const s = e.source;
  const meta: string[] = [];
  if (e.by) meta.push(`by ${s?.by_node && s.by === e.by ? `<a href='/${encodeURIComponent(s.by_node.type)}/${encodeURIComponent(s.by_node.slug)}'>${htmlEscape(e.by)}</a>` : htmlEscape(e.by)}`);
  else if (s) meta.push("anonymous");
  if (s?.title) meta.push(htmlEscape(s.title));
  if (s?.source_url && /^https?:\/\//i.test(s.source_url)) meta.push(`<a href='${htmlEscape(s.source_url)}' target='_blank' rel='noopener'>source</a>`);
  if (s?.batch_id) meta.push(`batch: ${htmlEscape(s.batch_id)}`);
  if (s?.first_proposed) meta.push(`first proposed by ${htmlEscape(s.first_proposed.by ?? "a contributor")} in <a href='/batch/${encodeURIComponent(s.first_proposed.batch_id)}'>an earlier read</a>`);
  if (s?.status && s.status !== "active") meta.push(`<span class='tag'>${htmlEscape(s.status)}</span>`);
  let html = `<div class='card'><p class='meta'>${day}</p>${what}`;
  if (meta.length) html += `<p class='meta'>${meta.join(" · ")}</p>`;
  if (s?.proposed_as) {
    html += `<details><summary class='meta'>changed by the contributor before confirming — what the reader proposed</summary><pre style='white-space:pre-wrap;font-size:0.75rem'>${htmlEscape(JSON.stringify(s.proposed_as, null, 2))}</pre></details>`;
  }
  return html + `</div>`;
}

function historyHandler(req: any, res: any) {
  const h = historyFor(req);
  if (!h) {
    res.status(404).set(HTML_HEADERS).send(htmlPage("Not found", "<p>No such node.</p>"));
    return;
  }
  const profile = `/${encodeURIComponent(h.node.type)}/${encodeURIComponent(h.node.slug)}`;
  let body = `<h2>History: <a href='${profile}'>${htmlEscape(h.node.name)}</a></h2>`;
  body += `<p class='meta'>Every change to this ${htmlEscape(h.node.type)}, newest first. Nothing is deleted: edits keep the value they replaced, ended relations stay on record. <a href='${profile}/history.json'>JSON</a></p>`;
  if (h.events.length === 0) body += `<p class='meta'>No recorded changes.</p>`;
  for (const e of h.events) body += renderHistoryEvent(e);
  if (h.node.created_at) body += `<div class='card'><p class='meta'>${htmlEscape(h.node.created_at.slice(0, 10))}</p><strong>created</strong></div>`;
  res.set(HTML_HEADERS).send(htmlPage(`${h.node.name} — history`, body, "", { fieldNode: h.node }));
}

function historyJsonHandler(req: any, res: any) {
  const h = historyFor(req);
  if (!h) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(h);
}

for (const t of ["practitioner", "artwork", "concept", "scene", "collective", "institution", "platform", "publication", "project", "classification_regime"]) {
  router.get(`/${t}/:slug/history`, historyHandler);
  router.get(`/${t}/:slug/history.json`, historyJsonHandler);
}

// GET /:type/:slug/contributions — what a node contributed to the commons
// through the contributors that stand for it (issue #70): an institution
// posting its collection through a token. Consent-filtered like the record
// view: anonymous and structural-only signals are not listed.
function contributionsHandler(type: string) {
  return (req: any, res: any) => {
    const db = getDb();
    const node = nodeAt(db, type, req.params.slug);
    if (!node || node.type !== type) {
      res.status(404).set(HTML_HEADERS).send(notFoundPage());
      return;
    }
    const as = contributorsAs(db, node.id);
    const page = nodePath(node);
    let body = `<h2>Contributions: <a href='${page}'>${htmlEscape(node.name)}</a></h2>`;
    if (!as.length) {
      body += `<p class='meta'>${htmlEscape(node.name)} has not contributed to the commons as a contributor of its own.</p>`;
      res.set(HTML_HEADERS).send(htmlPage(`${node.name} — contributions`, body, "", { fieldNode: node }));
      return;
    }
    // Only what this node's contributors provably wrote (ownedBySql: the
    // authenticated author first) — a name typed into the public form is not
    // theirs — filtered in SQL, before the limit.
    const stmt = db.prepare(
      `SELECT s.id, s.batch_id, s.title, s.content, s.source_url, s.source_type, s.submitted_by, s.created_at, s.consent_attribution, iq.proposed_nodes, iq.proposed_edges
         FROM signals s LEFT JOIN intake_queue iq ON iq.signal_id = s.id
        WHERE ${ownedBySql("s")} AND s.status = 'active'
          AND (iq.id IS NULL OR iq.status = 'approved')
          AND (s.consent_attribution IS NULL OR s.consent_attribution != 'anonymous')
          AND (s.consent_scope IS NULL OR s.consent_scope != 'structural_only')
        ORDER BY s.created_at DESC
        LIMIT 500`
    );
    const seenIds = new Set<string>();
    const rows = (as.flatMap((c) => stmt.all({ owner_id: c.id, owner_name: c.name }) as any[]) as any[])
      .filter((r) => (seenIds.has(r.id) ? false : (seenIds.add(r.id), true)))
      .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))
      .slice(0, 500) as unknown as ContributionRow[];
    body += `<p class='meta'>${htmlEscape(node.name)} contributes to the commons as ${as.map((c) => htmlEscape(c.name)).join(", ")}. Newest first; what is still waiting for review is not listed.</p>`;
    body += rows.length ? contributionCards(db, rows) : `<p class='meta'>Nothing yet.</p>`;
    res.set(HTML_HEADERS).send(htmlPage(`${node.name} — contributions`, body, "", { fieldNode: node }));
  };
}
for (const t of NODE_ROUTE_TYPES) router.get(`/${t}/:slug/contributions`, contributionsHandler(t));

// GET /neighbours/:type/:slug — similarity browser. Shows the top-K cosine
// neighbours of a node across any kind+candidate combination. Useful for
// curators evaluating AI suggestions and for general "what does this thing
// sit next to in embedding space" exploration.
router.get("/neighbours/:type/:slug", (req, res) => {
  const db = getDb();
  const slug = req.params.slug;
  const node = db.prepare("SELECT id, name, type, slug, metadata FROM nodes WHERE slug = ?").get(slug) as any;
  if (!node) {
    res.status(404).set(HTML_HEADERS).send(htmlPage("not found", "<p>node not found</p>"));
    return;
  }

  // Query knobs (URL-overridable) — sensible defaults pick the most useful
  // comparison for each node type.
  const defaultsByType: Record<string, { queryKind: string; candidateKind: string; prefixes: string }> = {
    practitioner: { queryKind: "style_centroid", candidateKind: "style_centroid", prefixes: "practitioner:,collective:" },
    collective: { queryKind: "style_centroid", candidateKind: "style_centroid", prefixes: "practitioner:,collective:" },
    artwork: { queryKind: "identity", candidateKind: "identity", prefixes: "artwork:" },
    concept: { queryKind: "identity", candidateKind: "identity", prefixes: "artwork:,concept:" },
    scene: { queryKind: "identity", candidateKind: "identity", prefixes: "artwork:,practitioner:" },
  };
  const def = defaultsByType[node.type] ?? { queryKind: "identity", candidateKind: "identity", prefixes: "" };

  const queryKind = String(req.query.qkind ?? def.queryKind);
  const candidateKind = String(req.query.ckind ?? def.candidateKind);
  const prefixesRaw = String(req.query.prefixes ?? def.prefixes);
  const k = Math.min(Math.max(parseInt(String(req.query.k ?? "20"), 10) || 20, 1), 100);
  const prefixes = prefixesRaw ? prefixesRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const neighbours = withMetadata(
    db,
    topKByNodeId(db, node.id, {
      queryKind: queryKind as any,
      candidateKind: candidateKind as any,
      typePrefixes: prefixes,
      k,
    })
  );

  // Render the page.
  const escName = htmlEscape(String(node.name));
  const escType = htmlEscape(String(node.type));
  let body = `<h2>Neighbours of <a href='/${encodeURIComponent(node.type)}/${encodeURIComponent(node.slug)}'>${escName}</a></h2>`;
  body += `<p class='meta'><span class='tag'>${escType}</span>
 · query vector: <span class='tag'>${htmlEscape(queryKind)}</span>
 · candidates: <span class='tag'>${htmlEscape(candidateKind)}</span>
 · filter: <span class='tag'>${htmlEscape(prefixesRaw || "(any)")}</span>
 · k=${k}</p>`;

  // Filter chips — let the curator swap query/candidate kind in one click.
  // The "switch" form lives at the top, GET-based so URLs are shareable.
  body += `<form method='get' style='margin:1rem 0;padding:0.75rem;background:#111;border:1px solid #2a2a2a;border-radius:6px;font-size:0.85rem'>
  <label style='margin-right:1rem'>query kind:
    <select name='qkind' style='background:#1a1a1a;color:#d4d4d4;border:1px solid #333;padding:0.2rem'>
      <option value='identity'${queryKind === "identity" ? " selected" : ""}>identity (this node's own vector)</option>
      <option value='style_centroid'${queryKind === "style_centroid" ? " selected" : ""}>style_centroid (practitioner mean)</option>
    </select>
  </label>
  <label style='margin-right:1rem'>candidate kind:
    <select name='ckind' style='background:#1a1a1a;color:#d4d4d4;border:1px solid #333;padding:0.2rem'>
      <option value='identity'${candidateKind === "identity" ? " selected" : ""}>identity</option>
      <option value='style_centroid'${candidateKind === "style_centroid" ? " selected" : ""}>style_centroid</option>
    </select>
  </label>
  <label style='margin-right:1rem'>prefixes:
    <input type='text' name='prefixes' value='${htmlEscape(prefixesRaw)}'
           style='background:#1a1a1a;color:#d4d4d4;border:1px solid #333;padding:0.2rem;width:14rem'
           placeholder='e.g. artwork: or practitioner:,collective:' />
  </label>
  <label style='margin-right:1rem'>k:
    <input type='number' name='k' min='1' max='100' value='${k}'
           style='background:#1a1a1a;color:#d4d4d4;border:1px solid #333;padding:0.2rem;width:4rem' />
  </label>
  <button type='submit' class='btn'>refresh</button>
</form>`;

  if (!neighbours.length) {
    body += `<p>No neighbours — this node has no vector of kind <span class='tag'>${htmlEscape(queryKind)}</span> (likely a node without an embedding, or a practitioner with no <code>CREATED_BY</code> artworks for the centroid).</p>`;
  } else {
    body += renderNeighbourTable(neighbours);
  }

  res.set(HTML_HEADERS).send(htmlPage(`Neighbours of ${node.name}`, body, "", { fieldNode: node }));
});

// Larger table variant for /neighbours/: shows name + type + similarity
// + thumbnail in a denser layout than the profile-page card grid.
function renderNeighbourTable(neighbours: Neighbour[]): string {
  let s = `<table style='width:100%;border-collapse:collapse;margin-top:1rem;font-size:0.88rem'>`;
  s += `<thead><tr style='border-bottom:1px solid #2a2a2a;text-align:left'>
    <th style='padding:0.4rem 0.6rem;width:88px'></th>
    <th style='padding:0.4rem 0.6rem'>name</th>
    <th style='padding:0.4rem 0.6rem;width:90px'>type</th>
    <th style='padding:0.4rem 0.6rem;width:80px;text-align:right'>cosine</th>
  </tr></thead><tbody>`;
  for (const n of neighbours) {
    const url = n.slug && n.type ? `/${encodeURIComponent(n.type)}/${encodeURIComponent(n.slug)}` : "#";
    const img = n.cdn_image_url || n.image_url;
    const sim = n.similarity.toFixed(4);
    const nameEsc = htmlEscape(String(n.name ?? n.node_id));
    const typeEsc = htmlEscape(String(n.type ?? "?"));
    const thumb = img
      ? `<img src='${htmlEscape(String(img))}' alt='' crossorigin='anonymous' style='width:72px;height:72px;object-fit:cover;border-radius:3px;display:block' loading='lazy' />`
      : `<div style='width:72px;height:72px;background:#181818;border-radius:3px'></div>`;
    s += `<tr style='border-bottom:1px solid #1a1a1a'>
  <td style='padding:0.4rem 0.6rem'>${thumb}</td>
  <td style='padding:0.4rem 0.6rem'><a href='${url}'>${nameEsc}</a></td>
  <td style='padding:0.4rem 0.6rem'><span class='tag'>${typeEsc}</span></td>
  <td style='padding:0.4rem 0.6rem;text-align:right;font-variant-numeric:tabular-nums'>${sim}</td>
</tr>`;
  }
  s += `</tbody></table>`;
  return s;
}

// GET /contribute — contribution form
// Legacy signal form. The URL intake (src/routes/intake.ts) owns /contribute;
// this page stays reachable for the token/assistant path described on it.
router.get("/contribute/signal", (_req, res) => {
  const db = getDb();
  const entities = db
    .prepare(`SELECT id, name, slug FROM nodes WHERE type NOT IN ${ENTITY_TYPES_EXCLUDE} AND ${NODE_NOT_RETIRED} ORDER BY name`)
    .all() as any[];

  let options = "";
  for (const p of entities) {
    options += `<option value='${htmlEscape(String(p.id))}'>${htmlEscape(String(p.name))}</option>`;
  }

  // Styled to read native next to the /field chrome (SF Mono, near-black,
  // sharp borders, cobalt accent) — this page is the no-JS/fallback human
  // path; /contribute/assistant covers the assistant/token path.
  // Scoped under #contribute-page so the shared template CSS stays untouched.
  const formBody = `<style>
#contribute-page { font-family: 'SF Mono','SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace; }
#contribute-page .kicker { color: #6a6a6c; font-size: 12px; letter-spacing: 0.08em; margin-bottom: 10px; }
#contribute-page h2 { font-size: 19px; color: #e8e6e1; margin: 0 0 8px; letter-spacing: 0.01em; }
#contribute-page .lede { color: #8a8a8c; font-size: 13px; line-height: 1.65; max-width: 560px; }
#contribute-page .assist { border: 1px solid #2a2a2c; padding: 12px 14px; margin: 18px 0 4px; font-size: 12px; color: #8a8a8c; line-height: 1.65; max-width: 560px; }
#contribute-page .assist a { color: #7eb8da; }
#contribute-page form { max-width: 560px; margin-top: 6px; }
#contribute-page form label { color: #8a8a8c; text-transform: uppercase; letter-spacing: 0.07em; font-size: 11px; margin: 20px 0 7px; font-family: inherit; }
#contribute-page form input, #contribute-page form select, #contribute-page form textarea {
  background: #0f0f10; border: 1px solid #2a2a2c; color: #e8e6e1;
  border-radius: 0; font-size: 13px; font-family: inherit; padding: 9px 11px;
}
#contribute-page form input:focus, #contribute-page form select:focus, #contribute-page form textarea:focus { border-color: #4169B0; }
#contribute-page form ::placeholder { color: #55555a; }
#contribute-page .btn {
  border: 1px solid #4169B0; color: #4169B0; background: transparent; border-radius: 0;
  text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; padding: 9px 14px;
  font-family: inherit; transition: background 120ms ease;
}
#contribute-page .btn:hover { background: rgba(65,105,176,0.12); color: #7eb8da; border-color: #4169B0; }
#contribute-page #result .msg { border-radius: 0; font-size: 13px; }
</style>
<div id='contribute-page'>
<p class='kicker'>[contribute · signal]</p>
<h2>Contribute a Signal</h2>
<p class='lede'>Submit information about an entity in the graph. Contributions from new contributors go to the review queue before they merge.</p>
<div class='assist'>Prefer to contribute through your own AI assistant? The <a href='/contribute/assistant'>setup guide</a> connects Claude (or any assistant) to the governed write API — every edit attributed, withdrawable anytime.</div>
<form id='contribute-form'>
<label>About which entity</label>
<select name='target_node' required>${options}</select>
<label>Signal title</label>
<input type='text' name='title' placeholder='e.g. New exhibition at Serpentine' required>
<label>Content</label>
<textarea name='content' placeholder='Describe the signal...' required></textarea>
<label>Source URL (optional)</label>
<input type='text' name='source_url' placeholder='https://...'>
<label>Your name</label>
<input type='text' name='contributor_name' placeholder='Your name or handle' required>
<label>Consent scope — how much of your contribution enters the commons</label>
<select name='consent_scope'>
<option value='full_commons'>full_commons — content + structure are public</option>
<option value='structural_only'>structural_only — only the edge counts, not the content</option>
</select>
<label>Attribution</label>
<select name='consent_attribution'>
<option value='attributed'>attributed — my name is public</option>
<option value='anonymous'>anonymous — don't show my name</option>
<option value='attributed_with_notification'>attributed_with_notification — tell me if I'm quoted</option>
</select>
<button type='submit' class='btn' style='margin-top:1.4rem'>Submit Signal</button>
</form>
<div id='result'></div>
</div>
<script>
document.getElementById('contribute-form').addEventListener('submit',function(e){
e.preventDefault();
var fd=new FormData(this);
var d={};
fd.forEach(function(v,k){d[k]=v;});
fetch('/api/contribute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})
.then(function(r){return r.text();})
.then(function(h){document.getElementById('result').innerHTML=h;document.getElementById('contribute-form').reset();});
});
</script>`;

  res.set(HTML_HEADERS).send(htmlPage("Contribute", formBody));
});

// GET /review — review queue. The default tab shows human-signal contributions
// (intake_queue.kind='human_signal'). The AI tab shows ai_suggestion rows
// from the embedding derive pipeline; mixing them in one feed swamped the
// curator's attention so we keep them separate by URL.
router.get("/review", (req, res) => {
  const db = getDb();
  const session = readSession(db, req);
  if (!session || session.contributor.scope !== "admin") {
    res.status(session ? 403 : 401).set(PRIVATE_HTML_HEADERS).send(htmlPage("Review Queue", curatorSignIn(!!session)));
    return;
  }
  const tab = String(req.query.kind ?? "human_signal");
  const TABS: Array<[string, string]> = [
    ["human_signal", "Human signals"],
    ["ai_suggestion", "AI suggestions"],
    ["claim", "Claims"],
    ["contest", "Contests"],
    ["context", "Subject notes"],
    ["reading", "Readings"],
  ];
  const tabKind = TABS.some(([k]) => k === tab) ? tab : "human_signal";
  const pendingCount = (k: string): number =>
    Number((db.prepare("SELECT COUNT(*) as count FROM intake_queue WHERE status='pending' AND kind=?").get(k) as any).count) +
    (k === "claim" ? accessClaimCount(db) : 0);
  const qCount = pendingCount(tabKind);

  const tabLink = (k: string, label: string, n: number, active: boolean): string =>
    `<a href='/review?kind=${k}' class='tag'${active ? " style='background:#444;color:#fff'" : ""}>${label} (${n})</a>`;

  let body = `<h2>Review Queue</h2>
<p class='meta'>
  ${TABS.map(([k, label]) => tabLink(k, label, pendingCount(k), tabKind === k)).join(" &nbsp; ")}
</p>
<p class='meta'>${qCount} pending in this tab · signed in as ${htmlEscape(session.contributor.name || session.email)}</p>`;

  if (qCount === 0) {
    body += `<p>Nothing to review here.</p>`;
  } else if (tabKind === "claim" || tabKind === "contest" || tabKind === "context" || tabKind === "reading") {
    body += claimReviewCards(db, tabKind);
    if (tabKind === "claim") body += accessClaimCards(db);
  } else if (tabKind === "ai_suggestion") {
    // AI suggestion rows: target_node is the *artwork*; proposed_edges
    // carries the proposed CREATED_BY pointing to a practitioner. We show
    // both ends + the cosine similarity so the curator can rank quickly.
    const items = db
      .prepare(
        `SELECT iq.id, iq.target_node, iq.submitted_by, iq.created_at, iq.proposed_edges,
                n.name as target_name
           FROM intake_queue iq
           LEFT JOIN nodes n ON iq.target_node = n.id
          WHERE iq.status='pending' AND iq.kind='ai_suggestion'
          ORDER BY iq.created_at DESC`
      )
      .all() as any[];
    for (const item of items) {
      let proposals: any[] = [];
      try { proposals = JSON.parse(item.proposed_edges || "[]"); } catch { /* leave empty */ }
      const p = proposals[0] || {};
      const candidate = db.prepare("SELECT name, slug FROM nodes WHERE id = ?").get(p.target_id) as any;
      const candName = htmlEscape(String(candidate?.name ?? p.target_id ?? "?"));
      const candSlug = String(candidate?.slug ?? "");
      const sim = typeof p.similarity === "number" ? p.similarity.toFixed(4) : "?";
      const artName = htmlEscape(String(item.target_name ?? item.target_node));
      const artSlug = String(item.target_node ?? "").split(":").slice(1).join(":");
      body += `<div class='card' id='item-${item.id}'>
<h3>${artName}</h3>
<p class='meta'>Proposed creator: <strong><a href='/record/practitioner/${encodeURIComponent(candSlug)}'>${candName}</a></strong>
 · cosine: <span class='tag'>${sim}</span>
 · ${String(item.created_at ?? "")}</p>
<p class='meta'>Artwork: <a href='/record/artwork/${encodeURIComponent(artSlug)}'>${artName}</a></p>
<div style='margin-top:0.5rem'>
<button class='btn btn-approve' onclick="reviewAction('${item.id}','approve')">Approve attribution</button>
<button class='btn btn-reject' onclick="reviewAction('${item.id}','reject')">Reject</button>
<input type='text' id='reason-${item.id}' placeholder='Rejection reason...' style='width:auto;display:inline-block;margin-left:0.5rem;padding:0.4rem'>
</div></div>`;
    }
  } else {
    const items = db
      .prepare(
        "SELECT iq.id, iq.signal_id, iq.target_node, iq.submitted_by, iq.trust_tier, iq.created_at, iq.proposed_nodes, iq.proposed_edges, s.title, s.content, s.source_url, s.source_type, n.name as target_name, n.type as target_type, n.slug as target_slug FROM intake_queue iq LEFT JOIN signals_full s ON iq.signal_id = s.id LEFT JOIN nodes n ON iq.target_node = n.id WHERE iq.status='pending' AND iq.kind='human_signal' ORDER BY iq.created_at DESC"
      )
      .all() as any[];

    for (const item of items) {
      const qtitle = htmlEscape(String(item.title ?? ""));
      const qurl = htmlEscape(String(item.source_url ?? ""));
      const qauthor = htmlEscape(String(item.submitted_by ?? ""));
      const qtier = htmlEscape(String(item.trust_tier ?? ""));
      const qtarget = item.target_slug
        ? `<a href='/record/${encodeURIComponent(item.target_type)}/${encodeURIComponent(item.target_slug)}'>${htmlEscape(String(item.target_name ?? item.target_node))}</a>`
        : htmlEscape(String(item.target_name ?? item.target_node ?? ""));
      const qdate = String(item.created_at ?? "");
      const qsource = String(item.source_type ?? "");

      body += `<div class='card' id='item-${item.id}'>
<h3>${qtitle}</h3>
<p class='meta'>About: <strong>${qtarget}</strong> · By: ${qauthor} · Trust: <span class='tag'>${qtier}</span> · ${qdate}${qsource ? ` · <span class='tag'>${htmlEscape(qsource)}</span>` : ""}</p>`;

      // For API-submitted contributions (source_type like 'api_*'), preview
      // the structured proposed_nodes / proposed_edges payload instead of
      // dumping the raw JSON in `content`. For legacy web-form signals,
      // fall back to rendering the content body as before.
      const isApiContribution = qsource.startsWith("api_");
      if (isApiContribution) {
        let ops: any[] = [];
        let edges: any[] = [];
        try { ops = JSON.parse(item.proposed_nodes || "[]"); } catch { /* empty */ }
        try { edges = JSON.parse(item.proposed_edges || "[]"); } catch { /* empty */ }
        if (ops.length) {
          body += `<p class='meta'>Proposed node operations:</p><ul class='meta'>`;
          for (const op of ops) {
            if (op?.op === "create_node") {
              body += `<li>create <span class='tag'>${htmlEscape(String(op.type))}</span> "${htmlEscape(String(op.name))}" (id: <code>${htmlEscape(`${op.type}:${op.slug}`)}</code>)</li>`;
            } else if (op?.op === "patch_node") {
              const keys = Object.keys(op.metadata || {}).join(", ");
              body += `<li>patch metadata of <code>${htmlEscape(String(op.node_id))}</code> — keys: ${htmlEscape(keys)}</li>`;
            } else if (op?.op === "attach_image") {
              if (op.cdn_image_url) {
                body += `<li>attach image to <code>${htmlEscape(String(op.node_id))}</code> — <a href='${htmlEscape(String(op.cdn_image_url))}' target='_blank'>preview</a> (sha256: <code>${htmlEscape(String(op.sha256 ?? "").slice(0, 12))}…</code>)</li>`;
              } else {
                body += `<li>image for <code>${htmlEscape(String(op.node_id))}</code> from ${htmlEscape(String(op.image_url ?? ""))} — fetched and mirrored when you approve; if that fails the node is still created without it</li>`;
              }
            } else if (op?.op === "image_failed") {
              body += `<li>image for <code>${htmlEscape(String(op.node_id))}</code> — <strong>will not be attached</strong>: ${htmlEscape(String(op.image_error ?? ""))} (source: ${htmlEscape(String(op.image_url ?? ""))}). The node itself is unaffected.</li>`;
            } else if (op?.op === "end_edge") {
              body += `<li>end relation <code>${htmlEscape(String(op.edge_id))}</code> — the source no longer shows it (nothing is deleted; the edge becomes historical)</li>`;
            } else {
              body += `<li>${htmlEscape(JSON.stringify(op))}</li>`;
            }
          }
          body += `</ul>`;
        }
        if (edges.length) {
          body += `<p class='meta'>Proposed edges:</p><ul class='meta'>`;
          for (const e of edges) {
            const sup = e.supersedes_edge_id ? ` <em>supersedes</em> <code>${htmlEscape(String(e.supersedes_edge_id))}</code>` : "";
            body += `<li><code>${htmlEscape(String(e.source_id))}</code> — <strong>${htmlEscape(String(e.edge_type))}</strong> → <code>${htmlEscape(String(e.target_id))}</code>${sup}</li>`;
          }
          body += `</ul>`;
        }
      } else {
        body += `<p>${htmlEscape(String(item.content ?? ""))}</p>`;
      }

      if (qurl) {
        body += `<p class='meta'>Source: <a href='${qurl}'>${qurl}</a></p>`;
      }
      body += objectionsBlock(db, item.id);

      body += `<div style='margin-top:0.5rem'>
<button class='btn btn-approve' onclick="reviewAction('${item.id}','approve')">Approve</button>
<button class='btn btn-reject' onclick="reviewAction('${item.id}','reject')">Reject</button>
<input type='text' id='reason-${item.id}' placeholder='Rejection reason...' style='width:auto;display:inline-block;margin-left:0.5rem;padding:0.4rem'>
</div></div>`;
    }
  }

  // recent decisions
  const recentDecisions = db
    .prepare(
      "SELECT iq.id, iq.status, iq.kind, iq.reviewed_at, s.title, n.name as target_name FROM intake_queue iq LEFT JOIN signals_full s ON iq.signal_id = s.id LEFT JOIN nodes n ON iq.target_node = n.id WHERE iq.status != 'pending' ORDER BY iq.reviewed_at DESC LIMIT 10"
    )
    .all() as any[];

  if (recentDecisions.length > 0) {
    body += `<h3>recent decisions</h3>`;
    for (const r of recentDecisions) {
      body += `<div class='card'><span class='status-${htmlEscape(String(r.status))}'>${htmlEscape(String(r.status))}</span> ${htmlEscape(String(r.title ?? r.kind ?? ""))} — ${htmlEscape(String(r.target_name ?? ""))}</div>`;
    }
  }

  // review action JS
  body += `<script>
function reviewAction(id,action){
var body={};
if(action==='reject'){
var r=document.getElementById('reason-'+id).value;
if(!r){alert('Please enter a rejection reason');return;}
body.reason=r;}
fetch('/api/review/'+id+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
.then(function(r){return r.text();})
.then(function(){var el=document.getElementById('item-'+id);if(el){el.style.opacity='0.3';el.innerHTML+='<p class="meta">'+action+'d</p>';}});
}
</script>`;

  res.set(PRIVATE_HTML_HEADERS).send(htmlPage("Review Queue", body));
});

// GET /field — data-driven p5-derived dot-field view (assets in public/field).
// GET /field/:type/:slug — the field focused on one node (issue #71); the
// client reads the node from the path. The old /field?node=<id> 301s to it,
// other parameters (lens, reading, seed) kept. Sent through res.send, not
// sendFile, so the staging bar is added like on every other page.
const FIELD_HTML = path.join(__dirname, "..", "..", "public", "field", "index.html");
const sendField = (res: any) => res.set(HTML_HEADERS).send(fs.readFileSync(FIELD_HTML, "utf-8"));

/** A ?node= value: a node id, `type:slug`, or a bare slug. */
function fieldNodeOf(db: any, raw: string): EntityNode | undefined {
  const byId = db.prepare("SELECT id, name, type, slug, metadata FROM nodes WHERE id = ?").get(raw) as EntityNode | undefined;
  if (byId) return byId;
  const m = /^([a-z_]+):(.+)$/.exec(raw);
  return m ? nodeAt(db, m[1], m[2]) : nodeAt(db, "", raw);
}

router.get("/field", (req, res) => {
  const raw = typeof req.query.node === "string" ? req.query.node.trim() : "";
  const node = raw ? fieldNodeOf(getDb(), raw) : undefined;
  if (node) {
    const rest = new URLSearchParams(req.url.split("?")[1] ?? "");
    rest.delete("node");
    const q = rest.toString();
    res.redirect(301, fieldPath(node) + (q ? `?${q}` : ""));
    return;
  }
  sendField(res);
});

router.get("/field/:type/:slug", (req, res) => {
  const node = nodeAt(getDb(), req.params.type, req.params.slug);
  if (!node) {
    res.status(404).set(HTML_HEADERS).send(notFoundPage());
    return;
  }
  if (node.type !== req.params.type || node.slug !== req.params.slug) {
    const q = req.url.split("?")[1];
    res.redirect(301, fieldPath(node) + (q ? `?${q}` : ""));
    return;
  }
  sendField(res);
});

export default router;
