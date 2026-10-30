import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { dataUrl } from '../lib/commons.ts'
import { cityOf, viewOf } from '../lib/city.ts'
import type { Manifest, ManifestWork } from '../lib/manifest.ts'
import { Look, spring, type Spring } from '../lib/motion.ts'
import { CityScene } from './city/city3d.ts'
import { fitWindow, ndc } from './three/screen.ts'

/** how near the eye comes to the work on stage, and how far back the wheel may draw it (an aerial view of the city) */
const NEAR = 3.6
const FAR = 150
/** how high the eye climbs on its way across, per unit it still has to go (so long flights pass over the roofs) */
const CLIMB = 0.32

/**
 * The city: the commons as a town, its districts the places the works were shown, its buildings the artists, their
 * facades panelled with their works, time running outward from the plaza (lib/city.ts). The eye stands before the
 * work on stage, drifting a little sideways while it holds; when the run moves on it flies to the next work's
 * panel, climbing over the roofs if it is far. All sprung. The wheel draws back toward an aerial view and in again;
 * the mouse looks around; click a panel to bring its work on stage, hover names it.
 */
export function City(props: { manifest: Manifest; works: Map<string, ManifestWork>; current: ManifestWork | null; paused: boolean; hold: number; onPick: (id: string) => void; onPause: () => void; onHover: (id: string | null) => void }) {
  const { manifest, works, current, paused, hold, onPick, onPause, onHover } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const city = useMemo(() => cityOf(manifest), [manifest])
  const scene = useRef<CityScene | null>(null)
  // the camera reads these every frame; React only writes them
  const live = useRef({ current, paused, shownAt: performance.now(), heldFor: 0 })
  const cb = useRef({ onPick, onPause, onHover })
  cb.current = { onPick, onPause, onHover }

  useEffect(() => {
    const cv = canvas.current!
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' })
    let s: CityScene | null = null
    let alive = true
    const resize = () => {
      const { dpr } = fitWindow(renderer, s?.camera ?? null)
      s?.setDpr(dpr)
    }
    window.addEventListener('resize', resize)

    // the eye and the point it looks at, each a spring per axis; how far back the wheel has drawn it
    const eye: Spring[] = [0, 1, 2].map(() => ({ x: 0, v: 0 }))
    const at: Spring[] = [0, 1, 2].map(() => ({ x: 0, v: 0 }))
    const dist = { x: NEAR, v: 0 }
    let distTo = NEAR
    let placed = false
    const look = new Look({ yaw: 0.5, pitch: 0.3 })
    let raf = 0, last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const L = live.current
      const p = s && L.current ? s.panel(L.current.id) : undefined
      if (s && p) {
        const held = L.paused ? L.heldFor : L.heldFor + (now - L.shownAt) / 1000
        spring(dist, distTo, 2, dt)
        const v = viewOf(p, dist.x)
        // a slow drift across the face while it holds
        const drift = (Math.min(1, held / hold) - 0.5) * 1.2
        const to = [v.eye.x + p.nz * drift, v.eye.y, v.eye.z - p.nx * drift]
        const lookTo = [v.at.x, v.at.y, v.at.z]
        if (!placed) (eye.forEach((e, i) => (e.x = to[i]!)), at.forEach((e, i) => (e.x = lookTo[i]!)), (placed = true))
        eye.forEach((e, i) => spring(e, to[i]!, 1.1, dt))
        at.forEach((e, i) => spring(e, lookTo[i]!, 1.6, dt))
        // still far to go: fly higher, over the roofs
        const away = Math.hypot(to[0]! - eye[0]!.x, to[2]! - eye[2]!.x)
        s.camera.position.set(eye[0]!.x, eye[1]!.x + Math.min(45, away * CLIMB), eye[2]!.x)
        s.camera.lookAt(at[0]!.x, at[1]!.x, at[2]!.x)
        look.update(dt)
        s.camera.rotateY(look.yaw.x)
        s.camera.rotateX(look.pitch.x)
        s.update(now, { x: at[0]!.x, y: at[1]!.x, z: at[2]!.x })
        renderer.render(s.scene, s.camera)
      }
      raf = requestAnimationFrame(frame)
    }

    // the kin links are a separate small file; the city stands without them if it is missing
    void fetch(dataUrl('city.json'))
      .then((r) => (r.ok ? (r.json() as Promise<{ kin: Array<[string, string]> }>) : { kin: [] }))
      .catch(() => ({ kin: [] as Array<[string, string]> }))
      .then(({ kin }) => {
        if (!alive) return
        s = new CityScene(works, city, kin)
        scene.current = s
        const c = live.current.current
        if (c) s.setCurrent(c.artist, c.by[0] ?? '')
        resize()
      })
    resize()
    raf = requestAnimationFrame(frame)

    let hovered: string | null = null
    const onMove = (e: PointerEvent) => {
      const id = s?.pick(ndc(e)) ?? null
      if (id !== hovered) ((hovered = id), cb.current.onHover(id))
      cv.style.cursor = id ? 'pointer' : ''
    }
    const onClick = (e: MouseEvent) => {
      const id = s?.pick(ndc(e))
      if (id) cb.current.onPick(id)
      else cb.current.onPause()
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      distTo = Math.max(NEAR, Math.min(FAR, distTo * Math.exp(px * 0.0016)))
    }
    // the look follows the mouse anywhere on the page (a finger on a touch screen steers nothing)
    const onPoint = (e: PointerEvent) => e.pointerType === 'mouse' && look.point(ndc(e))
    const onLeave = (e: PointerEvent) => !e.relatedTarget && look.point(null)
    cv.addEventListener('pointermove', onMove)
    cv.addEventListener('click', onClick)
    cv.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('pointermove', onPoint)
    document.addEventListener('pointerout', onLeave)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('click', onClick)
      cv.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointermove', onPoint)
      document.removeEventListener('pointerout', onLeave)
      s?.dispose()
      renderer.dispose()
      scene.current = null
    }
  }, [works, city, hold])

  // a new work on stage: its building becomes the current one, and the hold's clock starts again
  useEffect(() => {
    const L = live.current
    if (current?.id !== L.current?.id) Object.assign(L, { current, shownAt: performance.now(), heldFor: 0 })
    if (current) scene.current?.setCurrent(current.artist, current.by[0] ?? '')
  }, [current])
  useEffect(() => {
    const L = live.current
    const now = performance.now()
    if (paused && !L.paused) L.heldFor += (now - L.shownAt) / 1000
    if (!paused && L.paused) L.shownAt = now
    L.paused = paused
  }, [paused])

  return <canvas ref={canvas} className="gallery" aria-label="The city: the commons' works as the panels of its artists' buildings" />
}
