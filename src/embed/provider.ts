// Which embedding model the commons uses, and how to reach it.
//
// Two providers, chosen by EMBED_PROVIDER:
//
//   gemini (default)  Google's hosted Gemini Embedding 2 through @google/genai.
//                     Key: GEMINI_API_KEY. Model: EMBED_MODEL, default
//                     "gemini-embedding-2".
//   openai            Any OpenAI-compatible /embeddings endpoint serving an
//                     open model we can own: DeepInfra today, vLLM / Ollama /
//                     our own box later. Key: EMBED_API_KEY. Base URL:
//                     EMBED_BASE_URL, default DeepInfra. Model: EMBED_MODEL,
//                     default "google/embeddinggemma-2".
//
// The model name is also the tag written to node_embeddings.model, and every
// reader (loadAll, the backfill, the idempotency check) only takes rows of
// the current tag: vectors of two models live in different spaces and must
// never be compared. Switching model = set the env, run `embed:backfill`
// (it re-embeds every row of another tag), then `embed:derive`.
//
// The staging switch is still called `gemini` (STAGING_SWITCHES gemini=on):
// it governs every outbound embedding call, whichever provider serves it.

import { switchOn } from "../utils/staging.js";

export type EmbedProvider = "gemini" | "openai";

export const DEFAULT_OPENAI_BASE_URL = "https://api.deepinfra.com/v1/openai";

export function embedProvider(): EmbedProvider {
  const p = (process.env.EMBED_PROVIDER || "gemini").trim().toLowerCase();
  if (p === "gemini" || p === "openai") return p;
  throw new Error(`EMBED_PROVIDER must be "gemini" or "openai", got "${p}"`);
}

/** The model name sent to the provider, and the node_embeddings.model tag. */
export function embedModel(): string {
  const m = process.env.EMBED_MODEL?.trim();
  if (m) return m;
  return embedProvider() === "openai" ? "google/embeddinggemma-2" : "gemini-embedding-2";
}

export function embedBaseUrl(): string {
  return (process.env.EMBED_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
}

/**
 * The provider's API key, or null when there is none — or when staging has
 * embeddings switched off. Callers treat null as "embedding unavailable".
 */
export function embedKey(): string | null {
  if (!switchOn("gemini")) return null;
  const key = embedProvider() === "openai" ? process.env.EMBED_API_KEY : process.env.GEMINI_API_KEY;
  return key || null;
}

/**
 * Image formats the provider embeds. Anything else is left out of the node's
 * vector (text only) rather than failing it. Gemini Embedding 2 documents PNG
 * and JPEG; DeepInfra's EmbeddingGemma 2 also takes WebP and GIF, but rejects
 * AVIF (tried October 2026).
 */
export function embedImageMimes(): ReadonlySet<string> {
  return embedProvider() === "openai"
    ? new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
    : new Set(["image/jpeg", "image/png"]);
}

/** Name of the env var holding the key, for error messages. */
export function embedKeyVar(): string {
  return embedProvider() === "openai" ? "EMBED_API_KEY" : "GEMINI_API_KEY";
}
