// The vortex: spacetime as a sheet, drawn down into a well. The viewer stands a little above the sheet and looks across
// it; ahead, the sheet curves down into a throat (a surface of revolution round a vertical axis, height falling off like
// a gravity well, its shoulders rounded toward the viewer). The works tile the slope densely along one spiral wound
// round the throat, each a fixed share of the sheet, so they follow its curve. As the run moves on they slide along the
// spiral toward the throat: the work on stage lifts off the sheet and floats in front of the viewer, then sinks back
// and falls down the throat. The whole spiral turns slowly. Places are given by k, a work's place in the run relative to
// the stage (continuous: 0.5 is halfway to the next). y is up; the viewer looks down -z.

/** where the well's axis stands, and how high above the flat sheet the viewer's eye is */
export const CENTRE = { x: 0, z: -15 }
export const EYE = 2.8
/** the well's depth and the width of its shoulders: height at radius ρ is -DEPTH · (SHOULDER / (ρ + SHOULDER))² */
export const DEPTH = 13
export const SHOULDER = 2.2
export const heightAt = (rho: number) => -DEPTH * (SHOULDER / (Math.max(0, rho) + SHOULDER)) ** 2
/** the slope of the sheet at radius ρ (rise per unit outward) */
export const slopeAt = (rho: number) => (2 * DEPTH * SHOULDER ** 2) / (Math.max(0, rho) + SHOULDER) ** 3

/** the spiral: arms PITCH apart, works SPACING apart along it, the work on stage at radius STAGE_R */
export const PITCH = 1.55
export const SPACING = 1.6
export const STAGE_R = 2.4
/** how fast the whole spiral turns (radians a second) */
export const SPIN = 0.025
/** how many works ahead of the stage the sheet shows, and behind it (falling down the throat) */
export const AHEAD = 150
export const BEHIND = 5
/** where the work on stage floats: in front of the viewer, a little below the eye */
export const STAGE = { x: 0, y: EYE - 0.55, z: -7.4 }
/** the box a work on stage fits in, and one on the sheet */
export const STAGE_BOX = { w: 2.2, h: 1.65 }
export const SHEET_BOX = { w: SPACING * 0.84, h: PITCH * 0.8 }

export interface Place {
  x: number
  y: number
  z: number
  /** radius from the axis and angle round it */
  rho: number
  angle: number
  /** 0 = on the sheet, 1 = floating on stage */
  eye: number
  box: { w: number; h: number }
  /** 1 = fully seen; fading in at the far edge, and out down the throat */
  fade: number
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))

/** how fast the radius changes per work just at the stage (the spiral carried on smoothly past it) */
const DRHO0 = (SPACING * PITCH) / (2 * Math.PI * STAGE_R)

/** the radius of work k: each work a SPACING × PITCH share of the sheet outward; past the stage, on down the throat */
export function rhoOf(k: number): number {
  if (k >= 0) return Math.sqrt(STAGE_R ** 2 + (k * SPACING * PITCH) / Math.PI)
  return Math.max(0.25, STAGE_R + k * DRHO0 * 1.6)
}

/** where work k sits at time t (seconds) */
export function place(k: number, t: number): Place {
  const rho = rhoOf(k)
  // an Archimedean spiral: one turn per PITCH of radius
  const angle = (2 * Math.PI * (rho - STAGE_R)) / PITCH + SPIN * t
  const eye = 1 - smooth(Math.min(1, Math.abs(k) / 1.3))
  const sx = CENTRE.x + Math.sin(angle) * rho, sz = CENTRE.z + Math.cos(angle) * rho, sy = heightAt(rho)
  const lerp = (a: number, b: number) => a + (b - a) * eye
  return {
    x: lerp(sx, STAGE.x),
    y: lerp(sy, STAGE.y),
    z: lerp(sz, STAGE.z),
    rho,
    angle,
    eye,
    box: { w: lerp(SHEET_BOX.w, STAGE_BOX.w), h: lerp(SHEET_BOX.h, STAGE_BOX.h) },
    fade: smooth((AHEAD - k) / 20) * smooth((BEHIND + k) / 3),
  }
}

/** the works (as indices into the run) the sheet shows around position `at` (stage index plus progress) */
export function shown(at: number, count: number): [number, number] {
  return [Math.max(0, Math.ceil(at - BEHIND)), Math.min(count - 1, Math.floor(at + AHEAD))]
}

/** the size a work shows at in its box: as large as fits, its own aspect */
export function fit(aspect: number, box: { w: number; h: number }): { w: number; h: number } {
  const w = Math.min(box.w, box.h * aspect)
  return { w, h: w / aspect }
}

// The jump into the wormhole: a path for the eye from where it stands, forward and level over the sheet, curving down
// over the throat and straight down into it (a cubic Bézier: it leaves level and arrives heading straight down).
const DIVE = [
  { x: 0, y: EYE, z: 0 },
  { x: 0, y: EYE, z: CENTRE.z * 0.72 },
  { x: CENTRE.x, y: EYE * 0.45, z: CENTRE.z },
  { x: CENTRE.x, y: heightAt(0.2) + 0.6, z: CENTRE.z },
]

/** the eye's place at e (0 = standing, 1 = deep in the throat) */
export function divePoint(e: number): { x: number; y: number; z: number } {
  const u = 1 - e
  const w = [u * u * u, 3 * u * u * e, 3 * u * e * e, e * e * e]
  const at = (k: 'x' | 'y' | 'z') => DIVE.reduce((s, p, i) => s + p[k] * w[i]!, 0)
  return { x: at('x'), y: at('y'), z: at('z') }
}

/** the way the eye heads at e (not normalised) */
export function diveHeading(e: number): { x: number; y: number; z: number } {
  const u = 1 - e
  const w = [-3 * u * u, 3 * u * u - 6 * u * e, 6 * u * e - 3 * e * e, 3 * e * e]
  const at = (k: 'x' | 'y' | 'z') => DIVE.reduce((s, p, i) => s + p[k] * w[i]!, 0)
  return { x: at('x'), y: at('y'), z: at('z') }
}

/** Where the wormhole lets out: a place in the run (of `count`) at least a quarter of it away from `pos`, chosen by r (0..1). */
export function wormholeExit(pos: number, count: number, r: number): number {
  if (count < 2) return pos
  const away = Math.floor(count * 0.25 + r * count * 0.5)
  return (pos + Math.max(1, away)) % count
}
