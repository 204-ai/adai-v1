// `npm run artblocks [--db path]`: the commons has no dates for its Art Blocks works, so ask Art Blocks' public data API
// when each project started and keep the answers in work/artblocks.json (committed; the manifest reads only the file).
import { writeFileSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { arg, DEFAULT_DB, root } from './lib.ts'

const API = 'https://data.artblocks.io/v1/graphql'

const db = new DatabaseSync(arg('--db') ?? DEFAULT_DB, { readOnly: true })
const rows = db
  .prepare(
    `SELECT DISTINCT lower(json_extract(metadata, '$.artblocks_contract')) AS contract, json_extract(metadata, '$.artblocks_project_id') AS pid
     FROM nodes WHERE type = 'artwork' AND json_extract(metadata, '$.artblocks_project_id') IS NOT NULL`,
  )
  .all() as Array<{ contract: string; pid: string }>
db.close()

const byContract = new Map<string, string[]>()
for (const r of rows) byContract.set(r.contract, [...(byContract.get(r.contract) ?? []), String(r.pid)])

const out: Record<string, string> = {}
for (const [contract, pids] of byContract) {
  const query = `query($c: String!, $p: [String!]) { projects_metadata(where: {contract_address: {_eq: $c}, project_id: {_in: $p}}) { project_id start_datetime } }`
  const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { c: contract, p: pids } }) })
  if (!res.ok) throw new Error(`artblocks: ${res.status} for ${contract}`)
  const body = (await res.json()) as { data?: { projects_metadata: Array<{ project_id: string; start_datetime: string | null }> }; errors?: unknown }
  if (!body.data) throw new Error(`artblocks: ${JSON.stringify(body.errors)}`)
  for (const p of body.data.projects_metadata) if (p.start_datetime) out[`${contract}:${p.project_id}`] = p.start_datetime
  console.log(`${contract}: ${body.data.projects_metadata.length}/${pids.length} projects, ${body.data.projects_metadata.filter((p) => p.start_datetime).length} with a start date`)
}

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })))
mkdirSync(root('work'), { recursive: true })
writeFileSync(root('work/artblocks.json'), JSON.stringify(sorted, null, 1) + '\n')
console.log(`work/artblocks.json: ${Object.keys(sorted).length} of ${rows.length} projects dated`)
