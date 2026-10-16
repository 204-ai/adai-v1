// Tool definitions the model sees, and the dispatcher that runs them.
// Three families:
//   graph reads  → HTTP proxy to /internal/intake/tool (allowlisted)
//   draft writes → HTTP to /internal/intake/drafts/:id/candidates (validated)
//   fetch_page   → local Playwright (worker/src/browser.ts)
//   finish_pass  → local, ends the loop

import type Anthropic from "@anthropic-ai/sdk";
import { graphTool, draftTool, addPage, getDraft } from "./client.js";
import { fetchPage, sameSite, FetchRefused, type FetchPolicy } from "./browser.js";
import { renderPage, type PriorRead } from "./prompt.js";
import { ORG_KINDS } from "./org-kinds.js";
import { checkQuote } from "./evidence.js";

type Tool = Anthropic.Messages.Tool;

const NODE_TYPES = ["practitioner", "artwork", "project", "institution", "collective", "concept", "platform"];
const EDGE_TYPES = ["CREATED_BY", "EXHIBITED_AT", "HELD_BY", "PARTICIPATED_IN", "PRESENTED_BY", "CURATED_BY", "REPRESENTS", "USES_TECHNIQUE", "EMBODIES", "BELONGS_TO", "COLLABORATES_WITH"];
const QUESTION_EDGE_TYPES = [...EDGE_TYPES, "INFLUENCES", "RESPONDS_TO"];

const evidenceProps = {
  page_url: { type: "string", description: "The page the quote comes from (final URL as fetched)." },
  quote: { type: "string", description: "Verbatim sentence(s) from the page that support this, <= 300 chars." },
};
const linkProp = {
  link_url: { type: "string", description: "The item's own page (the work's page a listing links to) when you tried to open it with fetch_page and it failed. The card then starts rejected and goes to the re-check list for another contributor. Only pages that really failed count." },
};

export const TOOLS: Tool[] = [
  {
    name: "fetch_page",
    description: "Open a page in the browser (JS rendered). Returns the readable text, its links (same-site, plus off-site ones flagged `offsite`) and the images on it. Same-site pages (subdomains included) are always allowed; an OFF-SITE page is allowed only if a same-site page linked to it (objkt, fxhash, Art Blocks, a gallery's show page, press) — one hop, own cap. Respects robots.txt and the page caps.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        view: { type: "boolean", description: "Also return a screenshot of the page as a person sees it (top of the page). Use it where layout carries meaning the text may not: roster / artists pages, exhibition indexes, anything split into sections. Not needed for ordinary text pages." },
      },
      required: ["url"],
    },
  },
  {
    name: "search_nodes",
    description: "Substring search over node names/slugs. Cheap first look; resolve_entity is the real dedup gate.",
    input_schema: { type: "object", properties: { query: { type: "string" }, type: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
  },
  {
    name: "get_node",
    description: "Full node: metadata, live edges with peer names, approved signals. Use slug or id.",
    input_schema: { type: "object", properties: { slug: { type: "string" }, id: { type: "string" } } },
  },
  {
    name: "get_neighbours",
    description: "Embedding neighbours of a node (style-kin for practitioners, visually-affine for artworks). Sensed, not attested — feeds note_known / ask_contributor only.",
    input_schema: { type: "object", properties: { slug: { type: "string" }, id: { type: "string" }, kind: { type: "string", enum: ["auto", "style_kin", "visually_affine", "semantic"] }, k: { type: "integer" } } },
  },
  {
    name: "get_component",
    description: "Everything reachable from a node over live edges (capped). Use on the subject to see its shows, venues, collaborators.",
    input_schema: { type: "object", properties: { slug: { type: "string" }, max_nodes: { type: "integer" } }, required: ["slug"] },
  },
  {
    name: "resolve_entity",
    description: "THE dedup gate. Call before proposing any named entity. Returns exact/alias/fuzzy matches (with node ids) and `would_create` — the id a new node would get. Link when a match is right; ask_contributor when two are plausible.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string", enum: NODE_TYPES },
        hints: { type: "object", properties: { year: { type: "string" }, url: { type: "string" }, country: { type: "string" } } },
      },
      required: ["name"],
    },
  },
  {
    name: "find_path",
    description: "Shortest path between two existing nodes over live edges (default max 4 hops).",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, max_depth: { type: "integer" } }, required: ["from", "to"] },
  },
  {
    name: "image_neighbours",
    description: "Visually nearest artworks in A(DAI) for an image URL. Use on up to 10 proposed images to find works A(DAI) may already hold. Sensed only.",
    input_schema: { type: "object", properties: { image_url: { type: "string" }, k: { type: "integer" } }, required: ["image_url"] },
  },
  {
    name: "set_subject",
    description: "Declare the subject of this draft: an existing node id, or the cid of a node you proposed.",
    input_schema: { type: "object", properties: { node_id: { type: "string" }, cid: { type: "string" } } },
  },
  {
    name: "note_survey",
    description: "Record your survey of the site: what kind of site it is, what it holds (inventory: artists, exhibitions, works, editions … with counts and the index page for each), and how you will spread this pass over it. Call it once BEFORE deep extraction, and again before finish_pass with `covered` and `remaining` filled in. Fields merge; the contributor sees it, and later passes read it instead of re-surveying.",
    input_schema: {
      type: "object",
      properties: {
        site_kind: { type: "string", enum: ["artist", "gallery", "platform", "institution", "publication", "other"] },
        inventory: {
          type: "array",
          description: "One entry per kind of thing the site holds, at most 16.",
          items: { type: "object", properties: { label: { type: "string", description: "e.g. 'artists', 'exhibitions 2019–2026', 'editions'" }, count: { type: "integer" }, url: { type: "string", description: "The index page that lists them." } }, required: ["label"] },
        },
        plan: { type: "string", description: "How this pass spreads over the inventory, and why." },
        covered: { type: "string", description: "What the draft now covers, in the contributor's terms (e.g. 'full roster; 8 of 52 exhibitions: …')." },
        remaining: { type: "string", description: "What is NOT covered yet — named, so the contributor can ask for it." },
      },
      required: ["site_kind"],
    },
  },
  {
    name: "propose_node",
    description: "Propose a node (work, person, show, venue, collective, concept, platform). Returns a cid usable as 'cid:c_NN' in edges/images. If resolve_entity found the entity, pass resolves_to + resolution so the card links instead of creating.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: NODE_TYPES },
        name: { type: "string" },
        metadata: { type: "object", description: `year, medium, summary, country, bio_summary … only what the page says. For an institution: kind — a list from ${ORG_KINDS.join(", ")} (several allowed), with kind_source {page_url, quote}: how the organisation describes itself on its own site.` },
        ...evidenceProps,
        resolves_to: { type: "string", description: "Existing node id this is (from resolve_entity)." },
        resolution: { type: "string", enum: ["exact", "alias", "fuzzy"] },
        note: { type: "string", description: "One line for the contributor: why this card exists." },
        ...linkProp,
      },
      required: ["type", "name", "page_url", "quote"],
    },
  },
  {
    name: "propose_edge",
    description: "Propose a relation within the relation policy, with evidence.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "node id or cid:c_NN" },
        target: { type: "string", description: "node id or cid:c_NN" },
        edge_type: { type: "string", enum: EDGE_TYPES },
        event_time: { type: "string", description: "YYYY, YYYY-MM or YYYY-MM-DD when the page gives a date." },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        ...evidenceProps,
        note: { type: "string" },
        ...linkProp,
      },
      required: ["source", "target", "edge_type", "confidence", "page_url", "quote"],
    },
  },
  {
    name: "propose_image",
    description: "Propose an image from the page for a node (existing id or cid).",
    input_schema: {
      type: "object",
      properties: { for: { type: "string" }, image_url: { type: "string" }, page_url: { type: "string" }, alt: { type: "string" }, note: { type: "string" }, ...linkProp },
      required: ["for", "image_url", "page_url"],
    },
  },
  {
    name: "propose_patch",
    description: "The site disagrees with A(DAI) on a metadata fact. Show both values; the contributor decides.",
    input_schema: {
      type: "object",
      properties: { node_id: { type: "string" }, key: { type: "string" }, existing: {}, proposed: {}, ...evidenceProps, note: { type: "string" } },
      required: ["node_id", "key", "proposed", "page_url", "quote"],
    },
  },
  {
    name: "note_known",
    description: "Record that A(DAI) already has this (node, or node+edge+other). Shown as 'Already in A(DAI)'. origin 'graph' for attested facts, 'embedding' for sensed ones.",
    input_schema: {
      type: "object",
      properties: { node_id: { type: "string" }, edge_type: { type: "string" }, other_id: { type: "string" }, summary: { type: "string" }, origin: { type: "string", enum: ["graph", "embedding"] }, note: { type: "string" } },
      required: ["node_id", "summary"],
    },
  },
  {
    name: "ask_contributor",
    description: "Ask the contributor a yes/no question whose 'yes' becomes an edge in their own words (this is the ONLY route for INFLUENCES / RESPONDS_TO, and for ambiguous COLLABORATES_WITH). For COLLABORATES_WITH the buttons read 'Worked together' / 'Only shown together' — phrase the text to match (\"Did X and Y work together, or only show together — in A and B?\"). Max 10 per draft.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        if_yes: { type: "object", properties: { source: { type: "string" }, target: { type: "string" }, edge_type: { type: "string", enum: QUESTION_EDGE_TYPES } }, required: ["source", "target", "edge_type"] },
        note: { type: "string" },
      },
      required: ["text", "if_yes"],
    },
  },
  {
    name: "site_claims",
    description: "Present-tense relations (REPRESENTS) that pages of this site attested on earlier reads and that are still live in A(DAI), with edge ids. Call it on an UPDATE read (the <memory> block shows earlier reads), then re-check each against the page as it reads now.",
    input_schema: { type: "object", properties: { domain: { type: "string", description: "The site's domain, e.g. interfacegallery.io" } }, required: ["domain"] },
  },
  {
    name: "propose_ended",
    description: "A present-tense relation from site_claims that the site NO LONGER shows (an artist gone from the represented-artists page). The card asks the contributor to end it; accepted, the edge becomes historical — nothing is deleted. Evidence: the current page (the roster as it reads now). Never for shows or works: those stay true. Never because a page failed to load.",
    input_schema: {
      type: "object",
      properties: {
        edge_id: { type: "string", description: "From site_claims." },
        summary: { type: "string", description: "One line for the contributor, e.g. 'Ashley Zelinskie is no longer on the represented-artists page.'" },
        ...evidenceProps,
        note: { type: "string" },
      },
      required: ["edge_id", "summary", "page_url", "quote"],
    },
  },
  {
    name: "update_candidate",
    description: "Merge-patch an untouched proposed candidate (name, metadata, edge_type, resolves_to, note …). Contributor-touched cards are immutable. You cannot set state or question answers; propose a separate correction for review.",
    input_schema: { type: "object", properties: { cid: { type: "string" }, patch: { type: "object" } }, required: ["cid", "patch"] },
  },
  {
    name: "remove_candidate",
    description: "Remove a candidate you proposed, only if the contributor has not touched it and nothing references it.",
    input_schema: { type: "object", properties: { cid: { type: "string" } }, required: ["cid"] },
  },
  {
    name: "finish_pass",
    description: "End this pass with a plain-language summary for the contributor (or, in a chat pass, your reply). Call exactly once, last.",
    input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  },
];

const GRAPH_TOOLS = new Set(["search_nodes", "get_node", "get_neighbours", "get_component", "resolve_entity", "find_path", "image_neighbours", "site_claims"]);
const DRAFT_TOOLS = new Set(["set_subject", "note_survey", "propose_node", "propose_edge", "propose_image", "propose_patch", "note_known", "ask_contributor", "propose_ended", "update_candidate", "remove_candidate"]);

export interface ToolContext {
  draftId: string;
  policy: FetchPolicy;
  /** Earlier reads of this site, by URL — marks each fetched page changed / unchanged. */
  prior?: Map<string, PriorRead>;
  /** Reading passes (initial / continue) must leave the subject connected; chat passes are exempt. */
  checkSubject?: boolean;
  subjectChecked?: boolean;
  /** Text of every page read this pass, by URL — quotes are checked against it. */
  pageText?: Map<string, string>;
  /** Pages that could not be opened this pass, by URL (issue #75). */
  linkFailures?: Map<string, LinkFailure>;
  getDraft?: typeof getDraft;
  // Injected in tests.
  fetchPage?: typeof fetchPage;
  draftTool?: typeof draftTool;
  addPage?: typeof addPage;
  sleep?: (ms: number) => Promise<void>;
}

/** What the reader saw when it tried a page: an HTTP error, or no answer at all. */
export interface LinkFailure {
  url: string;
  status: number | null;
  reason: "http" | "dns" | "timeout" | "unreachable";
  checked_at: string;
}

// Worth one more try: the network, not the page (Scott's teh.kim read lost
// two fxhash works to a DNS lookup that failed from the worker).
const TRANSIENT = /ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION|ERR_TIMED_OUT|socket hang up|timeout/i;
export const RETRY_DELAY_MS = 2000;

function failureReason(msg: string): LinkFailure["reason"] {
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED/i.test(msg)) return "dns";
  if (/timeout|ETIMEDOUT|ERR_TIMED_OUT/i.test(msg)) return "timeout";
  return "unreachable";
}

/**
 * fetch_page with one retry for a transient failure (a network error, or a
 * 5xx answer), and a record of what still failed: an HTTP error page (4xx /
 * 5xx — refusals like 403/429 are thrown as FetchRefused and are not
 * "broken") or no answer. Policy refusals are never retried or recorded.
 */
async function fetchWithRetry(ctx: ToolContext, url: string, view: boolean): Promise<Awaited<ReturnType<typeof fetchPage>>> {
  const fetcher = ctx.fetchPage ?? fetchPage;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const record = (f: Omit<LinkFailure, "url" | "checked_at">) => {
    if (!ctx.linkFailures) ctx.linkFailures = new Map();
    ctx.linkFailures.set(normUrl(url), { url, ...f, checked_at: new Date().toISOString() });
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const p = await fetcher(url, ctx.policy, { view });
      if (p.status >= 500 && attempt === 0) {
        if (!sameSite(url, ctx.policy.rootUrl)) ctx.policy.offsiteFetched--; // the retry counts once
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      if (p.status >= 400) record({ status: p.status, reason: "http" });
      else ctx.linkFailures?.delete(normUrl(url));
      return p;
    } catch (e: any) {
      if (e instanceof FetchRefused) throw e;
      const msg = String(e?.message ?? e);
      if (attempt === 0 && TRANSIENT.test(msg)) { await sleep(RETRY_DELAY_MS); continue; }
      record({ status: null, reason: failureReason(msg) });
      throw e;
    }
  }
}

/** Artwork cards (not rejected) that no live edge touches — a work linked to nothing. */
export function orphanWorks(d: { candidates: any[] }): string[] {
  const live = (c: any) => c.state !== "rejected" && c.state !== "context_only";
  const linked = new Set<string>();
  for (const c of d.candidates) if (live(c) && c.kind === "edge") { linked.add(c.edge.source); linked.add(c.edge.target); }
  return d.candidates.filter((c) => live(c) && c.kind === "node" && c.node.type === "artwork" && !linked.has(`cid:${c.cid}`) && !(c.resolves_to && linked.has(c.resolves_to))).map((c) => c.node.name);
}

/**
 * How many live cards connect the draft's subject: edges (not rejected)
 * touching the subject, directly or through a node card that resolves to it,
 * and questions about it. 0 means the site's own subject would enter the
 * graph linked to nothing — the verse.works failure.
 */
export function subjectLinks(d: { subject_node_id: string | null; candidates: any[] }): number {
  const subject = d.subject_node_id;
  if (!subject) return 0;
  const refs = new Set<string>([subject]);
  for (const c of d.candidates) {
    if (c.kind !== "node") continue;
    if (c.resolves_to && refs.has(c.resolves_to)) refs.add(`cid:${c.cid}`);
    if (subject === `cid:${c.cid}` && c.resolves_to) refs.add(c.resolves_to);
  }
  const live = (c: any) => c.state !== "rejected" && c.state !== "context_only";
  let n = 0;
  for (const c of d.candidates) {
    if (!live(c)) continue;
    if (c.kind === "edge" && (refs.has(c.edge.source) || refs.has(c.edge.target))) n++;
    if (c.kind === "question" && (refs.has(c.question.if_yes.source) || refs.has(c.question.if_yes.target))) n++;
  }
  return n;
}

export interface ToolOutcome {
  /** Text, or text + a page screenshot (fetch_page view:true). */
  content: string | Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam>;
  is_error: boolean;
  finished?: string; // summary when finish_pass was called
}

const normUrl = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "");

export function rememberPage(ctx: ToolContext, p: { url: string; final_url: string; text: string }): void {
  if (!ctx.pageText) ctx.pageText = new Map();
  ctx.pageText.set(normUrl(p.final_url), p.text);
  ctx.pageText.set(normUrl(p.url), p.text);
}

export async function runTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  if (name === "finish_pass") {
    // Once per pass: a reading pass that leaves the site's subject linked to
    // nothing is sent back to connect it, or to say in the summary why not.
    if (ctx.checkSubject && !ctx.subjectChecked) {
      ctx.subjectChecked = true;
      const d = await (ctx.getDraft ?? getDraft)(ctx.draftId).catch(() => null);
      const problems: string[] = [];
      if (d && subjectLinks(d) === 0) {
        const why = d.subject_node_id
          ? `The subject ${d.subject_node_id} has no relation in this draft.`
          : "No subject was set (set_subject).";
        problems.push(`${why} The site's own subject must end up connected: the shows it presents (PRESENTED_BY the subject), the works shown on it (EXHIBITED_AT the subject), its roster. Propose those with quotes now; if the site truly evidences no relation to its subject, say so plainly at the top of the summary.`);
      }
      const orphans = d ? orphanWorks(d) : [];
      if (orphans.length) {
        problems.push(`${orphans.length} proposed work(s) are linked to nothing: ${orphans.slice(0, 12).join(", ")}${orphans.length > 12 ? " …" : ""}. Give each its CREATED_BY (and EXHIBITED_AT where the page says where it was shown) and its image, or remove_candidate the ones you cannot support.`);
      }
      if (problems.length) {
        return {
          content: JSON.stringify({ error: "draft_incomplete", message: `${problems.join("\n")}\nThen call finish_pass again; the second call stands.` }),
          is_error: true,
        };
      }
    }
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    return { content: JSON.stringify({ ok: true }), is_error: false, finished: summary || "(no summary)" };
  }
  if (name === "fetch_page") {
    const url = typeof input.url === "string" ? input.url : "";
    try {
      const p = await fetchWithRetry(ctx, url, input.view === true);
      // Same-site pages count against the page cap; off-site ones are
      // counted against their own cap inside fetchPage.
      if (sameSite(url, ctx.policy.rootUrl)) ctx.policy.pagesFetched++;
      await (ctx.addPage ?? addPage)(ctx.draftId, { url: p.url, final_url: p.final_url, title: p.title, status: p.status, chars: p.chars, sha256: p.sha256, via: p.via });
      rememberPage(ctx, p);
      const rendered = renderPage(p, ctx.prior?.get(p.final_url) ?? ctx.prior?.get(p.url));
      if (input.view === true) {
        if (!p.screenshot) return { content: `${rendered}\n(no screenshot: the page could only be read as text)`, is_error: false };
        return {
          content: [
            { type: "text", text: rendered },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.screenshot } },
          ],
          is_error: false,
        };
      }
      return { content: rendered, is_error: false };
    } catch (e: any) {
      const msg = e instanceof FetchRefused ? `refused (${e.code}): ${e.message}` : `fetch failed: ${e?.message ?? e}`;
      return { content: JSON.stringify({ error: msg }), is_error: true };
    }
  }
  if (GRAPH_TOOLS.has(name)) {
    const r = await graphTool(name, input);
    const isErr = !!(r && typeof r === "object" && "error" in (r as any) && Object.keys(r as any).length <= 2);
    return { content: JSON.stringify(r), is_error: isErr };
  }
  if (DRAFT_TOOLS.has(name)) {
    // Evidence is held to the page (worker/src/evidence.ts) when we read it this pass.
    if (typeof input.quote === "string" && typeof input.page_url === "string") {
      const text = ctx.pageText?.get(normUrl(input.page_url));
      const problem = text !== undefined ? checkQuote(text, input.quote, input.page_url) : null;
      if (problem) return { content: JSON.stringify({ error: "quote_not_on_page", message: problem, field: "quote" }), is_error: true };
    }
    // A card about a page that failed carries what the reader saw; only the
    // worker's own record counts, never the model's word for it.
    const { link_url, link_check: _ignored, ...rest } = input;
    const failed = typeof link_url === "string" ? ctx.linkFailures?.get(normUrl(link_url)) : undefined;
    const r = await (ctx.draftTool ?? draftTool)(ctx.draftId, name, failed ? { ...rest, link_check: failed } : rest);
    if (typeof link_url === "string" && !failed && r.ok) {
      return { content: JSON.stringify({ ...(r.result as object), note: `link_url ${link_url} did not fail this pass, so the card starts as proposed` }), is_error: false };
    }
    return { content: JSON.stringify(r.result), is_error: !r.ok };
  }
  return { content: JSON.stringify({ error: `unknown tool ${name}` }), is_error: true };
}
