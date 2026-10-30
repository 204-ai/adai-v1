// The window as the 3D views see it: the renderer and camera fitted to it with a capped pixel ratio, and a pointer as
// normalised device coordinates. Shared by the gallery, the vortex and the city.
import * as THREE from 'three'

/** the most device pixels drawn per CSS pixel: enough for crisp pictures, not a 4K render on a phone */
export const MAX_DPR = 1.5

export interface Viewport {
  W: number
  H: number
  dpr: number
}

/** Fit the renderer (and the camera, when there is one yet) to the window; returns the size it was fitted to. */
export function fitWindow(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera | null): Viewport {
  const W = window.innerWidth, H = window.innerHeight, dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
  renderer.setPixelRatio(dpr)
  renderer.setSize(W, H, false)
  if (camera) {
    camera.aspect = W / H
    camera.updateProjectionMatrix()
  }
  return { W, H, dpr }
}

/** a pointer's place on the screen as normalised device coordinates (-1..1, y up), for picking */
export const ndc = (e: { clientX: number; clientY: number }) => new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
