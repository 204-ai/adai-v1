// Seeded randomness: same seed, same braid.

/** mulberry32: small, fast, good enough for ordering. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Mix a seed and a turn number into one 32-bit seed. */
export function seedOf(seed: number, turn: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0
  h = Math.imul(h ^ (turn + 0x85ebca6b), 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
