import { describe, expect, it } from 'vitest'
import type { BraidItem } from './braid.ts'
import { CoilOrder } from './order.ts'

const clips: BraidItem[] = Array.from({ length: 6 }, (_, i) => ({ id: `w${i % 2}-${i}`, artist: `w${i % 2}`, year: 1965 + i * 10 }))
const make = () => new CoilOrder(clips, { seed: 3, fuzz: 0.02 })

describe('coil order across turns', () => {
  it('wraps into a re-braided next turn', () => {
    const o = make()
    for (let i = 0; i < clips.length; i++) o.next()
    expect([o.turn, o.pos]).toEqual([1, 0])
    expect(o.current()).toBe(o.orderOf(1)[0])
  })
  it('peeks across the turn boundary without moving', () => {
    const o = make()
    o.pos = clips.length - 1
    expect(o.peek(1)).toBe(o.orderOf(1)[0])
    expect([o.turn, o.pos]).toEqual([0, clips.length - 1])
  })
  it('steps back into the previous turn, never before the first', () => {
    const o = make()
    o.prev()
    expect([o.turn, o.pos]).toEqual([0, 0])
    o.turn = 1
    o.pos = 0
    o.prev()
    expect([o.turn, o.pos]).toEqual([0, clips.length - 1])
  })
  it('starts on a work or an artist', () => {
    const o = make()
    o.startAt({ work: 'w1-3' }, () => undefined)
    expect(o.current()).toBe('w1-3')
    const p = make()
    p.startAt({ artist: 'w1' }, (id) => id.split('-')[0])
    expect(p.current().startsWith('w1-')).toBe(true)
  })
})
