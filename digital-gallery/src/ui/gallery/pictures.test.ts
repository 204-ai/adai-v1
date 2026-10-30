import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pictures } from './pictures.ts'

let bitmaps: Array<{ width: number; height: number; close: ReturnType<typeof vi.fn> }>
beforeEach(() => {
  bitmaps = []
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob() })))
  vi.stubGlobal('createImageBitmap', vi.fn(async (_blob, options) => {
    const bitmap = { width: 100, height: 50, close: vi.fn() }
    if (options) bitmaps.push(bitmap)
    return bitmap
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('pictures across navigation and transient failures', () => {
  it('retries an image when it is revisited after a network failure', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    const pictures = new Pictures(() => true)
    expect(await pictures.get('a')).toBeNull()
    expect(await pictures.get('a')).not.toBeNull()
    pictures.dispose()
  })
  it('closes decoded bitmaps on eviction and disposal', async () => {
    const wanted = new Set(['a'])
    const pictures = new Pictures((url) => wanted.has(url), { cache: 1 })
    await pictures.get('a')
    wanted.delete('a')
    wanted.add('b')
    await pictures.get('b')
    expect(bitmaps[0]!.close).toHaveBeenCalledOnce()
    expect(bitmaps[1]!.close).not.toHaveBeenCalled()
    pictures.dispose()
    expect(bitmaps[1]!.close).toHaveBeenCalledOnce()
  })
  it('discards a pending load that was evicted before it finished', async () => {
    let wanted = 'a'
    const pictures = new Pictures((url) => url === wanted, { cache: 1 })
    const a = pictures.get('a')
    wanted = 'b'
    const b = pictures.get('b')
    expect(await a).toBeNull()
    expect(await b).not.toBeNull()
    expect(bitmaps[0]!.close).toHaveBeenCalledOnce()
    pictures.dispose()
  })
  it('keeps a bitmap alive while a mesh still uses it, regardless of cache recency', async () => {
    const wanted = new Set(['a', 'b'])
    const pictures = new Pictures((url) => wanted.has(url), { cache: 2 })
    await pictures.get('a')
    await pictures.get('b')
    wanted.delete('b')
    wanted.add('c')
    await pictures.get('c')
    expect(bitmaps[0]!.close).not.toHaveBeenCalled()
    expect(bitmaps[1]!.close).toHaveBeenCalledOnce()
    pictures.dispose()
  })
  it('can revisit an image that left the view while it was loading', async () => {
    let wanted = true
    const pictures = new Pictures(() => wanted)
    const first = pictures.get('a')
    wanted = false
    expect(await first).toBeNull()
    wanted = true
    expect(await pictures.get('a')).not.toBeNull()
    pictures.dispose()
  })
  it('does not fetch queued images after the view is disposed', async () => {
    const pictures = new Pictures(() => true)
    const loads = ['a', 'b', 'c', 'd', 'e'].map((url) => pictures.get(url))
    pictures.dispose()
    expect(await Promise.all(loads)).toEqual([null, null, null, null, null])
    expect(fetch).toHaveBeenCalledTimes(4)
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledOnce()
  })
})
