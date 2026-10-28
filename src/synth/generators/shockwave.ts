import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Shockwave (衝撃波) — one expanding radial shock ring per cycle. Coordinates
 * are pushed outward at the wavefront: a sharp compressed front, a wider
 * rarefied tail behind it carrying fbm turbulence. The ring origin is hashed
 * per cycle from the seed, and the amplitude fades to 0 at both ends of the
 * cycle so nothing pops when the next ring is born elsewhere. `uPunch` / `uBeat`
 * kick the strength. Unlike `ripple` (endless sine rings) this is a single
 * travelling event. Returns a displacement; the assembler multiplies by `amount`.
 */
export const shockwaveDef: GeneratorDefinition = {
  id: 'shockwave',
  version: 1,
  category: 'field',
  costClass: 'medium',
  impl: 'inline',
  output: 'vector',
  tags: {
    motion: ['radial', 'pulse'],
    material: ['fluid'],
    affect: ['physical', 'dense'],
  },
  parameters: [
    {
      id: 'period',
      label: 'Period',
      kind: 'number',
      min: 2,
      max: 12,
      default: 4,
      // uTime / period is the cycle clock: modulating it would jump the ring
      modulatable: false,
    },
    {
      id: 'width',
      label: 'Width',
      kind: 'number',
      min: 0.04,
      max: 0.4,
      default: 0.14,
      modulatable: true,
    },
    {
      id: 'turbulence',
      label: 'Turbulence',
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.4,
      modulatable: true,
    },
    {
      id: 'amount',
      label: 'Amount',
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.12,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 0.45, stateful: false },
};

export const shockwaveGenerator: InlineGenerator = {
  def: shockwaveDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uPeriod = uniform('period');
    const uWidth = uniform('width');
    const uTurb = uniform('turbulence');
    const vnoise = `${fnName}_vnoise`;
    const fbm = `${fnName}_fbm`;
    return /* glsl */ `
// shockwave field: one expanding shock ring per cycle (amount applied in main)
float ${vnoise}(vec2 q) {
  vec2 i = floor(q);
  vec2 f = fract(q);
  vec2 u = f * f * (3.0 - 2.0 * f);
  uint ix = uint(int(i.x));
  uint iy = uint(int(i.y));
  float a = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(ix, iy));
  float b = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(ix + 1u, iy));
  float c = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(ix, iy + 1u));
  float d = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(ix + 1u, iy + 1u));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float ${fbm}(vec2 q) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 2; i++) {
    sum += amp * ${vnoise}(q);
    q = q * 2.03 + vec2(5.2, 1.3);
    amp *= 0.5;
  }
  return sum;
}
vec2 ${fnName}(vec2 p) {
  float period = clamp(${uPeriod}, 2.0, 12.0);
  float width = clamp(${uWidth}, 0.04, 0.4);
  float turb = clamp(${uTurb}, 0.0, 1.0);

  // cycle clock: which ring, and how far it has travelled
  float cyc = floor(uTime / period);
  float ph = uTime / period - cyc;
  uint cid = uint(max(cyc, 0.0));
  float aspect = clamp(uRes.x / max(uRes.y, 1.0), 0.5, 4.0);
  vec2 origin = vec2(
    (synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(cid, 1u)) - 0.5) * 0.7 * aspect,
    (synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(cid, 2u)) - 0.5) * 0.7
  );

  // amplitude is exactly 0 at both ends of the cycle, so the origin change at the wrap is invisible
  float env = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.5, 0.95, ph));
  // beat / punch kick the strength; silence still travels at 1x
  float kick = 1.0 + 0.8 * clamp(uPunch, 0.0, 1.0) + 0.25 * clamp(uBeat, 0.0, 1.0);

  // ring radius: fast launch, easing out; the front widens as it spreads
  float ringR = 1.7 * (1.0 - pow(1.0 - ph, 1.5));
  float wFront = width * (0.9 + 0.5 * ph);
  float wTail = width * (1.2 + 0.9 * ph);

  vec2 d = p - origin;
  float r = length(d);
  // direction is undefined at the origin: ramp it in so the field stays continuous there
  vec2 dir = d / max(r, 1e-4) * smoothstep(0.0, 0.12, r);

  float x = r - ringR;
  // sharp gaussian ahead of the front, longer smooth tail behind it
  float ahead = exp(-(x * x) / (wFront * wFront));
  float behind = exp(-pow(max(-x, 0.0) / wTail, 1.5));
  float prof = x >= 0.0 ? ahead : behind;

  // content is pushed outward: sample from inside the ring
  vec2 disp = -dir * prof;

  // turbulence lives in the wake behind the front
  float wake = (x < 0.0 ? behind : 0.0) * smoothstep(0.0, 0.25 * wTail, max(-x, 0.0));
  if (turb > 0.0 && wake > 0.01) {
    vec2 q = (p - origin) * 2.2 + vec2(uTime * 0.35, -uTime * 0.27);
    vec2 tv = vec2(${fbm}(q), ${fbm}(q + vec2(17.3, 9.1))) - 0.375;
    disp += tv * (1.3 * wake * turb);
  }
  // a ring still smaller than the origin ramp would only invert the centre: keep it quiet until it opens
  return disp * env * kick * smoothstep(0.04, 0.22, ringR);
}
`.trim();
  },
};
