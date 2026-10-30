// `npm run manifest [--db path] [--site url]`: read every live artwork with an image out of an A(DAI) database, date it
// (scripts/dates.ts), find who made it, and write public/data/manifest.json, then a detail file per work for the panel
// (scripts/details.ts, public/data/works/<index>.json). Works without a readable date or a
// creator stay off the coil; the report says how many and why.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Manifest, ManifestArtist, ManifestWork } from '../src/lib/manifest.ts'
import { dateOf, type ArtBlocksDates } from './dates.ts'
import { NOT_RETIRED, writeDetails } from './details.ts'
import { arg, DEFAULT_DB, root } from './lib.ts'

const dbPath = arg('--db') ?? DEFAULT_DB
const site = (arg('--site') ?? 'https://digitalartsinstitute.io').replace(/\/$/, '')
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}: build one with \`npm run fork:pull\` at the repository root, or pass --db`)
  process.exit(1)
}
const abPath = root('work/artblocks.json')
const artblocks: ArtBlocksDates = existsSync(abPath) ? JSON.parse(readFileSync(abPath, 'utf8')) : {}

const db = new DatabaseSync(dbPath, { readOnly: true })
const arts = db
  .prepare(
    `SELECT id, name, slug, metadata FROM nodes
     WHERE type = 'artwork' AND json_extract(metadata, '$.cdn_image_url') IS NOT NULL AND ${NOT_RETIRED('metadata')}`,
  )
  .all() as Array<{ id: string; name: string; slug: string; metadata: string }>
const makers = db
  .prepare(
    `SELECT e.source_id AS work, n.id, n.name, n.type, n.slug FROM edges e JOIN nodes n ON n.id = e.target_id
     WHERE e.edge_type = 'CREATED_BY' AND e.valid_until IS NULL AND ${NOT_RETIRED('n.metadata')}`,
  )
  .all() as Array<{ work: string; id: string; name: string; type: string; slug: string }>

const byWork = new Map<string, ManifestArtist[]>()
for (const m of makers) {
  const list = byWork.get(m.work) ?? []
  if (!list.some((a) => a.id === m.id)) list.push({ id: m.id, name: m.name, type: m.type, slug: m.slug })
  byWork.set(m.work, list)
}

const sourceOf = (meta: Record<string, unknown>) =>
  meta.fxhash_slug ? 'fxhash' : meta.artblocks_project_id != null ? 'Art Blocks' : meta.superrare_token_id ? 'SuperRare' : meta.va_system_number ? 'V&A' : 'A(DAI)'

const works: ManifestWork[] = []
const artists = new Map<string, ManifestArtist>()
const skipped = { undated: 0, unattributed: 0 }
const undatedBySource = new Map<string, number>()
for (const a of arts) {
  const meta = JSON.parse(a.metadata) as Record<string, unknown>
  const by = (byWork.get(a.id) ?? []).sort((x, y) => x.name.localeCompare(y.name))
  if (!by.length) {
    skipped.unattributed++
    continue
  }
  const d = dateOf(a.id, meta, artblocks)
  if (!d) {
    skipped.undated++
    undatedBySource.set(sourceOf(meta), (undatedBySource.get(sourceOf(meta)) ?? 0) + 1)
    continue
  }
  for (const m of by) artists.set(m.id, m)
  works.push({
    id: a.id,
    slug: a.slug,
    title: a.name,
    artist: by[0]!.id,
    by: by.map((m) => m.name),
    year: Math.round(d.year * 10000) / 10000,
    date: d.label,
    basis: d.basis,
    firm: d.firm,
    img: String(meta.cdn_image_url),
    source: sourceOf(meta),
  })
}
works.sort((x, y) => x.year - y.year || x.id.localeCompare(y.id))

const manifest: Manifest = {
  version: 1,
  from: dbPath.replace(process.env.HOME ?? '\0', '~'),
  built: new Date().toISOString(),
  site,
  artists: [...artists.values()].sort((x, y) => x.id.localeCompare(y.id)),
  works,
}
mkdirSync(root('public/data'), { recursive: true })
writeFileSync(root('public/data/manifest.json'), JSON.stringify(manifest))
const detailed = writeDetails(db, works, root('public/data/works'))
// the city's sky bridges: style kin between the artists here (machine-derived by the commons' embeddings), each pair once
const here = new Set(manifest.artists.map((x) => x.id))
const kin = new Set<string>()
for (const e of db
  .prepare(
    `SELECT e.source_id AS a, e.target_id AS b FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
     WHERE e.edge_type = 'STYLE_KIN' AND e.valid_until IS NULL AND ${NOT_RETIRED('s.metadata')} AND ${NOT_RETIRED('t.metadata')}`,
  )
  .all() as unknown as Array<{ a: string; b: string }>)
  if (here.has(e.a) && here.has(e.b) && e.a !== e.b) kin.add(JSON.stringify([e.a, e.b].sort()))
writeFileSync(root('public/data/city.json'), JSON.stringify({ kin: [...kin].map((k) => JSON.parse(k) as [string, string]) }))
db.close()

const bySource = new Map<string, number>()
for (const w of works) bySource.set(w.source, (bySource.get(w.source) ?? 0) + 1)
const decades = new Map<number, number>()
for (const w of works) decades.set(Math.floor(w.year / 10) * 10, (decades.get(Math.floor(w.year / 10) * 10) ?? 0) + 1)
console.log(`${works.length} works by ${manifest.artists.length} artists on the coil (of ${arts.length} with an image)`)
console.log(`  off the coil: ${skipped.undated} undated (${[...undatedBySource].map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}), ${skipped.unattributed} without a creator`)
console.log(`  by source: ${[...bySource].map(([s, n]) => `${s} ${n}`).join(' · ')}`)
console.log(`  firm dates: ${works.filter((w) => w.firm).length} · estimates: ${works.filter((w) => !w.firm).length}`)
console.log(`  detail files: ${detailed} in public/data/works/ · kin links for the city: ${kin.size}`)
console.log(`  by decade: ${[...decades].sort(([a], [b]) => a - b).map(([d, n]) => `${d}s ${n}`).join(' · ')}`)
