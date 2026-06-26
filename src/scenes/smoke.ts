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
 * Smoke — volumetric-looking fog from domain-warped FBM. A single fullscreen
 * fragment pass: 5-octave value-noise FBM, warped by a second FBM offset, with
 * a fine treble shimmer octave on top. Bass drives drift speed + swirl scale,
 * level drives density/brightness. Soft alpha falloff so it reads as wisps over
 * transparency, never a filled rectangle.
 *
 * variant: 0 rising wisps · 1 horizontal drifting banks · 2 rotating vortex ·
 *          3 thin incense streams.
 */

const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;        // physical pixels
uniform float uTime;
uniform vec3 uBase;       // deep base colour
uniform vec3 uHi;         // bright highlight colour
uniform float uDrift;     // upward/lateral drift speed (bass-driven)
uniform float uSwirl;     // domain-warp strength
uniform float uDensity;   // overall opacity gain (level-driven)
uniform float uShimmer;   // treble fine-octave amount
uniform float uScale;     // base feature scale
uniform float uSpeed;     // global time multiplier
uniform float uPulse;     // subtle beat modulation, ~0..0.15
uniform int uVariant;
uniform float uDir;       // +1 / -1 circulation

// ---- value noise + fbm ----
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * vnoise(p * freq);
    freq *= 2.02;
    amp *= 0.5;
  }
  return sum;
}

void main() {
  // Aspect-correct coords centred at 0, y up.
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float t = uTime * uSpeed;
  float dir = uDir;

  // Per-variant flow field feeding the noise domain.
  vec2 q = p * (2.4 * uScale);
  vec2 flow = vec2(0.0);
  float vignette = 1.0;

  if (uVariant == 0) {
    // Rising wisps: smoke scrolls upward, denser near the bottom.
    flow = vec2(0.12 * sin(t * 0.2 + p.x * 1.5), -t * (0.35 + uDrift));
    vignette = smoothstep(-0.95, 0.55, -p.y) * 0.85 + 0.15;
  } else if (uVariant == 1) {
    // Horizontal drifting banks.
    flow = vec2(t * (0.4 + uDrift) * dir, 0.08 * sin(t * 0.18 + p.y * 2.0));
    q.y *= 1.6; // flatten into bands
    vignette = 0.9;
  } else if (uVariant == 2) {
    // Slow rotating vortex around centre.
    float r = length(p);
    float a = atan(p.y, p.x) + dir * (0.5 + uDrift) * (0.6 / (r + 0.25)) * 1.0 + t * 0.15 * dir;
    q = vec2(cos(a), sin(a)) * (r * 3.0 * uScale);
    flow = vec2(0.0, -t * 0.1);
    vignette = smoothstep(1.15, 0.1, r);
  } else {
    // Incense streams: a few narrow vertical columns rising and wavering.
    flow = vec2(0.0, -t * (0.5 + uDrift));
    q.x *= 3.0; // squeeze horizontally so columns are narrow
    q += vec2(0.4 * sin(t * 0.5 + p.y * 4.0), 0.0);
    vignette = smoothstep(-0.95, 0.4, -p.y);
  }

  // Domain warp: offset the lookup by a slowly animated FBM vector.
  vec2 warp = vec2(
    fbm(q * 0.6 + flow + vec2(0.0, t * 0.05)),
    fbm(q * 0.6 + flow + vec2(5.2, 1.3 - t * 0.05))
  );
  vec2 sp = q + flow + (warp - 0.5) * (2.6 * uSwirl);

  float density = fbm(sp);
  // second-pass warp for richer curls
  density = fbm(sp + (vec2(density) - 0.5) * 1.6 * uSwirl + flow * 0.5);

  // Fine treble shimmer octave.
  float shimmer = vnoise(sp * 7.0 + vec2(0.0, -t * 1.6)) * uShimmer;
  density += shimmer * 0.35;

  // Incense: carve into narrow lit columns.
  if (uVariant == 3) {
    float col = abs(fract(p.x * 1.6 + 0.5) - 0.5) * 2.0;
    float column = smoothstep(0.55, 0.0, col);
    density *= column;
  }

  density *= vignette;

  // Soft alpha falloff -> wisps, not a filled rect.
  float d = clamp(density, 0.0, 1.0);
  float alpha = smoothstep(0.32, 0.92, d);
  alpha = pow(alpha, 1.35);
  alpha *= clamp(uDensity, 0.0, 1.0);
  alpha *= (1.0 + uPulse * 0.6);
  alpha = clamp(alpha, 0.0, 0.96);

  // Two-tone: deep base in thin regions, bright highlight in dense cores.
  float hiMix = smoothstep(0.45, 0.95, d);
  vec3 col = mix(uBase, uHi, hiMix);
  // Slight self-illumination in the densest cores.
  col += uHi * pow(hiMix, 3.0) * 0.4 * (0.7 + uPulse);

  // Premultiplied-alpha output.
  fragColor = vec4(col * alpha, alpha);
}`;

/** Module-level GPU handles (one active GL scene at a time). */
let prog: WebGLProgram | null = null;
let vao: WebGLVertexArrayObject | null = null;
let uni: Uniforms | null = null;

// Smoothed audio state (seconds-scale absorption).
let sBass = 0;
let sLevel = 0;
let sTreble = 0;

// Preallocated colour buffers (no per-frame allocation in draw).
const cBase: [number, number, number] = [0, 0, 0];
const cHi: [number, number, number] = [0, 0, 0];

/** Frame-rate-independent smoothing factor for a time constant `tau` seconds. */
function smoothK(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / Math.max(0.0001, tau));
}

export const smokeScene: GlScene = {
  kind: 'gl',
  id: 'smoke',
  name: 'Smoke',

  init(gl: WebGL2RenderingContext) {
    prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    vao = createEmptyVao(gl);
    uni = new Uniforms(gl, prog);
    sBass = 0;
    sLevel = 0;
    sTreble = 0;
  },

  draw(s: GlSceneContext) {
    const { gl, pxW, pxH, t, dt, audio, hue, va } = s;
    if (!prog || !vao || !uni) return;

    const running = audio.running;
    // Slow absorption (0.6–1.2 s constants). Idle: gentle nonzero floor.
    sBass = lerp(sBass, running ? audio.bass : 0.18, smoothK(dt, 0.9));
    sLevel = lerp(sLevel, running ? audio.level : 0.28, smoothK(dt, 0.7));
    sTreble = lerp(sTreble, running ? audio.treble : 0.06, smoothK(dt, 0.5));

    // Two-tone palette from the spread hue.
    const baseHue = hue;
    const hiHue = spreadHue(va, hue, 1, 1);
    const base = hslToRgb(baseHue, va.saturation * 0.7, va.lightness * 0.4, cBase);
    const hi = hslToRgb(hiHue, va.saturation, Math.min(85, va.lightness + 22), cHi);

    const pulse = audio.tempoLocked ? audio.gridPulse : audio.beatIntensity;

    gl.useProgram(prog);
    uni.f2('uRes', pxW, pxH);
    uni.f1('uTime', t);
    uni.v3('uBase', base);
    uni.v3('uHi', hi);
    uni.f1('uDrift', 0.15 + sBass * 0.9);
    uni.f1('uSwirl', 0.55 + sBass * 0.7);
    uni.f1('uDensity', clamp01(0.45 + sLevel * 0.7));
    uni.f1('uShimmer', sTreble * 1.4);
    uni.f1('uScale', 0.8 + va.scale * 0.5);
    uni.f1('uSpeed', va.speed);
    uni.f1('uPulse', clamp01(pulse) * 0.15);
    uni.i1('uVariant', va.variant);
    uni.f1('uDir', va.direction);

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
