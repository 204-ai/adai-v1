// The detail files the panel reads (src/lib/detail.ts): one per work in the manifest, by its index, written by
// `npm run manifest` right after the manifest so the two always agree. Read from the same database, live edges only,
// retired nodes left out. Machine-derived relations (visually close works, style kin, embedding-proposed concepts)
// are marked as such; nothing is inferred here.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { Detail, DetailArtist, Related } from '../src/lib/detail.ts'
import type { ManifestWork } from '../src/lib/manifest.ts'

/** the commons' own rule for a retired node (src/utils/visibility.ts): the same clause, so the two never disagree */
export const NOT_RETIRED = (metadata: string) => `json_extract(${metadata},'$.retired') IS NOT 1`
const LIVE = `e.valid_until IS NULL AND ${NOT_RETIRED('n.metadata')}`
const DERIVED = 'embedding-multimodal-v1'

/** how many of each kind the panel shows at most */
const CAP = { concept: 8, regime: 3, venue: 3, holder: 3, affine: 6, sibling: 6, kin: 4 }

const str = (v: unknown, max = 600): string | null => {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s
}

/** a link worth following: an absolute http(s) URL, as A(DAI)'s own pages require; anything else never becomes an href */
const http = (v: unknown, max: number): string | null => {
  const s = str(v, max)
  return s && /^https?:\/\/\S+$/i.test(s) ? s : null
}

/** a fact worth a row: a short string or a number */
const fact = (v: unknown): string | null => (typeof v === 'number' ? String(v) : str(v, 120))

interface Row {
  id: string
  name: string
  slug: string
  type: string
  metadata: string
  created_by?: string
}

/** a statement's rows, typed (node:sqlite types them as loose records) */
const rows = <T,>(stmt: StatementSync, ...args: string[]): T[] => stmt.all(...args) as unknown as T[]

export function writeDetails(db: DatabaseSync, works: ManifestWork[], dir: string): number {
  const index = new Map(works.map((w, i) => [w.id, i]))
  const node = db.prepare(`SELECT id, name, slug, type, metadata FROM nodes WHERE id = ?`)
  const out = db.prepare(
    `SELECT n.id, n.name, n.slug, n.type, n.metadata, e.edge_type AS edge, e.created_by FROM edges e JOIN nodes n ON n.id = e.target_id
     WHERE e.source_id = ? AND ${LIVE}`,
  )
  const both = db.prepare(
    `SELECT n.id, n.name, n.slug, n.type, n.metadata FROM edges e JOIN nodes n ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
     WHERE e.edge_type = ? AND (e.source_id = ? OR e.target_id = ?) AND ${LIVE}`,
  )
  const madeBy = db.prepare(
    `SELECT n.id, n.name, n.slug, n.type, n.metadata FROM edges e JOIN nodes n ON n.id = e.source_id
     WHERE e.edge_type = 'CREATED_BY' AND e.target_id = ? AND ${LIVE}`,
  )

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  works.forEach((w, i) => {
    const self = node.get(w.id) as Row | undefined
    const meta = self ? (JSON.parse(self.metadata) as Record<string, unknown>) : {}
    const edges = rows<Row & { edge: string; created_by: string }>(out, w.id)
    const related: Related[] = []
    const seen = new Set<string>([w.id])
    const add = (r: Row, rel: Related['rel'], extra: Partial<Related> = {}) => {
      if (seen.has(r.id) || related.filter((x) => x.rel === rel).length >= CAP[rel]) return
      seen.add(r.id)
      related.push({ id: r.id, name: r.name, slug: r.slug, type: r.type, rel, ...extra })
    }
    const asWork = (r: Row): Partial<Related> => {
      const m = JSON.parse(r.metadata) as Record<string, unknown>
      const here = index.get(r.id)
      return { img: typeof m.cdn_image_url === 'string' ? m.cdn_image_url : undefined, year: here != null ? works[here]!.year : undefined, here: here != null }
    }

    // curated concepts before the ones the embeddings proposed
    const concepts = edges.filter((e) => e.edge === 'EMBODIES').sort((a, b) => Number(a.created_by === DERIVED) - Number(b.created_by === DERIVED))
    for (const e of concepts) add(e, 'concept', e.created_by === DERIVED ? { inferred: true } : {})
    for (const e of edges.filter((e) => e.edge === 'CLASSIFIED_BY')) add(e, 'regime')
    for (const e of edges.filter((e) => e.edge === 'EXHIBITED_AT')) add(e, 'venue')
    for (const e of edges.filter((e) => e.edge === 'HELD_BY')) add(e, 'holder')
    for (const r of rows<Row>(both, w.id, 'VISUALLY_AFFINE', w.id, w.id)) if (r.type === 'artwork' && index.has(r.id)) add(r, 'affine', { ...asWork(r), inferred: true })

    const artists: DetailArtist[] = []
    for (const e of edges.filter((e) => e.edge === 'CREATED_BY')) {
      if (artists.some((a) => a.id === e.id)) continue
      const m = JSON.parse(e.metadata) as Record<string, unknown>
      const known = Array.isArray(m.known_for) ? m.known_for.filter((x) => typeof x === 'string').join(', ') : m.known_for
      artists.push({ id: e.id, name: e.name, slug: e.slug, type: e.type, about: str(m.summary) ?? str(m.bio) ?? str(known) ?? str(m.role), website: http(m.homepage, 300) ?? http(meta.artist_website, 300) })
    }
    // the same maker's other works here, nearest in time first
    const first = artists[0]
    if (first) {
      const others = rows<Row>(madeBy, first.id).filter((r) => index.has(r.id)).sort((a, b) => Math.abs(works[index.get(a.id)!]!.year - w.year) - Math.abs(works[index.get(b.id)!]!.year - w.year))
      for (const r of others) add(r, 'sibling', asWork(r))
      for (const r of rows<Row>(both, first.id, 'STYLE_KIN', first.id, first.id)) add(r, 'kin', { inferred: true })
    }

    const facts: Array<[string, string]> = []
    for (const [label, key] of [
      ['Object', 'object_type'],
      ['Medium', 'medium'],
      ['Dimensions', 'dimensions'],
      ['Made in', 'place'],
      ['Series', 'series'],
      ['Collection', 'collection'],
      ['Edition', 'edition'],
      ['Supply', 'supply'],
      ['Mints', 'invocations'],
      ['Dated', 'date_text'],
    ] as const) {
      const v = fact(meta[key])
      if (v) facts.push([label, v])
    }
    const detail: Detail = {
      id: w.id,
      text: str(meta.description, 900) ?? str(meta.summary, 900),
      facts,
      tags: Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === 'string').slice(0, 12) : [],
      source: http(meta.source_url, 400),
      artists,
      related,
    }
    writeFileSync(`${dir}/${i}.json`, JSON.stringify(detail))
  })
  return works.length
}
