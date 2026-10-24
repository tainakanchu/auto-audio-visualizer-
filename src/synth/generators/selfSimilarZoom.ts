import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Self-similar zoom (自己相似ズーム) — nested n-gon rings + log-spiral spokes that
 * zoom in forever.
 *
 * Everything is drawn in log-radius coordinates: zooming by the scale factor is
 * a shift of exactly one period in `log r`, and the pattern is built to be
 * periodic in that coordinate (the spiral twist advances by exactly one polygon
 * sector per period, which the n-fold symmetry hides). The zoom phase is
 * `uTime * speed` in whole periods, so the loop is seamless by construction —
 * there is no fract()/reset of time to jump at. Motion is a pure function of
 * uTime (audio-independent).
 */
export const selfSimilarZoomDef: GeneratorDefinition = {
  id: 'selfSimilarZoom',
  version: 1,
  category: 'source',
  costClass: 'light',
  impl: 'inline',
  output: 'field',
  tags: {
    motion: ['radial', 'flythrough'],
    affect: ['hypnotic', 'symmetrical'],
    material: ['geometric'],
  },
  parameters: [
    {
      id: 'scale',
      label: 'Scale per loop',
      kind: 'number',
      min: 1.4,
      max: 6,
      default: 2.4,
      modulatable: true,
    },
    {
      id: 'sides',
      label: 'Sides',
      kind: 'int',
      min: 3,
      max: 8,
      default: 5,
      modulatable: true,
    },
    {
      id: 'speed',
      label: 'Zoom speed',
      kind: 'number',
      min: 0.02,
      max: 1,
      default: 0.14,
      modulatable: true,
    },
    {
      id: 'thickness',
      label: 'Thickness',
      kind: 'number',
      min: 0.01,
      max: 0.3,
      default: 0.04,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 0.35, stateful: false },
};

export const selfSimilarZoomGenerator: InlineGenerator = {
  def: selfSimilarZoomDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform } = ctx;
    const uScale = uniform('scale');
    const uSides = uniform('sides');
    const uSpeed = uniform('speed');
    const uThickness = uniform('thickness');
    return /* glsl */ `
// selfSimilarZoom source: log-radius periodic n-gon rings + log-spiral spokes.
// phase advances in whole loops (uTime * speed), the pattern repeats exactly every
// log(scale) in log r, so there is no reset jump anywhere.
float ${fnName}(vec2 p) {
  float sc = clamp(${uScale}, 1.4, 6.0);
  float n = float(clamp(${uSides}, 3, 8));
  float spd = clamp(${uSpeed}, 0.02, 1.0);
  float th = clamp(${uThickness}, 0.01, 0.3);
  float period = log(sc);
  float sector = 6.28318530718 / n;
  float r = length(p);
  // the origin is a singularity (log / atan undefined) — nothing to draw there
  if (r < 1e-4) return 0.0;
  float phase = uTime * spd;
  float logR = log(r);
  float u0 = logR / period - phase;
  // one polygon sector of twist per loop: invisible at the seam thanks to n-fold symmetry
  float ang = atan(p.y, p.x) + sector * u0;
  float m = mod(ang, sector) - 0.5 * sector;
  float cosTerm = max(cos(m), 0.2);
  // polygon distance in log space: rings are n-gons, not circles
  float u = (logR + log(cosTerm)) / period - phase;
  float fr = fract(u);
  float d = min(fr, 1.0 - fr);
  float px = clamp(fwidth(u), 1e-5, 1.0);
  float halfW = clamp(th * 0.5, 0.004, 0.45);
  float w = max(halfW, px * 0.75);
  float ring = 1.0 - smoothstep(w - px, w + px, d);
  // soft halo hugging each ring gives the line some body without a flat mask
  float halo = 0.3 * exp(-d / max(halfW * 3.0, px));
  // log-spiral spokes: constant angular width, so they scale with the zoom too.
  // atan() jumps by a whole number of sectors at its seam, so take the smaller of
  // two fwidth estimates (the second one is continuous across the seam).
  float gs = ang / sector;
  float fs = fract(gs);
  float ds = min(fs, 1.0 - fs);
  float pxs = clamp(min(fwidth(gs), fwidth(fract(gs + 0.5))), 1e-5, 1.0);
  float ws = max(0.035 + th * 0.12, pxs * 0.75);
  float spoke = 0.45 * (1.0 - smoothstep(ws - pxs, ws + pxs, ds));
  float v = max(max(ring, halo), spoke);
  // where the rings are denser than a pixel the line AA would mush to grey: fade out
  float fade = 1.0 - smoothstep(0.12, 0.35, px);
  return clamp(v * fade, 0.0, 1.0);
}
`.trim();
  },
};
