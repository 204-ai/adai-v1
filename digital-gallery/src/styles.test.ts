import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// What must be seen over the picture on stage stacks above it.
const css = fs.readFileSync(path.resolve(import.meta.dirname, 'styles.css'), 'utf8')
const zOf = (selector: string) => {
  const m = new RegExp(`(^|\\n)\\${selector} \\{[^}]*?z-index:\\s*(\\d+)`).exec(css)
  return m ? Number(m[2]) : NaN
}

describe('overlays stack above the stage', () => {
  const stage = zOf('.screen')
  for (const sel of ['.hint', '.credit', '.mode-button', '.timeline'])
    it(`${sel} is above .screen`, () => {
      expect(stage).toBeGreaterThan(0)
      expect(zOf(sel)).toBeGreaterThan(stage)
    })
})
