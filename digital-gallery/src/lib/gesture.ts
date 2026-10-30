// a pointer stroke on the stage → an action. Tap pauses (mind.lol's click), a horizontal swipe steps.
import type { Action } from './keys.ts'

export function gesture(dx: number, dy: number, ms: number): Action | null {
  const ax = Math.abs(dx), ay = Math.abs(dy)
  if (ax < 10 && ay < 10 && ms < 500) return 'pause'
  if (ax >= 40 && ax > ay * 1.5 && ms < 800) return dx < 0 ? 'next' : 'prev'
  return null
}

/** reduced motion starts paused, as does ?paused=1. */
export const startPaused = (asked: boolean, reducedMotion: boolean) => asked || reducedMotion
