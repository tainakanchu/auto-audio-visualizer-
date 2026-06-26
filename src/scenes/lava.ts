import type { GlScene, GlSceneContext } from './types';
import {
  compileProgram,
  createEmptyVao,
  drawFullscreen,
  FULLSCREEN_VERT,
  Uniforms,
} from '../render/glutil';
import type { Variation } from '../variation/types';
import { hslToRgb, spreadHue, clamp, clamp01, lerp } from './util';

/**
 * Lava — a metaball lava lamp. CPU updates N blob centres/radii with slow
 * buoyancy physics (rise/fall, soft wall bounce, lateral sine wander); the
 * fragment shader evaluates a smooth-min field, soft-thresholds the edge, and
 * shades the interior with a vertical gradient + rim light + outer glow.
 *
 * variant: 0 classic rising lamp · 1 horizontal flow · 2 orbit ·
 *          3 split symmetric (mirrored across centre).
 */

/** Max blobs the shader array is sized for (must match the GLSL constant). */
const MAX_BLOBS = 18;

const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;
uniform int uCount;
// xy = position (aspect-corrected space, centred 0, y up), z = radius,
// w = per-blob hue fraction 0..1.
uniform vec4 uBlobs[${MAX_BLOBS}];
uniform vec3 uColLo;   // bottom / shadow colour
uniform vec3 uColHi;   // top / lit colour
uniform vec3 uColRim;  // rim / glow colour
uniform float uPulse;  // subtle beat modulation
uniform int uSymFold;  // mirror fold for variant 3 (0 = off)

// polynomial smooth min accumulation -> metaball field
void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);

  if (uSymFold == 1) {
    p.x = abs(p.x);
  }

  // Accumulate inverse-square-ish field for smooth blending.
  float field = 0.0;
  vec2 grad = vec2(0.0);
  for (int i = 0; i < ${MAX_BLOBS}; i++) {
    if (i >= uCount) break;
    vec4 b = uBlobs[i];
    vec2 d = p - b.xy;
    float r2 = dot(d, d) + 1e-4;
    float w = (b.z * b.z) / r2;
    field += w;
    // gradient of the field (for surface normal / rim)
    grad += (-2.0 * w / r2) * d;
  }

  // Soft threshold around field == 1.0 gives the blob surface.
  float surf = smoothstep(0.75, 1.45, field);
  float edge = smoothstep(0.75, 1.05, field) - smoothstep(1.35, 2.2, field);

  // Interior shading: vertical gradient by screen y + field intensity.
  float vert = clamp(vUv.y, 0.0, 1.0);
  vec3 body = mix(uColLo, uColHi, vert * 0.7 + smoothstep(1.0, 3.0, field) * 0.5);

  // Rim light along the field gradient (surface-ish normal).
  vec2 n = normalize(grad + 1e-5);
  float rim = pow(clamp(0.5 + 0.5 * n.y, 0.0, 1.0), 1.5) * edge;
  body += uColRim * rim * 0.7;

  // Faint outer glow just outside the surface.
  float glow = smoothstep(0.35, 1.0, field) * (1.0 - surf);
  vec3 glowCol = uColRim * glow * 0.5;

  float alpha = surf * (0.92 + uPulse * 0.4) + glow * 0.28;
  alpha = clamp(alpha, 0.0, 0.97);

  vec3 col = body * surf + glowCol;
  // gentle core brightening on strong field
  col += uColHi * pow(surf, 2.0) * 0.18 * (0.7 + uPulse);

  fragColor = vec4(col * alpha, alpha);
}`;

interface Blob {
  x: number; // aspect-corrected x (centred 0)
  y: number; // screen-space-ish y, -0.5..0.5 (y up)
  vy: number;
  baseR: number;
  hueFrac: number;
  lane: number; // base x lane
  phase: number;
  wanderAmp: number;
  orbitR: number;
  orbitAng: number;
  orbitSpeed: number;
}

let prog: WebGLProgram | null = null;
let vao: WebGLVertexArrayObject | null = null;
let uni: Uniforms | null = null;

let blobs: Blob[] = [];
const blobData = new Float32Array(MAX_BLOBS * 4);
let count = 0;
let builtSeed = '';
let builtVariant = -1;

// Smoothed audio.
let sLevel = 0;
let sBass = 0;

// Preallocated colour buffers (no per-frame allocation in draw).
const cLo: [number, number, number] = [0, 0, 0];
const cHi: [number, number, number] = [0, 0, 0];
const cRim: [number, number, number] = [0, 0, 0];

function smoothK(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / Math.max(0.0001, tau));
}

/** (Re)build the blob set deterministically from the variation. */
function buildBlobs(va: Variation): void {
  count = clamp(Math.round(8 + va.density * 5), 8, MAX_BLOBS);
  blobs = [];
  for (let i = 0; i < count; i++) {
    const r0 = va.rand(i * 4 + 0);
    const r1 = va.rand(i * 4 + 1);
    const r2 = va.rand(i * 4 + 2);
    const r3 = va.rand(i * 4 + 3);
    const baseR = (0.1 + r0 * 0.12) * (0.85 + va.scale * 0.3);
    const lane = (r1 - 0.5) * 1.3; // spread across width
    const orbitR = 0.18 + r2 * 0.42;
    blobs.push({
      x: lane,
      y: (r2 - 0.5) * 0.9,
      vy: (r3 - 0.5) * 0.06,
      baseR,
      hueFrac: r0,
      lane,
      phase: r1 * Math.PI * 2,
      wanderAmp: (0.04 + r3 * 0.14) * va.wobble,
      orbitR,
      orbitAng: r1 * Math.PI * 2,
      orbitSpeed: (0.15 + r0 * 0.35) * va.speed * va.direction,
    });
  }
  builtSeed = va.seed;
  builtVariant = va.variant;
}

export const lavaScene: GlScene = {
  kind: 'gl',
  id: 'lava',
  name: 'Lava',

  init(gl: WebGL2RenderingContext) {
    prog = compileProgram(gl, FULLSCREEN_VERT, FRAG);
    vao = createEmptyVao(gl);
    uni = new Uniforms(gl, prog);
    sLevel = 0;
    sBass = 0;
    builtSeed = '';
    builtVariant = -1;
  },

  draw(s: GlSceneContext) {
    const { gl, pxW, pxH, t, dt, audio, hue, va } = s;
    if (!prog || !vao || !uni) return;

    // Rebuild blobs when the seed or variant changes (cheap; no GPU churn).
    if (va.seed !== builtSeed || va.variant !== builtVariant) buildBlobs(va);

    const running = audio.running;
    sLevel = lerp(sLevel, running ? audio.level : 0.25, smoothK(dt, 0.8));
    sBass = lerp(sBass, running ? audio.bass : 0.2, smoothK(dt, 1.0));

    const aspect = pxW / pxH;
    const variant = va.variant;
    const buoy = 0.05 + sBass * 0.14; // bass adds buoyancy
    const radiusGain = 1 + sLevel * 0.2; // level scales radii (<=20%)
    const dir = va.direction;

    for (let i = 0; i < count; i++) {
      const b = blobs[i]!;
      let px: number;
      let py: number;
      const r = b.baseR * radiusGain;

      if (variant === 2) {
        // Orbit: circulate around centre.
        b.orbitAng += b.orbitSpeed * dt;
        const wob = Math.sin(t * 0.6 + b.phase) * b.wanderAmp * 0.6;
        px = Math.cos(b.orbitAng) * (b.orbitR + wob);
        py = Math.sin(b.orbitAng) * (b.orbitR + wob) * 0.85;
      } else if (variant === 1) {
        // Horizontal flow: blobs stream sideways, wrapping around.
        b.x += dir * (0.12 + buoy) * dt;
        const half = aspect * 0.5 + r;
        if (b.x > half) b.x = -half;
        if (b.x < -half) b.x = half;
        py = b.lane * 0.7 + Math.sin(t * 0.7 + b.phase) * b.wanderAmp;
        px = b.x;
      } else {
        // 0 classic rising lamp / 3 split symmetric: vertical buoyancy.
        // Slight density-style oscillation: rise then sink, soft wall bounce.
        b.vy += buoy * dt * Math.sin(t * 0.3 + b.phase * 1.3);
        b.vy += buoy * 0.4 * dt; // net upward bias
        b.vy *= 0.985; // drag
        b.y += b.vy * dt * 6.0;
        const wall = 0.5 + r * 0.5;
        if (b.y > wall) {
          b.y = wall;
          b.vy = -Math.abs(b.vy) * 0.6;
        } else if (b.y < -wall) {
          b.y = -wall;
          b.vy = Math.abs(b.vy) * 0.6;
        }
        const wander = Math.sin(t * (0.4 + b.phase * 0.1) + b.phase) * b.wanderAmp;
        px = b.lane + wander;
        py = b.y;
      }

      const o = i * 4;
      blobData[o + 0] = px;
      blobData[o + 1] = py;
      blobData[o + 2] = r;
      blobData[o + 3] = b.hueFrac;
    }

    // Palette: three keys spanning the spread.
    const colLo = hslToRgb(hue, va.saturation, Math.max(20, va.lightness - 28), cLo);
    const colHi = hslToRgb(spreadHue(va, hue, 1), va.saturation, Math.min(80, va.lightness + 14), cHi);
    const colRim = hslToRgb(spreadHue(va, hue, 0.5, 1), va.saturation, Math.min(88, va.lightness + 28), cRim);

    const pulse = audio.tempoLocked ? audio.gridPulse : audio.beatIntensity;

    gl.useProgram(prog);
    uni.f2('uRes', pxW, pxH);
    uni.i1('uCount', count);
    uni.v4array('uBlobs', blobData);
    uni.v3('uColLo', colLo);
    uni.v3('uColHi', colHi);
    uni.v3('uColRim', colRim);
    uni.f1('uPulse', clamp01(pulse) * 0.15);
    uni.i1('uSymFold', variant === 3 ? 1 : 0);

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
