import { describe, expect, it } from 'vitest'
import { AHEAD, BEHIND, CENTRE, EYE, PITCH, SPACING, STAGE, STAGE_R, diveHeading, divePoint, fit, heightAt, place, rhoOf, shown, slopeAt, wormholeExit } from './vortex.ts'

describe('the well', () => {
  it('is flat far out and falls ever more steeply toward the throat, its shoulders rounded', () => {
    expect(heightAt(60)).toBeGreaterThan(-0.1)
    expect(heightAt(1)).toBeLessThan(heightAt(3))
    expect(slopeAt(1)).toBeGreaterThan(slopeAt(3))
    // the profile bends over (concave down): each step outward rises less than the one before
    expect(heightAt(3) - heightAt(2)).toBeLessThan(heightAt(2) - heightAt(1))
  })
  it('floats the work on stage in front of the viewer', () => {
    const p = place(0, 40)
    expect([p.x, p.y, p.z]).toEqual([STAGE.x, STAGE.y, STAGE.z])
    expect(p.eye).toBe(1)
  })
  it('lays the others on the sheet along a spiral round the throat, farther out ahead', () => {
    const p = place(10, 0)
    expect(Math.hypot(p.x - CENTRE.x, p.z - CENTRE.z)).toBeCloseTo(rhoOf(10))
    expect(p.y).toBeCloseTo(heightAt(rhoOf(10)))
    expect(rhoOf(20)).toBeGreaterThan(rhoOf(10))
  })
  it('tiles the sheet densely: neighbours about SPACING apart, arms about PITCH apart', () => {
    const a = place(40, 0), b = place(41, 0)
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(SPACING, 0)
    expect(rhoOf(STAGE_R * 30) - rhoOf(0)).toBeGreaterThan(PITCH)
  })
  it('moves every work continuously as the run flows on', () => {
    for (let k = -BEHIND; k < AHEAD; k += 0.01) {
      const p = place(k, 0), q = place(k + 0.01, 0)
      expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeLessThan(0.2)
    }
  })
  it('lets the passed works fall down the throat, fading', () => {
    expect(place(-3, 0).y).toBeLessThan(heightAt(STAGE_R))
    expect(place(-BEHIND, 0).fade).toBe(0)
    expect(place(AHEAD, 0).fade).toBe(0)
  })
  it('turns slowly as a whole', () => {
    expect(place(30, 10).angle).toBeGreaterThan(place(30, 0).angle)
  })
  it('shows the works from just behind to far ahead', () => {
    expect(shown(100.5, 3500)).toEqual([96, 250])
  })
  it('fits any aspect in a box', () => {
    for (const a of [0.3, 1, 4]) {
      const { w, h } = fit(a, { w: 2, h: 1.5 })
      expect(w).toBeLessThanOrEqual(2 + 1e-9)
      expect(h).toBeLessThanOrEqual(1.5 + 1e-9)
    }
  })
})

describe('the jump into the wormhole', () => {
  it('starts where the eye stands and ends deep in the throat, on its axis', () => {
    expect(divePoint(0)).toEqual({ x: 0, y: EYE, z: 0 })
    const end = divePoint(1)
    expect([end.x, end.z]).toEqual([CENTRE.x, CENTRE.z])
    expect(end.y).toBeLessThan(heightAt(1))
  })
  it('leaves level and arrives heading straight down', () => {
    const a = diveHeading(0), b = diveHeading(1)
    expect(a.y).toBeCloseTo(0)
    expect(a.z).toBeLessThan(0)
    expect(b.x).toBeCloseTo(0)
    expect(b.z).toBeCloseTo(0)
    expect(b.y).toBeLessThan(0)
  })
  it('moves smoothly', () => {
    for (let e = 0; e < 1; e += 0.01) {
      const p = divePoint(e), q = divePoint(e + 0.01)
      expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeLessThan(0.5)
    }
  })
})

describe('where the wormhole lets out', () => {
  it('somewhere at least a quarter of the run away, either way round', () => {
    for (const r of [0, 0.3, 0.7, 0.999]) {
      const to = wormholeExit(100, 1000, r)
      const d = Math.abs(to - 100)
      expect(Math.min(d, 1000 - d)).toBeGreaterThanOrEqual(250)
      expect(to).toBeGreaterThanOrEqual(0)
      expect(to).toBeLessThan(1000)
    }
  })
  it('somewhere else even in a tiny run', () => {
    expect(wormholeExit(0, 2, 0)).toBe(1)
  })
})
