import { describe, expect, it } from 'vitest'
import { BOX, CENTRE, bow, constellation } from './constellation.ts'
import type { DetailArtist, Related } from './detail.ts'

const artist: DetailArtist = { id: 'practitioner:a', name: 'A', slug: 'a', type: 'practitioner', about: null, website: null }
const rel = (rel: Related['rel'], n: number): Related[] => Array.from({ length: n }, (_, i) => ({ id: `${rel}:${i}`, name: `${rel} ${i}`, slug: `${rel}-${i}`, type: 'x', rel }))

describe('the constellation', () => {
  const stars = constellation([artist], [...rel('concept', 8), ...rel('sibling', 6), ...rel('kin', 4), ...rel('affine', 6), ...rel('venue', 2), ...rel('regime', 3)])
  it('places every neighbour inside the box', () => {
    expect(stars).toHaveLength(1 + 8 + 6 + 4 + 6 + 2 + 3)
    for (const s of stars) {
      expect(s.x).toBeGreaterThan(0)
      expect(s.x).toBeLessThan(BOX.w)
      expect(s.y).toBeGreaterThan(0)
      expect(s.y).toBeLessThan(BOX.h)
    }
  })
  it('puts the maker above, and hangs their other works and kin from them', () => {
    const maker = stars.find((s) => s.kind === 'maker')!
    expect(maker.y).toBeLessThan(CENTRE.y)
    for (const s of stars.filter((s) => s.kind === 'sibling' || s.kind === 'kin')) expect(s.from).toEqual({ x: maker.x, y: maker.y })
    for (const s of stars.filter((s) => s.kind === 'concept')) expect(s.from).toEqual(CENTRE)
  })
  it('keeps each kind on its own side', () => {
    expect(stars.filter((s) => s.kind === 'concept').every((s) => s.x > CENTRE.x)).toBe(true)
    expect(stars.filter((s) => s.kind === 'affine').every((s) => s.x < CENTRE.x)).toBe(true)
    expect(stars.filter((s) => s.kind === 'venue').every((s) => s.y > CENTRE.y)).toBe(true)
  })
  it('draws a bowed line between two stars', () => {
    expect(bow({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe('M0.0 0.0 Q5.0 1.2 10.0 0.0')
  })
})
