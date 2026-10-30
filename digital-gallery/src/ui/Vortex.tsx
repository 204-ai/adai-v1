import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { Glide, Look } from '../lib/motion.ts'
import type { ManifestWork } from '../lib/manifest.ts'
import { EYE, diveHeading, divePoint } from '../lib/vortex.ts'
import { VortexScene } from './vortex/vortex3d.ts'
import { WarpPass } from './vortex/warpPass.ts'
import { fitWindow, ndc } from './three/screen.ts'

/** a jump farther than this many works fades through black instead of streaming everything between past the viewer */
const FAR_WORKS = 8
/** seconds down into the wormhole, the longest to wait at the bottom for the run to arrive, and seconds back up */
const DIVE_IN = 2.8
const DARK_MAX = 1.6
const DIVE_OUT = 2.6

const ease = (x: number) => x * x * (3 - 2 * x)

/**
 * The vortex: the viewer looks out across a sheet of spacetime, ruled with a faint dithered grid, that curves down
 * into a well ahead; the works are tiled densely on its slope along one spiral. While one holds, the spiral slides on
 * toward the throat: the work on stage lifts off the sheet to float in front, then sinks and falls down the well.
 * Everything is sprung (the flow and the look that follows the mouse), and a far jump fades through black. Click a work
 * to bring it to the stage; hover names it.
 *
 * A new `warp` sends the viewer into the wormhole: forward over the sheet, down over the throat and spiralling down
 * it, the view widening and everything streaking, until the dark at the bottom. There `onArrive` sends the run
 * somewhere far off; once it has arrived the viewer rises back up out of the throat onto the new spiral.
 *
 * Clicking a work opens that work as a wormhole of its own: it winds into its middle and sinks into a funnel while
 * the viewer flies to it and dives in, through to the dark; there `onArrive` brings that work on stage, and the
 * viewer rises out of the throat with it.
 */
export function Vortex(props: {
  works: Map<string, ManifestWork>
  order: string[]
  pos: number
  paused: boolean
  hold: number
  warp: number
  /** a work was clicked: the dive into it begins */
  onPortal: (id: string) => void
  /** at the bottom of a dive: into a work (its id), or the throat (null) */
  onArrive: (id: string | null) => void
  /** back up and standing again after a dive */
  onLanded: () => void
  onPause: () => void
  onHover: (id: string | null) => void
}) {
  const { works, order, pos, paused, hold, warp, onPortal, onArrive, onLanded, onPause, onHover } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const vortex = useRef<VortexScene | null>(null)
  // the flow reads these every frame; React only writes them
  const live = useRef({ pos, paused, shownAt: performance.now(), heldFor: 0, order, warp })
  const cb = useRef({ onPortal, onArrive, onLanded, onPause, onHover })
  cb.current = { onPortal, onArrive, onLanded, onPause, onHover }

  useEffect(() => {
    const cv = canvas.current!
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' })
    const v = new VortexScene(works)
    const pass = new WarpPass()
    v.setOrder(live.current.order)
    vortex.current = v
    const resize = () => {
      const { W, H, dpr } = fitWindow(renderer, v.camera)
      pass.setSize(W, H, dpr)
      v.setDpr(dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    let raf = 0, last = performance.now()
    const flow = new Glide(live.current.pos - 0.5, 1.4, FAR_WORKS)
    const look = new Look({ yaw: 0.6, pitch: 0.25 }, 1.6)
    // the dive: where along its path the eye is (0 = standing, 1 = at the bottom), and what it is doing
    // `into`: the work being dived into, if the dive is into a work rather than the throat
    const dive = { phase: 'idle' as 'idle' | 'in' | 'dark' | 'out', p: 0, darkAt: 0, from: 0, warp: live.current.warp, into: null as string | null }
    const P = new THREE.Vector3(), H = new THREE.Vector3(), UP = new THREE.Vector3()
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion()
    // the path into a work: from where the eye stands, out toward the work, square on to it, and on into its funnel
    const W = new THREE.Vector3(), N = new THREE.Vector3(), TOP = new THREE.Vector3()
    const path = new THREE.CubicBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3())
    const intoWork = (mesh: THREE.Object3D) => {
      mesh.getWorldPosition(W)
      N.set(0, 0, 1).applyQuaternion(mesh.quaternion)
      TOP.set(0, 1, 0).applyQuaternion(mesh.quaternion)
      path.v0.set(0, EYE, 0)
      path.v1.lerpVectors(path.v0, W, 0.35).setY(path.v0.y)
      path.v2.copy(W).addScaledVector(N, 1.8)
      path.v3.copy(W).addScaledVector(N, -0.9)
    }
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const L = live.current
      const held = L.paused ? L.heldFor : L.heldFor + (now - L.shownAt) / 1000
      const target = L.pos - 0.5 + Math.min(1, held / hold)

      if (L.warp !== dive.warp) ((dive.warp = L.warp), dive.phase === 'idle' && (dive.phase = 'in'))
      if (dive.phase === 'in' && (dive.p = Math.min(1, dive.p + dt / DIVE_IN)) === 1) {
        Object.assign(dive, { phase: 'dark', darkAt: now, from: L.pos })
        cb.current.onArrive(dive.into)
        v.setSwirl(null, 0)
        dive.into = null
      }
      if (dive.phase === 'dark' && (L.pos !== dive.from || now - dive.darkAt > DARK_MAX * 1000)) {
        // arrived out of sight: be there already, and come back up
        flow.snap(target)
        pass.reset()
        dive.phase = 'out'
      }
      if (dive.phase === 'out' && (dive.p = Math.max(0, dive.p - dt / DIVE_OUT)) === 0) ((dive.phase = 'idle'), cb.current.onLanded())

      // the arm flows on by one work over the hold, the work on stage passing through the eye halfway
      if (dive.phase !== 'dark') flow.update(target, dt)
      if (flow.landed) pass.reset()
      if (dive.phase !== 'idle') look.point(null)
      look.update(dt)
      v.update(flow.at.x, { yaw: look.yaw.x, pitch: look.pitch.x }, now / 1000)

      // the dive takes the camera from the standing view along its path, turning and widening as it goes down
      const e = ease(dive.p)
      const work = dive.into ? v.meshOf(dive.into) : null
      if (work) v.setSwirl(dive.into, ease(Math.min(1, dive.p / 0.45)))
      // (should the work leave the view mid-dive, the path it last had still holds)
      if (e > 0 && dive.into) {
        if (work) intoWork(work)
        path.getPoint(e, P)
        path.getTangent(Math.min(0.999, e), H).add(P)
        UP.set(0, 1, 0).lerp(TOP, e).normalize()
      } else if (e > 0) {
        const p = divePoint(e), h = diveHeading(Math.min(0.999, e))
        P.set(p.x, p.y, p.z)
        H.set(h.x, h.y, h.z).normalize().add(P)
        UP.set(0, 1 - e, -e).normalize()
      }
      if (e > 0) {
        Q.setFromRotationMatrix(M.lookAt(P, H, UP))
        const w = ease(Math.min(1, dive.p / 0.18))
        v.camera.position.lerp(P, w)
        v.camera.quaternion.slerp(Q, w)
        v.camera.rotateZ(e * e * 2.4)
      }
      const fov = 60 + 46 * e * e
      if (Math.abs(v.camera.fov - fov) > 1e-3) ((v.camera.fov = fov), v.camera.updateProjectionMatrix())
      const dark = dive.phase === 'dark' ? 0 : 1 - ease(Math.max(0, (dive.p - 0.72) / 0.28))
      pass.render(renderer, v.scene, v.camera, dt, flow.fade * dark, e)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    let hovered: string | null = null
    const onMove = (e: PointerEvent) => {
      const id = dive.phase === 'idle' ? v.pick(ndc(e)) : null
      if (id !== hovered) ((hovered = id), cb.current.onHover(id))
      cv.style.cursor = id ? 'pointer' : ''
    }
    const onClick = (e: MouseEvent) => {
      if (dive.phase !== 'idle') return
      const id = v.pick(ndc(e))
      if (!id) return cb.current.onPause()
      // open it as a wormhole and dive in
      Object.assign(dive, { phase: 'in', into: id })
      cb.current.onHover(null)
      cb.current.onPortal(id)
    }
    // the look follows the mouse anywhere on the page (a finger on a touch screen steers nothing)
    const onPoint = (e: PointerEvent) => e.pointerType === 'mouse' && dive.phase === 'idle' && look.point(ndc(e))
    const onLeave = (e: PointerEvent) => !e.relatedTarget && look.point(null)
    cv.addEventListener('pointermove', onMove)
    cv.addEventListener('click', onClick)
    window.addEventListener('pointermove', onPoint)
    document.addEventListener('pointerout', onLeave)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('click', onClick)
      window.removeEventListener('pointermove', onPoint)
      document.removeEventListener('pointerout', onLeave)
      pass.dispose()
      v.dispose()
      renderer.dispose()
      vortex.current = null
    }
  }, [works, hold])

  // a new turn shows a new order
  useEffect(() => {
    if (live.current.order === order) return
    live.current.order = order
    vortex.current?.setOrder(order)
  }, [order])

  useEffect(() => {
    live.current.warp = warp
  }, [warp])

  // keep the flow's clock: time held on this work so far, frozen while paused
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

  return <canvas ref={canvas} className="gallery" aria-label="The vortex: the commons' works spiralling into a well in spacetime" />
}
