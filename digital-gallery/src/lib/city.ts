// The city: the commons' graph built as a town round a central plaza. Each district is a wedge for one of the places
// the works were shown (the source most of an artist's works came from: V&A, SuperRare, Art Blocks, fxhash, A(DAI)),
// its width by how many artists it holds. Each artist is a building, its facades panelled with their works: oldest on
// the ground floor, going up a floor at a time, round the four faces. Buildings stand oldest nearest the plaza: in each
// district they are packed along ring bands outward in the order of their first work, so time runs outward, and the
// band where each decade begins is marked. Kin links (the commons' style kin) span between rooftops; the scene draws
// them. Kept pure (no three.js) so it is tested. x right, z toward the viewer, y up; the plaza is at the origin.
import type { Manifest } from './manifest.ts'

/** the districts in their order round the plaza */
export const DISTRICTS = ['V&A', 'SuperRare', 'Art Blocks', 'fxhash', 'A(DAI)'] as const
/** the open plaza in the middle, the street between ring bands, the gap between buildings along a band, the avenue between districts (radians) */
export const PLAZA = 16
export const STREET = 3.2
export const GAP = 2.2
export const AVENUE = 0.08
/** a panel's spacing along a facade, its size, and the height of a floor */
export const MOD = 1.65
export const PANEL = { w: 1.5, h: 1.12 }
export const FLOOR = 1.27
/** the ground floor's sill height */
export const SILL = 0.35

export interface Panel {
  work: string
  /** centre of the panel, and the way its face points (unit, horizontal) */
  x: number
  y: number
  z: number
  nx: number
  nz: number
}

export interface Building {
  artist: string
  district: string
  /** centre of the footprint, its half-size, its turn (radians, its first face toward the plaza), its height */
  x: number
  z: number
  half: number
  yaw: number
  height: number
  /** panels a face is wide, and how many floors */
  width: number
  floors: number
  /** the year of its first work */
  first: number
  panels: Panel[]
}

export interface DistrictPlace {
  name: string
  a0: number
  a1: number
  /** where each decade's first building stands in this district: the radius of its band */
  decades: Array<{ decade: number; r: number }>
}

export interface City {
  buildings: Building[]
  districts: DistrictPlace[]
  /** the panel of each work, and the building of each artist */
  panelOf: Map<string, Panel>
  buildingOf: Map<string, Building>
  /** how far out the farthest building stands */
  radius: number
}

/** how many panels wide a facade is for n works */
export const widthFor = (n: number) => (n <= 4 ? 1 : n <= 24 ? 2 : n <= 80 ? 3 : 4)

export function cityOf(manifest: Manifest): City {
  // each artist's works, oldest first, and their district
  const byArtist = new Map<string, Manifest['works']>()
  for (const w of manifest.works) byArtist.set(w.artist, [...(byArtist.get(w.artist) ?? []), w])
  const artists = [...byArtist.entries()].map(([artist, ws]) => {
    ws.sort((a, b) => a.year - b.year || a.id.localeCompare(b.id))
    const count = new Map<string, number>()
    for (const w of ws) count.set(w.source, (count.get(w.source) ?? 0) + 1)
    const district = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
    return { artist, works: ws, district, first: ws[0]!.year }
  })

  // wedges by how many artists each district holds (a small one still gets room)
  const names = [...DISTRICTS.filter((d) => artists.some((a) => a.district === d)), ...new Set(artists.map((a) => a.district).filter((d) => !(DISTRICTS as readonly string[]).includes(d)))]
  const weight = names.map((d) => Math.max(0.03 * artists.length, artists.filter((a) => a.district === d).length))
  const total = weight.reduce((s, w) => s + w, 0)
  const free = Math.PI * 2 - AVENUE * names.length
  let a = -Math.PI / 2 - free * (weight[0]! / total) / 2
  const districts: DistrictPlace[] = names.map((name, i) => {
    const a0 = a, a1 = a + (free * weight[i]!) / total
    a = a1 + AVENUE
    return { name, a0, a1, decades: [] }
  })

  const buildings: Building[] = []
  const panelOf = new Map<string, Panel>()
  const buildingOf = new Map<string, Building>()
  let radius = PLAZA
  for (const d of districts) {
    const here = artists.filter((x) => x.district === d.name).sort((x, y) => x.first - y.first || x.artist.localeCompare(y.artist))
    // pack along ring bands: across the wedge, then a band further out
    let r = PLAZA, s = 0, depth = 0, lastDecade = -Infinity
    for (const x of here) {
      const width = widthFor(x.works.length)
      const side = width * MOD + 0.6
      // measured along the band's inner edge, where it is shortest, so neighbours never close in
      const arc = (d.a1 - d.a0) * r
      if (s > 0 && s + side > arc) ((r += depth + STREET), (s = 0), (depth = 0))
      // a narrow wedge near the plaza may be too narrow for even one: move out until it fits
      while (s === 0 && (d.a1 - d.a0) * r < side) r += STREET
      const decade = Math.floor(x.first / 10) * 10
      if (decade > lastDecade) ((lastDecade = decade), d.decades.push({ decade, r }))
      const rc = r + side / 2
      const angle = d.a0 + (s + side / 2) / r
      s += side + GAP
      depth = Math.max(depth, side)
      radius = Math.max(radius, rc + side / 2)
      buildings.push(build(x.artist, d.name, x.works, x.first, Math.cos(angle) * rc, Math.sin(angle) * rc, width, panelOf))
      buildingOf.set(x.artist, buildings.at(-1)!)
    }
  }
  return { buildings, districts, panelOf, buildingOf, radius }
}

/** a building at (x, z), its first face toward the plaza, its works on its facades from the ground floor up */
function build(artist: string, district: string, works: Manifest['works'], first: number, x: number, z: number, width: number, panelOf: Map<string, Panel>): Building {
  const half = (width * MOD + 0.6) / 2
  // face 0 looks toward the plaza; the others follow round
  const yaw = Math.atan2(-x, -z)
  const perFloor = 4 * width
  const floors = Math.max(1, Math.ceil(works.length / perFloor))
  const panels: Panel[] = works.map((w, k) => {
    const floor = Math.floor(k / perFloor), at = k % perFloor
    // a lone few take one face each, so a small building shows them all round
    const face = works.length <= 4 ? k : Math.floor(at / width)
    const col = works.length <= 4 ? 0 : at % width
    const fa = yaw + (face * Math.PI) / 2
    const nx = Math.sin(fa), nz = Math.cos(fa)
    // across the face: its right-hand direction
    const along = (col - (width - 1) / 2) * MOD
    const p: Panel = { work: w.id, x: x + nx * (half + 0.02) + nz * along, y: SILL + floor * FLOOR + PANEL.h / 2, z: z + nz * (half + 0.02) - nx * along, nx, nz }
    panelOf.set(w.id, p)
    return p
  })
  return { artist, district, x, z, half, yaw, height: SILL + floors * FLOOR + 0.25, width, floors, first, panels }
}

/**
 * Where the eye stands to look at a panel from `dist` away: out in front of it, nearly level up close, rising toward an
 * aerial view of the city as it draws back.
 */
export function viewOf(p: Panel, dist: number): { eye: { x: number; y: number; z: number }; at: { x: number; y: number; z: number } } {
  const t = Math.min(1, Math.max(0, (dist - 4) / 70))
  const el = 0.08 + 0.85 * t * t * (3 - 2 * t)
  const out = dist * Math.cos(el), up = dist * Math.sin(el)
  return { eye: { x: p.x + p.nx * out, y: p.y + up, z: p.z + p.nz * out }, at: { x: p.x, y: p.y, z: p.z } }
}
