import { describe, expect, it } from 'vitest'
import { WHEEL_PER_WORK, panelFrame, settle, wheelWorks } from './panel.ts'

describe('the wheel', () => {
  it('moves forward scrolling up, back scrolling down, a work per WHEEL_PER_WORK px', () => {
    expect(wheelWorks({ deltaY: -WHEEL_PER_WORK, deltaMode: 0 })).toBe(1)
    expect(wheelWorks({ deltaY: WHEEL_PER_WORK / 2, deltaMode: 0 })).toBe(-0.5)
    expect(wheelWorks({ deltaY: -3, deltaMode: 1 })).toBeCloseTo((3 * 33) / WHEEL_PER_WORK)
  })
  it('leads the walk without stepping until it reaches the next work', () => {
    expect(settle(0.3, 0.5)).toEqual({ step: 0, lead: 0.5 })
    expect(settle(0.3, -0.7)).toEqual({ step: 0, lead: -0.7 })
  })
  it('steps and keeps the remainder, so the eye stays where it is', () => {
    const r = settle(0.6, 0.7)
    expect(r.step).toBe(1)
    expect(r.lead).toBeCloseTo(0.3)
    // the eye is at progress + lead: 1.3 works on before, 1 + 0 + 0.3 after
    expect(0.6 + 0.7).toBeCloseTo(r.step + 0 + r.lead)
    const b = settle(0.1, -0.8)
    expect(b.step).toBe(-1)
    expect(b.step + b.lead).toBeCloseTo(0.1 - 0.8)
  })
  it('steps several works for a long fling', () => {
    expect(settle(0, 3.2).step).toBe(3)
  })
})

describe('the open work', () => {
  it('puts the panel beside the work on a wide screen, the work centred in what is left', () => {
    const f = panelFrame(1600, 900)
    expect(f.side).toBe('right')
    expect(f.size).toBe(560)
    expect(f.ox).toBeCloseTo((1600 - 560) / 1600 - 1)
    expect(f.fw).toBeLessThan((1600 - 560) / 1600)
  })
  it('puts it under the work on a tall screen', () => {
    const f = panelFrame(400, 860)
    expect(f.side).toBe('bottom')
    expect(f.oy).toBeGreaterThan(0)
    expect(f.ox).toBe(0)
  })
})
