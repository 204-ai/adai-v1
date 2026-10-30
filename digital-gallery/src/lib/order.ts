// Where the coil is: turn number and position, across turn boundaries (each turn re-braids).
import { braid, type BraidItem } from './braid.ts'

export interface OrderOpts {
  seed: number
  fuzz: number
}

export class CoilOrder {
  turn = 0
  pos = 0
  private turns = new Map<number, string[]>()
  private items: BraidItem[]
  private opts: OrderOpts

  constructor(items: BraidItem[], opts: OrderOpts) {
    this.items = items
    this.opts = opts
  }

  orderOf(turn: number): string[] {
    let o = this.turns.get(turn)
    if (!o) {
      o = braid(this.items, { ...this.opts, turn })
      this.turns.set(turn, o)
      // keep the cache small: the coil only ever looks one turn either side
      for (const t of this.turns.keys()) if (Math.abs(t - turn) > 2) this.turns.delete(t)
    }
    return o
  }

  get length(): number {
    return this.items.length
  }

  current(): string {
    return this.orderOf(this.turn)[this.pos]!
  }

  /** The work `d` steps from here (d ≥ 0), across turn boundaries, without moving. */
  peek(d = 1): string {
    let turn = this.turn, pos = this.pos + d
    while (pos >= this.length) (pos -= this.length, turn++)
    return this.orderOf(turn)[pos]!
  }

  next(): string {
    if (++this.pos >= this.length) (this.pos = 0, this.turn++)
    return this.current()
  }

  prev(): string {
    if (this.pos > 0) this.pos--
    else if (this.turn > 0) (this.turn--, (this.pos = this.length - 1))
    return this.current()
  }

  /** Move to a work in the current turn; returns false when it is not in the pool. */
  jumpTo(id: string): boolean {
    const i = this.orderOf(this.turn).indexOf(id)
    if (i < 0) return false
    this.pos = i
    return true
  }

  /** Start on a work, else on an artist's first work of the turn, else at the beginning of time. */
  startAt(at: { work?: string | null; artist?: string | null }, artistOf: (id: string) => string | undefined): void {
    if (at.work && this.jumpTo(at.work)) return
    if (at.artist) {
      const i = this.orderOf(this.turn).findIndex((id) => artistOf(id) === at.artist)
      if (i >= 0) this.pos = i
    }
  }

  /** Index of the work of this turn nearest a point in time (timeline click). */
  indexAtTime(t: number, timeOf: (id: string) => number): number {
    const o = this.orderOf(this.turn)
    let best = 0, bestD = Infinity
    o.forEach((id, i) => {
      const d = Math.abs(timeOf(id) - t)
      if (d < bestD) (best = i, (bestD = d))
    })
    return best
  }
}
