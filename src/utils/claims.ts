// One relation, several claims. Edge ids carry the writer
// (`source--TYPE--target--created_by`), so when Pace states its roster and a
// reader of fellowship.xyz states the same relation, both rows live side by
// side, each with its own evidence — nothing overwrites anything. That is
// the right storage. Reading it, though, the relation is ONE line, backed by
// however many independent sources.
//
// A source is where the evidence comes from, not who typed it in: three
// people reading the same website are one website three times. So:
//   - evidence with a web page     → its host (www. dropped): "fellowship.xyz"
//   - no page, a person attested it → that person (their own words)
//   - neither (canon / pipelines)  → the writer stamp ("A(DAI) canon")
//
// Consent: an anonymous claim still counts as a source but is labelled
// "anonymous"; a structural_only claim counts, its URL is not shown.

import type { DatabaseSync } from "node:sqlite";

export interface ClaimRow {
  source_id: string;
  target_id: string;
  edge_type: string;
  created_by?: string | null;
  source_url?: string | null;
  submitted_by?: string | null;
  consent_attribution?: string | null;
  consent_scope?: string | null;
  claim_signal_id?: string | null;
  withheld_source_url?: string | null;
}

export interface Origin {
  key: string;
  label: string;
}

export function originOf(r: ClaimRow): Origin {
  // A structural_only claim's page is on the private side (signal_private):
  // it still counts as its source, never shown. (A fork has no private side:
  // there the claim counts by who made it.)
  const url = r.source_url ?? (r.consent_scope === "structural_only" ? r.withheld_source_url ?? null : null);
  if (url && /^https?:\/\//i.test(url)) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      // structural_only: counts as its source, but the page is not shown.
      if (host) return { key: `web:${host}`, label: r.consent_scope === "structural_only" ? "withheld source" : host };
    } catch { /* fall through */ }
  }
  if (r.submitted_by) {
    // anonymous: one source per contribution, keyed by nothing that names anyone
    if (r.consent_attribution === "anonymous") return { key: `anonymous:${r.claim_signal_id ?? "?"}`, label: "anonymous" };
    return { key: `person:${r.submitted_by}`, label: r.submitted_by };
  }
  const by = r.created_by ?? "unknown";
  return { key: `writer:${by}`, label: by === "contributor:migration" ? "A(DAI) canon" : by.replace(/^api-/, "") };
}

export const tripleKey = (r: { source_id: string; target_id: string; edge_type: string }) =>
  `${r.source_id}\u0000${r.edge_type}\u0000${r.target_id}`;

/**
 * Collapse claim rows to one entry per (source, type, target), keeping the
 * first row's fields and the distinct evidence origins, in first-seen order.
 */
export function collapseClaims<T extends ClaimRow>(rows: T[]): Array<T & { origins: Origin[] }> {
  const out = new Map<string, T & { origins: Origin[] }>();
  for (const r of rows) {
    const k = tripleKey(r);
    const o = originOf(r);
    const hit = out.get(k);
    if (!hit) out.set(k, { ...r, origins: [o] });
    else if (!hit.origins.some((x) => x.key === o.key)) hit.origins.push(o);
  }
  return [...out.values()];
}

/** The SQL columns collapseClaims reads, for an `edges e LEFT JOIN signals s ON s.id = e.signal_id` query. */
export const CLAIM_COLS =
  "e.source_id, e.target_id, e.edge_type, e.created_by, s.source_url, s.submitted_by, s.consent_attribution, s.consent_scope, s.id AS claim_signal_id, " +
  "(SELECT sp.source_url FROM signal_private sp WHERE sp.signal_id = s.id AND s.consent_scope = 'structural_only') AS withheld_source_url";

/**
 * Every live claim of one relation, one entry per source — as served
 * publicly (GET /api/edge/attribution). The dedup key (`originOf().key`) is
 * internal and never serialised: for a structural_only claim it is derived
 * from the withheld source URL. Each entry gets an opaque ordinal id instead.
 */
export interface PublicSource { id: string; label: string; attested_by: string | null; source_url: string | null; date: string | null }
export function claimsOf(db: DatabaseSync, source: string, target: string, type: string): PublicSource[] {
  const rows = db
    .prepare(
      `SELECT ${CLAIM_COLS}, e.valid_from, e.event_time FROM edges e LEFT JOIN signals s ON s.id = e.signal_id
        WHERE e.valid_until IS NULL AND e.source_id = ? AND e.target_id = ? AND e.edge_type = ?
        ORDER BY e.valid_from ASC`
    )
    .all(source, target, type) as any[];
  const seen = new Map<string, PublicSource>();
  for (const r of rows) {
    const o = originOf(r);
    if (seen.has(o.key)) continue;
    const anon = r.consent_attribution === "anonymous";
    seen.set(o.key, {
      id: `source-${seen.size + 1}`,
      label: o.label,
      attested_by: r.submitted_by ? (anon ? "anonymous" : r.submitted_by) : null,
      source_url: r.consent_scope === "structural_only" ? null : r.source_url ?? null,
      date: String(r.event_time || r.valid_from || "").slice(0, 10) || null,
    });
  }
  return [...seen.values()];
}
