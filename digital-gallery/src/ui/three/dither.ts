// What the 3D views share: the ordered dither the vortex's grid and the city's structure are drawn with, thin lines
// drawn 1-bit with it (each vertex with a tone, how bright before dithering, and a colour, fading with distance), the
// pieces of a full-screen pass, and small text sprites.
import * as THREE from 'three'

/** a 4×4 ordered-dither threshold for a pixel */
export const bayer = /* glsl */ `
float bayer(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int k = i.x + i.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[k] + 0.5) / 16.0;
}
`

/** the vertex shader of a full-screen pass: the quad as it is */
export const screenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/** linear → sRGB, for a pass that puts a rendered frame on the screen itself */
export const toSRGB = /* glsl */ `
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`

const lineVertex = /* glsl */ `
attribute float tone;
attribute vec3 color;
varying float vTone;
varying vec3 vColor;
varying float vDist;
void main() {
  vTone = tone;
  vColor = color;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vDist = distance(w.xyz, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const lineFragment = /* glsl */ `
uniform float uDpr;
uniform float uNear;
uniform float uFall;
uniform float uGain;
uniform float uMono;
varying float vTone;
varying vec3 vColor;
varying float vDist;
${bayer}
void main() {
  float v = vTone * uGain * exp(-max(0.0, vDist - uNear) * uFall);
  if (step(bayer(floor(gl_FragCoord.xy / uDpr)), v) < 0.5) discard;
  gl_FragColor = vec4(mix(vColor, vec3(0.42), uMono), 1.0);
}
`

/**
 * the dithered line material; `dpr` is shared so a resize reaches every one; lines fade beyond `near` at rate `fall`.
 * `uGain` scales every tone and `uMono` draws them grey, to quiet lines out of focus.
 */
export function lineMaterial(dpr: { value: number }, near = 50, fall = 0.006): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: lineVertex,
    fragmentShader: lineFragment,
    uniforms: { uDpr: dpr, uNear: { value: near }, uFall: { value: fall }, uGain: { value: 1 }, uMono: { value: 0 } },
  })
}

const GREY: [number, number, number] = [0.62, 0.66, 0.72]

/** line segments as a geometry, each vertex with its tone and colour (sRGB, 0..1) */
export class Lines {
  pos: number[] = []
  tone: number[] = []
  color: number[] = []
  seg(a: [number, number, number], b: [number, number, number], t: number, c: [number, number, number] = GREY): void {
    this.pos.push(...a, ...b)
    this.tone.push(t, t)
    this.color.push(...c, ...c)
  }
  /** a polyline through points */
  path(points: Array<[number, number, number]>, t: number, c?: [number, number, number]): void {
    for (let i = 1; i < points.length; i++) this.seg(points[i - 1]!, points[i]!, t, c)
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('tone', new THREE.Float32BufferAttribute(this.tone, 1))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3))
    return g
  }
}

/** a hex colour as the 0..1 components the line shader draws as they are (sRGB) */
export const rgb = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace)
  return [c.r, c.g, c.b]
}

/** a line of text as a sprite: `family` is the font-family list, `style` what goes before the size ("italic 400") */
export function textSprite(text: string, px: number, alpha: number, family: string, style = ''): THREE.Sprite {
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  const font = `${style} ${px}px ${family}`.trim()
  ctx.font = font
  c.width = Math.ceil(ctx.measureText(text).width) + 16
  c.height = Math.ceil(px * 1.4)
  ctx.font = font
  ctx.fillStyle = `rgba(233,227,214,${alpha})`
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 8, c.height / 2)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }))
  sp.userData.aspect = c.width / c.height
  return sp
}
