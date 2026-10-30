// Camera motion with no jolts. A critically damped spring moves a value toward its target with no jump in position or
// speed, however the target jumps; a glide is a spring that, asked to go farther than it should travel, coasts to a
// stop while the view fades to black, lands at the target unseen and fades back in. The pointer's look is a pair of
// springs toward where the pointer is.

export interface Spring {
  x: number
  v: number
}

/** Step a critically damped spring toward `target`; `omega` is its stiffness (≈ 1 / response time in seconds). */
export function spring(s: Spring, target: number, omega: number, dt: number): void {
  const x = s.x - target
  const e = Math.exp(-omega * dt)
  const k = (s.v + omega * x) * dt
  s.v = (s.v - omega * k) * e
  s.x = target + (x + k) * e
}

/** how long a fade out (and the fade back in) of a long glide takes, in seconds */
export const LEAP = 0.45

export class Glide {
  readonly at: Spring
  /** 1 = the view is seen, 0 = black */
  fade = 1
  /** true for the one update on which the glide landed at a far target */
  landed = false
  private leaping = false
  private omega: number
  private far: number

  constructor(x: number, omega: number, far: number) {
    this.at = { x, v: 0 }
    this.omega = omega
    this.far = far
  }

  /** Be at x now, at rest and seen: for a jump made out of sight by someone else (the wormhole). */
  snap(x: number): void {
    Object.assign(this.at, { x, v: 0 })
    this.leaping = false
    this.fade = 1
  }

  update(target: number, dt: number): void {
    this.landed = false
    if (!this.leaping && Math.abs(target - this.at.x) > this.far) this.leaping = true
    if (this.leaping) {
      // coast to a stop while the view goes dark, then arrive
      this.at.v *= Math.exp(-dt * 5)
      this.at.x += this.at.v * dt
      this.fade = Math.max(0, this.fade - dt / LEAP)
      if (this.fade === 0) {
        this.at.x = target
        this.at.v = 0
        this.leaping = false
        this.landed = true
      }
      return
    }
    spring(this.at, target, this.omega, dt)
    this.fade = Math.min(1, this.fade + dt / LEAP)
  }
}

/** The pointer's look: yaw and pitch (radians) easing toward the pointer, back to straight ahead when it leaves. */
export class Look {
  readonly yaw: Spring = { x: 0, v: 0 }
  readonly pitch: Spring = { x: 0, v: 0 }
  private to = { x: 0, y: 0 }
  private range: { yaw: number; pitch: number }
  private omega: number

  constructor(range: { yaw: number; pitch: number }, omega = 2.2) {
    this.range = range
    this.omega = omega
  }

  /** the pointer at (x, y), each -1..1 from the centre of the screen, y up; null when it left */
  point(p: { x: number; y: number } | null): void {
    this.to = p ? { x: Math.max(-1, Math.min(1, p.x)), y: Math.max(-1, Math.min(1, p.y)) } : { x: 0, y: 0 }
  }

  update(dt: number): void {
    spring(this.yaw, -this.to.x * this.range.yaw, this.omega, dt)
    spring(this.pitch, this.to.y * this.range.pitch, this.omega, dt)
  }
}
