// Where the stage sits. The stage is a 16:9 box; every mode here fills the screen (field: A(DAI)'s own view of the
// commons; gallery, vortex and city: 3D views), so the stage only preloads the pictures, out of sight.

export type Mode = 'field' | 'gallery' | 'vortex' | 'city'
export const MODES: Mode[] = ['field', 'gallery', 'vortex', 'city']
export const nextMode = (m: Mode): Mode => MODES[(MODES.indexOf(m) + 1) % MODES.length]!

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  W: number
  H: number
  /** where the (hidden) stage sits; the pause glyph centres on it */
  stage: Rect
  portrait: boolean
  mode: Mode
}

export function layout(W: number, H: number, mode: Mode = 'gallery'): Layout {
  const portrait = H > W * 1.05
  if (portrait) {
    const w = W * 0.94
    const h = (w * 9) / 16
    return { W, H, stage: { x: (W - w) / 2, y: H * 0.6 - h / 2, w, h }, portrait, mode }
  }
  const w = Math.min(W * 0.54, (H * 0.62 * 16) / 9)
  const h = (w * 9) / 16
  return { W, H, stage: { x: W * 0.965 - w, y: H * 0.5 - h / 2, w, h }, portrait, mode }
}
