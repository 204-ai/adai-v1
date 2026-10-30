import { describe, expect, it } from 'vitest'
import type { BraidItem } from './braid.ts'
import { CoilOrder } from './order.ts'
import { Stepper, type Clock, type Slot } from './stepper.ts'

/** a hand-wound clock: timers fire only when the test moves time on */
function fakeClock() {
  let t = 0, nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    now: () => t,
    set: (fn, ms) => (timers.set(nextId, { at: t + ms, fn }), nextId++),
    clear: (id) => void timers.delete(id),
  }
  const tick = (ms: number) => {
    t += ms
    for (const [id, x] of [...timers]) if (x.at <= t) (timers.delete(id), x.fn())
  }
  return { clock, tick }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(broken: string[] = []) {
  const items: BraidItem[] = Array.from({ length: 5 }, (_, i) => ({ id: `w${i}`, artist: `a${i}`, year: 1970 + i }))
  const order = new CoilOrder(items, { seed: 1, fuzz: 0 })
  const slot = (): Slot => {
    const s: Slot = { src: '', decode: () => (broken.some((b) => s.src.endsWith(b)) ? Promise.reject(new Error('404')) : Promise.resolve()) }
    return s
  }
  const slots: [Slot, Slot] = [slot(), slot()]
  const log: string[] = []
  const { clock, tick } = fakeClock()
  const s = new Stepper(slots, (id) => `/img/${id}`, order, { show: (id, n) => log.push(`show ${id}@${n}`), retire: (id) => log.push(`retire ${id}`), error: (id) => log.push(`error ${id}`) }, { hold: 4000, clock, preload: () => undefined })
  return { s, order, slots, log, tick }
}

describe('stepper', () => {
  it('shows the first work, then the next every hold, alternating slots', async () => {
    const { s, log, tick } = setup()
    s.start()
    await flush()
    expect(log).toEqual(['show w0@0'])
    tick(4000)
    await flush()
    expect(log).toEqual(['show w0@0', 'show w1@1', 'retire w0'])
    tick(3999)
    await flush()
    expect(log).toHaveLength(3)
    tick(1)
    await flush()
    expect(log.at(-2)).toBe('show w2@0')
  })
  it('keeps what is left of the hold across a pause', async () => {
    const { s, log, tick } = setup()
    s.start()
    await flush()
    tick(3000)
    s.setUserPaused(true)
    tick(60000)
    await flush()
    expect(log).toEqual(['show w0@0'])
    s.setUserPaused(false)
    tick(999)
    await flush()
    expect(log).toHaveLength(1)
    tick(1)
    await flush()
    expect(log[1]).toBe('show w1@1')
  })
  it('holds while blurred, and a user pause survives the focus coming back', async () => {
    const { s, log, tick } = setup()
    s.start()
    await flush()
    s.setBlurred(true)
    s.setUserPaused(true)
    s.setBlurred(false)
    expect(s.paused).toBe(true)
    tick(10000)
    await flush()
    expect(log).toHaveLength(1)
  })
  it('holds while a work is open, and goes on where it left off once it is closed', async () => {
    const { s, log, tick } = setup()
    s.start()
    await flush()
    tick(1000)
    s.setHeld(true)
    expect(s.paused).toBe(true)
    tick(60000)
    await flush()
    expect(log).toHaveLength(1)
    s.setHeld(false)
    tick(2999)
    await flush()
    expect(log).toHaveLength(1)
    tick(1)
    await flush()
    expect(log[1]).toBe('show w1@1')
  })
  it('skips a broken image in the direction of travel', async () => {
    const { s, log, tick } = setup(['w1'])
    s.start()
    await flush()
    tick(4000)
    await flush()
    await flush()
    expect(log).toEqual(['show w0@0', 'error w1', 'show w2@1', 'retire w0'])
  })
  it('lets the newest request win over one still decoding', async () => {
    const { s, order, log } = setup()
    s.start()
    await flush()
    s.advance()
    s.advance()
    await flush()
    expect(order.current()).toBe('w2')
    expect(log).toEqual(['show w0@0', 'show w2@1', 'retire w0'])
  })
  it('does nothing after dispose', async () => {
    const { s, log, tick } = setup()
    s.start()
    await flush()
    s.dispose()
    tick(10000)
    await flush()
    expect(log).toEqual(['show w0@0'])
  })
})
