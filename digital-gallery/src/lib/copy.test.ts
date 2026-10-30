import { describe, expect, it } from 'vitest'
import { STAGE_COPY, creditLines, workLabel } from './copy.ts'
import type { ManifestWork } from './manifest.ts'

const work: ManifestWork = { id: 'artwork:fidenza', slug: 'fidenza', title: 'Fidenza', artist: 'practitioner:tyler-hobbs', by: ['Tyler Hobbs'], year: 2021.44, date: '11 Jun 2021', basis: 'Art Blocks project launch', firm: true, img: 'https://example.org/f.png', source: 'Art Blocks' }

describe('credit', () => {
  it('names the work, its makers, its date and why', () => {
    const c = creditLines(work, 'https://digitalartsinstitute.io', { seed: 42, turn: 0 })
    expect([c.title, c.by, c.date, c.basis]).toEqual(['Fidenza', 'Tyler Hobbs', '11 Jun 2021', 'Art Blocks project launch'])
    expect(c.where).toBe('A(DAI) Digital Arts Commons · via Art Blocks · seed 42 · turn 1')
  })
  it('links to the record in the commons', () => {
    expect(creditLines(work, 'http://localhost:8080', { seed: 1, turn: 0 }).link).toBe('http://localhost:8080/artwork/fidenza')
    expect(creditLines({ ...work, slug: 'toujours-là' }, 'x', { seed: 1, turn: 0 }).link).toBe('x/artwork/toujours-l%C3%A0')
  })
  it('labels a work by who, what and when', () => {
    expect(workLabel(work)).toBe('Tyler Hobbs · Fidenza · 11 Jun 2021')
  })
})

describe('stage copy', () => {
  it('is the hint, the credit pieces and the notice — nothing else', () => {
    expect(Object.keys(STAGE_COPY).sort()).toEqual(['COMMONS', 'KEY_HINT', 'NOTICE', 'RIGHTS_NOTE', 'TOUCH_HINT'])
  })
})
