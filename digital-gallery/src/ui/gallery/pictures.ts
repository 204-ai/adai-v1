// Pictures for the 3D views: each image fetched, decoded and shrunk once, a few at a time, kept in a small cache where
// the least recently asked for leave first. A load whose turn comes after the view has moved past it is let go.
import * as THREE from 'three'

export interface Picture {
  tex: THREE.Texture
  aspect: number
}

/** at most this many images decode at once */
const LOADS = 4

export class Pictures {
  private pictures = new Map<string, Promise<Picture | null>>()
  private ready = new Map<string, Picture>()
  private queue: Array<() => void> = []
  private loading = 0
  private alive = true
  private wanted: (url: string) => boolean
  private cache: number
  private maxPx: number

  /**
   * `wanted` says whether the view still shows a picture when its turn to load comes; `cache` is how many decoded
   * pictures to keep, `maxPx` the longest side one is uploaded at.
   */
  constructor(wanted: (url: string) => boolean, opts: { cache?: number; maxPx?: number } = {}) {
    this.wanted = wanted
    this.cache = opts.cache ?? 48
    this.maxPx = opts.maxPx ?? 1024
  }

  /** Fetch, decode and shrink an image once; a few at a time; the least recently asked for leave first. */
  get(url: string): Promise<Picture | null> {
    const have = this.pictures.get(url)
    if (have) {
      this.pictures.delete(url)
      this.pictures.set(url, have)
      return have
    }
    const p = new Promise<Picture | null>((resolve) => {
      const run = async () => {
        // passed by before its turn came: let it go, and let a later visit ask again
        if (!this.wanted(url)) {
          this.pictures.delete(url)
          resolve(null)
          return this.queue.shift()?.()
        }
        this.loading++
        try {
          const blob = await (await fetch(url, { mode: 'cors' })).blob()
          const probe = await createImageBitmap(blob)
          const aspect = probe.width / probe.height
          const k = Math.min(1, this.maxPx / Math.max(probe.width, probe.height))
          const size = { resizeWidth: Math.max(1, Math.round(probe.width * k)), resizeHeight: Math.max(1, Math.round(probe.height * k)) }
          probe.close()
          const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', resizeQuality: 'high', ...size })
          if (!this.alive) return (bmp.close(), resolve(null))
          const tex = new THREE.Texture(bmp)
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = 8
          tex.needsUpdate = true
          const pic = { tex, aspect }
          this.ready.set(url, pic)
          resolve(pic)
        } catch {
          resolve(null)
        } finally {
          this.loading--
          this.queue.shift()?.()
        }
      }
      if (this.loading < LOADS) void run()
      else this.queue.push(() => void run())
    })
    this.pictures.set(url, p)
    while (this.pictures.size > this.cache) {
      const old = this.pictures.keys().next().value!
      this.pictures.delete(old)
      this.ready.get(old)?.tex.dispose()
      this.ready.delete(old)
    }
    return p
  }

  dispose(): void {
    this.alive = false
    for (const p of this.ready.values()) p.tex.dispose()
    this.ready.clear()
  }
}
