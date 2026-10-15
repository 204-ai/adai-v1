// The archivist's links, checked against the graph (issue #62). The model
// writes `[Name](/type/slug)` from memory as often as from its tool results:
// it invents domains (https://adai.is/…) and derives slugs from names
// (`ben-f-laposky` for the node slugged `ben-laposky`). At the end of a turn
// every link in the reply is resolved against the DB and the client gets a
// correction map `{ href → path | null }` (null = no such node: show the
// label without a link, never a dead one).

import type { DatabaseSync } from "node:sqlite";
import { slugify, legacySlugify } from "../utils/slug.js";

export interface SeenNode { type: string; name: string; slug: string }

/** Hosts that are this site — a link to one of them is a site path. */
export function ownHosts(): Set<string> {
  const hosts = new Set(["adai.is", "www.adai.is", "digitalartsinstitute.io", "www.digitalartsinstitute.io", "adai-basel.fly.dev", "adai-staging.fly.dev"]);
  try {
    if (process.env.ADAI_BASE_URL) hosts.add(new URL(process.env.ADAI_BASE_URL).host);
  } catch { /* not a URL */ }
  return hosts;
}

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const NODE_PATH = /^\/([a-z_]+)\/([^/?#]+)\/?$/;

/** Walk a tool result for node-shaped objects ({type, name, slug}). */
export function collectNodes(value: unknown, out: SeenNode[], depth = 0): void {
  if (!value || typeof value !== "object" || depth > 6) return;
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out, depth + 1);
    return;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.slug === "string" && typeof o.name === "string" && typeof o.type === "string") {
    out.push({ type: o.type, name: o.name, slug: o.slug });
  }
  for (const v of Object.values(o)) if (v && typeof v === "object") collectNodes(v, out, depth + 1);
}

const words = (s: string): string[] => slugify(s).split("-").filter(Boolean);

/** Every word of the shorter name appears in the longer ("Ben Laposky" ⊂ "Ben F. Laposky"). */
function namesAgree(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)].sort((p, q) => p.length - q.length);
  if (x.length < 2 && x.join("") !== y.join("")) return false;
  const set = new Set(y);
  return x.every((w) => set.has(w));
}

export function resolveLinks(db: DatabaseSync, text: string, seen: SeenNode[]): Record<string, string | null> {
  const hosts = ownHosts();
  const bySlug = db.prepare("SELECT type, slug FROM nodes WHERE slug = ?");
  const byName = db.prepare("SELECT type, slug FROM nodes WHERE name = ? COLLATE NOCASE ORDER BY (type = ?) DESC LIMIT 1");
  const out: Record<string, string | null> = {};
  for (const m of text.matchAll(LINK)) {
    const [, label, href] = m;
    if (href in out) continue;
    let path = href;
    if (/^https?:\/\//i.test(href)) {
      let u: URL;
      try { u = new URL(href); } catch { continue; }
      if (!hosts.has(u.host.toLowerCase())) continue; // someone else's page — the client shows the label
      path = u.pathname;
    }
    const pm = NODE_PATH.exec(path);
    if (!pm) {
      if (path !== href) out[href] = path; // e.g. https://adai.is/whitepaper → /whitepaper
      continue;
    }
    const type = pm[1];
    let slug: string;
    try { slug = decodeURIComponent(pm[2]); } catch { slug = pm[2]; }
    const nodePath = (n: { type: string; slug: string }) => `/${n.type}/${encodeURIComponent(n.slug)}`;

    const exact = bySlug.get(slug) as { type: string; slug: string } | undefined;
    if (exact) {
      const p = nodePath(exact);
      if (p !== href) out[href] = p;
      continue;
    }
    // The model derived the slug: look for the node it was talking about —
    // first among what its tools returned this turn, then by name.
    const fromTools =
      seen.find((n) => n.type === type && (slugify(n.name) === slugify(label) || slugify(n.name) === slug)) ??
      seen.find((n) => n.type === type && (namesAgree(n.name, label) || namesAgree(n.slug.replace(/-/g, " "), slug.replace(/-/g, " "))));
    if (fromTools) { out[href] = nodePath(fromTools); continue; }
    const named = (byName.get(label.replace(/\*+/g, "").trim(), type) as { type: string; slug: string } | undefined)
      ?? (bySlug.get(slugify(label)) as { type: string; slug: string } | undefined)
      ?? (bySlug.get(legacySlugify(label)) as { type: string; slug: string } | undefined);
    out[href] = named ? nodePath(named) : null;
  }
  return out;
}
