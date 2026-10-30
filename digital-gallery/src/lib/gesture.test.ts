import { describe, expect, it } from 'vitest'
import { gesture, startPaused } from './gesture.ts'

describe('I.touch', () => {
  it('taps pause, swipes step, vertical or slow drags do nothing', () => {
    expect(gesture(2, -3, 120)).toBe('pause')
    expect(gesture(-90, 10, 220)).toBe('next')
    expect(gesture(90, -12, 220)).toBe('prev')
    expect(gesture(20, 140, 200)).toBe(null)
    expect(gesture(-90, 0, 1500)).toBe(null)
    expect(gesture(3, 2, 900)).toBe(null)
  })
})

describe('reduced motion', () => {
  it('starts paused when motion is reduced or the URL asks', () => {
    expect([startPaused(false, false), startPaused(false, true), startPaused(true, false)]).toEqual([false, true, true])
  })
})
