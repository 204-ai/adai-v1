// The top strip: the turn's works as ticks on the time axis.
export interface Axis {
  lo: number
  hi: number
}

/** pad the span a little so the first and last ticks are not on the edge */
export function axisOf(times: number[]): Axis {
  if (!times.length) return { lo: 0, hi: 1 }
  const lo = Math.min(...times), hi = Math.max(...times)
  const pad = Math.max((hi - lo) * 0.02, 0.01)
  return { lo: lo - pad, hi: hi + pad }
}

export const fracOf = (t: number, a: Axis) => (t - a.lo) / (a.hi - a.lo)
export const timeAt = (f: number, a: Axis) => a.lo + Math.min(1, Math.max(0, f)) * (a.hi - a.lo)

/** decade marks inside the span (lines only, no numbers on stage) */
export function decades(a: Axis): number[] {
  const out: number[] = []
  for (let y = Math.ceil(a.lo / 10) * 10; y <= a.hi; y += 10) out.push(y)
  return out
}

export type TickState = 'behind' | 'now' | 'ahead'
export const tickState = (index: number, pos: number): TickState => (index < pos ? 'behind' : index === pos ? 'now' : 'ahead')
