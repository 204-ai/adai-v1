// Single-node multimodal embedding for the runtime path.
//
// embed_nodes.py runs offline against seed/nodes.json — fine for bulk
// pipelines that bake into seed.db at Docker build time, but it doesn't
// help nodes that arrive via the contributor API (`POST /api/v1/nodes`,
// `POST /api/v1/images`, etc.) in the live Fly DB. This module fills that
// gap by embedding a single node on demand, then writing the f32 LE blob
// into `node_embeddings`.
//
// Per-type strategy matches the Python pipeline (see embed_nodes.py § 3):
//   artwork                    → text + image (if any), fused into one vector
//   practitioner | collective  → text only (no portraits — the visual
//                                 signal lives in the downstream
//                                 style_centroid, not on the practitioner)
//   concept | scene            → text only
//   everything else            → skipped (institution, publication, etc.)
//
// Idempotency: matches the Python pipeline's (text_hash, image_hash) key.
// If the existing row matches both, we skip the API call.
//
// Failure mode: any error (Gemini timeout, image fetch fail, missing
// API key) returns `{ status: 'error', detail }`. Callers in the API
// endpoints use the fire-and-forget variant — the user's response isn't
// delayed by a transient embedding failure, and the daily backfill
// catches anything that slips through.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { encodeBlob, l2normalise, DIMS, invalidateVectorCache } from "./vectors.js";
import { isStaging } from "../utils/staging.js";
import { embedBaseUrl, embedImageMimes, embedKey, embedKeyVar, embedModel, embedProvider } from "./provider.js";
export const TASK_PREFIX = "task: sentence similarity | query: ";

// Raw bytes; base64 grows them by 4/3, so 14 MB stays under a 20 MB cap.
const EMBED_IMAGE_MAX_BYTES = 14 * 1024 * 1024;

const EMBEDDABLE_TYPES = new Set([
  "artwork",
  "practitioner",
  "collective",
  "concept",
  "scene",
]);

// Only artworks fuse an image into the identity vector. Practitioner
// portraits are intentionally NOT used — see embed_nodes.py § 3.1.
const TYPES_WITH_IMAGE = new Set(["artwork"]);

export type EmbedStatus = "embedded" | "skipped_unchanged" | "skipped_unembeddable" | "error";

export interface EmbedResult {
  status: EmbedStatus;
  detail?: string;
  has_image?: boolean;
  text_hash?: string | null;
  image_hash?: string | null;
}

// Lazy-loaded Gemini client. The SDK is imported dynamically so a server
// that's never been called for an embedding (e.g. local dev without
// GEMINI_API_KEY) doesn't fail at startup.
let cachedClient: any = null;

async function getClient(): Promise<any> {
  if (cachedClient) return cachedClient;
  const apiKey = embedKey();
  if (!apiKey) {
    throw new Error(
      `${embedKeyVar()} missing — set as a Fly secret on production, in .env locally`
    );
  }
  const { GoogleGenAI } = await import("@google/genai");
  cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

// ----- text construction (mirrors embed_nodes.py build_text) ------------

function coerceStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(coerceStr).filter(Boolean).join(" ");
  if (typeof v === "object") {
    return Object.values(v as Record<string, unknown>)
      .map(coerceStr)
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function parseMetadata(raw: unknown): Record<string, any> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  return {};
}

/**
 * Build the embeddable text for a node. Exported for tests; the runtime
 * path uses it indirectly via embedNodeNow. Mirrors embed_nodes.py's
 * build_text, with the same per-type strategy and the same TASK_PREFIX
 * so text hashes stay stable across runs.
 */
export function buildText(node: { type: string; name: string; metadata: unknown }): string | null {
  const md = parseMetadata(node.metadata);
  const fp = md.full_profile;
  const name = node.name || "";
  let parts: string[] = [];

  if (node.type === "artwork") {
    if (fp) {
      const bi = fp.basic_info || {};
      const pd = fp.practice_description;
      const year = coerceStr(bi.active_years);
      const location = coerceStr(bi.location);
      let summary = "";
      let methodology = "";
      let medium = "";
      if (pd && typeof pd === "object" && !Array.isArray(pd)) {
        summary = coerceStr(pd.practice_summary);
        methodology = coerceStr(pd.methodology);
        medium = coerceStr(pd.medium);
      } else if (typeof pd === "string") {
        summary = pd;
      }
      const head = year ? `${name} (${year})` : name;
      parts = [head, medium, summary, methodology, location];
    } else {
      const year = coerceStr(md.year_start || md.year_raw || md.active_years);
      const desc = coerceStr(md.description);
      const relevance = coerceStr(md.relevance);
      const medium = coerceStr(md.medium || md.work_type);
      const head = year ? `${name} (${year})` : name;
      parts = [head, medium, desc, relevance];
    }
  } else if (node.type === "practitioner" || node.type === "collective") {
    if (fp) {
      const pd = fp.practice_description;
      let summary = "";
      let methodology = "";
      let medium = "";
      if (pd && typeof pd === "object" && !Array.isArray(pd)) {
        summary = coerceStr(pd.practice_summary);
        methodology = coerceStr(pd.methodology);
        medium = coerceStr(pd.medium);
      } else if (typeof pd === "string") {
        summary = pd;
      }
      const sensory = coerceStr(fp.sensory_register || {});
      parts = [name, medium, summary, methodology, sensory];
    } else {
      const occupations = coerceStr(md.occupations);
      const nationalities = coerceStr(md.nationalities);
      const desc = coerceStr(md.description || md.practice_summary || md.commons_summary);
      const methodology = coerceStr(md.methodology);
      const medium = coerceStr(md.medium);
      parts = [name, occupations, nationalities, medium, desc, methodology];
    }
  } else if (node.type === "concept") {
    const desc = coerceStr(md.description || md.summary);
    const kind = coerceStr(md.concept_kind);
    parts = [`Concept: ${name}`, kind, desc];
  } else if (node.type === "scene") {
    const desc = coerceStr(md.description || md.grounding_note);
    parts = [`Scene: ${name}`, desc];
  } else {
    return null;
  }

  const cleaned = parts.map((p) => p.trim()).filter(Boolean).join(" ");
  if (!cleaned) return null;
  return TASK_PREFIX + cleaned;
}

function pickImageUrl(md: Record<string, any>): string | null {
  // Prefer the R2 mirror — fast, immutable, won't 429. Fall back to upstream.
  const candidates = [md.cdn_image_url, md.image_url, md.image];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
  }
  return null;
}

async function fetchImage(url: string): Promise<{ bytes: Buffer; mime: string; sha256: string } | null> {
  // Single-attempt fetch with a 10 s cap — for the runtime path, retries
  // belong in the daily backfill, not in a user-facing request hot loop.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const bytes = Buffer.from(ab);
    if (!bytes.length) return null;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    return { bytes, mime, sha256 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ----- Gemini call -------------------------------------------------------

interface GeminiPart {
  text?: string;
  inlineData?: { data: string; mimeType: string };
}

/**
 * One Gemini embedding call. Exported for the URL-intake tools
 * (resolve_entity text queries, image_neighbours) — callers must
 * l2normalise the result before comparing against node_embeddings.
 */
export async function embedOnce(text: string, image: { bytes: Buffer; mime: string } | null): Promise<Float32Array> {
  if (embedProvider() === "openai") return embedOnceOpenAI(text, image);
  return embedOnceGemini(text, image);
}

/**
 * OpenAI-compatible /embeddings (DeepInfra, vLLM, …). Text and image go as
 * the content parts of ONE input item, which the model fuses into one
 * vector — the same shape as the Gemini call. No `task` field: the text
 * already carries its EmbeddingGemma task prefix (TASK_PREFIX), and the
 * endpoint adds none of its own when `task` is absent.
 */
async function embedOnceOpenAI(text: string, image: { bytes: Buffer; mime: string } | null): Promise<Float32Array> {
  const apiKey = embedKey();
  if (!apiKey) throw new Error(`${embedKeyVar()} missing — set as a Fly secret on production, in .env locally`);
  const parts: Array<Record<string, unknown>> = [];
  if (text) parts.push({ type: "text", text });
  if (image) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mime};base64,${image.bytes.toString("base64")}` },
    });
  }
  if (!parts.length) throw new Error("nothing to embed");
  const input = parts.length === 1 && !image ? text : parts;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  let res: Response;
  try {
    res = await fetch(`${embedBaseUrl()}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: embedModel(), input: [input], dimensions: DIMS, encoding_format: "float" }),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`embeddings endpoint returned ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const values = json?.data?.[0]?.embedding;
  if (!Array.isArray(values) || values.length !== DIMS) {
    throw new Error(`embedding wrong shape: got ${Array.isArray(values) ? values.length : "null"}`);
  }
  return new Float32Array(values);
}

async function embedOnceGemini(text: string, image: { bytes: Buffer; mime: string } | null): Promise<Float32Array> {
  const client = await getClient();
  const contents: GeminiPart[] = [{ text }];
  if (image) {
    contents.push({
      inlineData: { data: image.bytes.toString("base64"), mimeType: image.mime },
    });
  }
  const res = await client.models.embedContent({
    model: embedModel(),
    contents,
    config: { outputDimensionality: DIMS },
  });
  // SDK returns either {embeddings: [{values: [...]}]} or {embedding: {values: [...]}}
  // depending on version — be permissive.
  const values =
    res?.embeddings?.[0]?.values ??
    res?.embedding?.values ??
    null;
  if (!values || values.length !== DIMS) {
    throw new Error(`embedding wrong shape: got ${values ? values.length : "null"}`);
  }
  return new Float32Array(values);
}

// ----- main entrypoint ---------------------------------------------------

export async function embedNodeNow(db: DatabaseSync, nodeId: string): Promise<EmbedResult> {
  const node = db
    .prepare("SELECT id, type, name, metadata FROM nodes WHERE id = ?")
    .get(nodeId) as { id: string; type: string; name: string; metadata: string } | undefined;

  if (!node) return { status: "error", detail: "node not found" };
  if (!EMBEDDABLE_TYPES.has(node.type)) {
    return { status: "skipped_unembeddable", detail: `type=${node.type} not embedded` };
  }

  const text = buildText(node);
  const md = parseMetadata(node.metadata);

  let image: { bytes: Buffer; mime: string; sha256: string } | null = null;
  if (TYPES_WITH_IMAGE.has(node.type)) {
    const url = pickImageUrl(md);
    if (url) image = await fetchImage(url);
    // A format the provider can't read (AVIF, SVG, …) would fail the whole
    // call: embed the text alone instead, as the Gemini-era rows did.
    // Likewise an image over the provider's size cap (DeepInfra: 20 MB per
    // input, base64-encoded — hit by a few huge animated GIFs).
    if (image && (!embedImageMimes().has(image.mime) || image.bytes.length > EMBED_IMAGE_MAX_BYTES)) image = null;
  }

  if (!text && !image) {
    return { status: "skipped_unembeddable", detail: "no text and no image" };
  }

  const textHash = text ? crypto.createHash("sha256").update(text).digest("hex") : "";
  const imageHash = image ? image.sha256 : null;

  // Idempotency: same (text_hash, image_hash) as existing row → skip.
  const existing = db
    .prepare("SELECT model, text_hash, image_hash FROM node_embeddings WHERE node_id = ? AND kind = 'identity'")
    .get(nodeId) as { model: string; text_hash: string | null; image_hash: string | null } | undefined;
  // A row from another model is never "unchanged": its vector lives in a
  // different space, so a model switch re-embeds every node.
  if (
    existing &&
    existing.model === embedModel() &&
    existing.text_hash === textHash &&
    (existing.image_hash ?? null) === imageHash
  ) {
    return {
      status: "skipped_unchanged",
      has_image: !!image,
      text_hash: textHash,
      image_hash: imageHash,
    };
  }

  let rawVec: Float32Array;
  try {
    rawVec = await embedOnce(text || "", image);
  } catch (e: any) {
    return { status: "error", detail: e?.message ?? String(e) };
  }
  const normed = l2normalise(rawVec);

  db.prepare(
    `INSERT INTO node_embeddings (node_id, kind, model, dims, vector, has_image, image_hash, text_hash, created_at)
     VALUES (?, 'identity', ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(node_id, kind) DO UPDATE SET
       model = excluded.model,
       dims = excluded.dims,
       vector = excluded.vector,
       has_image = excluded.has_image,
       image_hash = excluded.image_hash,
       text_hash = excluded.text_hash,
       created_at = excluded.created_at`
  ).run(
    nodeId,
    embedModel(),
    DIMS,
    encodeBlob(normed),
    image ? 1 : 0,
    imageHash,
    textHash || null
  );
  invalidateVectorCache(); // new/updated vector must be visible to neighbours now

  return {
    status: "embedded",
    has_image: !!image,
    text_hash: textHash,
    image_hash: imageHash,
  };
}

// Fire-and-forget wrapper for the contributor-API hot path. We log errors
// but never throw into the request handler — the daily backfill catches
// anything that fails here.
export function embedNodeAsync(db: DatabaseSync, nodeId: string): void {
  if (isStaging() && !embedKey()) return; // embeddings switched off on staging
  embedNodeNow(db, nodeId)
    .then((r) => {
      if (r.status === "error") {
        console.error(`[embed] ${nodeId}: ${r.detail}`);
      }
    })
    .catch((err) => {
      console.error(`[embed] ${nodeId} threw:`, err);
    });
}

// The same contract for many nodes at once (an approved package): one
// provider call at a time instead of a burst of hundreds, so a big approval
// does not trip the provider's rate limit. Still fire-and-forget.
export function embedNodesAsync(db: DatabaseSync, nodeIds: Iterable<string>): void {
  const ids = [...new Set(nodeIds)];
  if (ids.length <= 1) { for (const id of ids) embedNodeAsync(db, id); return; }
  if (isStaging() && !embedKey()) return;
  void (async () => {
    for (const nodeId of ids) {
      try {
        const r = await embedNodeNow(db, nodeId);
        if (r.status === "error") console.error(`[embed] ${nodeId}: ${r.detail}`);
      } catch (err) {
        console.error(`[embed] ${nodeId} threw:`, err);
      }
    }
  })();
}
