import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Chladni plate (クラドニ図形) — nodal lines of a vibrating square plate.
 *
 * The plate's standing wave is F = sin(nπx)sin(mπy) - sin(mπx)sin(nπy); the sand
 * collects where F = 0, so the density is a thin bright line around the zero
 * set (distance estimated in pixels with fwidth, so the line width is the same
 * everywhere and anti-aliased). The mode pair (n, m) is picked per step from the
 * seeded RNG, and the field *crossfades* between consecutive mode pairs
 * (F_k → F_{k+1}) so the nodal pattern flows from one figure to the next and
 * never pops. The morph clock is uTime (alive with silence); uBeat only adds a
 * small, smooth nudge to it.
 *
 * Optional overlay: a faint golden-angle (Vogel) dot spiral — phyllotaxis — found
 * with a Fibonacci-lattice inverse (3x3 candidates, verified against brute force), not a loop over all dots.
 */
export const chladniDef: GeneratorDefinition = {
  id: 'chladni',
  version: 1,
  category: 'source',
  costClass: 'light',
  impl: 'inline',
  output: 'field',
  tags: {
    motion: ['wave', 'ripple'],
    affect: ['technical', 'calm'],
    material: ['geometric', 'salt-crust'],
  },
  parameters: [
    {
      id: 'modes',
      label: 'Max mode',
      kind: 'int',
      min: 4,
      max: 12,
      default: 10,
      modulatable: true,
    },
    {
      id: 'morph',
      label: 'Morph rate',
      kind: 'number',
      min: 0.02,
      max: 0.6,
      default: 0.1,
      modulatable: true,
    },
    {
      id: 'thickness',
      label: 'Line width',
      kind: 'number',
      min: 0.5,
      max: 6,
      default: 2.2,
      modulatable: true,
    },
    {
      id: 'phyllotaxis',
      label: 'Phyllotaxis dots',
      kind: 'number',
      min: 0,
      max: 1,
      default: 0,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 0.3, stateful: false },
};

export const chladniGenerator: InlineGenerator = {
  def: chladniDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uModes = uniform('modes');
    const uMorph = uniform('morph');
    const uThickness = uniform('thickness');
    const uPhyllo = uniform('phyllotaxis');
    const plate = `${fnName}_plate`;
    const mode = `${fnName}_mode`;
    const phyl = `${fnName}_phyl`;
    return /* glsl */ `
// chladni source: crossfaded standing-wave modes, nodal lines in pixel-distance AA
float ${plate}(vec2 x, vec3 nms) {
  vec2 a = 3.14159265359 * nms.x * x;
  vec2 b = 3.14159265359 * nms.y * x;
  return sin(a.x) * sin(b.y) + nms.z * sin(b.x) * sin(a.y);
}
// mode pair k: n in [3, M-1], m in [n+1, min(n+3, M)] so the two terms never cancel exactly.
// z = sign of the second term: antisymmetric (diagonal node) or symmetric figure.
vec3 ${mode}(int k, float M) {
  uint h = uint(max(k, 0));
  float rn = synthRand(${seedUniform}, ${nsUniform}, h * 3u);
  float rm = synthRand(${seedUniform}, ${nsUniform}, h * 3u + 1u);
  float rs = synthRand(${seedUniform}, ${nsUniform}, h * 3u + 2u);
  float n = 3.0 + floor(rn * (M - 3.0));
  float m = n + 1.0 + floor(rm * min(3.0, M - n));
  return vec3(n, min(m, M), rs < 0.5 ? -1.0 : 1.0);
}
// Vogel spiral (golden angle) dots; nearest dot via the Fibonacci lattice inverse
float ${phyl}(vec2 q) {
  const float GA = 2.39996322973;
  const float TAU = 6.28318530718;
  const float PHI = 1.61803398875;
  float c = 0.034;
  float r = length(q);
  if (r < 1e-4) return 0.0;
  float kt = (r / c) * (r / c);
  float th = atan(q.y, q.x);
  float lvl = clamp(floor(log(2.37 * 2.2360679 * sqrt(max(kt, 1.0))) / log(PHI) + 0.5), 3.0, 12.0);
  float fj = floor(pow(PHI, lvl) / 2.2360679 + 0.5);
  float fj1 = floor(pow(PHI, lvl + 1.0) / 2.2360679 + 0.5);
  float dj = fj * GA;
  dj -= TAU * floor(dj / TAU + 0.5);
  float dj1 = fj1 * GA;
  dj1 -= TAU * floor(dj1 / TAU + 0.5);
  float det = fj * dj1 - fj1 * dj;
  if (abs(det) < 1e-3) return 0.0;
  float a = (kt * dj1 - fj1 * th) / det;
  float b = (fj * th - dj * kt) / det;
  float best = 1e9;
  for (int u = -1; u <= 1; u++) {
    for (int v = -1; v <= 1; v++) {
      float i = (floor(a) + float(u)) * fj + (floor(b) + float(v)) * fj1;
      if (i < 0.0) continue;
      float rr = c * sqrt(i);
      float aa = i * GA;
      best = min(best, length(q - rr * vec2(cos(aa), sin(aa))));
    }
  }
  float rad = c * 0.28;
  float px = max(fwidth(best), 1e-5);
  float w = max(rad, px * 0.75);
  return 1.0 - smoothstep(w - px, w + px, best);
}
float ${fnName}(vec2 p) {
  float M = float(clamp(${uModes}, 4, 12));
  float rate = clamp(${uMorph}, 0.02, 0.6);
  float thk = clamp(${uThickness}, 0.5, 6.0);
  float phy = clamp(${uPhyllo}, 0.0, 1.0);
  // morph clock: time-driven, beat adds a small smooth nudge (never a step)
  float T = uTime * rate + 0.12 * clamp(uBeat, 0.0, 1.0);
  float k = floor(T);
  float s = T - k;
  // hold each figure for a while, then flow into the next one
  s = smoothstep(0.45, 1.0, s);
  // plate coordinates: a square plate slightly wider than the screen, so its (always
  // nodal) free edges stay off-screen and only interior figures are visible
  float aspect = clamp(uRes.x / max(uRes.y, 1.0), 0.5, 4.0);
  vec2 x = p / (max(aspect, 1.0) * 1.06) + 0.5;
  float f0 = ${plate}(x, ${mode}(int(k), M));
  float f1 = ${plate}(x, ${mode}(int(k) + 1, M));
  float F = mix(f0, f1, s);
  // distance to the nodal set in pixels (first-order), so width is uniform on screen
  float gpx = max(fwidth(F), 1e-4);
  float dpx = abs(F) / gpx;
  float resScale = clamp(uRes.y / 720.0, 0.5, 4.0);
  float tpx = 0.5 * thk * resScale;
  float line = 1.0 - smoothstep(tpx - 0.75, tpx + 0.75, dpx);
  // faint sand halo around the line gives the density some falloff
  float halo = 0.3 * exp(-dpx / (3.0 * tpx + 2.0));
  float v = max(line, halo);
  if (phy > 0.01) {
    float ca = cos(uTime * 0.04);
    float sa = sin(uTime * 0.04);
    vec2 q = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y);
    v = max(v, phy * 0.7 * ${phyl}(q));
  }
  return clamp(v, 0.0, 1.0);
}
`.trim();
  },
};
