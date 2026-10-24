import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Fireworks (花火) — stateless analytic bursts, overlay-friendly (background density 0).
 *
 * Each layer repeats a burst cycle. The burst centre, radius and spark rotation are hashed
 * per (layer, cycle index) from the Patch seed (same per-cell hash trick as `points`), so
 * the show is deterministic and needs no state. Inside a cycle the sparks fly out along
 * hashed directions with ease-out speed, droop under gravity, and drag a streak back toward
 * the burst; brightness decays to 0 before the cycle ends so the wrap is invisible.
 *
 * Per pixel only the 3 sparks nearest in angle are evaluated per layer (angular sector
 * lookup), so the cost is bounded by 3 layers x 3 sparks regardless of the spark count.
 * uBeat only brightens / lengthens trails, so a silent room still fires.
 */
export const fireworksDef: GeneratorDefinition = {
  id: 'fireworks',
  version: 1,
  category: 'source',
  costClass: 'medium',
  impl: 'inline',
  output: 'field',
  tags: {
    material: ['emissive', 'spark'],
    motion: ['radial', 'burst'],
    affect: ['festive', 'dramatic'],
  },
  parameters: [
    {
      id: 'radius',
      label: 'Radius',
      kind: 'number',
      min: 0.1,
      max: 0.7,
      default: 0.34,
      modulatable: true,
    },
    {
      id: 'count',
      label: 'Sparks',
      kind: 'int',
      min: 6,
      max: 16,
      default: 12,
      modulatable: true,
    },
    {
      id: 'layers',
      label: 'Layers',
      kind: 'int',
      min: 1,
      max: 3,
      default: 3,
      modulatable: false,
    },
    {
      id: 'period',
      label: 'Period',
      kind: 'number',
      min: 1,
      max: 8,
      default: 3.4,
      modulatable: false,
    },
  ],
  cost: { passes: 0, relativeFill: 0.6, stateful: false },
};

export const fireworksGenerator: InlineGenerator = {
  def: fireworksDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uRadius = uniform('radius');
    const uCount = uniform('count');
    const uLayers = uniform('layers');
    const uPeriod = uniform('period');
    const seg = `${fnName}_seg`;
    const ease = `${fnName}_ease`;
    return /* glsl */ `
// fireworks helpers
// distance from p to the segment a-b; t = 0 at a (spark head), 1 at b (trail tail)
float ${seg}(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * t);
}
// radial travel 0..1 over a cycle phase: fast out of the shell, then coasting
float ${ease}(float s) {
  float u = clamp(s / 0.8, 0.0, 1.0);
  float v = 1.0 - u;
  return 1.0 - v * v * v;
}
// fireworks source: stateless layered bursts, nearest-sector spark lookup
float ${fnName}(vec2 p) {
  float radius0 = clamp(${uRadius}, 0.1, 0.7);
  int nSp = clamp(${uCount}, 6, 16);
  int nLay = clamp(${uLayers}, 1, 3);
  float period = clamp(${uPeriod}, 1.0, 8.0);
  float beat = clamp(uBeat, 0.0, 1.0);
  float aspect = max(uRes.x / max(uRes.y, 1.0), 0.1);
  // derivatives must be taken in uniform control flow, i.e. before the loops
  float px = clamp(max(fwidth(p.x), fwidth(p.y)), 1e-4, 0.05);
  float gain = 0.85 + 0.35 * beat;
  float trailLen = 0.22 * (1.0 + 0.3 * beat);
  float nF = float(nSp);
  float sector = 6.28318530718 / nF;
  float dens = 0.0;
  for (int l = 0; l < 3; l++) {
    if (l >= nLay) break;
    uint lu = uint(l);
    float tt = uTime / (period * (0.8 + 0.23 * float(l))) + float(l) * 0.37;
    float cyc = floor(tt);
    float s = tt - cyc;
    uint key = synthHashCombine(synthHashCombine(uint(max(cyc, 0.0)), lu + 101u), 0x51u);
    float rx = synthRand(${seedUniform}, ${nsUniform}, key);
    float ry = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(key, 1u));
    float rr = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(key, 2u));
    float rot = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(key, 3u)) * 6.28318530718;
    vec2 center = vec2((rx - 0.5) * aspect * 0.8, -0.02 + ry * 0.36);
    float rad = radius0 * (0.75 + 0.5 * rr);
    // brightness: soft attack, slow-then-steep decay, exactly 0 at the cycle end
    float fade = pow(max(1.0 - s * s, 0.0), 1.3) * smoothstep(0.0, 0.04, s);
    // gravity droop of the whole shell (quadratic in time)
    float grav = 0.35 * rad;
    vec2 g0 = vec2(0.0, -grav * s * s);
    float s2 = max(s - trailLen, 0.0);
    vec2 g1 = vec2(0.0, -grav * s2 * s2);
    float ex0 = ${ease}(s);
    float ex1 = ${ease}(s2);
    float layerV = 0.0;
    vec2 q = p - (center + g0);
    // cull pixels that cannot be touched by this burst
    if (dot(q, q) < rad * rad * 1.5 + 0.01 && fade > 0.0) {
      float ang = atan(q.y, q.x) - rot;
      ang = ang - 6.28318530718 * floor(ang / 6.28318530718);
      int k = clamp(int(floor(ang / sector)), 0, nSp - 1);
      for (int j = -1; j <= 1; j++) {
        int i = (k + j + nSp) % nSp;
        uint sk = synthHashCombine(key, 16u + uint(i));
        float ja = synthRand(${seedUniform}, ${nsUniform}, sk);
        float jm = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(sk, 1u));
        float a = rot + (float(i) + 0.5 + (ja - 0.5) * 0.6) * sector;
        vec2 dir = vec2(cos(a), sin(a));
        float reach = rad * (0.8 + 0.2 * jm);
        vec2 head = center + dir * (reach * ex0) + g0;
        vec2 tail = center + dir * (reach * ex1) + g1;
        float t;
        float d = ${seg}(p, head, tail, t);
        float wd = max(mix(0.009, 0.0028, t) * (0.55 + 0.45 * fade), px * 0.9);
        float line = 1.0 - smoothstep(wd * 0.3, wd * 1.5, d);
        float glow = exp(-d * d / (wd * wd * 16.0)) * 0.5;
        float along = pow(1.0 - t, 1.5);
        float tw = 0.85 + 0.15 * sin(uTime * 23.0 + float(i) * 5.1 + ja * 6.28);
        layerV = max(layerV, (line * 0.85 + glow) * along * tw);
      }
    }
    // opening flash at the burst centre
    vec2 qc = p - center;
    float flash = (1.0 - smoothstep(0.0, 0.14, s)) * exp(-dot(qc, qc) / (0.02 * rad * rad + 1e-4));
    float v = clamp(layerV * fade * gain + flash, 0.0, 1.0);
    dens = 1.0 - (1.0 - dens) * (1.0 - v);
  }
  return clamp(dens, 0.0, 1.0);
}
`.trim();
  },
};
