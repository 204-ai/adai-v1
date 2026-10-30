import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import type { Detail } from '../src/lib/detail.ts'
import type { ManifestWork } from '../src/lib/manifest.ts'
import { writeDetails } from './details.ts'

it('shows each live maker once even when several sources attest the same relation', () => {
  const db = new DatabaseSync(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'gallery-details-'))
  try {
    db.exec(`CREATE TABLE nodes (id TEXT, name TEXT, slug TEXT, type TEXT, metadata TEXT);
      CREATE TABLE edges (source_id TEXT, target_id TEXT, edge_type TEXT, valid_until TEXT, created_by TEXT);`)
    const insert = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?)')
    insert.run('w', 'Work', 'work', 'artwork', JSON.stringify({ description: 'Work description', source_url: 'javascript:alert(1)' }))
    insert.run('a', 'Maker', 'maker', 'practitioner', JSON.stringify({ retired: false, homepage: 'https://artist.example' }))
    insert.run('retired', 'Retired', 'retired', 'practitioner', '{"retired":true}')
    insert.run('old', 'Old attribution', 'old', 'practitioner', '{}')
    db.exec(`INSERT INTO edges VALUES
      ('w', 'a', 'CREATED_BY', NULL, 'source-one'),
      ('w', 'a', 'CREATED_BY', NULL, 'source-two'),
      ('w', 'retired', 'CREATED_BY', NULL, 'source-one'),
      ('w', 'old', 'CREATED_BY', '2020-01-01', 'source-one');`)
    const work: ManifestWork = { id: 'w', slug: 'work', title: 'Work', artist: 'a', by: ['Maker'], year: 2000, date: '2000', basis: 'fixture', firm: true, img: 'https://images.example/work.png', source: 'A(DAI)' }
    writeDetails(db, [work], dir)
    const detail = JSON.parse(readFileSync(join(dir, '0.json'), 'utf8')) as Detail
    expect(detail.artists.map((a) => a.id)).toEqual(['a'])
    expect(detail.artists[0]?.website).toBe('https://artist.example')
    expect(detail.source).toBeNull()
    expect(detail.text).toBe('Work description')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
