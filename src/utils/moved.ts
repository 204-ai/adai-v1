// Addresses that moved (issues #67, #69): a node's old slug keeps working.
//
// Two ways a page moves, both answered with a 301 by the page router:
//   - its slug was rewritten (migrate-slugs): the old one is kept as
//     node_aliases(source='slug', external_id='<type>/<old slug>');
//   - it was merged into another node (merge-nodes): the retired duplicate
//     carries metadata.merged_into, and its address leads to the kept node.
//
// node_aliases is a CRR whose PK (source, external_id) makes an old address
// point at one node only. Slugs repeat across types, hence the type prefix.

import type { DatabaseSync } from "node:sqlite";

export interface MovedTo {
  id: string;
  type: string;
  slug: string;
}

const MAX_HOPS = 5;

function mergedInto(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata);
    return m && m.retired === true && typeof m.merged_into === "string" ? m.merged_into : null;
  } catch {
    return null;
  }
}

/** Where a merged node's address leads now: the node it was merged into, followed through later merges. */
function follow(db: DatabaseSync, start: { id: string; type: string; slug: string; metadata: string | null }): MovedTo | null {
  let n = start;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const into = mergedInto(n.metadata);
    if (!into) return hop === 0 ? null : { id: n.id, type: n.type, slug: n.slug };
    const next = db.prepare("SELECT id, type, slug, metadata FROM nodes WHERE id = ?").get(into) as typeof n | undefined;
    if (!next) return null;
    n = next;
  }
  return { id: n.id, type: n.type, slug: n.slug };
}

/**
 * The node an address under (type, slug) now belongs to, when it moved; null
 * when the address is current (or unknown). Resolves like the page router:
 * (type, slug) first, then slug alone.
 */
export function movedTo(db: DatabaseSync, type: string, slug: string): MovedTo | null {
  const here = (db.prepare("SELECT id, type, slug, metadata FROM nodes WHERE type = ? AND slug = ?").get(type, slug)
    ?? db.prepare("SELECT id, type, slug, metadata FROM nodes WHERE slug = ?").get(slug)) as any;
  if (here) return follow(db, here);
  const alias = (db.prepare("SELECT node_id FROM node_aliases WHERE source = 'slug' AND external_id = ?").get(`${type}/${slug}`)
    ?? db.prepare("SELECT node_id FROM node_aliases WHERE source = 'slug' AND substr(external_id, instr(external_id, '/') + 1) = ?").get(slug)) as any;
  if (!alias) return null;
  const n = db.prepare("SELECT id, type, slug, metadata FROM nodes WHERE id = ?").get(alias.node_id) as any;
  if (!n) return null;
  return follow(db, n) ?? { id: n.id, type: n.type, slug: n.slug };
}

/** Keep an old address leading to `nodeId`. A later move of the same address wins. */
export function keepOldSlug(db: DatabaseSync, type: string, oldSlug: string, nodeId: string): void {
  db.prepare(
    `INSERT INTO node_aliases (source, external_id, node_id, created_at) VALUES ('slug', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(source, external_id) DO UPDATE SET node_id = excluded.node_id`
  ).run(`${type}/${oldSlug}`, nodeId);
}
