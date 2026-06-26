import type { GlScene, GlSceneContext } from './types';
import {
  compileProgram,
  createEmptyVao,
  drawFullscreen,
  FULLSCREEN_VERT,
  Uniforms,
} from '../render/glutil';
import { hslToRgb, spreadHue, clamp01, lerp } from './util';

/**
 * Aurora — aurora curtains / nebula. Layered sinusoidal bands, vertically
 * attenuated and FBM domain-warped, composited as 2–4 translucent parallax
 * layers with different speeds + hues. Bass sways the curtains (slow phase),
 * treble runs a shimmer ripple along them, mid shifts the palette blend.
 *
 * variant: 0 vertical curtains from top · 1 horizon glow (bottom-hugging) ·
 *          2 nebula (cloudy FBM blobs + star sparkles) · 3 one thick ribbon.
 */

const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uColA;    // layer colour A
uniform vec3 uColB;    // layer colour B
uniform vec3 uColC;    // layer colour C
uniform float uSway;   // bass-driven horizontal sway
uniform float uShimmer;// treble ripple amount
uniform float uMidMix; // mid-driven palette blend
uniform float uBright; // level-driven brightness
uniform float uSpeed;
uniform float uScale;
uniform float uPulse;
uniform int uVariant;
uniform float uDir;
uniform float uSeed;    // 0..1, decorrelates star field per look

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5, f = 1.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p * f); f *= 2.03; a *= 0.5; }
  return s;
}

// One curtain layer: a vertically-attenuated sinusoidal band, warped by fbm.
// band selects the vertical centre, freq the horizontal wiggle, phase the motion.
float curtain(vec2 p, float band, float freq, float phase, float thick, float warp) {
  // horizontal warp
  float w = fbm(vec2(p.x * 1.5 + phase * 0.3, phase * 0.2 + warp)) - 0.5;
  float wave = sin(p.x * freq + phase + w * 3.0) * 0.12;
  float y = p.y - band - wave;
  float v = exp(-y * y / (thick * thick));
  // vertical fbm texture along the curtain
  v *= 0.6 + 0.6 * fbm(vec2(p.x * 3.0 + phase, p.y * 4.0 - phase * 0.5));
  return v;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 uv = vUv;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y) * uScale;
  float t = uTime * uSpeed;
  float sway = uSway * sin(t * 0.25) * uDir;
  p.x += sway;

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  if (uVariant == 2) {
    // Nebula: cloudy FBM blobs, no band structure, plus star sparkles.
    vec2 q = p * 1.4;
    float n = fbm(q + vec2(t * 0.05, -t * 0.03));
    n = fbm(q * 1.2 + (vec2(n) - 0.5) * 2.0 + vec2(0.0, t * 0.04));
    float cloud = smoothstep(0.45, 0.95, n);
    float hiMix = smoothstep(0.6, 1.0, n);
    col = mix(uColA, uColC, hiMix);
    col = mix(col, uColB, uMidMix * 0.6);
    alpha = cloud * 0.85;

    // star sparkle dots
    vec2 g = floor((uv * uRes) / 6.0);
    float star = hash(g + uSeed * 31.7);
    star = step(0.997, star);
    float tw = 0.5 + 0.5 * sin(t * 3.0 + hash(g) * 40.0);
    float starA = star * tw * (0.5 + uShimmer * 2.0);
    col += vec3(1.0) * starA;
    alpha = max(alpha, starA);
  } else if (uVariant == 3) {
    // Single thick winding ribbon across the screen.
    float warp = fbm(vec2(p.x * 0.8 + t * 0.1, t * 0.15)) - 0.5;
    float band = 0.5 + sin(p.x * 1.3 + t * 0.3) * 0.18 + warp * 0.25;
    float y = uv.y - band;
    float thick = 0.16;
    float v = exp(-y * y / (thick * thick));
    v *= 0.55 + 0.55 * fbm(vec2(p.x * 4.0 + t, uv.y * 5.0 - t * 0.4));
    float ripple = sin(p.x * 30.0 - t * 6.0) * uShimmer * 0.25;
    v *= 1.0 + ripple;
    col = mix(uColA, uColC, clamp01(uv.y * 0.5 + 0.3));
    col = mix(col, uColB, uMidMix * 0.5);
    alpha = clamp01(v);
  } else {
    // 0 vertical curtains from top / 1 horizon glow from bottom.
    // Three parallax layers with different bands/speeds/colours.
    float baseBand = (uVariant == 1) ? 0.22 : 0.78;
    float dirB = (uVariant == 1) ? 1.0 : -1.0; // attenuation direction

    float l0 = curtain(p, baseBand,        2.2, t * 0.7,  0.30, 0.0);
    float l1 = curtain(p, baseBand + dirB * 0.10, 3.1, t * 1.0 + 2.0, 0.22, 7.3);
    float l2 = curtain(p, baseBand + dirB * 0.20, 4.3, t * 1.4 + 5.0, 0.16, 13.1);

    // treble shimmer ripple running along the curtains
    float ripple = sin(p.x * 26.0 - t * 5.0) * uShimmer;
    l1 *= 1.0 + ripple * 0.4;
    l2 *= 1.0 + ripple * 0.6;

    // vertical falloff toward the screen edge the aurora hangs from
    float vy = (uVariant == 1) ? uv.y : (1.0 - uv.y);
    float fall = smoothstep(1.05, -0.05, vy);
    l0 *= fall; l1 *= fall; l2 *= fall;

    vec3 cA = mix(uColA, uColB, uMidMix);
    col = cA * l0 + uColB * l1 + uColC * l2;
    alpha = clamp01(l0 * 0.7 + l1 * 0.85 + l2 * 1.0);
  }

  alpha *= clamp(uBright, 0.0, 1.2);
  alpha *= (1.0 + uPulse * 0.5);
  alpha = clamp(alpha, 0.0, 0.95);

  // gentle tone shaping
  col = col / (1.0 + col * 0.5); // soft rolloff to avoid blowout
  col *= 1.0 + uPulse * 0.3;

  fragColor = vec4(col * alpha, alpha);
}`;

let prog: WebGLProgram | null = null;
let vao: WebGLVertexArrayObject | null = null;
let uni: Uniforms | null = null;

let sBass = 0;
let sTreble = 0;
let sMid = 0;
let sLevel = 0;

// Preallocated colour buffers (no per-frame allocation in draw).
const cA: [number, number, number] = [0, 0, 0];
const cB: [number, number, number] = [0, 0, 0];
const cC: [number, number, number] = [0, 0, 0];

function smoothK(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / Math.max(0.0001, tau));
}

export const auroraScene: GlScene = {
  kind: 'gl',
  id: 'aurora',
  name: 'Aurora',

  init(gl: WebGL2RenderingContext) {
    prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    vao = createEmptyVao(gl);
    uni = new Uniforms(gl, prog);
    sBass = 0;
    sTreble = 0;
    sMid = 0;
    sLevel = 0;
  },

  draw(s: GlSceneContext) {
    const { gl, pxW, pxH, t, dt, audio, hue, va } = s;
    if (!prog || !vao || !uni) return;

    const running = audio.running;
    sBass = lerp(sBass, running ? audio.bass : 0.2, smoothK(dt, 1.1));
    sTreble = lerp(sTreble, running ? audio.treble : 0.05, smoothK(dt, 0.5));
    sMid = lerp(sMid, running ? audio.mid : 0.3, smoothK(dt, 0.9));
    sLevel = lerp(sLevel, running ? audio.level : 0.3, smoothK(dt, 0.7));

    // Three layered hues across the spread.
    const colA = hslToRgb(hue, va.saturation, va.lightness, cA);
    const colB = hslToRgb(spreadHue(va, hue, 0.5), Math.min(100, va.saturation + 8), Math.min(78, va.lightness + 10), cB);
    const colC = hslToRgb(spreadHue(va, hue, 1, 1), va.saturation, Math.min(82, va.lightness + 18), cC);

    const pulse = audio.tempoLocked ? audio.gridPulse : audio.beatIntensity;

    gl.useProgram(prog);
    uni.f2('uRes', pxW, pxH);
    uni.f1('uTime', t);
    uni.v3('uColA', colA);
    uni.v3('uColB', colB);
    uni.v3('uColC', colC);
    uni.f1('uSway', 0.1 + sBass * 0.5);
    uni.f1('uShimmer', sTreble * 1.3);
    uni.f1('uMidMix', clamp01(sMid));
    uni.f1('uBright', clamp01(0.5 + sLevel * 0.6));
    uni.f1('uSpeed', va.speed);
    uni.f1('uScale', 0.8 + va.scale * 0.4);
    uni.f1('uPulse', clamp01(pulse) * 0.15);
    uni.i1('uVariant', va.variant);
    uni.f1('uDir', va.direction);
    uni.f1('uSeed', va.rand(0));

    drawFullscreen(gl, vao);
  },

  dispose(gl: WebGL2RenderingContext) {
    if (prog) gl.deleteProgram(prog);
    if (vao) gl.deleteVertexArray(vao);
    prog = null;
    vao = null;
    uni = null;
  },
};
