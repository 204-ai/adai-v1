// Read-only graph tools the intake worker may call through
// POST /internal/intake/tool (docs/URL-INTAKE-SPEC.md §6.3).
//
// This allowlist IS trust promise 1. Nothing here reaches materialise*,
// insertSignal or R2 — tests/intake-imports.test.ts asserts that at the
// import level. The four archivist tools are imported, not copied.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SERVER_HANDLERS, type ServerHandler, type ToolDef } from "../archivist/tools.js";
import { NODE_NOT_RETIRED } from "../utils/visibility.js";
import { slugify, legacySlugify } from "../utils/slug.js";
import { embedOnce, TASK_PREFIX } from "../embed/server.js";
import { l2normalise } from "../embed/vectors.js";
import { topKByVector, withMetadata } from "../embed/neighbours.js";
import { safeFetch, sniffImageMime, SsrfError } from "../utils/ssrf.js";
import { PRESENT_TENSE_EDGE_TYPES } from "./candidate.js";
import { embedKey } from "../embed/provider.js";

type AsyncHandler = (db: DatabaseSync, input: Record<string, unknown>) => Promise<unknown> | unknown;

function asString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ---- resolve_entity ----------------------------------------------------------

export function normaliseWebUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.search = "";
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "").replace(/\/index\.html?$/i, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

interface ResolveHit {
  id: string;
  name: string;
  type: string;
  slug: string;
  resolution: "exact" | "alias" | "fuzzy";
  similarity?: number;
  summary?: string;
}

const NODE_COLS = "id, name, type, slug, metadata";

function project(row: any, resolution: ResolveHit["resolution"], similarity?: number): ResolveHit {
  let summary: string | undefined;
  try {
    const md = row.metadata ? JSON.parse(row.metadata) : {};
    const s = md.summary || md.description || md.bio;
    if (typeof s === "string") summary = s.slice(0, 200);
  } catch { /* ignore */ }
  const hit: ResolveHit = { id: row.id, name: row.name, type: row.type, slug: row.slug, resolution };
  if (similarity !== undefined) hit.similarity = Math.round(similarity * 1000) / 1000;
  if (summary) hit.summary = summary;
  return hit;
}

export async function resolve_entity(db: DatabaseSync, input: Record<string, unknown>): Promise<unknown> {
  const name = asString(input.name);
  const type = asString(input.type);
  const hints = (input.hints && typeof input.hints === "object" ? input.hints : {}) as Record<string, unknown>;
  if (!name) return { error: "name is required" };

  const hits: ResolveHit[] = [];
  const seen = new Set<string>();
  const push = (h: ResolveHit) => { if (!seen.has(h.id)) { seen.add(h.id); hits.push(h); } };

  // 1. exact name (NOCASE), optionally by type
  const exactRows = (type
    ? db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE name = ? COLLATE NOCASE AND type = ? AND ${NODE_NOT_RETIRED} LIMIT 5`).all(name, type)
    : db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE name = ? COLLATE NOCASE AND ${NODE_NOT_RETIRED} LIMIT 5`).all(name)) as any[];
  for (const r of exactRows) push(project(r, "exact"));

  // 1b. deterministic id — what a create would collide with
  // (also under the pre-October-2026 slug rules, which kept accents and #)
  const slug = slugify(name);
  const legacy = legacySlugify(name);
  const idRows = (type
    ? db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE (id IN (?, ?) OR slug IN (?, ?)) AND ${NODE_NOT_RETIRED} LIMIT 3`).all(`${type}:${slug}`, `${type}:${legacy}`, slug, legacy)
    : db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE slug IN (?, ?) AND ${NODE_NOT_RETIRED} LIMIT 3`).all(slug, legacy)) as any[];
  for (const r of idRows) push(project(r, "exact"));

  // 2. web alias
  const url = asString(hints.url);
  if (url) {
    const norm = normaliseWebUrl(url);
    if (norm) {
      const rows = db
        .prepare(`SELECT ${NODE_COLS} FROM nodes WHERE id IN (SELECT node_id FROM node_aliases WHERE source = 'web' AND external_id = ?) AND ${NODE_NOT_RETIRED}`)
        .all(norm) as any[];
      for (const r of rows) push(project(r, "alias"));
    }
  }

  // 3. slug LIKE
  if (hits.length < 5) {
    const like = `%${slug}%`;
    const rows = (type
      ? db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE slug LIKE ? AND type = ? AND ${NODE_NOT_RETIRED} ORDER BY length(name) LIMIT 5`).all(like, type)
      : db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE slug LIKE ? AND ${NODE_NOT_RETIRED} ORDER BY length(name) LIMIT 5`).all(like)) as any[];
    for (const r of rows) push(project(r, "fuzzy"));
  }

  // 4. embedding top-5 (identity vectors), when a key is configured
  let embedding_note: string | undefined;
  if (hits.length < 5 && embedKey()) {
    try {
      const parts = [name];
      if (type) parts.unshift(type === "practitioner" ? "Practitioner:" : type === "artwork" ? "Artwork:" : `${type}:`);
      if (typeof hints.year === "string" || typeof hints.year === "number") parts.push(String(hints.year));
      if (typeof hints.country === "string") parts.push(hints.country);
      const vec = l2normalise(await embedOnce(TASK_PREFIX + parts.join(" "), null));
      const nbs = withMetadata(db, topKByVector(db, vec, { k: 5, typePrefixes: type ? [`${type}:`] : undefined, minSimilarity: 0.6 }));
      for (const n of nbs) {
        const row = db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE id = ? AND ${NODE_NOT_RETIRED}`).get(n.node_id) as any;
        if (row) push(project(row, "fuzzy", n.similarity));
      }
    } catch (e: any) {
      embedding_note = `embedding lookup skipped: ${e?.message ?? e}`;
    }
  }

  return {
    query: { name, type: type ?? null, would_create: `${type ?? "<type>"}:${slug}` },
    matches: hits.slice(0, 8),
    ...(embedding_note ? { note: embedding_note } : {}),
  };
}

// ---- find_path --------------------------------------------------------------------

export function find_path(db: DatabaseSync, input: Record<string, unknown>): unknown {
  const from = asString(input.from);
  const to = asString(input.to);
  const maxDepth = clampInt(input.max_depth, 4, 1, 6);
  if (!from || !to) return { error: "from and to are required (node ids)" };
  if (from === to) return { path: [from], edges: [] };

  const rows = db.prepare("SELECT source_id, target_id, edge_type FROM edges WHERE valid_until IS NULL").all() as any[];
  const adj = new Map<string, Array<{ other: string; edge_type: string; dir: "out" | "in" }>>();
  for (const e of rows) {
    if (!adj.has(e.source_id)) adj.set(e.source_id, []);
    if (!adj.has(e.target_id)) adj.set(e.target_id, []);
    adj.get(e.source_id)!.push({ other: e.target_id, edge_type: e.edge_type, dir: "out" });
    adj.get(e.target_id)!.push({ other: e.source_id, edge_type: e.edge_type, dir: "in" });
  }
  const prev = new Map<string, { from: string; edge_type: string; dir: "out" | "in" }>();
  const depth = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    if (cur === to) break;
    if (d >= maxDepth) continue;
    for (const n of adj.get(cur) ?? []) {
      if (depth.has(n.other)) continue;
      depth.set(n.other, d + 1);
      prev.set(n.other, { from: cur, edge_type: n.edge_type, dir: n.dir });
      queue.push(n.other);
    }
  }
  if (!depth.has(to)) return { path: null, note: `no path within ${maxDepth} hops` };
  const path: string[] = [to];
  const edges: Array<{ from: string; to: string; edge_type: string }> = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur)!;
    edges.unshift(p.dir === "out" ? { from: p.from, to: cur, edge_type: p.edge_type } : { from: cur, to: p.from, edge_type: p.edge_type });
    cur = p.from;
    path.unshift(cur);
  }
  const names = new Map<string, string>();
  const ph = path.map(() => "?").join(",");
  for (const r of db.prepare(`SELECT id, name FROM nodes WHERE id IN (${ph})`).all(...path) as any[]) names.set(r.id, r.name);
  return { path: path.map((id) => ({ id, name: names.get(id) ?? null })), edges, hops: edges.length };
}

// ---- image_neighbours ---------------------------------------------------------------

export async function image_neighbours(db: DatabaseSync, input: Record<string, unknown>): Promise<unknown> {
  const url = asString(input.image_url);
  const k = clampInt(input.k, 5, 1, 10);
  if (!url) return { error: "image_url is required" };
  if (!embedKey()) return { error: "embedding unavailable (embedding key unset or staging switch off)" };
  let bytes: Buffer;
  try {
    const r = await safeFetch(url, { maxBytes: 10 * 1024 * 1024, timeoutMs: 15_000, headers: { accept: "image/*" } });
    if (r.status < 200 || r.status >= 300) return { error: `image fetch returned ${r.status}` };
    bytes = r.bytes;
  } catch (e: any) {
    return { error: e instanceof SsrfError ? `image fetch refused: ${e.message}` : `image fetch failed: ${e?.message ?? e}` };
  }
  const mime = sniffImageMime(bytes);
  if (!mime) return { error: "not an image" };
  let vec: Float32Array;
  try {
    vec = l2normalise(await embedOnce(TASK_PREFIX + "Artwork", { bytes, mime }));
  } catch (e: any) {
    return { error: `embedding failed: ${e?.message ?? e}` };
  }
  const nbs = withMetadata(db, topKByVector(db, vec, { k, typePrefixes: ["artwork:"] }));
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    neighbours: nbs.map((n) => ({ id: n.node_id, name: n.name, slug: n.slug, similarity: Math.round(n.similarity * 1000) / 1000, ...(n.year ? { year: n.year } : {}) })),
    note: "similarity ≥ 0.84 is the VISUALLY_AFFINE threshold; ≥ 0.95 usually means the same image",
  };
}

// ---- site_claims ---------------------------------------------------------------------

/**
 * Present-tense relations (REPRESENTS …) that pages of one site attested
 * and that are still live — what a later read must re-check. A relation the
 * site no longer shows becomes an `ended` card (propose_ended), never an
 * automatic change. Events (shows, works) are not listed: they stay true.
 */
export function site_claims(db: DatabaseSync, input: Record<string, unknown>): unknown {
  const raw = asString(input.domain);
  if (!raw) return { error: "domain is required (e.g. interfacegallery.io)" };
  const bare = raw.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9.-]+$/.test(bare)) return { error: "domain must be a host name" };
  const pats: string[] = [];
  for (const scheme of ["http", "https"]) for (const host of [bare, `www.${bare}`]) pats.push(`${scheme}://${host}/%`, `${scheme}://${host}`);
  const types = PRESENT_TENSE_EDGE_TYPES as readonly string[];
  const rows = db
    .prepare(
      `SELECT e.id, e.edge_type, e.source_id, e.target_id, e.event_time, s.source_url, s.created_at AS attested_at,
              n1.name AS source_name, n2.name AS target_name
         FROM edges e
         JOIN signals s ON s.id = e.signal_id
         LEFT JOIN nodes n1 ON n1.id = e.source_id
         LEFT JOIN nodes n2 ON n2.id = e.target_id
        WHERE e.valid_until IS NULL
          AND e.edge_type IN (${types.map(() => "?").join(",")})
          AND (${pats.map(() => "s.source_url LIKE ?").join(" OR ")})
        ORDER BY s.created_at DESC
        LIMIT 300`
    )
    .all(...types, ...pats) as any[];
  return {
    domain: bare,
    claims: rows.map((r) => ({
      edge_id: r.id,
      edge_type: r.edge_type,
      source: { id: r.source_id, name: r.source_name },
      target: { id: r.target_id, name: r.target_name },
      page_url: r.source_url,
      attested_at: r.attested_at,
    })),
    note: "Live present-tense relations this site attested. Re-check each against the page as it reads now; if the site no longer shows it, propose_ended with the current page as evidence.",
  };
}

// ---- registry -------------------------------------------------------------------------

const ARCHIVIST_READ_TOOLS = ["search_nodes", "get_node", "get_neighbours", "get_component"] as const;

export const INTAKE_TOOL_HANDLERS: Record<string, AsyncHandler> = {
  ...Object.fromEntries(ARCHIVIST_READ_TOOLS.map((n) => [n, SERVER_HANDLERS[n] as ServerHandler])),
  resolve_entity,
  find_path,
  image_neighbours,
  site_claims,
};

export function isIntakeTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTAKE_TOOL_HANDLERS, name);
}

export async function runIntakeTool(db: DatabaseSync, name: string, input: unknown): Promise<unknown> {
  const h = INTAKE_TOOL_HANDLERS[name];
  if (!h) return { error: "unknown_tool", name };
  return h(db, (input && typeof input === "object" ? input : {}) as Record<string, unknown>);
}

/** Tool schemas for the three intake-only tools (the worker owns the prompt; this keeps schemas next to handlers). */
export const INTAKE_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "resolve_entity",
    description:
      "The dedup gate. Before proposing ANY named entity (person, work, show, venue, collective, concept), resolve it against A(DAI). Returns exact / alias / fuzzy matches with the node ids to link, plus `would_create`, the id a new node would get. Prefer linking to an existing node; when two matches are plausible, ask_contributor instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Entity name as written on the page." },
        type: { type: "string", description: "practitioner | artwork | project | institution | collective | concept | platform" },
        hints: {
          type: "object",
          description: "Optional disambiguation: {year, url, country}. `url` is matched against web aliases of existing nodes.",
          properties: { year: { type: "string" }, url: { type: "string" }, country: { type: "string" } },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "find_path",
    description: "Shortest path between two existing nodes over live edges (max 4 hops by default). Use it to see how the subject already connects to someone or something the page mentions.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Node id." },
        to: { type: "string", description: "Node id." },
        max_depth: { type: "integer", minimum: 1, maximum: 6 },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "image_neighbours",
    description: "Visually nearest artworks in A(DAI) for an image URL from the page (multimodal embedding, nothing persisted). Use it on up to 10 proposed images to find works A(DAI) may already hold. Close matches become `known` or a fuzzy `node` candidate — never an edge.",
    input_schema: {
      type: "object",
      properties: {
        image_url: { type: "string" },
        k: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["image_url"],
    },
  },
];
