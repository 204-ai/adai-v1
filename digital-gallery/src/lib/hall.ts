// The gallery: works suspended in the dark, each on two cables from above, in one line running into the void, -z ahead.
// The turn's works hang in its order on either side of the walk, staggered (left, right, left …) so every work moves the
// walk on by half a bay. A decade floats overhead where the walk first reaches a new one, and a card floats before the
// first work of each run of one artist's works. The scene is seen through one depth-aware pass: the real picture up to
// and a little past the focus, about a third of the way into the view, then ASCII on into the distance.

/** how far the walk moves along z for each pair of works */
export const BAY = 4.6
/** how far off the walk the works hang, and how far (radians) they turn from facing down it toward it */
export const HANG_X = 2.8
export const HANG_TURN = 0.9
/** eye height, and the height the works hang at (their centre) */
export const EYE_Y = 1.6
export const HANG_Y = 1.85
/** where the cables vanish overhead */
export const CABLE_TOP = 14
/** the largest a work hangs: width × height in world units */
export const MAX_W = 2.4
export const MAX_H = 2.1
/** how far ahead of the eye the work on stage sits */
export const FOCUS = 9
/** how far past the focus the picture stays real, then how far it takes to turn into ASCII */
export const SHARP = 2.2
export const SOFT = 2.6
/** how many bays the gallery builds behind and ahead of the eye */
export const BEHIND = 2
export const AHEAD = 11

export type Side = -1 | 1

/** left (-1) or right (1) */
export const sideOf = (i: number): Side => (i % 2 === 0 ? -1 : 1)

/** z of the i-th work of the turn: left works sit a quarter into their bay, right ones three quarters */
export const zOf = (i: number) => -(Math.floor(i / 2) + (i % 2 === 0 ? 0.25 : 0.75)) * BAY

/** the bay a point along the walk is in */
export const bayAt = (z: number) => Math.floor(-z / BAY)

/** where the eye stands to have work i (plus a fraction of the way to the next) at the focus */
export const eyeZ = (i: number, frac = 0) => zOf(i) - (frac * BAY) / 2 + FOCUS

/** the size a work hangs at: as large as fits the box, its own aspect */
export function hangSize(aspect: number): { w: number; h: number } {
  const w = Math.min(MAX_W, MAX_H * aspect)
  return { w, h: w / aspect }
}

/** 1 = the real picture, 0 = ASCII, by distance from the eye (the shader does the same per pixel): real up close */
export function sharpness(d: number): number {
  const x = (d - FOCUS - SHARP) / SOFT
  if (x <= 0) return 1
  if (x >= 1) return 0
  return 1 - x * x * (3 - 2 * x)
}

export interface Marker {
  /** the bay boundary it floats over: z = -bay × BAY */
  bay: number
  decade: number
}

/** A marker at the start of the first bay that reaches a decade later than any before it (the braid wobbles in time). */
export function markersFor(years: number[]): Marker[] {
  const out: Marker[] = []
  let top = -Infinity
  for (let i = 0; i < years.length; i++) {
    const decade = Math.floor(years[i]! / 10) * 10
    if (decade > top) {
      top = decade
      const bay = Math.floor(i / 2)
      if (out.at(-1)?.bay === bay) out[out.length - 1] = { bay, decade }
      else out.push({ bay, decade })
    }
  }
  return out
}

/** Indices where a run of one artist's works begins: each gets a floating card. */
export function cardStarts(artists: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < artists.length; i++) if (i === 0 || artists[i] !== artists[i - 1]) out.push(i)
  return out
}

/** the works whose bays are within view of an eye at z */
export function inView(eye: number, count: number): [number, number] {
  const bay = bayAt(eye)
  return [Math.max(0, (bay - BEHIND) * 2), Math.min(count - 1, (bay + AHEAD) * 2 + 1)]
}
