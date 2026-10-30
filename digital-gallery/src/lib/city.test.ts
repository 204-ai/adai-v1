import { describe, expect, it } from 'vitest'
import { PLAZA, cityOf, viewOf, widthFor } from './city.ts'
import type { Manifest, ManifestWork } from './manifest.ts'

let seq = 0
const work = (artist: string, year: number, source: string): ManifestWork => ({
  id: `artwork:${++seq}`,
  slug: `w-${seq}`,
  title: `w ${seq}`,
  artist,
  by: [artist],
  year,
  date: String(year),
  basis: '',
  firm: true,
  img: '',
  source,
})

function manifest(): Manifest {
  const works: ManifestWork[] = []
  // a prolific one, some middling, many with one work, in three districts
  for (let i = 0; i < 90; i++) works.push(work('artist:big', 1965 + i * 0.3, 'V&A'))
  for (let a = 0; a < 20; a++) for (let i = 0; i < 6; i++) works.push(work(`artist:mid${a}`, 1990 + a, a % 2 ? 'fxhash' : 'SuperRare'))
  for (let a = 0; a < 200; a++) works.push(work(`artist:one${a}`, 2000 + (a % 25), a % 3 ? 'fxhash' : 'Art Blocks'))
  works.push(work('artist:mixed', 2010, 'fxhash'), work('artist:mixed', 2011, 'fxhash'), work('artist:mixed', 2012, 'V&A'))
  return { version: 1, from: '', built: '', site: '', artists: [], works }
}

describe('the city', () => {
  const m = manifest()
  const c = cityOf(m)
  it('gives every work a panel and every artist a building', () => {
    expect(c.panelOf.size).toBe(m.works.length)
    expect(c.buildings).toHaveLength(1 + 20 + 200 + 1)
  })
  it('puts an artist in the district most of their works came from', () => {
    expect(c.buildingOf.get('artist:mixed')!.district).toBe('fxhash')
    expect(c.buildingOf.get('artist:big')!.district).toBe('V&A')
  })
  it('builds taller for more works, wider facades for many', () => {
    const big = c.buildingOf.get('artist:big')!, one = c.buildingOf.get('artist:one0')!
    expect(big.height).toBeGreaterThan(one.height)
    expect(big.width).toBe(widthFor(90))
    expect(one.floors).toBe(1)
  })
  it('stands every building outside the plaza, inside its own wedge, none overlapping', () => {
    for (const b of c.buildings) expect(Math.hypot(b.x, b.z) - b.half).toBeGreaterThanOrEqual(PLAZA - 1e-6)
    for (const d of c.districts) {
      for (const b of c.buildings.filter((b) => b.district === d.name)) {
        let ang = Math.atan2(b.z, b.x)
        while (ang < d.a0 - 1e-9) ang += Math.PI * 2
        expect(ang).toBeLessThanOrEqual(d.a1 + 1e-9)
      }
    }
    for (let i = 0; i < c.buildings.length; i++)
      for (let j = i + 1; j < c.buildings.length; j++) {
        const a = c.buildings[i]!, b = c.buildings[j]!
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(a.half + b.half)
      }
  })
  it('runs time outward: within a district, older artists stand nearer the plaza', () => {
    const fx = c.buildings.filter((b) => b.district === 'fxhash').sort((a, b) => a.first - b.first)
    expect(Math.hypot(fx[0]!.x, fx[0]!.z)).toBeLessThan(Math.hypot(fx.at(-1)!.x, fx.at(-1)!.z))
    const d = c.districts.find((d) => d.name === 'fxhash')!
    expect(d.decades.map((x) => x.decade)).toEqual([...d.decades.map((x) => x.decade)].sort())
  })
  it('hangs an artist’s works oldest at the bottom, each panel on its building’s face', () => {
    const big = c.buildingOf.get('artist:big')!
    expect(big.panels[0]!.y).toBeLessThan(big.panels.at(-1)!.y)
    for (const p of big.panels) {
      // out from the centre by the half-size along its normal
      const out = (p.x - big.x) * p.nx + (p.z - big.z) * p.nz
      expect(out).toBeCloseTo(big.half + 0.02)
    }
  })
  it('stands the eye in front of a panel, looking at it, rising to an aerial view as it draws back', () => {
    const p = c.panelOf.get(m.works[0]!.id)!
    for (const dist of [4, 30, 100]) {
      const v = viewOf(p, dist)
      expect(Math.hypot(v.eye.x - p.x, v.eye.y - p.y, v.eye.z - p.z)).toBeCloseTo(dist)
      expect((v.eye.x - p.x) * p.nx + (v.eye.z - p.z) * p.nz).toBeGreaterThan(0)
      expect(v.at).toEqual({ x: p.x, y: p.y, z: p.z })
    }
    expect(viewOf(p, 4).eye.y - p.y).toBeLessThan(0.5)
    expect(viewOf(p, 100).eye.y - p.y).toBeGreaterThan(60)
  })
})
