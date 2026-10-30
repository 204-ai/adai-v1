// The coil's order for one turn: each artist's works go in their own time order, cut into chunks of 2-4; the chunks of
// all artists merge by their place in time, nudged by a seeded jitter so it runs forward through time to a degree.
import { mulberry32, seedOf } from './rng.ts'

export interface BraidItem {
  id: string
  artist: string
  year: number
}

export interface BraidOpts {
  seed: number
  turn: number
  /** jitter as a fraction of the time span: 0 = strict order */
  fuzz: number
  chunk?: [number, number]
}

export const CHUNK: [number, number] = [2, 4]
export const DEFAULT_FUZZ = 0.02

export function span(items: BraidItem[]): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (const c of items) {
    if (c.year < lo) lo = c.year
    if (c.year > hi) hi = c.year
  }
  return items.length ? [lo, hi] : [0, 0]
}

export interface Chunk {
  artist: string
  ids: string[]
  key: number
}

const byTime = (a: BraidItem, b: BraidItem) => a.year - b.year || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Each artist's works in time order, cut into chunks, each with its jittered key. Artists go in id order (determinism). */
export function chunksFor(items: BraidItem[], o: BraidOpts): Chunk[] {
  const rng = mulberry32(seedOf(o.seed, o.turn))
  const [cmin, cmax] = o.chunk ?? CHUNK
  const [lo, hi] = span(items)
  const jitter = Math.max(0, o.fuzz) * (hi - lo)
  const byArtist = new Map<string, BraidItem[]>()
  for (const c of items) {
    const list = byArtist.get(c.artist)
    if (list) list.push(c)
    else byArtist.set(c.artist, [c])
  }
  const out: Chunk[] = []
  for (const artist of [...byArtist.keys()].sort()) {
    const mine = byArtist.get(artist)!.sort(byTime)
    for (let i = 0; i < mine.length; ) {
      const size = cmin + Math.floor(rng() * (cmax - cmin + 1))
      const part = mine.slice(i, i + size)
      out.push({ artist, ids: part.map((c) => c.id), key: part[0]!.year + (rng() * 2 - 1) * jitter })
      i += size
    }
  }
  return out
}

/** One turn: the chunks in key order (ties → artist id). Each artist's chunks keep their order. */
export function braid(items: BraidItem[], o: BraidOpts): string[] {
  const chunks = chunksFor(items, o)
  // an artist's later chunk may draw an earlier key than its previous one; keep the artist's own order by never letting
  // a chunk's key fall below the one before it
  const last = new Map<string, number>()
  for (const ch of chunks) {
    const prev = last.get(ch.artist)
    if (prev !== undefined && ch.key < prev) ch.key = prev
    last.set(ch.artist, ch.key)
  }
  chunks.sort((a, b) => a.key - b.key || (a.artist < b.artist ? -1 : a.artist > b.artist ? 1 : 0))
  return chunks.flatMap((c) => c.ids)
}
