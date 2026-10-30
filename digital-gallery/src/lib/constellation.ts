// The open work's neighbourhood in the commons, laid out as a small constellation round it: its makers above, the
// makers' other works and their style kin either side of them, the concepts it embodies to the right, where it was
// shown and how it is classified below, and the works the commons finds visually close to the left. Each kind keeps
// its own arc, so the picture reads the same way for every work. Kept pure (no DOM) so it is tested.
import type { DetailArtist, RelKind, Related } from './detail.ts'

export const BOX = { w: 520, h: 440 }
const C = { x: BOX.w / 2, y: BOX.h / 2 }

type Kind = RelKind | 'maker'

export interface Star {
  id: string
  name: string
  slug: string
  type: string
  kind: Kind
  x: number
  y: number
  /** a picture (works) or a dot with a label */
  img?: string
  year?: number
  here?: boolean
  inferred?: boolean
  /** which way its label reads from it, and how far below it a centred label sits */
  anchor: 'start' | 'middle' | 'end'
  drop: number
  /** what it hangs from: the work in the middle, or a maker */
  from: { x: number; y: number }
}

/** each group's arc (degrees, 0 = right, clockwise) and distance from the middle; where and how it is kept share one */
type Group = 'maker' | 'sibling' | 'kin' | 'concept' | 'below' | 'affine'
const ARC: Record<Group, { a: [number, number]; r: number }> = {
  maker: { a: [-112, -68], r: 104 },
  sibling: { a: [-180, -114], r: 186 },
  kin: { a: [-64, -8], r: 176 },
  concept: { a: [-6, 52], r: 150 },
  below: { a: [62, 138], r: 140 },
  affine: { a: [150, 212], r: 176 },
}

const spread = (n: number, [a0, a1]: [number, number]) => (n === 1 ? [(a0 + a1) / 2] : Array.from({ length: n }, (_, i) => a0 + ((a1 - a0) * i) / (n - 1)))

export function constellation(artists: DetailArtist[], related: Related[]): Star[] {
  const stars: Star[] = []
  const place = (group: Group, items: Array<Omit<Star, 'x' | 'y' | 'anchor' | 'drop' | 'from'>>, from: { x: number; y: number }) => {
    const angles = spread(items.length, ARC[group].a)
    items.forEach((it, i) => {
      const a = (angles[i]! * Math.PI) / 180
      // labels of neighbours alternate a little in and out, so they do not run into each other
      const r = ARC[group].r + (items.length > 3 && !it.img ? (i % 2 ? 14 : -10) : 0)
      const x = C.x + Math.cos(a) * r, y = C.y + Math.sin(a) * r
      const c = Math.cos(a)
      const anchor = Math.abs(c) < 0.12 ? 'middle' : c > 0 ? 'start' : 'end'
      stars.push({ ...it, x, y, anchor, drop: i % 2 ? 30 : 16, from })
    })
  }
  const as = (r: Related) => ({ ...r, kind: r.rel as Kind })
  place('maker', artists.slice(0, 3).map((a) => ({ id: a.id, name: a.name, slug: a.slug, type: a.type, kind: 'maker' as const })), C)
  const maker = stars[0] ? { x: stars[0].x, y: stars[0].y } : C
  place('sibling', related.filter((r) => r.rel === 'sibling').map(as), maker)
  place('kin', related.filter((r) => r.rel === 'kin').map(as), maker)
  place('concept', related.filter((r) => r.rel === 'concept').map(as), C)
  place('below', related.filter((r) => r.rel === 'holder' || r.rel === 'venue' || r.rel === 'regime').map(as), C)
  place('affine', related.filter((r) => r.rel === 'affine').map(as), C)
  return stars
}

/** a gently bowed line from one star to another, as an SVG path */
export function bow(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  const dx = b.x - a.x, dy = b.y - a.y
  const k = 0.12
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${(mx - dy * k).toFixed(1)} ${(my + dx * k).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
}

export const CENTRE = C
