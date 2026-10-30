import { describe, expect, it } from 'vitest'
import { Glide, LEAP, Look, spring, type Spring } from './motion.ts'

const DT = 1 / 60

describe('spring', () => {
  it('settles on its target without overshooting', () => {
    const s: Spring = { x: 0, v: 0 }
    let max = 0
    for (let i = 0; i < 600; i++) (spring(s, 10, 3, DT), (max = Math.max(max, s.x)))
    expect(s.x).toBeCloseTo(10, 3)
    expect(max).toBeLessThanOrEqual(10 + 1e-9)
  })
  it('never jumps: a sudden new target only bends its speed, by about ω² · distance per second', () => {
    const s: Spring = { x: 0, v: 0 }
    let last = { ...s }
    for (let i = 0; i < 120; i++) {
      spring(s, i < 60 ? 2 : -2, 3, DT)
      expect(Math.abs(s.v - last.v)).toBeLessThan(1.2 * 3 * 3 * 4 * DT)
      expect(Math.abs(s.x - last.x)).toBeLessThan(0.1)
      last = { ...s }
    }
  })
})

describe('glide', () => {
  it('springs over short distances and stays seen', () => {
    const g = new Glide(0, 2, 20)
    for (let i = 0; i < 600; i++) g.update(5, DT)
    expect(g.at.x).toBeCloseTo(5, 2)
    expect(g.fade).toBe(1)
  })
  it('fades out, lands unseen and fades back in on a far jump', () => {
    const g = new Glide(0, 2, 20)
    let landedAt = -1, darkest = 1
    for (let i = 0; i < 180; i++) {
      g.update(500, DT)
      darkest = Math.min(darkest, g.fade)
      if (g.landed) ((landedAt = i), expect(g.fade).toBe(0), expect(g.at.x).toBe(500))
      if (landedAt < 0) expect(Math.abs(g.at.x)).toBeLessThan(1)
    }
    expect(darkest).toBe(0)
    expect(landedAt * DT).toBeCloseTo(LEAP, 1)
    expect(g.fade).toBe(1)
  })
})

describe('look', () => {
  it('eases toward the pointer within range, and home when it leaves', () => {
    const l = new Look({ yaw: 0.3, pitch: 0.1 })
    l.point({ x: 2, y: 1 })
    l.update(DT)
    expect(Math.abs(l.yaw.x)).toBeLessThan(0.01)
    for (let i = 0; i < 600; i++) l.update(DT)
    expect(l.yaw.x).toBeCloseTo(-0.3, 3)
    expect(l.pitch.x).toBeCloseTo(0.1, 3)
    l.point(null)
    for (let i = 0; i < 600; i++) l.update(DT)
    expect(l.yaw.x).toBeCloseTo(0, 3)
  })
})
