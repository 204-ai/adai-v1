// Two small pieces of the gallery's hands-on side, kept pure so they are tested.
//
// The wheel: scrolling moves the walk itself. `lead` is how far (in works) the wheel has taken the eye past where the
// run is; once the run's own progress plus the lead reaches the next work, the run steps there and the lead keeps the
// remainder, so the eye never jumps. Back a work once it is half a work behind.
//
// The open work: where the panel sits and where on the screen the work is framed beside it.

/** wheel travel (CSS px) per work */
export const WHEEL_PER_WORK = 320

/** a wheel event's travel in works, positive forward (scrolling up) */
export function wheelWorks(e: { deltaY: number; deltaMode: number }): number {
  const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY
  return -px / WHEEL_PER_WORK
}

/** Settle the lead against the run's progress on the work on stage (0..1): which way to step, and the lead left after it. */
export function settle(progress: number, lead: number): { step: number; lead: number } {
  let v = progress + lead
  let step = 0
  // the run restarts its progress at 0 on each new work
  while (v >= 1) (step++, (v -= 1))
  while (v < -0.5) (step--, (v += 1))
  return { step, lead: step ? v : lead }
}

export interface PanelFrame {
  /** the panel: beside the work on a wide screen, under it on a tall one */
  side: 'right' | 'bottom'
  /** its width (side right) or height (side bottom) in CSS px */
  size: number
  /** the share of the screen's width and height the work may fill, and where its centre sits (normalised device coordinates) */
  fw: number
  fh: number
  ox: number
  oy: number
}

export function panelFrame(W: number, H: number): PanelFrame {
  if (W >= H * 1.05) {
    const size = Math.min(W * 0.44, 560)
    const free = W - size
    return { side: 'right', size, fw: (free * 0.8) / W, fh: 0.7, ox: free / W - 1, oy: 0.03 }
  }
  const size = H * 0.52
  const free = H - size
  return { side: 'bottom', size, fw: 0.86, fh: (free * 0.78) / H, ox: 0, oy: 1 - free / H }
}
