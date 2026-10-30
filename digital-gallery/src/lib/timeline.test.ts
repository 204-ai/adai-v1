import { describe, expect, it } from 'vitest'
import { axisOf, decades, fracOf, tickState, timeAt } from './timeline.ts'

describe('timeline', () => {
  const a = axisOf([1915.3, 1972.6, 1960])
  it('maps time to the strip and back', () => {
    expect(fracOf(1915.3, a)).toBeGreaterThan(0)
    expect(fracOf(1972.6, a)).toBeLessThan(1)
    expect(timeAt(fracOf(1950, a), a)).toBeCloseTo(1950, 6)
    expect(timeAt(-1, a)).toBe(a.lo)
  })
  it('marks the decades of the span', () => {
    expect(decades(a)).toEqual([1920, 1930, 1940, 1950, 1960, 1970])
  })
  it('colours works behind, at and ahead of the current one', () => {
    expect([0, 1, 2].map((i) => tickState(i, 1))).toEqual(['behind', 'now', 'ahead'])
  })
})
