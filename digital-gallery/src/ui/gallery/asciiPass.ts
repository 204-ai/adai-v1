// The one pass the gallery is seen through. The scene renders into a target with its depth; past the focus, every
// small cell of the screen becomes a glyph: one of a long ramp picked by the cell's brightness, and on an edge a stroke
// along it (| / - \), found with a Sobel filter over the cells around, inked in the cell's own colour over a faint wash
// of it. Nothing about a glyph switches: brightness cross-fades between neighbouring glyphs of the ramp, an edge fades
// in with its strength and turns between neighbouring strokes, cells read an area average of the picture (a mip level,
// not one pixel), and the ASCII layer eases toward each new frame, so the far works move in gradients, never flicker.
// Up to the focus and a little past it, the true render shows through.
import * as THREE from 'three'
import { FOCUS, SHARP, SOFT } from '../../lib/hall.ts'
import { screenVertex, toSRGB } from '../three/dither.ts'

/** one glyph cell on screen, in CSS px */
export const CELL = { w: 5, h: 9 }
/** sparse to dense; the strokes for edges follow it in the atlas */
export const FINE_RAMP = " .'`^\",:;Il!i><~+_-?][}{1)(tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"
export const STROKES = '|\\-/'
/** how fast the ASCII layer catches up with a new frame (per second): high enough to follow the walk, low enough to calm it */
const SETTLE = 14

/** The ramp and the strokes drawn once, white on black, a glyph per slot along x, a little padding between slots. */
function glyphAtlas(): THREE.CanvasTexture {
  const glyphs = FINE_RAMP + STROKES
  const gw = 24, gh = 40
  const c = document.createElement('canvas')
  c.width = gw * glyphs.length
  c.height = gh
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = '#fff'
  ctx.font = `500 ${gh * 0.74}px ui-monospace, Menlo, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < glyphs.length; i++) ctx.fillText(glyphs[i]!, gw * (i + 0.5), gh * 0.54)
  const t = new THREE.CanvasTexture(c)
  t.minFilter = THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  t.generateMipmaps = false
  return t
}

/** shared by both passes: depth → how real a pixel is */
const common = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
uniform float uFocus;
uniform float uSharp;
uniform float uSoft;
varying vec2 vUv;
${toSRGB}

float sharpness(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  if (d >= 1.0) return 0.0;
  float z = d * 2.0 - 1.0;
  float dist = 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
  float x = clamp((dist - uFocus - uSharp) / uSoft, 0.0, 1.0);
  return 1.0 - x * x * (3.0 - 2.0 * x);
}
`

/** pass 1: the ASCII layer, eased into the history target */
const asciiFragment = /* glsl */ `
#define PI 3.14159265
${common}
uniform sampler2D tGlyphs;
uniform sampler2D tPrev;
uniform float uRamp;
uniform float uGlyphs;
uniform vec2 uRes;
uniform vec2 uCell;
uniform float uLod;
uniform float uEdge;
uniform float uGain;
uniform float uBlack;
uniform float uBlend;
uniform vec3 uInk;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// a cell's colour: the area around its centre, read off a mip level about the size of the cell
vec3 cellColor(vec2 cell) {
  return toSRGB(textureLod(tColor, (cell + 0.5) * uCell / uRes, uLod).rgb);
}

float glyph(float g, vec2 inCell) {
  // keep inside the slot so a neighbour never bleeds in
  float x = clamp(inCell.x, 0.04, 0.96);
  return texture2D(tGlyphs, vec2((g + x) / uGlyphs, inCell.y)).r;
}

void main() {
  vec2 px = vUv * uRes;
  vec2 cell = floor(px / uCell);
  vec2 inCell = fract(px / uCell);
  vec3 prev = texture2D(tPrev, vUv).rgb;

  // how near this cell and the cells beside it are: no glyphs over or around the real, near part, so a near work
  // never wears a rim of strokes; where it is near the layer fades to black, and ASCII grows in from nothing
  vec2 cs = uCell / uRes;
  vec2 uv = (cell + 0.5) * cs;
  float near = max(max(sharpness(uv), sharpness(vUv)), max(max(sharpness(uv + vec2(cs.x, 0.0)), sharpness(uv - vec2(cs.x, 0.0))), max(sharpness(uv + vec2(0.0, cs.y)), sharpness(uv - vec2(0.0, cs.y)))));
  if (near >= 1.0) {
    gl_FragColor = vec4(prev * (1.0 - uBlend), 1.0);
    return;
  }

  vec3 c = cellColor(cell);
  // below a floor of black the cell stays empty: faint haze never fills the dark with glyphs
  float l = clamp(pow(max(0.0, luma(c) * uGain - uBlack) / (1.0 - uBlack), 0.8), 0.0, 1.0);

  // brightness between two glyphs of the ramp: cross-fade them instead of jumping
  float lf = l * (uRamp - 1.0);
  float g0 = floor(lf);
  float ramp = mix(glyph(g0, inCell), glyph(min(g0 + 1.0, uRamp - 1.0), inCell), smoothstep(0.0, 1.0, fract(lf)));

  // Sobel over the neighbouring cells; the stroke fades in with the edge's strength and turns between its neighbours
  float tl = luma(cellColor(cell + vec2(-1.0, 1.0))), tc = luma(cellColor(cell + vec2(0.0, 1.0))), tr = luma(cellColor(cell + vec2(1.0, 1.0)));
  float ml = luma(cellColor(cell + vec2(-1.0, 0.0))), mr = luma(cellColor(cell + vec2(1.0, 0.0)));
  float bl = luma(cellColor(cell + vec2(-1.0, -1.0))), bc = luma(cellColor(cell + vec2(0.0, -1.0))), br = luma(cellColor(cell + vec2(1.0, -1.0)));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  float mag = length(vec2(gx, gy)) * uGain;
  float s = mod(atan(gy, gx), PI) / (PI / 4.0);
  float s0 = floor(s);
  float stroke = mix(glyph(uRamp + mod(s0, 4.0), inCell), glyph(uRamp + mod(s0 + 1.0, 4.0), inCell), smoothstep(0.0, 1.0, fract(s)));
  float edge = smoothstep(uEdge * 0.6, uEdge * 1.4, mag) * step(0.001, l);

  float ink = mix(ramp, stroke, edge);

  // ink in the cell's own colour, lifted so dim far cells still read; a faint wash of it behind the glyph
  float peak = max(max(c.r, c.g), max(c.b, 1e-3));
  vec3 hue = c / peak;
  float level = mix(0.35 + 0.85 * l, 0.55 + 0.6 * min(1.0, mag), edge);
  vec3 ascii = (mix(uInk, hue, 0.75) * level * ink + c * 0.12) * (1.0 - near);

  gl_FragColor = vec4(mix(prev, ascii, uBlend), 1.0);
}
`

/** pass 2: the real render where it is near, the eased ASCII layer beyond, blended by depth */
const composeFragment = /* glsl */ `
${common}
uniform sampler2D tAscii;
uniform float uFade;

void main() {
  vec3 real = toSRGB(texture2D(tColor, vUv).rgb);
  vec3 c = mix(texture2D(tAscii, vUv).rgb, real, sharpness(vUv));
  // the fade of a long glide, eased so it starts and ends gently
  gl_FragColor = vec4(c * uFade * uFade * (3.0 - 2.0 * uFade), 1.0);
}
`

export class AsciiPass {
  readonly target: THREE.WebGLRenderTarget
  /** the ASCII layer, this frame and the last, swapped every frame */
  private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private ascii: THREE.ShaderMaterial
  private compose: THREE.ShaderMaterial
  private quad: THREE.Mesh
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private fresh = true

  constructor(camera: THREE.PerspectiveCamera) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1),
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    })
    const layer = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.history = [layer(), layer()]
    const depth = {
      tColor: { value: this.target.texture },
      tDepth: { value: this.target.depthTexture },
      uNear: { value: camera.near },
      uFar: { value: camera.far },
      uFocus: { value: FOCUS },
      uSharp: { value: SHARP },
      uSoft: { value: SOFT },
    }
    this.ascii = new THREE.ShaderMaterial({
      vertexShader: screenVertex,
      fragmentShader: asciiFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...depth,
        tGlyphs: { value: glyphAtlas() },
        tPrev: { value: null },
        uRamp: { value: FINE_RAMP.length },
        uGlyphs: { value: FINE_RAMP.length + STROKES.length },
        uRes: { value: new THREE.Vector2(1, 1) },
        uCell: { value: new THREE.Vector2(CELL.w, CELL.h) },
        uLod: { value: 2 },
        uEdge: { value: 0.9 },
        uGain: { value: 1.5 },
        uBlack: { value: 0.07 },
        uBlend: { value: 1 },
        uInk: { value: new THREE.Color('#efe6d2') },
      },
    })
    this.compose = new THREE.ShaderMaterial({
      vertexShader: screenVertex,
      fragmentShader: composeFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: { ...depth, tAscii: { value: null }, uFade: { value: 1 } },
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.ascii)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  setSize(w: number, h: number, dpr: number): void {
    const W = Math.round(w * dpr), H = Math.round(h * dpr)
    this.target.setSize(W, H)
    for (const t of this.history) t.setSize(W, H)
    const u = this.ascii.uniforms
    ;(u.uRes!.value as THREE.Vector2).set(W, H)
    ;(u.uCell!.value as THREE.Vector2).set(CELL.w * dpr, CELL.h * dpr)
    // the mip level whose texels are about a cell across
    u.uLod!.value = Math.log2(Math.sqrt(CELL.w * CELL.h) * dpr)
    this.fresh = true
  }

  /** Start the ASCII layer afresh: after a cut nothing of the old view should linger. */
  reset(): void {
    this.fresh = true
  }

  /** Render the scene, then the ASCII layer eased over `dt` seconds toward it, then both to the screen, faded by `fade`. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, dt: number, fade = 1): void {
    renderer.setRenderTarget(this.target)
    renderer.render(scene, camera)

    const [prev, next] = this.history
    this.ascii.uniforms.tPrev!.value = prev.texture
    this.ascii.uniforms.uBlend!.value = this.fresh ? 1 : 1 - Math.exp(-dt * SETTLE)
    this.fresh = false
    this.quad.material = this.ascii
    renderer.setRenderTarget(next)
    renderer.render(this.scene, this.camera)

    this.compose.uniforms.tAscii!.value = next.texture
    this.compose.uniforms.uFade!.value = fade
    this.quad.material = this.compose
    renderer.setRenderTarget(null)
    renderer.render(this.scene, this.camera)
    this.history = [next, prev]
  }

  dispose(): void {
    this.target.depthTexture?.dispose()
    this.target.dispose()
    for (const t of this.history) t.dispose()
    ;(this.ascii.uniforms.tGlyphs!.value as THREE.Texture).dispose()
    this.ascii.dispose()
    this.compose.dispose()
    this.quad.geometry.dispose()
  }
}
