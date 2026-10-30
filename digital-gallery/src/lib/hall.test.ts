import { describe, expect, it } from 'vitest'
import { BAY, FOCUS, MAX_H, MAX_W, cardStarts, eyeZ, hangSize, inView, markersFor, sharpness, sideOf, zOf } from './hall.ts'

describe('hanging', () => {
  it('staggers the works left, right, half a bay apart, running ahead into -z', () => {
    expect([0, 1, 2, 3].map(sideOf)).toEqual([-1, 1, -1, 1])
    expect([0, 1, 2, 3].map(zOf)).toEqual([-0.25, -0.75, -1.25, -1.75].map((f) => f * BAY))
  })
  it('stands the eye one focus distance before the work on stage, and walks evenly to the next', () => {
    expect(eyeZ(4) - zOf(4)).toBe(FOCUS)
    expect(eyeZ(4, 1)).toBeCloseTo(eyeZ(5))
    expect(eyeZ(5, 1)).toBeCloseTo(eyeZ(6))
  })
  it('fits any aspect in the frame box', () => {
    for (const a of [0.3, 0.75, 1, 16 / 9, 4]) {
      const { w, h } = hangSize(a)
      expect(w).toBeLessThanOrEqual(MAX_W + 1e-9)
      expect(h).toBeLessThanOrEqual(MAX_H + 1e-9)
      expect(w / h).toBeCloseTo(a)
    }
  })
  it('builds only the bays near the eye', () => {
    const [lo, hi] = inView(eyeZ(100), 3500)
    expect(lo).toBeGreaterThan(80)
    expect(hi).toBeLessThan(140)
    expect(inView(eyeZ(0), 3)).toEqual([0, 2])
  })
})

describe('the sharp band', () => {
  it('is the real picture up close and at the focus, ASCII far away', () => {
    expect(sharpness(0.5)).toBe(1)
    expect(sharpness(FOCUS)).toBe(1)
    expect(sharpness(40)).toBe(0)
  })
  it('falls off monotonically into the distance', () => {
    let last = 1
    for (let d = 0; d < 30; d += 0.5) (expect(sharpness(d)).toBeLessThanOrEqual(last), (last = sharpness(d)))
  })
})

describe('decades and cards', () => {
  it('floats a decade only when the walk reaches a later one', () => {
    expect(markersFor([1965, 1968, 1971, 1969, 1975, 1982, 1979, 2021])).toEqual([
      { bay: 0, decade: 1960 },
      { bay: 1, decade: 1970 },
      { bay: 2, decade: 1980 },
      { bay: 3, decade: 2020 },
    ])
  })
  it('keeps one decade per bay, the later one', () => {
    expect(markersFor([1969, 1971])).toEqual([{ bay: 0, decade: 1970 }])
  })
  it("floats a card at the start of each artist's run", () => {
    expect(cardStarts(['a', 'a', 'b', 'b', 'b', 'a', 'c'])).toEqual([0, 2, 5, 6])
  })
})
