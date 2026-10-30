// The pass the storm is seen through. Colour splits toward the rim, and time smears: each frame keeps the last one,
// fading, so whatever moves leaves a trail (the wheeling cloud streaks like wind). Brighter of the two wins, so what
// holds still stays crisp.
import * as THREE from 'three'
import { screenVertex, toSRGB } from '../three/dither.ts'

/** how fast a trail fades (per second) */
const DECAY = 12

const warpFragment = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tPrev;
uniform vec2 uAspect;
uniform float uKeep;
uniform float uTrail;
varying vec2 vUv;
${toSRGB}

vec2 back(vec2 d) { return d / uAspect + 0.5; }

void main() {
  vec2 d = (vUv - 0.5) * uAspect;
  float r = length(d);
  // colour splitting toward the rim
  float ca = 0.0008 * r * r;
  vec3 cur = vec3(
    toSRGB(texture2D(tScene, back(d * (1.0 + ca))).rgb).r,
    toSRGB(texture2D(tScene, vUv).rgb).g,
    toSRGB(texture2D(tScene, back(d * (1.0 - ca))).rgb).b
  );
  vec3 trail = texture2D(tPrev, vUv).rgb * uKeep;
  gl_FragColor = vec4(max(cur, trail * uTrail), 1.0);
}
`

const showFragment = /* glsl */ `
uniform sampler2D tFrame;
uniform vec2 uAspect;
uniform float uFade;
varying vec2 vUv;
void main() {
  vec2 d = (vUv - 0.5) * uAspect;
  float vignette = 1.0 - 0.45 * smoothstep(0.35, 1.05, length(d));
  float f = uFade * uFade * (3.0 - 2.0 * uFade);
  gl_FragColor = vec4(texture2D(tFrame, vUv).rgb * vignette * f, 1.0);
}
`

export class WarpPass {
  private target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType })
  private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private warp: THREE.ShaderMaterial
  private show: THREE.ShaderMaterial
  private quad: THREE.Mesh
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private fresh = true

  constructor() {
    const layer = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.history = [layer(), layer()]
    const aspect = { value: new THREE.Vector2(1, 1) }
    this.warp = new THREE.ShaderMaterial({
      vertexShader: screenVertex,
      fragmentShader: warpFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: { tScene: { value: this.target.texture }, tPrev: { value: null }, uAspect: aspect, uKeep: { value: 0 }, uTrail: { value: 0.5 } },
    })
    this.show = new THREE.ShaderMaterial({
      vertexShader: screenVertex,
      fragmentShader: showFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: { tFrame: { value: null }, uAspect: aspect, uFade: { value: 1 } },
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.warp)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  setSize(w: number, h: number, dpr: number): void {
    const W = Math.round(w * dpr), H = Math.round(h * dpr)
    this.target.setSize(W, H)
    for (const t of this.history) t.setSize(W, H)
    ;(this.warp.uniforms.uAspect!.value as THREE.Vector2).set(w / Math.max(w, h), h / Math.max(w, h))
    this.fresh = true
  }

  /** Start without trails: after a cut nothing of the old view should linger. */
  reset(): void {
    this.fresh = true
  }

  /** `streak` (0..1) stretches the trails out, for the dive into the wormhole */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, dt: number, fade: number, streak = 0): void {
    renderer.setRenderTarget(this.target)
    renderer.render(scene, camera)

    const [prev, next] = this.history
    const u = this.warp.uniforms
    u.tPrev!.value = prev.texture
    u.uKeep!.value = this.fresh ? 0 : Math.exp(-dt * DECAY * (1 - 0.85 * streak))
    u.uTrail!.value = 0.5 + 0.42 * streak
    this.fresh = false
    this.quad.material = this.warp
    renderer.setRenderTarget(next)
    renderer.render(this.scene, this.camera)

    this.show.uniforms.tFrame!.value = next.texture
    this.show.uniforms.uFade!.value = fade
    this.quad.material = this.show
    renderer.setRenderTarget(null)
    renderer.render(this.scene, this.camera)
    this.history = [next, prev]
  }

  dispose(): void {
    this.target.dispose()
    for (const t of this.history) t.dispose()
    this.warp.dispose()
    this.show.dispose()
    this.quad.geometry.dispose()
  }
}
