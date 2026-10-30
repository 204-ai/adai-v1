import { describe, expect, it } from 'vitest'
import { parseParams } from './params.ts'

describe('url', () => {
  it('reads every parameter', () => {
    expect(parseParams('?work=fidenza&artist=tyler-hobbs&seed=42&fuzz=0.2&hold=6&paused=1&mode=city')).toEqual({ seed: 42, fuzz: 0.2, hold: 6, work: 'fidenza', artist: 'tyler-hobbs', paused: true, mode: 'city' })
  })
  it('falls back to a random seed, the default fuzz and hold, playing', () => {
    expect(parseParams('', () => 0.5)).toEqual({ seed: 500000, fuzz: 0.02, hold: 4, work: null, artist: null, paused: false, mode: 'field' })
  })
  it('clamps fuzz and hold and ignores junk', () => {
    const p = parseParams('?fuzz=7&seed=-3&work=../x&hold=0&paused=0', () => 0)
    expect([p.fuzz, p.seed, p.work, p.hold, p.paused]).toEqual([1, 0, null, 1, false])
    expect(parseParams('?fuzz=0').fuzz).toBe(0)
    expect(parseParams('?mode=helter-skelter').mode).toBe('field')
    expect(parseParams('?mode=gallery').mode).toBe('gallery')
    expect(parseParams('?mode=vortex').mode).toBe('vortex')
    expect(parseParams('?mode=city').mode).toBe('city')
    // the views this fork left out fall back to the field
    for (const gone of ['spiral', 'coilendar', 'tunnel']) expect(parseParams(`?mode=${gone}`).mode).toBe('field')
  })
  it('keeps legacy slugs with accents', () => {
    expect(parseParams('?work=toujours-là').work).toBe('toujours-là')
  })
})
