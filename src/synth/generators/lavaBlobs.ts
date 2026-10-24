import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Lava blobs (ラバランプ) — flat 2D lava-lamp metaballs.
 *
 * 4..7 blobs drift up and down their own lane with a buoyancy-skewed motion
 * (heated blobs rise slowly, then sink faster), stretching along their travel
 * direction. The blobs are merged with a polynomial smooth-min of their
 * ellipse distances, so two blobs that meet stretch a neck between them before
 * they pinch apart. The density is NOT a flat 0/1 mask: it has a bright thin
 * rim, a soft inner gradient from the rim toward a dimmer core, and a faint
 * outer glow. Different from `sdfBlob` (3D raymarched mercury): this is purely
 * 2D. Lane / size / phase come from the seeded RNG; motion is uTime-only.
 */
export const lavaBlobsDef: GeneratorDefinition = {
  id: 'lavaBlobs',
  version: 1,
  category: 'source',
  costClass: 'light',
  impl: 'inline',
  output: 'field',
  tags: {
    motion: ['drift', 'sway'],
    affect: ['retro', 'humid', 'hypnotic'],
    material: ['fluid'],
  },
  parameters: [
    {
      id: 'count',
      label: 'Blobs',
      kind: 'int',
      min: 4,
      max: 7,
      default: 6,
      modulatable: true,
    },
    {
      id: 'size',
      label: 'Size',
      kind: 'number',
      min: 0.07,
      max: 0.25,
      default: 0.11,
      modulatable: true,
    },
    {
      id: 'speed',
      label: 'Drift speed',
      kind: 'number',
      min: 0.1,
      max: 2,
      default: 0.6,
      modulatable: true,
    },
    {
      id: 'goo',
      label: 'Gooeyness',
      kind: 'number',
      min: 0.03,
      max: 0.3,
      default: 0.08,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 0.4, stateful: false },
};

export const lavaBlobsGenerator: InlineGenerator = {
  def: lavaBlobsDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uCount = uniform('count');
    const uSize = uniform('size');
    const uSpeed = uniform('speed');
    const uGoo = uniform('goo');
    return /* glsl */ `
// lavaBlobs source: smooth-min of stretched ellipses, rim + inner gradient + glow
float ${fnName}(vec2 p) {
  int cnt = clamp(${uCount}, 4, 7);
  float sz = clamp(${uSize}, 0.07, 0.25);
  float spd = clamp(${uSpeed}, 0.1, 2.0);
  float k = clamp(${uGoo}, 0.03, 0.3);
  float aspect = clamp(uRes.x / max(uRes.y, 1.0), 0.5, 4.0);
  float halfW = 0.5 * aspect;
  float d = 1e3;
  for (int i = 0; i < 7; i++) {
    if (i >= cnt) break;
    uint id = uint(i) * 4u;
    float r0 = synthRand(${seedUniform}, ${nsUniform}, id);
    float r1 = synthRand(${seedUniform}, ${nsUniform}, id + 1u);
    float r2 = synthRand(${seedUniform}, ${nsUniform}, id + 2u);
    float r3 = synthRand(${seedUniform}, ${nsUniform}, id + 3u);
    // lane: evenly spread over the width with a jitter so blobs overlap their neighbours
    float lane = (float(i) + 0.5) / float(cnt);
    float cx = (lane - 0.5) * 2.0 * (halfW - sz * 0.6) + (r0 - 0.5) * sz * 1.2;
    // buoyancy: rise slowly, sink faster (skewed wave); each blob has its own period
    float w = spd * (0.18 + 0.16 * r1);
    float ph = 6.28318530718 * r2 + uTime * w;
    float wave = sin(ph) + 0.28 * sin(2.0 * ph + 1.3);
    float vel = cos(ph) + 0.56 * cos(2.0 * ph + 1.3);
    float travel = 0.5 - sz * 0.9;
    float cy = travel * wave * 0.78;
    // lateral wobble, slow and independent of the vertical phase
    cx += sz * 0.35 * sin(uTime * spd * 0.11 + 6.28318530718 * r3);
    // stretch along the direction of travel; a stationary (turning) blob is rounder
    float st = 1.0 + 0.45 * clamp(abs(vel) * 0.6, 0.0, 1.0);
    float rad = sz * (0.7 + 0.6 * r3);
    vec2 q = (p - vec2(cx, cy)) / vec2(1.0 / sqrt(st), st);
    float di = length(q) - rad;
    // polynomial smooth-min: necks form between blobs as they meet
    float h = clamp(0.5 + 0.5 * (d - di) / k, 0.0, 1.0);
    d = mix(d, di, h) - k * h * (1.0 - h);
  }
  float px = max(fwidth(d), 1e-5);
  float cover = 1.0 - smoothstep(-px, px, d);
  // inside: bright rim fading to a dimmer core (depth is in p units)
  float depth = clamp(-d / (sz * 1.2), 0.0, 1.0);
  float core = 0.22 + 0.4 * (1.0 - depth) * (1.0 - depth);
  float rim = 0.38 * exp(-pow(max(-d, 0.0) / (sz * 0.12 + px), 2.0));
  float body = cover * (core + rim);
  float glow = 0.18 * exp(-max(d, 0.0) / (sz * 0.35)) * (1.0 - cover);
  return clamp(body + glow, 0.0, 1.0);
}
`.trim();
  },
};
