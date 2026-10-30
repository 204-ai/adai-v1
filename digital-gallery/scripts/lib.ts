import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const root = (p: string) => resolve(ROOT, p)

/** the local A(DAI) fork built with `npm run fork:pull` at the repository root (read only) */
export const DEFAULT_DB = resolve(ROOT, '../adai.db')

export function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  return v && !v.startsWith('--') ? v : null
}
