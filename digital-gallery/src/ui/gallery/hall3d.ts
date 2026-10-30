// The gallery in three.js: nothing but the works. Each hangs in the dark on two cables that vanish overhead, turned
// toward the walk, with a small label under it. A decade floats overhead
// where the walk first reaches a new one, and a card floats before the first work of each artist's run. Only the works
// near the eye exist.
import * as THREE from 'three'
import type { ManifestWork } from '../../lib/manifest.ts'
import { Pictures } from './pictures.ts'
import { AHEAD, BAY, BEHIND, CABLE_TOP, EYE_Y, HANG_TURN, HANG_X, HANG_Y, bayAt, cardStarts, hangSize, inView, markersFor, sideOf, zOf, type Marker } from '../../lib/hall.ts'

export interface ArtistCard {
  name: string
  type: string
  count: number
  span: [number, number]
}

const SERIF = "italic 400 {px}px Newsreader, Georgia, serif"
const SANS = "500 {px}px Archivo, 'Helvetica Neue', Arial, sans-serif"
const MONO = '400 {px}px ui-monospace, Menlo, monospace'
const font = (f: string, px: number) => f.replace('{px}', String(px))
const PAPER = '#e9e3d6'

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** two vertical cables from the top corners of a unit-wide work up one unit (scaled to the work and the height), gone into the dark by a third of the way */
function cableGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const ys = [0, 0.1, 0.3]
  const tone = [0.36, 0.1, 0]
  const pos: number[] = [], col: number[] = []
  for (const x of [-0.5, 0.5])
    for (let k = 0; k < ys.length - 1; k++)
      for (const j of [k, k + 1]) (pos.push(x, ys[j]!, 0), col.push(tone[j]!, tone[j]! * 0.97, tone[j]! * 0.92))
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  return g
}

/** where the camera stands and how it is turned */
export interface Pose {
  pos: THREE.Vector3
  quat: THREE.Quaternion
}

interface Item {
  group: THREE.Group
  picture: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  plaque: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  back: THREE.Mesh
  cables: THREE.LineSegments
  turn: number
  id: string
}

export class Hall {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.1, 80)
  private works: Map<string, ManifestWork>
  private artists: Map<string, ArtistCard>
  private order: string[] = []
  private markers: Marker[] = []
  private cards = new Set<number>()
  private items = new Map<number, Item>()
  private markerObjs = new Map<number, THREE.Sprite>()
  private cardObjs = new Map<number, THREE.Sprite>()
  private pictures = new Pictures((url) => this.wanted(url))
  private backMat = new THREE.MeshBasicMaterial({ color: '#0c0c0c' })
  private backGeo = new THREE.BoxGeometry(1, 1, 0.04)
  private cableGeo = cableGeometry()
  private cableMat = new THREE.LineBasicMaterial({ vertexColors: true })
  private plaqueGeo = new THREE.PlaneGeometry(1, 0.25)

  constructor(works: Map<string, ManifestWork>, artists: Map<string, ArtistCard>) {
    this.works = works
    this.artists = artists
    this.scene.background = new THREE.Color('#000')
    this.scene.fog = new THREE.Fog('#000', 22, 62)
  }

  /** A new turn: hang its works afresh. */
  setOrder(order: string[]): void {
    this.order = order
    const ws = order.map((id) => this.works.get(id)!)
    this.markers = markersFor(ws.map((w) => w.year))
    this.cards = new Set(cardStarts(ws.map((w) => w.artist)))
    for (const i of [...this.items.keys()]) this.dropItem(i)
    for (const b of [...this.markerObjs.keys()]) this.dropMarker(b)
    for (const i of [...this.cardObjs.keys()]) this.dropCard(i)
  }

  /** Move the eye to z, looking a little toward `look.x` and turned by the pointer; build what came into view, drop what left it. */
  update(eye: number, look: { x: number; yaw: number; pitch: number }, t: number): void {
    this.camera.position.set(0, EYE_Y, eye)
    this.camera.lookAt(look.x, EYE_Y + 0.1, eye - 10)
    this.camera.rotateY(look.yaw)
    this.camera.rotateX(look.pitch)

    const [lo, hi] = this.order.length ? inView(eye, this.order.length) : [0, -1]
    for (const i of [...this.items.keys()]) if (i < lo || i > hi) this.dropItem(i)
    for (const i of [...this.cardObjs.keys()]) if (i < lo || i > hi) this.dropCard(i)
    for (let i = lo; i <= hi; i++) {
      if (!this.items.has(i)) this.hang(i)
      if (this.cards.has(i) && !this.cardObjs.has(i)) this.addCard(i)
    }
    const bay0 = bayAt(eye) - BEHIND
    const bays = new Set<number>()
    for (const m of this.markers) if (m.bay >= bay0 && m.bay <= bay0 + BEHIND + AHEAD) (bays.add(m.bay), this.markerObjs.has(m.bay) || this.addMarker(m))
    for (const b of [...this.markerObjs.keys()]) if (!bays.has(b)) this.dropMarker(b)

    // the works turn a little on their cables, each in its own time
    for (const [i, it] of this.items) it.group.rotation.y = it.turn + Math.sin(t * 0.25 + i * 1.7) * 0.02
    for (const [i, sp] of this.cardObjs) sp.position.y = 3.25 + Math.sin(t * 0.9 + i * 1.7) * 0.07
  }

  /**
   * Where the camera stands to look at work i up close: square on to it, as near as lets it fill its share of the
   * screen, and turned so it sits where `frame` puts it (beside the panel). Null while the work is not hung.
   */
  focusPose(i: number, frame: { fw: number; fh: number; ox: number; oy: number }): Pose | null {
    const it = this.items.get(i)
    if (!it) return null
    it.group.updateMatrixWorld()
    const q = it.group.getWorldQuaternion(new THREE.Quaternion())
    const centre = it.picture.getWorldPosition(new THREE.Vector3())
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const up = new THREE.Vector3(0, 1, 0)
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)
    const a = this.camera.aspect
    const { x: w, y: h } = it.picture.scale
    const dist = Math.max(h / frame.fh / 2 / t, w / frame.fw / 2 / (t * a))
    // the point the camera looks at: off the work's centre, so the work lands at (ox, oy) on the screen
    const look = centre.addScaledVector(right, -frame.ox * dist * t * a).addScaledVector(up, -frame.oy * dist * t)
    const pos = look.clone().addScaledVector(normal, dist)
    return { pos, quat: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, look, up)) }
  }

  /** the work under a point of the screen (normalised device coordinates), if any */
  pick(ndc: THREE.Vector2): string | null {
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hits = ray.intersectObjects([...this.items.values()].map((it) => it.picture), false)
    return (hits[0]?.object.userData.id as string | undefined) ?? null
  }

  private hang(i: number): void {
    const id = this.order[i]!
    const w = this.works.get(id)!
    const side = sideOf(i)
    const turn = -side * HANG_TURN
    const group = new THREE.Group()
    group.position.set(side * HANG_X, HANG_Y, zOf(i))
    group.rotation.y = turn
    const picture = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: '#141210' }))
    picture.position.z = 0.021
    picture.userData.id = id
    const back = new THREE.Mesh(this.backGeo, this.backMat)
    const cables = new THREE.LineSegments(this.cableGeo, this.cableMat)
    const plaque = new THREE.Mesh(this.plaqueGeo, new THREE.MeshBasicMaterial({ map: this.plaqueTexture(w), transparent: true }))
    plaque.scale.setScalar(0.82)
    group.add(back, picture, cables, plaque)
    const item: Item = { group, picture, plaque, back, cables, turn, id }
    this.size(item, hangSize(1))
    this.scene.add(group)
    this.items.set(i, item)
    void this.pictures.get(w.img).then((p) => {
      if (!p || this.items.get(i) !== item) return
      picture.material.dispose()
      picture.material = new THREE.MeshBasicMaterial({ map: p.tex, toneMapped: false })
      this.size(item, hangSize(p.aspect))
    })
  }

  private size(it: Item, { w, h }: { w: number; h: number }): void {
    it.picture.scale.set(w, h, 1)
    it.back.scale.set(w + 0.03, h + 0.03, 1)
    it.cables.position.y = h / 2
    it.cables.scale.set(w * 0.82, CABLE_TOP - HANG_Y - h / 2, 1)
    it.plaque.position.set(-w / 2 + 0.41, -h / 2 - 0.2, 0.01)
  }

  private dropItem(i: number): void {
    const it = this.items.get(i)
    if (!it) return
    this.scene.remove(it.group)
    it.picture.geometry.dispose()
    it.picture.material.dispose()
    it.plaque.material.map?.dispose()
    it.plaque.material.dispose()
    this.items.delete(i)
  }

  /**
   * The label under a work: title, maker, date, set straight on the dark. Its whole quad writes depth (no alpha test),
   * so the ASCII pass sees the label as near and never turns the dark between its letters into glyphs.
   */
  private plaqueTexture(w: ManifestWork): THREE.CanvasTexture {
    return canvasTexture(512, 128, (ctx) => {
      ctx.fillStyle = PAPER
      ctx.font = font(SERIF, 36)
      ctx.fillText(clip(ctx, w.title, 500), 4, 46)
      ctx.fillStyle = 'rgba(233,227,214,0.6)'
      ctx.font = font(MONO, 20)
      ctx.fillText(clip(ctx, `${w.by.join(', ')} · ${w.date}`, 500), 4, 90)
    })
  }

  private addCard(i: number): void {
    const w = this.works.get(this.order[i]!)!
    const a = this.artists.get(w.artist)
    const tex = canvasTexture(512, 260, (ctx) => {
      ctx.fillStyle = 'rgba(10,10,10,0.72)'
      ctx.fillRect(0, 0, 512, 260)
      ctx.fillStyle = 'rgba(233,227,214,0.35)'
      ctx.fillRect(0, 0, 2, 260)
      ctx.fillStyle = '#e8763a'
      ctx.font = font(MONO, 18)
      ctx.fillText((a?.type ?? 'artist').toUpperCase(), 30, 50)
      ctx.fillStyle = PAPER
      ctx.font = font(SERIF, 54)
      ctx.fillText(clip(ctx, a?.name ?? w.by[0] ?? '', 456), 30, 128)
      ctx.font = font(SANS, 20)
      ctx.fillStyle = 'rgba(233,227,214,0.6)'
      if (a) {
        const [y0, y1] = a.span.map(Math.floor) as [number, number]
        ctx.fillText(`${a.count} ${a.count === 1 ? 'work' : 'works'} in the commons · ${y0 === y1 ? y0 : `${y0}–${y1}`}`, 30, 200)
      }
    })
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }))
    sp.scale.set(1.3, 0.66, 1)
    sp.position.set(sideOf(i) * 1.15, 3.25, zOf(i) + 1.4)
    this.scene.add(sp)
    this.cardObjs.set(i, sp)
  }

  private dropCard(i: number): void {
    const sp = this.cardObjs.get(i)
    if (!sp) return
    this.scene.remove(sp)
    sp.material.map?.dispose()
    sp.material.dispose()
    this.cardObjs.delete(i)
  }

  /** a decade floating high over the walk */
  private addMarker(m: Marker): void {
    const tex = canvasTexture(1024, 200, (ctx) => {
      ctx.fillStyle = 'rgba(233,227,214,0.5)'
      ctx.textAlign = 'center'
      ctx.font = font(MONO, 120)
      ctx.letterSpacing = '24px'
      ctx.fillText(`${m.decade}s`, 512, 140)
    })
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }))
    sp.scale.set(3.2, 0.625, 1)
    sp.position.set(0, 4.2, -m.bay * BAY)
    this.scene.add(sp)
    this.markerObjs.set(m.bay, sp)
  }

  private dropMarker(bay: number): void {
    const sp = this.markerObjs.get(bay)
    if (!sp) return
    this.scene.remove(sp)
    sp.material.map?.dispose()
    sp.material.dispose()
    this.markerObjs.delete(bay)
  }

  /** whether a work hanging now shows this picture */
  private wanted(url: string): boolean {
    for (const it of this.items.values()) if (this.works.get(it.id)?.img === url) return true
    return false
  }

  dispose(): void {
    this.pictures.dispose()
    for (const i of [...this.items.keys()]) this.dropItem(i)
    for (const b of [...this.markerObjs.keys()]) this.dropMarker(b)
    for (const i of [...this.cardObjs.keys()]) this.dropCard(i)
    for (const d of [this.backMat, this.backGeo, this.cableGeo, this.cableMat, this.plaqueGeo]) d.dispose()
  }
}

/** cut a line to fit `max` px, with an ellipsis */
function clip(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(s.slice(0, mid) + '…').width <= max) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + '…'
}
