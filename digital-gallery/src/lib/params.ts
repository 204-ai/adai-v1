// url: ?work= ?artist= ?seed= ?fuzz=0..1 ?hold=seconds ?paused=1 ?mode=field|gallery|vortex|city ?field=<A(DAI) base url>
import { DEFAULT_FUZZ } from './braid.ts'
import { MODES, type Mode } from './layout.ts'

export interface Settings {
  seed: number
  fuzz: number
  /** seconds each work holds the stage */
  hold: number
  /** an artwork slug */
  work: string | null
  /** a practitioner or collective slug */
  artist: string | null
  paused: boolean
  mode: Mode
}

export const DEFAULT_HOLD = 4
/** the view it opens on: A(DAI)'s own, the field (the original this app's views stand beside) */
export const DEFAULT_MODE: Mode = 'field'

// A(DAI) slugs are lowercase ASCII with hyphens; nodes made before October 2026 may keep an accent or a '#'
const slug = (s: string | null) => (s && /^[^\s/?<>"'\\]{1,120}$/.test(s) && !s.includes('..') ? s : null)

export function parseParams(search: string, random: () => number = Math.random): Settings {
  const q = new URLSearchParams(search)
  const seedRaw = q.get('seed')
  const seed = seedRaw !== null && /^\d{1,10}$/.test(seedRaw) ? Number(seedRaw) % 4294967296 : Math.floor(random() * 1e6)
  const fuzzRaw = Number(q.get('fuzz'))
  const fuzz = q.get('fuzz') !== null && Number.isFinite(fuzzRaw) ? Math.min(1, Math.max(0, fuzzRaw)) : DEFAULT_FUZZ
  const holdRaw = Number(q.get('hold'))
  const hold = q.get('hold') !== null && Number.isFinite(holdRaw) ? Math.min(60, Math.max(1, holdRaw)) : DEFAULT_HOLD
  return {
    seed,
    fuzz,
    hold,
    work: slug(q.get('work')),
    artist: slug(q.get('artist')),
    paused: ['1', 'true', 'yes'].includes(q.get('paused') ?? ''),
    mode: MODES.find((m) => m === q.get('mode')) ?? DEFAULT_MODE,
  }
}
