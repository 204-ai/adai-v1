import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BAY, eyeZ, sideOf } from '../lib/hall.ts'
import { Glide, Look, spring } from '../lib/motion.ts'
import type { Manifest, ManifestWork } from '../lib/manifest.ts'
import { panelFrame, settle, wheelWorks } from '../lib/panel.ts'
import { AsciiPass } from './gallery/asciiPass.ts'
import { Hall, type ArtistCard, type Pose } from './gallery/hall3d.ts'
import { fitWindow, ndc } from './three/screen.ts'

/** a jump farther than this many bays fades through black instead of a walk past everything on the way */
const FAR_BAYS = 6
/** after the wheel rests this long (ms), its lead eases away and the run's own pace takes over again */
const WHEEL_REST = 600

/**
 * The gallery: the walk past the suspended works. The work on stage hangs at the focus, a third of the way into the view;
 * the real render runs up to it and a little past, then turns to ASCII into the distance. While it holds, the eye walks on
 * toward the next one, so the walk never stops unless paused; the wheel walks it forward (up) and back (down). Everything
 * the camera does is sprung, so nothing jolts: the walk, the turn toward the side the work hangs on, the look that
 * follows the mouse, and the move in to an open work. Click a work to open it: the camera comes up to it and frames it
 * beside the panel; click the dark (or press escape) to step back. Hover names a work.
 */
export function Gallery(props: {
  manifest: Manifest
  works: Map<string, ManifestWork>
  order: string[]
  pos: number
  paused: boolean
  hold: number
  open: string | null
  onOpen: (id: string) => void
  onClose: () => void
  onStep: (dir: number) => void
  onPause: () => void
  onHover: (id: string | null) => void
}) {
  const { manifest, works, order, pos, paused, hold, open, onOpen, onClose, onStep, onPause, onHover } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const hall = useRef<Hall | null>(null)
  // the walk reads these every frame; React only writes them
  const live = useRef({ pos, paused, shownAt: performance.now(), heldFor: 0, order, open, lead: 0, wheelAt: 0 })
  const cb = useRef({ onOpen, onClose, onStep, onPause, onHover })
  cb.current = { onOpen, onClose, onStep, onPause, onHover }

  const artists = useMemo(() => {
    const out = new Map<string, ArtistCard>()
    for (const a of manifest.artists) out.set(a.id, { name: a.name, type: a.type, count: 0, span: [Infinity, -Infinity] })
    for (const w of manifest.works) {
      const a = out.get(w.artist)
      if (!a) continue
      a.count++
      a.span = [Math.min(a.span[0], w.year), Math.max(a.span[1], w.year)]
    }
    return out
  }, [manifest])

  useEffect(() => {
    const cv = canvas.current!
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' })
    const h = new Hall(works, artists)
    const pass = new AsciiPass(h.camera)
    h.setOrder(live.current.order)
    hall.current = h
    const resize = () => {
      const { W, H, dpr } = fitWindow(renderer, h.camera)
      pass.setSize(W, H, dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    let raf = 0, last = performance.now()
    // a long jump fades through black (walking past hundreds of bays would load every work on the way); a step walks
    const eye = new Glide(eyeZ(live.current.pos), 1.6, FAR_BAYS * BAY)
    const side = { x: sideOf(live.current.pos) * 0.8, v: 0 }
    const look = new Look({ yaw: 0.34, pitch: 0.16 })
    // how far in toward the open work the camera is (0 = walking, 1 = framed beside the panel), and where it frames it
    const zoom = { x: 0, v: 0 }
    let pose: Pose | null = null
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const L = live.current
      const held = L.paused ? L.heldFor : L.heldFor + (now - L.shownAt) / 1000
      const progress = Math.min(1, held / hold)
      // the wheel's lead: step the run when it reaches another work, ease it away once the wheel rests
      const s = settle(progress, L.lead)
      if (s.step) {
        Object.assign(L, { pos: L.pos + s.step, shownAt: now, heldFor: 0, lead: s.lead })
        cb.current.onStep(s.step)
      } else if (now - L.wheelAt > WHEEL_REST) L.lead *= Math.exp(-dt * 1.5)
      eye.update(eyeZ(L.pos, (s.step ? 0 : progress) + L.lead), dt)
      if (eye.landed) pass.reset()
      spring(side, sideOf(L.pos) * 0.8, 0.9, dt)
      look.update(dt)
      h.update(eye.at.x, { x: side.x, yaw: look.yaw.x, pitch: look.pitch.x }, now / 1000)
      // in to the open work once it hangs (after a long jump it hangs only when the walk lands), out again when closed
      const i = L.open ? L.order.indexOf(L.open) : -1
      const p = i >= 0 && eye.fade > 0.99 ? h.focusPose(i, panelFrame(window.innerWidth, window.innerHeight)) : null
      if (p) pose = p
      spring(zoom, p ? 1 : 0, 2.4, dt)
      if (pose && zoom.x > 1e-4) {
        const z = Math.min(1, zoom.x)
        h.camera.position.lerp(pose.pos, z)
        h.camera.quaternion.slerp(pose.quat, z)
      }
      pass.render(renderer, h.scene, h.camera, dt, eye.fade)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    // the look follows the mouse anywhere on the page (a finger on a touch screen steers nothing); not while a work is open
    const onPoint = (e: PointerEvent) => e.pointerType === 'mouse' && look.point(live.current.open ? null : ndc(e))
    const onLeave = (e: PointerEvent) => !e.relatedTarget && look.point(null)
    window.addEventListener('pointermove', onPoint)
    document.addEventListener('pointerout', onLeave)
    let hovered: string | null = null
    const onMove = (e: PointerEvent) => {
      const id = h.pick(ndc(e))
      if (id !== hovered) ((hovered = id), cb.current.onHover(id))
      cv.style.cursor = id ? 'zoom-in' : live.current.open ? 'zoom-out' : ''
    }
    const onClick = (e: MouseEvent) => {
      const id = h.pick(ndc(e))
      if (id) cb.current.onOpen(id)
      else if (live.current.open) cb.current.onClose()
      else cb.current.onPause()
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const L = live.current
      // the first turn of the wheel on an open work steps back out to the walk
      if (L.open) return cb.current.onClose()
      L.lead = Math.max(-3, Math.min(3, L.lead + wheelWorks(e)))
      L.wheelAt = performance.now()
    }
    cv.addEventListener('pointermove', onMove)
    cv.addEventListener('click', onClick)
    cv.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('click', onClick)
      cv.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointermove', onPoint)
      document.removeEventListener('pointerout', onLeave)
      pass.dispose()
      h.dispose()
      renderer.dispose()
      hall.current = null
    }
  }, [works, artists, hold])

  // a new turn hangs a new order
  useEffect(() => {
    if (live.current.order === order) return
    live.current.order = order
    hall.current?.setOrder(order)
  }, [order])

  useEffect(() => {
    live.current.open = open
  }, [open])

  // keep the walk's clock: time held on this work so far, frozen while paused (a wheel step has already moved it on)
  useEffect(() => {
    const L = live.current
    if (pos !== L.pos) Object.assign(L, { pos, shownAt: performance.now(), heldFor: 0 })
  }, [pos])
  useEffect(() => {
    const L = live.current
    const now = performance.now()
    if (paused && !L.paused) L.heldFor += (now - L.shownAt) / 1000
    if (!paused && L.paused) L.shownAt = now
    L.paused = paused
  }, [paused])

  return <canvas ref={canvas} className="gallery" aria-label="The gallery: the commons' works suspended in the dark" />
}
