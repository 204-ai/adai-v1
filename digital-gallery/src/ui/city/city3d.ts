// The city in three.js (laid out by lib/city.ts). Everything structural is drawn the way the vortex draws spacetime:
// thin lines, faint, 1-bit with ordered dithering: each building's edges, the plaza's rim, the avenues between
// districts, the band where each decade begins in each district, a fine grid on the ground, and the kin links arching
// from roof to roof. What carries the city is its panels: every work a plate on its artist's facade, dim from afar, its
// picture shown on the panels nearest the eye. The current artist's building and links are drawn a little stronger.
import * as THREE from 'three'
import { FLOOR, PANEL, PLAZA, SILL, type Building, type City, type Panel } from '../../lib/city.ts'
import type { ManifestWork } from '../../lib/manifest.ts'
import { Pictures } from '../gallery/pictures.ts'
import { Lines, bayer, lineMaterial, textSprite } from '../three/dither.ts'

/** how many of the nearest panels show their pictures, and how often (ms) the nearest are found again */
const NEAR = 150
const REFRESH = 250
/** how bright the structure is drawn (before dithering): buildings, ground marks, kin links, the current building */
const TONE = { building: 0.34, mark: 0.42, kin: 0.16, current: 0.85, currentKin: 0.55 }

const groundVertex = /* glsl */ `
varying vec2 vXZ;
varying float vDist;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vXZ = w.xz;
  vDist = distance(w.xyz, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const groundFragment = /* glsl */ `
uniform float uDpr;
uniform float uRadius;
varying vec2 vXZ;
varying float vDist;
${bayer}
void main() {
  vec2 g = vXZ / 6.0;
  vec2 fw = max(fwidth(g), vec2(1e-4));
  vec2 w = abs(fract(g - 0.5) - 0.5) / fw;
  float line = (1.0 - min(min(w.x, w.y), 1.0)) * (1.0 - smoothstep(0.3, 0.8, min(fw.x, fw.y)));
  float r = length(vXZ);
  float v = line * 0.11 * (1.0 - smoothstep(uRadius, uRadius + 40.0, r)) * exp(-max(0.0, vDist - 30.0) * 0.02);
  if (step(bayer(floor(gl_FragCoord.xy / uDpr)), v) < 0.5) discard;
  gl_FragColor = vec4(0.62, 0.66, 0.72, 1.0);
}
`

/** a building's edges: the four corners, the roof and the footing, and a faint line at each floor */
function outline(l: Lines, b: Building, t: number): void {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw)
  const corner = (i: number, y: number): [number, number, number] => {
    const lx = (i === 0 || i === 3 ? -1 : 1) * b.half, lz = (i < 2 ? 1 : -1) * b.half
    return [b.x + lx * c + lz * s, y, b.z - lx * s + lz * c]
  }
  for (let i = 0; i < 4; i++) {
    l.seg(corner(i, 0), corner(i, b.height), t)
    l.seg(corner(i, b.height), corner((i + 1) % 4, b.height), t)
    l.seg(corner(i, 0), corner((i + 1) % 4, 0), t)
    for (let f = 1; f < b.floors; f++) l.seg(corner(i, SILL + f * FLOOR - 0.1), corner((i + 1) % 4, SILL + f * FLOOR - 0.1), t * 0.45)
  }
}

/** an arc from roof to roof, rising with the span */
function bridge(l: Lines, a: Building, b: Building, t: number): void {
  const n = 14
  const span = Math.hypot(a.x - b.x, a.z - b.z)
  const lift = Math.min(30, span * 0.22)
  const at = (u: number): [number, number, number] => [a.x + (b.x - a.x) * u, a.height + (b.height - a.height) * u + Math.sin(Math.PI * u) * lift, a.z + (b.z - a.z) * u]
  for (let i = 0; i < n; i++) l.seg(at(i / n), at((i + 1) / n), t)
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

interface Shown {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  work: string
  aspect: number
  loaded: number | null
}

export class CityScene {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.1, 600)
  readonly city: City
  private works: Map<string, ManifestWork>
  private ids: string[]
  /** each work's plate (its index), and the plate's place, so a plate can step aside while its picture shows */
  private plateOf = new Map<string, number>()
  private plateAt: THREE.Matrix4[] = []
  private plates: THREE.InstancedMesh
  private dpr = { value: 1 }
  private disposables: Array<{ dispose: () => void }> = []
  private shown = new Map<string, Shown>()
  private pictures = new Pictures((url) => this.wanted(url), { cache: 220, maxPx: 512 })
  private plane = new THREE.PlaneGeometry(1, 1)
  private lastNear = 0
  private current: { lines: THREE.LineSegments; label: THREE.Sprite } | null = null
  private currentArtist: string | null = null
  private kinOf = new Map<string, string[]>()

  constructor(works: Map<string, ManifestWork>, city: City, kin: Array<[string, string]>) {
    this.city = city
    this.works = works
    this.scene.background = new THREE.Color('#000')
    this.scene.fog = new THREE.Fog('#000', 90, city.radius * 4)

    // the ground's fine grid
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(city.radius + 60, 96).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({ vertexShader: groundVertex, fragmentShader: groundFragment, uniforms: { uDpr: this.dpr, uRadius: { value: city.radius } } }),
    )
    this.scene.add(ground)
    this.disposables.push(ground.geometry, ground.material)

    // buildings, plaza, avenues, decade bands
    const l = new Lines()
    for (const b of city.buildings) outline(l, b, TONE.building)
    const circle = (r: number, a0: number, a1: number, t: number) => {
      const n = Math.max(6, Math.ceil(((a1 - a0) * r) / 2))
      for (let i = 0; i < n; i++) {
        const u = a0 + ((a1 - a0) * i) / n, v = a0 + ((a1 - a0) * (i + 1)) / n
        l.seg([Math.cos(u) * r, 0.02, Math.sin(u) * r], [Math.cos(v) * r, 0.02, Math.sin(v) * r], t)
      }
    }
    circle(PLAZA - 1.6, 0, Math.PI * 2, TONE.mark)
    for (const d of city.districts) {
      for (const a of [d.a0, d.a1]) l.seg([Math.cos(a) * (PLAZA - 1.6), 0.02, Math.sin(a) * (PLAZA - 1.6)], [Math.cos(a) * (city.radius + 12), 0.02, Math.sin(a) * (city.radius + 12)], TONE.mark * 0.7)
      let lastTag = -Infinity
      for (const dec of d.decades) {
        const r = dec.r - 1.6
        circle(r, d.a0, d.a1, TONE.mark)
        // several decades may begin in the same band: name only the first there, and none in the plaza's ring
        if (r - lastTag < 5 || r < PLAZA) continue
        lastTag = r
        const mid = (d.a0 + d.a1) / 2
        const tag = textSprite(`${dec.decade}s`, 40, 0.42, 'ui-monospace, Menlo, monospace')
        tag.scale.set(0.55 * tag.userData.aspect, 0.55, 1)
        tag.position.set(Math.cos(mid) * (r - 0.4), 0.35, Math.sin(mid) * (r - 0.4))
        this.scene.add(tag)
        this.disposables.push(tag.material.map!, tag.material)
      }
      const mid = (d.a0 + d.a1) / 2
      // the district's name on the plaza, before its wedge, with the decade its first building began
      const name = textSprite(`${d.name}${d.decades[0] ? ` · from the ${d.decades[0].decade}s` : ''}`, 56, 0.5, 'Newsreader, Georgia, serif', 'italic 400')
      name.scale.set(0.8 * name.userData.aspect, 0.8, 1)
      name.position.set(Math.cos(mid) * (PLAZA - 5), 0.7, Math.sin(mid) * (PLAZA - 5))
      this.scene.add(name)
      this.disposables.push(name.material.map!, name.material)
    }
    const structure = new THREE.LineSegments(l.geometry(), lineMaterial(this.dpr))
    structure.frustumCulled = false
    this.scene.add(structure)
    this.disposables.push(structure.geometry, structure.material)

    // kin links from roof to roof
    const k = new Lines()
    for (const [a, b] of kin) {
      const A = city.buildingOf.get(a), B = city.buildingOf.get(b)
      if (!A || !B) continue
      bridge(k, A, B, TONE.kin)
      this.kinOf.set(a, [...(this.kinOf.get(a) ?? []), b])
      this.kinOf.set(b, [...(this.kinOf.get(b) ?? []), a])
    }
    const bridges = new THREE.LineSegments(k.geometry(), lineMaterial(this.dpr))
    bridges.frustumCulled = false
    this.scene.add(bridges)
    this.disposables.push(bridges.geometry, bridges.material)

    // every work a dim plate on its facade
    this.ids = [...city.panelOf.keys()]
    this.plates = new THREE.InstancedMesh(this.plane, new THREE.MeshBasicMaterial({ color: '#ffffff' }), this.ids.length)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(PANEL.w, PANEL.h, 1), col = new THREE.Color()
    this.ids.forEach((id, i) => {
      const p = city.panelOf.get(id)!
      q.setFromEuler(e.set(0, Math.atan2(p.nx, p.nz), 0))
      m.compose(new THREE.Vector3(p.x, p.y, p.z), q, one)
      this.plates.setMatrixAt(i, m)
      this.plateOf.set(id, i)
      this.plateAt.push(m.clone())
      // a faint tone, a touch warmer the older the work
      const y = works.get(id)?.year ?? 2000
      const t = 0.075 + 0.045 * Math.min(1, Math.max(0, (2025 - y) / 60))
      this.plates.setColorAt(i, col.setRGB(t * 1.05, t, t * 0.95, THREE.SRGBColorSpace))
    })
    this.plates.instanceMatrix.needsUpdate = true
    this.scene.add(this.plates)
    this.disposables.push(this.plates.material as THREE.Material)
  }

  setDpr(dpr: number): void {
    this.dpr.value = dpr
  }

  /** The artist whose building is current: drawn a little stronger, named above its roof, its links lit. */
  setCurrent(artist: string | null, name: string): void {
    if (artist === this.currentArtist) return
    this.currentArtist = artist
    if (this.current) {
      this.scene.remove(this.current.lines, this.current.label)
      this.current.lines.geometry.dispose()
      ;(this.current.lines.material as THREE.Material).dispose()
      this.current.label.material.map?.dispose()
      this.current.label.material.dispose()
      this.current = null
    }
    const b = artist ? this.city.buildingOf.get(artist) : undefined
    if (!b) return
    const l = new Lines()
    outline(l, b, TONE.current)
    for (const other of this.kinOf.get(b.artist) ?? []) bridge(l, b, this.city.buildingOf.get(other)!, TONE.currentKin)
    const lines = new THREE.LineSegments(l.geometry(), lineMaterial(this.dpr))
    lines.frustumCulled = false
    const label = textSprite(name, 56, 0.85, 'Newsreader, Georgia, serif', 'italic 400')
    label.scale.set(0.9 * label.userData.aspect, 0.9, 1)
    label.position.set(b.x, b.height + 1.1, b.z)
    this.scene.add(lines, label)
    this.current = { lines, label }
  }

  /**
   * Show pictures on the panels nearest what the eye looks at (found again every so often; the eye's own nearness
   * counts a little too), fading them in as they arrive. From up high that is the neighbourhood of the work on stage.
   */
  update(now: number, focus: { x: number; y: number; z: number }): void {
    if (now - this.lastNear > REFRESH) {
      this.lastNear = now
      const c = this.camera.position
      const d = this.ids.map((id) => {
        const p = this.city.panelOf.get(id)!
        return { id, d: Math.hypot(p.x - focus.x, p.y - focus.y, p.z - focus.z) + 0.3 * Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) }
      })
      d.sort((a, b) => a.d - b.d)
      const near = new Set(d.slice(0, NEAR).map((x) => x.id))
      for (const [id, s] of this.shown) if (!near.has(id)) this.hide(id, s)
      // nearest first, so they load in that order
      for (const { id } of d.slice(0, NEAR)) if (!this.shown.has(id)) this.show(id)
    }
    for (const s of this.shown.values()) if (s.loaded != null) s.mesh.material.opacity = Math.min(1, (now - s.loaded) / 600)
  }

  private show(id: string): void {
    const p = this.city.panelOf.get(id)!
    const w = this.works.get(id)
    if (!w) return
    const mesh = new THREE.Mesh(this.plane, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }))
    mesh.position.set(p.x + p.nx * 0.012, p.y, p.z + p.nz * 0.012)
    mesh.rotation.y = Math.atan2(p.nx, p.nz)
    mesh.scale.set(PANEL.w, PANEL.h, 1)
    mesh.userData.id = id
    this.scene.add(mesh)
    const s: Shown = { mesh, work: id, aspect: 4 / 3, loaded: null }
    this.shown.set(id, s)
    void this.pictures.get(w.img).then((pic) => {
      if (!pic || this.shown.get(id) !== s) return
      mesh.material.map = pic.tex
      mesh.material.needsUpdate = true
      // fit the panel's box, its own aspect; the dim plate behind steps aside, so no grey margin shows round it
      const fw = Math.min(PANEL.w, PANEL.h * pic.aspect)
      mesh.scale.set(fw, fw / pic.aspect, 1)
      s.loaded = performance.now()
      this.plate(id, false)
    })
  }

  /** show or hide a work's dim plate */
  private plate(id: string, on: boolean): void {
    const i = this.plateOf.get(id)
    if (i == null) return
    this.plates.setMatrixAt(i, on ? this.plateAt[i]! : ZERO)
    this.plates.instanceMatrix.needsUpdate = true
  }

  private hide(id: string, s: Shown): void {
    this.plate(id, true)
    this.scene.remove(s.mesh)
    s.mesh.material.dispose()
    this.shown.delete(id)
  }

  /** the work under a point of the screen (normalised device coordinates), if any */
  pick(ndc: THREE.Vector2): string | null {
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    // a picture showing, or the dim plate of one that is not
    const hit = ray.intersectObjects([this.plates, ...[...this.shown.values()].map((x) => x.mesh)], false)[0]
    if (!hit) return null
    return hit.object === this.plates ? (hit.instanceId != null ? this.ids[hit.instanceId]! : null) : ((hit.object.userData.id as string | undefined) ?? null)
  }

  /** the panel of a work */
  panel(id: string): Panel | undefined {
    return this.city.panelOf.get(id)
  }

  private wanted(url: string): boolean {
    for (const s of this.shown.values()) if (this.works.get(s.work)?.img === url) return true
    return false
  }

  dispose(): void {
    this.pictures.dispose()
    for (const [id, s] of this.shown) this.hide(id, s)
    this.setCurrent(null, '')
    this.plane.dispose()
    for (const d of this.disposables) d.dispose()
  }
}

