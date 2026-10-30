// The stage: two pooled <img> slots, fed by the coil's order. Each work holds the stage for `hold` ms; the next one is
// decoded in the idle slot before it takes the stage, so a swap never shows an empty frame. Works that fail to load
// are skipped in the direction of travel.
import type { CoilOrder } from './order.ts'

export interface StepperHooks {
  /** a work took the stage in this slot */
  show: (id: string, slot: 0 | 1) => void
  /** a work left the stage */
  retire: (id: string) => void
  error: (id: string) => void
}

export interface Slot {
  src: string
  decode: () => Promise<void>
}

export interface Clock {
  now: () => number
  set: (fn: () => void, ms: number) => number
  clear: (t: number) => void
}

const realClock: Clock = { now: () => performance.now(), set: (fn, ms) => window.setTimeout(fn, ms), clear: (t) => window.clearTimeout(t) }

/** give up on a run of broken images after this many */
const MAX_SKIPS = 8

export class Stepper {
  userPaused = false
  private blurred = false
  private held = false
  private slot: 0 | 1 = 0
  private onStage: string | null = null
  private token = 0
  private timer = 0
  private deadline = 0
  private remaining: number
  private alive = true
  private warm = new Map<string, HTMLImageElement>()
  private slots: [Slot, Slot]
  private srcOf: (id: string) => string
  private order: CoilOrder
  private hooks: StepperHooks
  private hold: number
  private clock: Clock
  private preload: (src: string) => void

  constructor(slots: [Slot, Slot], srcOf: (id: string) => string, order: CoilOrder, hooks: StepperHooks, opts: { hold: number; clock?: Clock; preload?: (src: string) => void }) {
    this.slots = slots
    this.srcOf = srcOf
    this.order = order
    this.hooks = hooks
    this.hold = opts.hold
    this.remaining = opts.hold
    this.clock = opts.clock ?? realClock
    this.preload = opts.preload ?? ((src) => this.warmUp(src))
  }

  get paused(): boolean {
    return this.userPaused || this.blurred || this.held
  }

  start(): void {
    void this.go(this.order.current(), 1)
  }

  setUserPaused(p: boolean): void {
    this.userPaused = p
    this.retime()
  }

  /** the window lost focus: hold still until it comes back */
  setBlurred(b: boolean): void {
    this.blurred = b
    this.retime()
  }

  /** a work is open for a closer look: hold still until it is closed */
  setHeld(b: boolean): void {
    this.held = b
    this.retime()
  }

  advance(): void {
    void this.go(this.order.next(), 1)
  }

  back(): void {
    void this.go(this.order.prev(), -1)
  }

  jump(id: string): void {
    if (this.order.jumpTo(id)) void this.go(id, 1)
  }

  dispose(): void {
    this.alive = false
    this.clock.clear(this.timer)
    this.warm.clear()
  }

  /** Decode `id` in the idle slot, then swap it in. A newer request wins over an older one still decoding. */
  private async go(id: string, dir: 1 | -1, skips = 0): Promise<void> {
    const mine = ++this.token
    this.clock.clear(this.timer)
    const next: 0 | 1 = this.onStage === null ? this.slot : this.slot === 0 ? 1 : 0
    const el = this.slots[next]
    el.src = this.srcOf(id)
    try {
      await el.decode()
    } catch {
      if (!this.alive || mine !== this.token) return
      this.hooks.error(id)
      if (skips >= MAX_SKIPS) return
      return this.go(dir === 1 ? this.order.next() : this.order.prev(), dir, skips + 1)
    }
    if (!this.alive || mine !== this.token) return
    const out = this.onStage
    this.slot = next
    this.onStage = id
    this.hooks.show(id, next)
    if (out !== null && out !== id) this.hooks.retire(out)
    this.remaining = this.hold
    this.retime()
    this.preload(this.srcOf(this.order.peek(1)))
    this.preload(this.srcOf(this.order.peek(2)))
  }

  /** (Re)arm the hold timer from what is left of it, or freeze what is left while paused. */
  private retime(): void {
    if (!this.alive || this.onStage === null) return
    this.clock.clear(this.timer)
    if (this.paused) {
      if (this.deadline) this.remaining = Math.max(0, this.deadline - this.clock.now())
      this.deadline = 0
      return
    }
    this.deadline = this.clock.now() + this.remaining
    this.timer = this.clock.set(() => {
      this.deadline = 0
      this.advance()
    }, this.remaining)
  }

  private warmUp(src: string): void {
    if (this.warm.has(src)) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.src = src
    this.warm.set(src, img)
    // keep the cache small: the next two and a few behind
    if (this.warm.size > 6) this.warm.delete(this.warm.keys().next().value!)
  }
}
