import type { GlScene, GlSceneContext } from './types';
import {
  checkFloatColorSupport,
  compileProgram,
  createEmptyVao,
  createFbo,
  createPingPong,
  disposeFbo,
  drawFullscreen,
  FULLSCREEN_VERT,
  Uniforms,
  type Fbo,
  type PingPong,
} from '../render/glutil';
import type { Variation } from '../variation/types';
import { beatPulse, clamp, clamp01, hslToRgb, lerp, spreadHue } from './util';

/**
 * Fluid Ink — ink marbling in water via a real GPU fluid simulation
 * (Jos Stam "Stable Fluids" + vorticity confinement, the classic WebGL
 * formulation). Velocity / pressure live on a small aspect-correct grid
 * (~128 short side); dye is advected at a higher resolution (~512 short side)
 * so the ink filaments stay crisp. 2–4 invisible "stirrers" orbit on slow
 * Lissajous paths and splat directional force + dye each frame; the audio is
 * absorbed slowly (seconds-scale smoothing) so the ink is *gently swallowed*
 * by the music rather than exploding on beats.
 *
 * Float-render support matrix:
 * - no EXT_color_buffer_float → cheap single-pass procedural marble fallback.
 * - float renderable but no OES_texture_float_linear → NEAREST textures +
 *   manual bilinear in the advection back-trace and dye display upscale.
 *
 * variant: 0 marbling (centre drops) · 1 edge jets (symmetry emitters) ·
 *          2 mandala (splats mirrored va.symmetry ways) · 3 ribbon sweep.
 */

// ---- Tuning constants ------------------------------------------------------

/** Sim never integrates more than this per frame (stalled-tab safety). */
const SIM_DT_MAX = 1 / 30;
/** Velocity fade per second (advection decay). */
const VELOCITY_DISSIPATION = 0.15;
/** Dye fade per second. */
const DYE_DISSIPATION = 0.25;
/** Jacobi relaxation iterations for the pressure solve. */
const PRESSURE_ITERATIONS = 14;
/** Warm-start damping applied to last frame's pressure. */
const PRESSURE_DAMPING = 0.8;
/** Shader-side uniform array size (4 stirrers × 8-way mandala). */
const MAX_SPLATS = 32;
/** Max emitters (edge-jet variant uses up to va.symmetry = 8). */
const MAX_EMITTERS = 8;
/** Cap on splat force magnitude, sim-texels/s² (spike safety). */
const MAX_FORCE = 600;
/** Stirrer force gain: velocity × (base + bass·gain), per second. */
const FORCE_GAIN_BASE = 5;
const FORCE_GAIN_BASS = 11;
/** Edge-jet inward force, sim-texels/s². */
const JET_FORCE_BASE = 45;
const JET_FORCE_BASS = 130;
/** Dye injection rate per second (level-driven, with idle floor via sLevel). */
const DYE_RATE_BASE = 0.3;
const DYE_RATE_LEVEL = 1.05;
/** Gaussian splat radius in uv² units (scaled by va.scale²). */
const SPLAT_RADIUS_BASE = 0.0021;

const TAU = Math.PI * 2;

// ---- GLSL ------------------------------------------------------------------

/** Manual bilinear fetch for float textures without OES_texture_float_linear. */
const BILERP = `
vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize) {
  vec2 st = uv / tsize - 0.5;
  vec2 iuv = floor(st);
  vec2 fuv = fract(st);
  vec4 a = texture(sam, (iuv + vec2(0.5, 0.5)) * tsize);
  vec4 b = texture(sam, (iuv + vec2(1.5, 0.5)) * tsize);
  vec4 c = texture(sam, (iuv + vec2(0.5, 1.5)) * tsize);
  vec4 d = texture(sam, (iuv + vec2(1.5, 1.5)) * tsize);
  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}`;

/**
 * Bodies for the two shaders that need a MANUAL_FILTERING compile-time
 * variant; assembled by {@link assembleFrag} (which puts `#version 300 es`
 * on the first line).
 */
const ADVECTION_BODY = `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexelSize;    // velocity (sim) texel
uniform vec2 uSrcTexelSize; // source texel (differs for the dye pass)
uniform float uDt;
uniform float uDissipation;
#ifdef MANUAL_FILTERING
${BILERP}
#endif
void main() {
#ifdef MANUAL_FILTERING
  vec2 coord = vUv - uDt * bilerp(uVelocity, vUv, uTexelSize).xy * uTexelSize;
  vec4 result = bilerp(uSource, coord, uSrcTexelSize);
#else
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexelSize;
  vec4 result = texture(uSource, coord);
#endif
  fragColor = result / (1.0 + uDissipation * uDt);
}`;

const DISPLAY_BODY = `
uniform sampler2D uDye;
uniform vec2 uTexelSize; // dye texel
#ifdef MANUAL_FILTERING
${BILERP}
#endif
void main() {
#ifdef MANUAL_FILTERING
  vec3 c = bilerp(uDye, vUv, uTexelSize).rgb;
#else
  vec3 c = texture(uDye, vUv).rgb;
#endif
  // Alpha from dye luminance with a soft knee: genuinely 0 where there is no
  // ink (OBS transparency), saturating gently in dense cores.
  float lum = max(c.r, max(c.g, c.b));
  float aRaw = 1.0 - exp(-lum * 2.6);
  float a = clamp((aRaw - 0.012) * 1.03, 0.0, 0.95);
  vec3 col = c / (1.0 + 0.4 * lum); // soft highlight rolloff
  fragColor = vec4(col * a, a);     // premultiplied alpha
}`;

const CURL_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;
void main() {
  float L = texture(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).y;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexelSize.y)).x;
  fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

const VORTICITY_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexelSize;
uniform float uStrength;
uniform float uDt;
void main() {
  float L = texture(uCurl, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexelSize.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= uStrength * C;
  force.y *= -1.0;
  vec2 velocity = texture(uVelocity, vUv).xy + force * uDt;
  fragColor = vec4(clamp(velocity, vec2(-1000.0), vec2(1000.0)), 0.0, 1.0);
}`;

const DIVERGENCE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;
void main() {
  vec2 vL = vUv - vec2(uTexelSize.x, 0.0);
  vec2 vR = vUv + vec2(uTexelSize.x, 0.0);
  vec2 vB = vUv - vec2(0.0, uTexelSize.y);
  vec2 vT = vUv + vec2(0.0, uTexelSize.y);
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float B = texture(uVelocity, vB).y;
  float T = texture(uVelocity, vT).y;
  vec2 C = texture(uVelocity, vUv).xy;
  // Solid-wall reflection at the borders (cheap containment).
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vB.y < 0.0) B = -C.y;
  if (vT.y > 1.0) T = -C.y;
  fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

const PRESSURE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexelSize;
void main() {
  float L = texture(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
  float divergence = texture(uDivergence, vUv).x;
  fragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;
void main() {
  float L = texture(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
  vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  fragColor = vec4(velocity, 0.0, 1.0);
}`;

/** Multiply a field by a scalar (pressure warm-start damping). */
const CLEAR_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform float uValue;
void main() {
  fragColor = uValue * texture(uTexture, vUv);
}`;

/** Accumulate up to MAX_SPLATS gaussian splats in one pass (force or dye). */
const SPLAT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTarget;
uniform float uAspect;
uniform int uCount;
uniform vec4 uPosRad[${MAX_SPLATS}]; // xy = uv position, z = radius
uniform vec4 uVal[${MAX_SPLATS}];    // xyz = added value
void main() {
  vec3 acc = texture(uTarget, vUv).xyz;
  for (int i = 0; i < ${MAX_SPLATS}; i++) {
    if (i >= uCount) break;
    vec2 p = vUv - uPosRad[i].xy;
    p.x *= uAspect;
    acc += exp(-dot(p, p) / uPosRad[i].z) * uVal[i].xyz;
  }
  fragColor = vec4(acc, 1.0);
}`;

/**
 * Fallback when float-colour rendering is unavailable: single-pass procedural
 * ink marble (FBM + domain warp + vein banding), modelled on smoke.ts.
 */
const FALLBACK_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uFlow;     // bass-driven warp strength
uniform float uDensity;  // level-driven opacity
uniform float uShimmer;  // treble fine detail
uniform float uMidMix;   // mid-driven palette drift
uniform float uScale;
uniform float uSpeed;
uniform float uPulse;
uniform int uVariant;
uniform float uDir;
uniform float uSeed;
uniform float uSym;

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

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0) * (1.7 * uScale);
  float t = uTime * uSpeed * 0.32 * uDir;

  if (uVariant == 2) {
    // Kaleidoscopic fold for the mandala look.
    float seg = 6.2831853 / max(uSym, 2.0);
    float ang = atan(p.y, p.x);
    ang = abs(mod(ang, seg) - seg * 0.5);
    p = vec2(cos(ang), sin(ang)) * length(p);
  }

  vec2 q = p * 1.9 + vec2(uSeed * 17.3, uSeed * 9.1);
  float n1 = fbm(q + vec2(t * 0.34, -t * 0.22));
  vec2 w = vec2(
    fbm(q * 1.13 + vec2(n1 * 2.1 + 3.7, t * 0.17)),
    fbm(q * 1.13 + vec2(-t * 0.14, n1 * 2.1 + 8.2)));
  float m = fbm(q + (w - 0.5) * (2.1 + uFlow * 2.4));

  // Marble veins: banded sine over the warped field.
  float veins = 0.5 + 0.5 * sin(m * 10.0 + n1 * 5.0 + t * 0.8);
  veins = pow(veins, 1.7);
  veins += vnoise(q * 6.0 + vec2(0.0, -t * 1.3)) * uShimmer * 0.4;

  float ink = smoothstep(0.34, 0.9, m) * (0.5 + veins * 0.65);

  if (uVariant == 1) {
    // Edge jets: ink hugs the borders, thins at centre.
    float edge = length((vUv - 0.5) * 2.0);
    ink *= 0.35 + smoothstep(0.2, 1.0, edge) * 0.9;
  } else if (uVariant == 3) {
    // Ribbon: concentrate into one winding band.
    float band = 0.5 + sin(p.x * 1.2 + t * 0.5) * 0.2 + (n1 - 0.5) * 0.3;
    float yb = vUv.y - band;
    ink *= 0.25 + exp(-yb * yb / 0.04);
  }

  float alpha = clamp(ink * (0.45 + uDensity * 0.75), 0.0, 0.94);
  alpha = clamp(alpha * (1.0 + uPulse * 0.5), 0.0, 0.94);

  vec3 col = mix(uC0, uC1, clamp(veins, 0.0, 1.0));
  col = mix(col, uC2, uMidMix * smoothstep(0.45, 0.95, m));
  col = col / (1.0 + col * 0.4);

  fragColor = vec4(col * alpha, alpha);
}`;

/** Assemble a fragment shader with the optional MANUAL_FILTERING define. */
function assembleFrag(body: string, manualFilter: boolean): string {
  const define = manualFilter ? '#define MANUAL_FILTERING 1\n' : '';
  return (
    `#version 300 es\n` +
    `precision highp float;\n` +
    `precision highp sampler2D;\n` +
    define +
    `in vec2 vUv;\nout vec4 fragColor;\n` +
    body
  );
}

// ---- Module state ----------------------------------------------------------

interface Pass {
  prog: WebGLProgram;
  uni: Uniforms;
}

function makePass(gl: WebGL2RenderingContext, fragSrc: string): Pass {
  const prog = compileProgram(gl, FULLSCREEN_VERT, fragSrc);
  return { prog, uni: new Uniforms(gl, prog) };
}

interface Passes {
  advect: Pass;
  curl: Pass;
  vorticity: Pass;
  divergence: Pass;
  pressure: Pass;
  gradient: Pass;
  splat: Pass;
  clear: Pass;
  display: Pass;
}

interface Targets {
  velocity: PingPong;   // RG16F, sim res
  dye: PingPong;        // RGBA16F, dye res
  pressure: PingPong;   // R16F, sim res
  divergence: Fbo;      // R16F, sim res
  curl: Fbo;            // R16F, sim res
  simW: number;
  simH: number;
  dyeW: number;
  dyeH: number;
}

/**
 * An invisible stirrer / emitter. Field meaning is variant-dependent: for
 * edge jets, cx is the base perimeter angle and ax/wx the slide amp/speed.
 */
interface Emitter {
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  wx: number;
  wy: number;
  phx: number;
  phy: number;
  x: number;
  y: number;
}

let vao: WebGLVertexArrayObject | null = null;
let passes: Passes | null = null;
let fallback: Pass | null = null;
let targets: Targets | null = null;
let supported = false;
let floatLinear = false;

let emitters: Emitter[] = [];
let emitterCount = 0;
let builtSeed = '';
let builtVariant = -1;
let freshBuild = true;
let orbitT = 0;
let palPhase = 0;

// Smoothed audio (seconds-scale absorption; idle floors keep it alive).
let sBass = 0;
let sLevel = 0;
let sMid = 0;
let sTreble = 0;

// Preallocated palette tuples + splat scratch (no per-frame allocation).
const cPal0: [number, number, number] = [0, 0, 0];
const cPal1: [number, number, number] = [0, 0, 0];
const cPal2: [number, number, number] = [0, 0, 0];
const palRefs = [cPal0, cPal1, cPal2] as const;

const forcePosRad = new Float32Array(MAX_SPLATS * 4);
const forceVal = new Float32Array(MAX_SPLATS * 4);
const dyePosRad = new Float32Array(MAX_SPLATS * 4);
const dyeVal = new Float32Array(MAX_SPLATS * 4);
let fCount = 0;
let dCount = 0;

function smoothK(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / Math.max(0.0001, tau));
}

// ---- GPU resource management -----------------------------------------------

function setNearest(gl: WebGL2RenderingContext, tex: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
}

function disposeTargets(gl: WebGL2RenderingContext): void {
  const tg = targets;
  if (!tg) return;
  tg.velocity.dispose(gl);
  tg.dye.dispose(gl);
  tg.pressure.dispose(gl);
  disposeFbo(gl, tg.divergence);
  disposeFbo(gl, tg.curl);
  targets = null;
}

/**
 * (Re)create the field FBOs for the current drawing-buffer size. Sim short
 * side ~128 (96..160), dye short side ~512 (384..768), aspect-correct with the
 * long side capped at 4× short. New textures are zero-filled by WebGL, so a
 * recreate doubles as a field clear.
 */
function ensureTargets(gl: WebGL2RenderingContext, pxW: number, pxH: number): void {
  const shortPx = Math.max(1, Math.min(pxW, pxH));
  const ratio = Math.min(4, Math.max(pxW, pxH) / shortPx);
  const simShort = clamp(Math.round(shortPx / 8), 96, 160);
  const dyeShort = clamp(Math.round(shortPx / 2), 384, 768);
  const simLong = Math.max(simShort, Math.round(simShort * ratio));
  const dyeLong = Math.max(dyeShort, Math.round(dyeShort * ratio));
  const landscape = pxW >= pxH;
  const simW = landscape ? simLong : simShort;
  const simH = landscape ? simShort : simLong;
  const dyeW = landscape ? dyeLong : dyeShort;
  const dyeH = landscape ? dyeShort : dyeLong;
  const tg = targets;
  if (tg && tg.simW === simW && tg.simH === simH && tg.dyeW === dyeW && tg.dyeH === dyeH) {
    return;
  }
  disposeTargets(gl);
  const velocity = createPingPong(gl, simW, simH, gl.RG16F);
  const dye = createPingPong(gl, dyeW, dyeH, gl.RGBA16F);
  const pressure = createPingPong(gl, simW, simH, gl.R16F);
  const divergence = createFbo(gl, simW, simH, gl.R16F);
  const curl = createFbo(gl, simW, simH, gl.R16F);
  if (!floatLinear) {
    // createFbo sets LINEAR; without OES_texture_float_linear that samples as
    // black on float textures, so force NEAREST (shaders bilerp manually).
    setNearest(gl, velocity.read.tex);
    setNearest(gl, velocity.write.tex);
    setNearest(gl, dye.read.tex);
    setNearest(gl, dye.write.tex);
    setNearest(gl, pressure.read.tex);
    setNearest(gl, pressure.write.tex);
    setNearest(gl, divergence.tex);
    setNearest(gl, curl.tex);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  targets = { velocity, dye, pressure, divergence, curl, simW, simH, dyeW, dyeH };
}

/** Clear every field to zero (seed/variant change → fresh marble). */
function clearTargets(gl: WebGL2RenderingContext): void {
  const tg = targets;
  if (!tg) return;
  gl.clearColor(0, 0, 0, 0);
  const fbos = [
    tg.velocity.read, tg.velocity.write,
    tg.dye.read, tg.dye.write,
    tg.pressure.read, tg.pressure.write,
    tg.divergence, tg.curl,
  ];
  for (const f of fbos) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

function bindTex(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}

/** Bind an offscreen target, set its viewport and draw the fullscreen tri. */
function blit(gl: WebGL2RenderingContext, target: Fbo): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.viewport(0, 0, target.w, target.h);
  if (vao) drawFullscreen(gl, vao);
}

// ---- Stirrers / emitters -----------------------------------------------------

/** (Re)seed emitter orbits deterministically from the variation. */
function rebuild(va: Variation): void {
  builtSeed = va.seed;
  builtVariant = va.variant;
  orbitT = 0;
  palPhase = 0;
  freshBuild = true;
  emitters = [];
  let count: number;
  if (va.variant === 1) count = clamp(Math.round(va.symmetry), 2, MAX_EMITTERS);
  else if (va.variant === 3) count = 3;
  else count = clamp(Math.round(1.2 + va.density * 1.4), 2, 4);

  for (let i = 0; i < count; i++) {
    const r0 = va.rand(i * 6 + 0);
    const r1 = va.rand(i * 6 + 1);
    const r2 = va.rand(i * 6 + 2);
    const r3 = va.rand(i * 6 + 3);
    const r4 = va.rand(i * 6 + 4);
    const r5 = va.rand(i * 6 + 5);
    if (va.variant === 1) {
      // Edge jet: cx = base perimeter angle, ax/wx = slide amplitude/speed.
      emitters.push({
        cx: ((i + 0.5) / count) * TAU + (r0 - 0.5) * 0.4,
        cy: 0,
        ax: 0.18 + r1 * 0.3,
        ay: 0,
        wx: 0.1 + r2 * 0.22,
        wy: 0,
        phx: r3 * TAU,
        phy: r4 * TAU,
        x: 0.5,
        y: 0.5,
      });
    } else if (va.variant === 3 && i === 0) {
      // Ribbon: one wide slow Lissajous sweep across the whole screen.
      emitters.push({
        cx: 0.5,
        cy: 0.5,
        ax: 0.42,
        ay: 0.34,
        wx: 0.2 + r0 * 0.1,
        wy: 0.29 + r1 * 0.12,
        phx: r2 * TAU,
        phy: r3 * TAU,
        x: 0.5,
        y: 0.5,
      });
    } else {
      // Marbling / mandala stirrer (mandala orbits a little tighter).
      const tight = va.variant === 2 ? 0.8 : 1;
      emitters.push({
        cx: 0.5 + (r0 - 0.5) * 0.28,
        cy: 0.5 + (r1 - 0.5) * 0.28,
        ax: (0.13 + r2 * 0.17) * tight,
        ay: (0.13 + r3 * 0.17) * tight,
        wx: 0.16 + r4 * 0.3,
        wy: 0.16 + r5 * 0.3,
        phx: r5 * TAU,
        phy: r4 * TAU,
        x: 0.5,
        y: 0.5,
      });
    }
  }
  emitterCount = count;
}

/** Blend between the 3 palette keys and write rgb·amount into a vec4 slot. */
function mixPalette(k: number, out: Float32Array, o: number, amount: number): void {
  const k0 = Math.floor(k);
  let f = k - k0;
  f = f * f * (3 - 2 * f);
  const ia = ((k0 % 3) + 3) % 3;
  const ib = (ia + 1) % 3;
  const pa = palRefs[ia]!;
  const pb = palRefs[ib]!;
  out[o + 0] = (pa[0] + (pb[0] - pa[0]) * f) * amount;
  out[o + 1] = (pa[1] + (pb[1] - pa[1]) * f) * amount;
  out[o + 2] = (pa[2] + (pb[2] - pa[2]) * f) * amount;
  out[o + 3] = 0;
}

function pushForce(x: number, y: number, rad: number, vx: number, vy: number): void {
  if (fCount >= MAX_SPLATS) return;
  const o = fCount * 4;
  forcePosRad[o + 0] = x;
  forcePosRad[o + 1] = y;
  forcePosRad[o + 2] = rad;
  forcePosRad[o + 3] = 0;
  forceVal[o + 0] = vx;
  forceVal[o + 1] = vy;
  forceVal[o + 2] = 0;
  forceVal[o + 3] = 0;
  fCount++;
}

function pushDye(x: number, y: number, rad: number, palK: number, amount: number): void {
  if (dCount >= MAX_SPLATS) return;
  const o = dCount * 4;
  dyePosRad[o + 0] = x;
  dyePosRad[o + 1] = y;
  dyePosRad[o + 2] = rad;
  dyePosRad[o + 3] = 0;
  mixPalette(palK, dyeVal, o, amount);
  dCount++;
}

/**
 * Advance the stirrers along their orbits and fill the force/dye splat
 * uniform arrays for this frame. Force is directed along each stirrer's
 * motion vector (sim-texel units), bass-scaled with a gentle idle floor;
 * dye colour cycles between the palette keys at a mid-driven rate.
 */
function updateAndFill(
  tg: Targets,
  va: Variation,
  t: number,
  dtSim: number,
  aspect: number,
  boost: number,
): void {
  fCount = 0;
  dCount = 0;
  orbitT += dtSim * va.speed;
  palPhase += dtSim * (0.05 + sMid * 0.22);
  const T = orbitT * va.direction;
  const invDt = dtSim > 1e-6 ? 1 / dtSim : 0;
  const variant = builtVariant;
  const radF = SPLAT_RADIUS_BASE * va.scale * va.scale;
  const radD = radF * 1.5;
  const jitter = sTreble * 0.008; // subtle treble positional shimmer
  const kForce = (FORCE_GAIN_BASE + sBass * FORCE_GAIN_BASS) * boost;
  const jetMag = (JET_FORCE_BASE + sBass * JET_FORCE_BASS) * boost;
  const dyeRate = DYE_RATE_BASE + sLevel * DYE_RATE_LEVEL;
  const sym = variant === 2 ? clamp(Math.round(va.symmetry), 2, 8) : 1;

  for (let i = 0; i < emitterCount; i++) {
    const e = emitters[i]!;
    let nx = 0;
    let ny = 0;
    let x: number;
    let y: number;
    if (variant === 1) {
      // Slide along the screen border; force points inward.
      const theta = e.cx + Math.sin(T * e.wx + e.phx) * e.ax;
      const dx = Math.cos(theta);
      const dy = Math.sin(theta);
      const m = 0.46 / Math.max(Math.abs(dx), Math.abs(dy));
      x = 0.5 + dx * m;
      y = 0.5 + dy * m;
      nx = -dx;
      ny = -dy;
    } else {
      x = e.cx + e.ax * Math.sin(e.wx * T + e.phx);
      y = e.cy + e.ay * Math.sin(e.wy * T + e.phy);
    }
    x += Math.sin(t * 6.3 + e.phx * 13.0) * jitter;
    y += Math.cos(t * 5.1 + e.phy * 17.0) * jitter;

    const lastX = e.x;
    const lastY = e.y;
    e.x = x;
    e.y = y;
    const prevX = freshBuild ? x : lastX;
    const prevY = freshBuild ? y : lastY;

    // Force in sim-texel/s² (isotropic in screen space), premultiplied by dt.
    let fx: number;
    let fy: number;
    if (variant === 1) {
      const dx2 = nx * tg.simW;
      const dy2 = ny * tg.simH;
      const len = Math.hypot(dx2, dy2) || 1;
      fx = (dx2 / len) * jetMag;
      fy = (dy2 / len) * jetMag;
    } else {
      fx = (x - prevX) * invDt * tg.simW * kForce;
      fy = (y - prevY) * invDt * tg.simH * kForce;
      const mag = Math.hypot(fx, fy);
      if (mag > MAX_FORCE) {
        const sc = MAX_FORCE / mag;
        fx *= sc;
        fy *= sc;
      }
    }
    fx *= dtSim;
    fy *= dtSim;

    const wantDye = variant !== 3 || i === 0;
    const amount = dyeRate * dtSim * (variant === 3 ? 1.7 : 1);
    const palK = i * 0.78 + palPhase;

    if (variant === 2) {
      // Mandala: mirror every splat va.symmetry ways around the centre
      // (positions rotated in aspect-corrected space, force vector rotated
      // to match).
      const step = TAU / sym;
      const px0 = (x - 0.5) * aspect;
      const py0 = y - 0.5;
      for (let k = 0; k < sym; k++) {
        const ca = Math.cos(step * k);
        const sa = Math.sin(step * k);
        const sx = (px0 * ca - py0 * sa) / aspect + 0.5;
        const sy = px0 * sa + py0 * ca + 0.5;
        pushForce(sx, sy, radF, fx * ca - fy * sa, fx * sa + fy * ca);
        pushDye(sx, sy, radD, palK, amount);
      }
    } else {
      pushForce(x, y, radF, fx, fy);
      if (wantDye) pushDye(x, y, radD, palK, amount);
    }
  }
  freshBuild = false;
}

// ---- Fallback path -----------------------------------------------------------

function drawFallback(s: GlSceneContext, pulse: number): void {
  const fb = fallback;
  if (!fb || !vao) return;
  const { gl, pxW, pxH, t, va } = s;
  gl.useProgram(fb.prog);
  fb.uni.f2('uRes', pxW, pxH);
  fb.uni.f1('uTime', t);
  fb.uni.v3('uC0', cPal0);
  fb.uni.v3('uC1', cPal1);
  fb.uni.v3('uC2', cPal2);
  fb.uni.f1('uFlow', clamp01(sBass));
  fb.uni.f1('uDensity', clamp01(0.4 + sLevel * 0.7));
  fb.uni.f1('uShimmer', sTreble * 1.2);
  fb.uni.f1('uMidMix', clamp01(sMid));
  fb.uni.f1('uScale', 0.8 + va.scale * 0.5);
  fb.uni.f1('uSpeed', va.speed);
  fb.uni.f1('uPulse', pulse * 0.15);
  fb.uni.i1('uVariant', va.variant);
  fb.uni.f1('uDir', va.direction);
  fb.uni.f1('uSeed', va.rand(0));
  fb.uni.f1('uSym', va.symmetry);
  drawFullscreen(gl, vao);
}

// ---- Scene -------------------------------------------------------------------

export const fluidScene: GlScene = {
  kind: 'gl',
  id: 'fluid',
  name: 'Fluid Ink',

  init(gl: WebGL2RenderingContext) {
    const support = checkFloatColorSupport(gl);
    supported = support.rgba16f;
    floatLinear = support.floatLinear;
    vao = createEmptyVao(gl);
    // init also runs after a context restore: old handles are dead, drop them.
    targets = null;
    passes = null;
    fallback = null;
    if (supported) {
      const manual = !floatLinear;
      passes = {
        advect: makePass(gl, assembleFrag(ADVECTION_BODY, manual)),
        curl: makePass(gl, CURL_FRAG),
        vorticity: makePass(gl, VORTICITY_FRAG),
        divergence: makePass(gl, DIVERGENCE_FRAG),
        pressure: makePass(gl, PRESSURE_FRAG),
        gradient: makePass(gl, GRADIENT_FRAG),
        splat: makePass(gl, SPLAT_FRAG),
        clear: makePass(gl, CLEAR_FRAG),
        display: makePass(gl, assembleFrag(DISPLAY_BODY, manual)),
      };
    } else {
      fallback = makePass(gl, FALLBACK_FRAG);
    }
    sBass = 0;
    sLevel = 0;
    sMid = 0;
    sTreble = 0;
    builtSeed = '';
    builtVariant = -1;
    emitterCount = 0;
    orbitT = 0;
    palPhase = 0;
    freshBuild = true;
  },

  draw(s: GlSceneContext) {
    const { gl, pxW, pxH, t, dt, audio, hue, va } = s;
    if (!vao) return;

    const running = audio.running;
    // Slow absorption with idle floors: silence keeps a calm living marble.
    sBass = lerp(sBass, running ? audio.bass : 0.18, smoothK(dt, 1.0));
    sLevel = lerp(sLevel, running ? audio.level : 0.28, smoothK(dt, 0.8));
    sMid = lerp(sMid, running ? audio.mid : 0.3, smoothK(dt, 1.2));
    sTreble = lerp(sTreble, running ? audio.treble : 0.05, smoothK(dt, 0.5));

    // Three palette keys; injected dye cycles between them.
    hslToRgb(hue, va.saturation, va.lightness, cPal0);
    hslToRgb(
      spreadHue(va, hue, 0.5, 1),
      Math.min(100, va.saturation + 6),
      Math.min(80, va.lightness + 10),
      cPal1,
    );
    hslToRgb(
      spreadHue(va, hue, 1, 2),
      va.saturation,
      Math.min(84, va.lightness + 18),
      cPal2,
    );

    const pulse = clamp01(beatPulse(audio));

    if (!supported || !passes) {
      drawFallback(s, pulse);
      return;
    }

    ensureTargets(gl, pxW, pxH);
    const tg = targets;
    if (!tg) return;

    if (va.seed !== builtSeed || va.variant !== builtVariant) {
      rebuild(va);
      clearTargets(gl);
    }

    const dtSim = Math.min(dt, SIM_DT_MAX);
    const aspect = pxW / Math.max(1, pxH);
    const boost = 1 + pulse * 0.15; // beats add at most 15% extra swirl
    updateAndFill(tg, va, t, dtSim, aspect, boost);

    const ps = passes;
    const simTx = 1 / tg.simW;
    const simTy = 1 / tg.simH;
    const dyeTx = 1 / tg.dyeW;
    const dyeTy = 1 / tg.dyeH;

    // Offscreen sim passes write raw field values: no blending.
    gl.disable(gl.BLEND);

    // 1. Advect velocity (semi-Lagrangian back-trace).
    gl.useProgram(ps.advect.prog);
    ps.advect.uni.i1('uVelocity', 0);
    ps.advect.uni.i1('uSource', 1);
    ps.advect.uni.f2('uTexelSize', simTx, simTy);
    ps.advect.uni.f2('uSrcTexelSize', simTx, simTy);
    ps.advect.uni.f1('uDt', dtSim);
    ps.advect.uni.f1('uDissipation', VELOCITY_DISSIPATION);
    bindTex(gl, 0, tg.velocity.read.tex);
    bindTex(gl, 1, tg.velocity.read.tex);
    blit(gl, tg.velocity.write);
    tg.velocity.swap();

    // 2. Curl of the velocity field.
    gl.useProgram(ps.curl.prog);
    ps.curl.uni.i1('uVelocity', 0);
    ps.curl.uni.f2('uTexelSize', simTx, simTy);
    bindTex(gl, 0, tg.velocity.read.tex);
    blit(gl, tg.curl);

    // 3. Vorticity confinement (curl-driven swirl reinforcement).
    gl.useProgram(ps.vorticity.prog);
    ps.vorticity.uni.i1('uVelocity', 0);
    ps.vorticity.uni.i1('uCurl', 1);
    ps.vorticity.uni.f2('uTexelSize', simTx, simTy);
    ps.vorticity.uni.f1('uStrength', (12 + va.wobble * 18) * boost);
    ps.vorticity.uni.f1('uDt', dtSim);
    bindTex(gl, 0, tg.velocity.read.tex);
    bindTex(gl, 1, tg.curl.tex);
    blit(gl, tg.velocity.write);
    tg.velocity.swap();

    // 4. Divergence.
    gl.useProgram(ps.divergence.prog);
    ps.divergence.uni.i1('uVelocity', 0);
    ps.divergence.uni.f2('uTexelSize', simTx, simTy);
    bindTex(gl, 0, tg.velocity.read.tex);
    blit(gl, tg.divergence);

    // 5. Pressure: damp last frame's solution as a warm start…
    gl.useProgram(ps.clear.prog);
    ps.clear.uni.i1('uTexture', 0);
    ps.clear.uni.f1('uValue', PRESSURE_DAMPING);
    bindTex(gl, 0, tg.pressure.read.tex);
    blit(gl, tg.pressure.write);
    tg.pressure.swap();

    // …then Jacobi-relax.
    gl.useProgram(ps.pressure.prog);
    ps.pressure.uni.i1('uPressure', 0);
    ps.pressure.uni.i1('uDivergence', 1);
    ps.pressure.uni.f2('uTexelSize', simTx, simTy);
    bindTex(gl, 1, tg.divergence.tex);
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      bindTex(gl, 0, tg.pressure.read.tex);
      blit(gl, tg.pressure.write);
      tg.pressure.swap();
    }

    // 6. Subtract the pressure gradient → divergence-free velocity.
    gl.useProgram(ps.gradient.prog);
    ps.gradient.uni.i1('uPressure', 0);
    ps.gradient.uni.i1('uVelocity', 1);
    ps.gradient.uni.f2('uTexelSize', simTx, simTy);
    bindTex(gl, 0, tg.pressure.read.tex);
    bindTex(gl, 1, tg.velocity.read.tex);
    blit(gl, tg.velocity.write);
    tg.velocity.swap();

    // 7. Splat stirrer forces into velocity (single pass, uniform array).
    gl.useProgram(ps.splat.prog);
    ps.splat.uni.i1('uTarget', 0);
    ps.splat.uni.f1('uAspect', aspect);
    ps.splat.uni.i1('uCount', fCount);
    ps.splat.uni.v4array('uPosRad', forcePosRad);
    ps.splat.uni.v4array('uVal', forceVal);
    bindTex(gl, 0, tg.velocity.read.tex);
    blit(gl, tg.velocity.write);
    tg.velocity.swap();

    // 8. Splat dye (same program, dye-res target).
    ps.splat.uni.i1('uCount', dCount);
    ps.splat.uni.v4array('uPosRad', dyePosRad);
    ps.splat.uni.v4array('uVal', dyeVal);
    bindTex(gl, 0, tg.dye.read.tex);
    blit(gl, tg.dye.write);
    tg.dye.swap();

    // 9. Advect dye through the velocity field.
    gl.useProgram(ps.advect.prog);
    ps.advect.uni.i1('uVelocity', 0);
    ps.advect.uni.i1('uSource', 1);
    ps.advect.uni.f2('uTexelSize', simTx, simTy);
    ps.advect.uni.f2('uSrcTexelSize', dyeTx, dyeTy);
    ps.advect.uni.f1('uDt', dtSim);
    ps.advect.uni.f1('uDissipation', DYE_DISSIPATION);
    bindTex(gl, 0, tg.velocity.read.tex);
    bindTex(gl, 1, tg.dye.read.tex);
    blit(gl, tg.dye.write);
    tg.dye.swap();

    // 10. Display: premultiplied-alpha composite to the screen, restoring the
    // blend state the renderer expects.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, pxW, pxH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(ps.display.prog);
    ps.display.uni.i1('uDye', 0);
    ps.display.uni.f2('uTexelSize', dyeTx, dyeTy);
    bindTex(gl, 0, tg.dye.read.tex);
    drawFullscreen(gl, vao);
    gl.activeTexture(gl.TEXTURE0);
  },

  resize(gl: WebGL2RenderingContext, pxW: number, pxH: number) {
    if (!supported) return;
    ensureTargets(gl, pxW, pxH);
  },

  dispose(gl: WebGL2RenderingContext) {
    const ps = passes;
    if (ps) {
      gl.deleteProgram(ps.advect.prog);
      gl.deleteProgram(ps.curl.prog);
      gl.deleteProgram(ps.vorticity.prog);
      gl.deleteProgram(ps.divergence.prog);
      gl.deleteProgram(ps.pressure.prog);
      gl.deleteProgram(ps.gradient.prog);
      gl.deleteProgram(ps.splat.prog);
      gl.deleteProgram(ps.clear.prog);
      gl.deleteProgram(ps.display.prog);
      passes = null;
    }
    if (fallback) {
      gl.deleteProgram(fallback.prog);
      fallback = null;
    }
    if (vao) {
      gl.deleteVertexArray(vao);
      vao = null;
    }
    disposeTargets(gl);
  },
};
