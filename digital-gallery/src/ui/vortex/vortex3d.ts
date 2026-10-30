// The well in three.js: a sheet of spacetime ruled with a square grid, bent down into the well and swirled a little
// round it, the grid's lines drawn faint and 1-bit with ordered dithering (so they read as dotted, printed lines, not
// glowing ones); the works laid on the slope (placed by lib/vortex.ts), facing up off the sheet, their tops toward the
// rim; the work on stage floating in front of the viewer. Grid and works pass through one bend in the vertex shaders:
// slow ripples running out of the throat across the sheet. Only the works near the stage exist.
import * as THREE from 'three'
import type { ManifestWork } from '../../lib/manifest.ts'
import { CENTRE, DEPTH, EYE, SHOULDER, fit, place, shown, slopeAt } from '../../lib/vortex.ts'
import { Pictures } from '../gallery/pictures.ts'
import { bayer } from '../three/dither.ts'

/** how strongly space ripples (1 = as designed) */
const WARP = 1
/** the grid: how far out it runs, its lines per unit, how much it swirls round the throat, and how far above it the works lie */
const GRID_OUT = 52
const GRID_IN = 0.12
const DENSITY = 0.85
const SWIRL = 2.4
const LIFT = 0.04

const n = (v: number) => v.toFixed(4)

/** the well and the ripple: shared by grid and works */
const well = /* glsl */ `
uniform float uTime;
uniform float uWarp;
const vec2 C = vec2(${n(CENTRE.x)}, ${n(CENTRE.z)});
float heightAt(float rho) { float k = ${n(SHOULDER)} / (max(rho, 0.0) + ${n(SHOULDER)}); return -${n(DEPTH)} * k * k; }
vec3 bend(vec3 p) {
  float rho = length(p.xz - C);
  // slow ripples running out of the throat, dying away across the sheet
  p.y += uWarp * 0.12 * sin(rho * 1.25 - uTime * 0.8) * exp(-rho * 0.09);
  return p;
}
`

const gridVertex = /* glsl */ `
${well}
varying vec2 vGrid;
varying float vRho;
void main() {
  float theta = uv.x * 6.2831853;
  float rho = mix(${n(GRID_IN)}, ${n(GRID_OUT)}, pow(uv.y, 2.2));
  vec2 plane = vec2(sin(theta), cos(theta)) * rho;
  // the square grid, wound a little round the throat (more the nearer it is)
  float a = ${n(SWIRL)} / (rho + 1.0) * (1.0 + 0.12 * sin(uTime * 0.25));
  vGrid = mat2(cos(a), sin(a), -sin(a), cos(a)) * plane * ${n(DENSITY)};
  vRho = rho;
  vec3 p = bend(vec3(C.x + plane.x, heightAt(rho), C.y + plane.y));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`

const gridFragment = /* glsl */ `
uniform float uDpr;
varying vec2 vGrid;
varying float vRho;
${bayer}

void main() {
  vec2 fw = max(fwidth(vGrid), vec2(1e-4));
  vec2 w = abs(fract(vGrid - 0.5) - 0.5) / fw;
  float line = 1.0 - min(min(w.x, w.y), 1.0);
  // where the lines crowd closer than a few pixels they would only shimmer: let them go
  float clear = 1.0 - smoothstep(0.4, 1.1, min(fw.x, fw.y));
  float seen = smoothstep(${n(GRID_IN)}, ${n(GRID_IN + 0.12)}, vRho) * (1.0 - smoothstep(${n(GRID_OUT * 0.22)}, ${n(GRID_OUT * 0.62)}, vRho));
  float v = line * 0.5 * clear * seen;
  // drawn 1-bit: ordered dithering on the CSS pixel grid, so a line is a run of dots
  float on = step(bayer(floor(gl_FragCoord.xy / uDpr)), v);
  gl_FragColor = vec4(vec3(0.6, 0.64, 0.7) * on, 1.0);
}
`

const workVertex = /* glsl */ `
${well}
uniform float uSwirl;
varying vec2 vUv;
varying float vDist;
void main() {
  vUv = uv;
  // opened as a wormhole: the picture wound round its middle and drawn back into a funnel behind it
  vec3 q = position;
  float r = min(1.0, length(q.xy) * 2.0);
  float a = uSwirl * 2.6 * (1.0 - r);
  q.xy = mat2(cos(a), sin(a), -sin(a), cos(a)) * q.xy;
  q.z -= uSwirl * 1.6 * (1.0 - r) * (1.0 - r);
  vec4 w = modelMatrix * vec4(q, 1.0);
  w.xyz = bend(w.xyz);
  vDist = distance(w.xyz, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const workFragment = /* glsl */ `
uniform sampler2D map;
uniform float uHasMap;
uniform float uOpacity;
uniform vec3 uBase;
uniform float uSwirl;
uniform float uTime;
varying vec2 vUv;
varying float vDist;
void main() {
  // opened as a wormhole: the picture spins into its middle, tighter toward it, and the middle goes dark
  vec2 d = vUv - 0.5;
  float r = min(1.0, length(d) * 2.0);
  float a = uSwirl * (7.0 * (1.0 - r) * (1.0 - r) + uTime * 1.5);
  d = mat2(cos(a), sin(a), -sin(a), cos(a)) * d * (1.0 - 0.55 * uSwirl * (1.0 - r));
  vec2 uv = 0.5 + d;
  // a picture fades in over its placeholder as it arrives
  vec3 c = mix(uBase, uHasMap > 0.0 ? texture2D(map, uv).rgb : uBase, uHasMap);
  c *= 1.0 - uSwirl * (1.0 - smoothstep(0.0, 0.45, r));
  // dims with distance across the sheet
  c *= exp(-max(0.0, vDist - 16.0) * 0.045);
  gl_FragColor = vec4(c, uOpacity);
}
`

interface Item {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  id: string
  aspect: number
  /** when its picture arrived (seconds, scene time), if it has */
  loaded: number | null
}

const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const M = new THREE.Matrix4()
const qSheet = new THREE.Quaternion(), qFace = new THREE.Quaternion()
const EYE_AT = new THREE.Vector3(0, EYE, 0)

/** the turn that lays a work on the sheet at (rho, angle): facing up off it, its top toward the rim */
function onSheet(rho: number, angle: number, q: THREE.Quaternion): THREE.Quaternion {
  const s = slopeAt(rho)
  X.set(Math.sin(angle), 0, Math.cos(angle))
  Z.copy(UP).addScaledVector(X, -s).normalize()
  Y.copy(X).addScaledVector(UP, s).normalize()
  X.crossVectors(Y, Z)
  return q.setFromRotationMatrix(M.makeBasis(X, Y, Z))
}

/** the turn that faces a work at p toward the viewer, upright */
function facing(p: THREE.Vector3, q: THREE.Quaternion): THREE.Quaternion {
  Z.copy(EYE_AT).sub(p).normalize()
  Y.copy(UP).addScaledVector(Z, -Z.y).normalize()
  X.crossVectors(Y, Z)
  return q.setFromRotationMatrix(M.makeBasis(X, Y, Z))
}

export class VortexScene {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 160)
  private works: Map<string, ManifestWork>
  private order: string[] = []
  private items = new Map<number, Item>()
  // the sheet shows many works at once: smaller pictures, more of them kept
  private pictures = new Pictures((url) => this.wanted(url), { cache: 180, maxPx: 384 })
  // fine enough to bend into a funnel when a work opens as a wormhole
  private geo = new THREE.PlaneGeometry(1, 1, 24, 24)
  private time = { value: 0 }
  private warp = { value: WARP }
  private grid: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>

  constructor(works: Map<string, ManifestWork>) {
    this.works = works
    this.scene.background = new THREE.Color('#000')
    this.grid = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 256, 256),
      new THREE.ShaderMaterial({
        vertexShader: gridVertex,
        fragmentShader: gridFragment,
        uniforms: { uTime: this.time, uWarp: this.warp, uDpr: { value: 1 } },
        side: THREE.DoubleSide,
      }),
    )
    this.grid.frustumCulled = false
    this.scene.add(this.grid)
  }

  setDpr(dpr: number): void {
    this.grid.material.uniforms.uDpr!.value = dpr
  }

  /** A new turn: show its works afresh. */
  setOrder(order: string[]): void {
    this.order = order
    for (const i of [...this.items.keys()]) this.drop(i)
  }

  /** The run at `at` (stage index plus progress), the view turned by the pointer, at time t (seconds). */
  update(at: number, look: { yaw: number; pitch: number }, t: number): void {
    this.time.value = t
    this.camera.position.copy(EYE_AT)
    this.camera.rotation.set(0, 0, 0)
    this.camera.rotateY(look.yaw)
    // looking out across the sheet, a little down into the well
    this.camera.rotateX(look.pitch - 0.2)

    const [lo, hi] = this.order.length ? shown(at, this.order.length) : [0, -1]
    for (const i of [...this.items.keys()]) if (i < lo || i > hi) this.drop(i)
    for (let i = lo; i <= hi; i++) {
      const it = this.items.get(i) ?? this.add(i)
      const p = place(i - at, t)
      const m = it.mesh
      m.position.set(p.x, p.y, p.z)
      onSheet(p.rho, p.angle, qSheet)
      // just above the sheet, so the grid never shows through
      if (p.eye < 1) m.position.addScaledVector(Z.set(0, 0, 1).applyQuaternion(qSheet), LIFT * (1 - p.eye))
      m.quaternion.copy(p.eye > 0 ? qSheet.slerp(facing(m.position, qFace), p.eye) : qSheet)
      const s = fit(it.aspect, p.box)
      m.scale.set(s.w, s.h, 1)
      m.material.uniforms.uOpacity!.value = p.fade
      if (it.loaded != null) m.material.uniforms.uHasMap!.value = Math.min(1, (t - it.loaded) / 0.7)
      m.visible = p.fade > 0.003
    }
  }

  /** the mesh of a work shown now, if it is */
  meshOf(id: string): THREE.Mesh | null {
    for (const it of this.items.values()) if (it.id === id) return it.mesh
    return null
  }

  /** how far a work has opened into a wormhole (0 = not at all, 1 = fully) */
  setSwirl(id: string | null, amount: number): void {
    for (const it of this.items.values()) it.mesh.material.uniforms.uSwirl!.value = it.id === id ? amount : 0
  }

  /** the work under a point of the screen (normalised device coordinates), if any */
  pick(ndc: THREE.Vector2): string | null {
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hits = ray.intersectObjects([...this.items.values()].map((it) => it.mesh).filter((m) => m.visible), false)
    return (hits[0]?.object.userData.id as string | undefined) ?? null
  }

  private add(i: number): Item {
    const id = this.order[i]!
    const w = this.works.get(id)!
    const mat = new THREE.ShaderMaterial({
      vertexShader: workVertex,
      fragmentShader: workFragment,
      uniforms: { map: { value: null }, uHasMap: { value: 0 }, uOpacity: { value: 0 }, uBase: { value: new THREE.Color('#0b0a09') }, uSwirl: { value: 0 }, uTime: this.time, uWarp: this.warp },
      transparent: true,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(this.geo, mat)
    mesh.userData.id = id
    this.scene.add(mesh)
    const it: Item = { mesh, id, aspect: 4 / 3, loaded: null }
    this.items.set(i, it)
    void this.pictures.get(w.img).then((p) => {
      if (!p || this.items.get(i) !== it) return
      mat.uniforms.map!.value = p.tex
      it.loaded = this.time.value
      it.aspect = p.aspect
    })
    return it
  }

  private drop(i: number): void {
    const it = this.items.get(i)
    if (!it) return
    this.scene.remove(it.mesh)
    it.mesh.material.dispose()
    this.items.delete(i)
  }

  /** whether a work shown now shows this picture */
  private wanted(url: string): boolean {
    for (const it of this.items.values()) if (this.works.get(it.id)?.img === url) return true
    return false
  }

  dispose(): void {
    this.pictures.dispose()
    for (const i of [...this.items.keys()]) this.drop(i)
    this.geo.dispose()
    this.grid.geometry.dispose()
    this.grid.material.dispose()
  }
}
