import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Flame column (炎柱) — rising fire tongues from the bottom edge, overlay-friendly.
 *
 * A domain-warped value-noise field scrolls upward and is shaped by per-column envelopes:
 * dense and wide near the base, narrowing into licking tongues, then breaking into faint
 * wisps toward the tip. The result is a density gradation, not a mask. Noise budget is
 * 5 value-noise octaves in total (2 warp + 3 detail). Bass swells the height slightly;
 * silence still burns (all motion runs on uTime).
 */
export const flameColumnDef: GeneratorDefinition = {
  id: 'flameColumn',
  version: 1,
  category: 'source',
  costClass: 'medium',
  impl: 'inline',
  output: 'field',
  tags: {
    material: ['fire', 'emissive'],
    motion: ['turbulent', 'directional'],
    affect: ['dramatic', 'ominous'],
  },
  parameters: [
    {
      id: 'height',
      label: 'Height',
      kind: 'number',
      min: 0.2,
      max: 1.4,
      default: 0.95,
      modulatable: true,
    },
    {
      id: 'columns',
      label: 'Columns',
      kind: 'int',
      min: 1,
      max: 5,
      default: 3,
      modulatable: false,
    },
    {
      id: 'turbulence',
      label: 'Turbulence',
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.55,
      modulatable: true,
    },
    {
      id: 'rise',
      label: 'Rise',
      kind: 'number',
      min: 0.1,
      max: 3,
      default: 1,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 0.7, stateful: false },
};

export const flameColumnGenerator: InlineGenerator = {
  def: flameColumnDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uHeight = uniform('height');
    const uColumns = uniform('columns');
    const uTurb = uniform('turbulence');
    const uRise = uniform('rise');
    const vnoise = `${fnName}_vnoise`;
    return /* glsl */ `
// flameColumn helper: synthRand value noise, 0..1
float ${vnoise}(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  int ix = int(i.x);
  int iy = int(i.y);
  float a = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(uint(ix), uint(iy)));
  float b = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(uint(ix + 1), uint(iy)));
  float c = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(uint(ix), uint(iy + 1)));
  float d = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(uint(ix + 1), uint(iy + 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// flameColumn source: warped scrolling noise under rising column envelopes
float ${fnName}(vec2 p) {
  float height = clamp(${uHeight}, 0.2, 1.4) * (1.0 + 0.18 * clamp(uBass, 0.0, 1.0));
  int cols = clamp(${uColumns}, 1, 5);
  float turb = clamp(${uTurb}, 0.0, 1.0);
  float rise = clamp(${uRise}, 0.1, 3.0);
  float aspect = max(uRes.x / max(uRes.y, 1.0), 0.1);
  float t = uTime * rise;
  float span = aspect * 0.9;
  float hh = (p.y + 0.56) / height;
  float hc = clamp(hh, 0.0, 1.5);
  // domain warp (2 octaves): sways more toward the tip
  vec2 wq = vec2(p.x * 2.3, p.y * 1.7 - t * 0.5);
  vec2 wv = vec2(${vnoise}(wq), ${vnoise}(wq + vec2(31.7, 11.3))) - 0.5;
  vec2 pw = p + vec2(wv.x, wv.y * 0.5) * (0.1 + 0.3 * turb) * (0.25 + hc);
  // detail (3 octaves), scrolled upward faster than the warp
  vec2 dq = vec2(pw.x * 4.5, pw.y * 2.2 - t * 1.5);
  float n = 0.5 * ${vnoise}(dq) + 0.3 * ${vnoise}(dq * 2.1 + 7.7) + 0.2 * ${vnoise}(dq * 4.3 + 3.1);
  float nn = n - 0.5;
  float fcols = float(cols);
  float cw = span / fcols;
  float fx = (pw.x / span + 0.5) * fcols - 0.5;
  float k0 = floor(fx);
  float dens = 0.0;
  for (int j = 0; j < 2; j++) {
    float kf = k0 + float(j);
    if (kf < 0.0 || kf > fcols - 1.0) continue;
    uint ku = uint(kf);
    float rh = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(ku, 211u));
    float rj = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(ku, 212u));
    float cx = ((kf + 0.5) / fcols - 0.5) * span + (rj - 0.5) * 0.25 * cw;
    float hk = hh / (0.7 + 0.45 * rh);
    float hkc = clamp(hk, 0.0, 1.2);
    float hw = cw * (0.62 - 0.5 * pow(clamp(hk, 0.0, 1.0), 0.7)) + 0.015;
    float lat = 1.0 - smoothstep(0.15 * hw, hw, abs(pw.x - cx));
    // body: bright core fading with height, torn up by the noise (more so with turbulence)
    float body = lat * (1.18 - hkc * 1.1) + nn * (0.45 + 0.9 * turb) * (0.35 + hkc);
    float flame = smoothstep(0.04, 1.3, body) * (0.7 + 0.6 * n);
    // faint wisps beyond the tongues
    float wide = 1.0 - smoothstep(0.0, cw * 0.75, abs(pw.x - cx));
    float wisp = smoothstep(0.52, 0.85, n) * wide * smoothstep(0.1, 0.5, hk) * (1.0 - smoothstep(0.55, 1.15, hk)) * 0.4;
    dens = max(dens, max(flame, wisp));
  }
  return clamp(dens, 0.0, 1.0);
}
`.trim();
  },
};
