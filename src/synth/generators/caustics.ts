import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Caustics (水底の光網) — drifting network of underwater light filaments.
 *
 * Classic iterated-sine water caustic: a few rounds of domain warping with
 * time-shifted sin/cos, accumulating an inverse-distance term whose bright
 * ridges form the filament web. The result is raised to a power so the field
 * is mostly dark between filaments (overlay friendly — see
 * knowledge/3d-generator-design-principles.md). A seeded offset gives each
 * seed its own web; motion is uTime-only so it keeps flowing in silence.
 */
export const causticsDef: GeneratorDefinition = {
  id: 'caustics',
  version: 1,
  category: 'source',
  costClass: 'medium',
  impl: 'inline',
  output: 'field',
  tags: {
    motion: ['drift', 'turbulent'],
    affect: ['calm', 'wet'],
    material: ['fluid'],
  },
  parameters: [
    {
      id: 'scale',
      label: 'Scale',
      kind: 'number',
      min: 0.8,
      max: 8,
      default: 4,
      modulatable: true,
    },
    {
      id: 'speed',
      label: 'Speed',
      kind: 'number',
      min: 0.05,
      max: 2,
      default: 0.5,
      modulatable: true,
    },
    {
      id: 'sharpness',
      label: 'Sharpness',
      kind: 'number',
      min: 2,
      max: 14,
      default: 4.5,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 0.55, stateful: false },
};

export const causticsGenerator: InlineGenerator = {
  def: causticsDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uScale = uniform('scale');
    const uSpeed = uniform('speed');
    const uSharp = uniform('sharpness');
    return /* glsl */ `
// caustics source: iterated-sine water caustic, high power => dark between filaments
float ${fnName}(vec2 p) {
  float sc = clamp(${uScale}, 0.8, 8.0);
  float spd = clamp(${uSpeed}, 0.05, 2.0);
  float sharp = clamp(${uSharp}, 2.0, 14.0);
  float ox = synthRand(${seedUniform}, ${nsUniform}, 0u) * 40.0;
  float oy = synthRand(${seedUniform}, ${nsUniform}, 1u) * 40.0;
  // the filament amplitude scales with |q|, so keep the domain far from the origin
  vec2 q = p * sc * 2.2 + vec2(ox, oy) - 250.0;
  float t = uTime * spd * 0.6 + 23.0;
  // the raw iteration tiles every 2*pi; a slow large-scale warp hides the repeat
  q += 1.1 * vec2(sin(p.y * 2.1 + t * 0.21 + ox), sin(p.x * 1.7 - t * 0.17 + oy));
  vec2 i = q;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 5; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = q + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    float sx = sin(i.x + tt);
    float cy = cos(i.y + tt);
    // guard the divisions: sx / cy can pass through zero (sign is irrelevant to length)
    vec2 e = vec2(q.x * inten / (abs(sx) + 1e-4), q.y * inten / (abs(cy) + 1e-4));
    c += 1.0 / max(length(e), 1e-4);
  }
  c /= 5.0;
  c = 1.17 - pow(max(c, 0.0), 1.4);
  float v = pow(clamp(abs(c), 0.0, 1.0), sharp);
  return clamp(v, 0.0, 1.0);
}
`.trim();
  },
};
