import { describe, expect, it } from 'vitest'
import { braid, chunksFor, type BraidItem } from './braid.ts'

// three artists: a long career, a short burst, one work
const career = (artist: string, n: number, from: number, to: number): BraidItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${artist}-${String(i).padStart(2, '0')}`, artist, year: from + ((to - from) * (i + 0.5)) / n }))
const items = [...career('a', 20, 1965, 2020), ...career('b', 10, 2021, 2022), ...career('c', 1, 1970, 1970)]
const opts = { seed: 7, turn: 0, fuzz: 0.02 }

describe('braid', () => {
  it('shows every work exactly once per turn', () => {
    for (let turn = 0; turn < 6; turn++) expect([...braid(items, { ...opts, turn })].sort()).toEqual(items.map((c) => c.id).sort())
  })
  it("keeps each artist's works in time order", () => {
    for (let turn = 0; turn < 6; turn++) {
      const out = braid(items, { ...opts, turn, fuzz: 0.5 })
      for (const w of ['a', 'b']) {
        const mine = out.filter((id) => id.startsWith(`${w}-`))
        expect(mine).toEqual([...mine].sort())
      }
    }
  })
  it('cuts careers into chunks of 2-4 works, only a last chunk shorter', () => {
    const chunks = chunksFor(items, opts)
    for (const w of ['a', 'b']) {
      const sizes = chunks.filter((c) => c.artist === w).map((c) => c.ids.length)
      expect(sizes.slice(0, -1).every((s) => s >= 2 && s <= 4)).toBe(true)
      expect(sizes.at(-1)).toBeLessThanOrEqual(4)
    }
  })
  it('with fuzz 0 runs forward through time', () => {
    const o = { ...opts, fuzz: 0 }
    const keyOf = new Map(chunksFor(items, o).map((c) => [c.ids[0]!, c.key]))
    const keys = braid(items, o).filter((id) => keyOf.has(id)).map((id) => keyOf.get(id)!)
    expect(keys).toEqual([...keys].sort((x, y) => x - y))
    expect(braid(items, o)[0]).toBe('a-00')
  })
  it('repeats for the same seed and turn, and changes on the next turn', () => {
    expect(braid(items, opts)).toEqual(braid(items, opts))
    expect(braid(items, { ...opts, turn: 1 })).not.toEqual(braid(items, opts))
  })
})
