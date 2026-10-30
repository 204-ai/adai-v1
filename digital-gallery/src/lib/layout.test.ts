import { describe, expect, it } from 'vitest'
import { layout, nextMode } from './layout.ts'

const inside = (r: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) => r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h

describe('stage', () => {
  for (const [W, H] of [[1280, 720], [1920, 1080], [800, 600], [390, 844]] as const)
    it(`fits a 16:9 box inside ${W}×${H}`, () => {
      const L = layout(W, H)
      expect(L.stage.w / L.stage.h).toBeCloseTo(16 / 9, 5)
      expect(inside(L.stage, { x: 0, y: 0, w: W, h: H })).toBe(true)
    })
})

describe('modes', () => {
  it("cycle from A(DAI)'s field through the gallery, vortex and city, and back", () => {
    expect([nextMode('field'), nextMode('gallery'), nextMode('vortex'), nextMode('city')]).toEqual(['gallery', 'vortex', 'city', 'field'])
  })
})
