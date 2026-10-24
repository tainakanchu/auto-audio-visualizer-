import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Fractal paper-cut — a Julia set whose smooth escape time is quantised into
 * 4–8 stacked "paper layers". The parameter c drifts slowly around a closed
 * loop hugging the Mandelbrot main-cardioid boundary (so the loop is seamless
 * and the set keeps breathing between connected and dusty). Each band edge
 * casts a small offset drop shadow onto the layer below (analytic, from the
 * screen-space gradient of the escape time — a single Julia evaluation, ≤ 48
 * iterations with early exit) and the upper layer's lit rim gets a faint
 * highlight. Density is graded: deeper layers are denser, with gentle
 * gradation inside every layer.
 */
export const fractalPaperDef: GeneratorDefinition = {
  id: 'fractalPaper',
  version: 1,
  category: 'source',
  costClass: 'medium',
  impl: 'inline',
  output: 'field',
  tags: {
    material: ['paper', 'fractal'],
    motion: ['drift', 'breathe'],
    affect: ['intricate', 'hypnotic'],
  },
  parameters: [
    {
      id: 'layers',
      label: 'Layers',
      kind: 'int',
      min: 4,
      max: 8,
      default: 6,
      modulatable: true,
    },
    {
      id: 'zoom',
      label: 'Zoom',
      kind: 'number',
      min: 0.4,
      max: 2.2,
      default: 1,
      modulatable: true,
    },
    {
      id: 'breath',
      label: 'Breath',
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.5,
      modulatable: true,
    },
    {
      id: 'shadow',
      label: 'Shadow',
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.6,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 0.85, stateful: false },
};

export const fractalPaperGenerator: InlineGenerator = {
  def: fractalPaperDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uLayers = uniform('layers');
    const uZoom = uniform('zoom');
    const uBreath = uniform('breath');
    const uShadow = uniform('shadow');
    return /* glsl */ `
// fractalPaper source: Julia escape time → stepped paper layers with analytic drop shadow
float ${fnName}(vec2 p) {
  float nLayers = float(clamp(${uLayers}, 4, 8));
  float zoom = clamp(${uZoom}, 0.4, 2.2);
  float breath = clamp(${uBreath}, 0.0, 1.0);
  float shadowAmt = clamp(${uShadow}, 0.0, 1.0);

  // c loops along the main cardioid boundary (fixed ~50 s lap), nudged across it by
  // breath * sin(3θ) — 3 is an integer, so the loop is seamless
  float seedPhase = synthRand(${seedUniform}, ${nsUniform}, 5u) * 6.28318530718;
  float th = seedPhase + uTime * 0.125;
  vec2 e1 = vec2(cos(th), sin(th));
  vec2 e2 = vec2(cos(2.0 * th), sin(2.0 * th));
  vec2 c = (e1 * 0.5 - e2 * 0.25) * (1.0 + 0.06 * breath * sin(3.0 * th + 0.7));

  // view: fixed 3.4-unit tall window at zoom 1; clamp keeps absurd params finite
  vec2 z = clamp(p * (3.4 / zoom), vec2(-1.0e3), vec2(1.0e3));

  // Douady-Hubbard distance estimate d = |z| ln|z| / (2 |z'|): layers are bands of d, so
  // every sheet keeps a visible width instead of halving towards the set boundary
  vec2 dz = vec2(1.0, 0.0);
  float trap = 4.0;
  float dist = 0.0;
  bool escaped = false;
  for (int i = 0; i < 48; i++) {
    dz = 2.0 * vec2(z.x * dz.x - z.y * dz.y, z.x * dz.y + z.y * dz.x);
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    float r2 = dot(z, z);
    trap = min(trap, r2);
    if (r2 > 256.0) {
      float rz = sqrt(r2);
      dist = 0.5 * rz * log(rz) / max(length(dz), 1e-30);
      escaped = true;
      break;
    }
  }

  // continuous layer coordinate g in [0, nLayers): far = bottom sheet, set interior = top sheet
  float topG = nLayers - 0.5;
  float tDist = clamp(dist / 0.7, 0.0, 1.0);
  float g = escaped ? topG * (1.0 - sqrt(tDist)) : topG;
  g = clamp(g, 0.0, nLayers - 0.001);

  // screen-space gradient of g (derivatives outside any divergent branch)
  vec2 gg = vec2(dFdx(g), dFdy(g));
  float gl = length(gg);
  float w = clamp(gl, 1e-3, 1.0);
  float fi = floor(g);
  float ff = g - fi;
  // anti-aliased staircase: level steps up as ff reaches 1
  float lvl = clamp(fi + smoothstep(1.0 - w, 1.0, ff), 0.0, nLayers - 1.0);

  float dMin = 0.02;
  float dMax = 0.95;
  // convex ramp: the outer sheets stay thin so the cut-out reads as a hero shape, not a wash
  float base = mix(dMin, dMax, pow(lvl / (nLayers - 1.0), 1.35));
  // gentle gradation inside each sheet
  float dens = base + 0.05 * ff;
  // set interior: shade the top sheet by how close the orbit came to the origin
  if (!escaped) dens = 0.78 + 0.2 * smoothstep(0.0, 0.8, sqrt(clamp(trap, 0.0, 1.0)));

  // ---- paper-cut edges: shadow on the lower sheet, lit rim on the upper ----
  vec2 n = gg / max(gl, 1e-4);
  vec2 shadowDir = normalize(vec2(0.7, -0.7));
  float shadowPx = (0.004 + 0.016 * shadowAmt) * uRes.y;
  // distance (px) to the next-higher sheet's edge ahead, and how far its shadow reaches down-right
  float dEdge = (1.0 - ff) / max(gl, 1e-4);
  float reach = shadowPx * max(dot(n, -shadowDir), 0.0);
  float inShadow = (1.0 - smoothstep(reach * 0.35, reach + 1e-3, dEdge)) * step(1e-3, reach);
  // the edge must really be a band edge (not the interior plateau)
  float notTop = 1.0 - step(topG - 1e-3, g);
  dens *= 1.0 - 0.55 * shadowAmt * inShadow * notTop;
  // rim light on the upper sheet's lit side (1.5px wide)
  float dBack = ff / max(gl, 1e-4);
  float rim = (1.0 - smoothstep(0.0, 1.5, dBack)) * max(dot(n, shadowDir), 0.0) * step(1.0, fi);
  dens += 0.12 * rim * (0.4 + 0.6 * shadowAmt);

  // dusty regions where g changes faster than a pixel: fall back to the smooth average
  float busy = smoothstep(0.35, 0.9, gl);
  float avg = mix(dMin, dMax, pow(g / nLayers, 1.35));
  dens = mix(dens, avg, busy);

  return clamp(dens, 0.0, 1.0);
}
`.trim();
  },
};
