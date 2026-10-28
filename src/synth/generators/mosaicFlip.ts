import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Flip-card mosaic — square or hex tiles that periodically flip like 3D cards.
 * Each flip foreshortens the tile along a hashed axis (cos of the flip angle),
 * so the tile narrows to a sliver, opens the grout, then re-expands showing its
 * other face with a specular glint sweeping through at mid-flip. Flips travel as
 * a wave across the grid; `uBeat` nudges the flip phase so hits visibly twitch
 * the cards. Grout gaps are 0 density; tile interiors carry a lit gradient and a
 * bevel rim instead of a flat value. Unlike tiles / hexGrid / kumiko this moves.
 */
export const mosaicFlipDef: GeneratorDefinition = {
  id: 'mosaicFlip',
  version: 1,
  category: 'source',
  costClass: 'medium',
  impl: 'inline',
  output: 'field',
  tags: {
    material: ['mosaic', 'tile'],
    motion: ['wave', 'tumble'],
    affect: ['tactile', 'rhythmic'],
  },
  parameters: [
    {
      id: 'scale',
      label: 'Scale',
      kind: 'number',
      min: 3,
      max: 24,
      default: 9,
      modulatable: true,
    },
    {
      id: 'shape',
      label: 'Shape',
      kind: 'enum',
      options: ['square', 'hex'],
      default: 'square',
      modulatable: false,
    },
    {
      id: 'speed',
      label: 'Flip Rate',
      kind: 'number',
      min: 0.05,
      max: 1.5,
      default: 0.4,
      // uTime * rate is a phase: modulating it would re-phase every card at once
      modulatable: false,
    },
    {
      id: 'grout',
      label: 'Grout',
      kind: 'number',
      min: 0.02,
      max: 0.25,
      default: 0.08,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 0.6, stateful: false },
};

export const mosaicFlipGenerator: InlineGenerator = {
  def: mosaicFlipDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uScale = uniform('scale');
    const uShape = uniform('shape');
    const uSpeed = uniform('speed');
    const uGrout = uniform('grout');
    const shapeDist = `${fnName}_dist`;
    return /* glsl */ `
// mosaicFlip source: flip-card tiles (cosine foreshortening) with a travelling wave of flips
// tile border distance: 0.5 at the cell edge for both lattices (square: Chebyshev, hex: hexGrid metric)
float ${shapeDist}(vec2 q, bool hex) {
  vec2 a = abs(q);
  if (hex) return max(dot(a, vec2(0.5, 0.86602540378)), a.x);
  return max(a.x, a.y);
}
float ${fnName}(vec2 p) {
  float sc = clamp(${uScale}, 3.0, 24.0);
  float rate = clamp(${uSpeed}, 0.05, 1.5);
  float gap = clamp(${uGrout}, 0.02, 0.25);
  bool hex = ${uShape} == 1;

  // ---- lattice: cell id (for hashing), cell centre (for the wave), local coords ----
  vec2 gp = p * sc;
  vec2 q;
  vec2 cen;
  uint cid;
  if (hex) {
    vec2 r = vec2(1.0, 1.73205080757);
    vec2 cA = floor(gp / r);
    vec2 hA = gp - (cA + 0.5) * r;
    vec2 gB = gp - r * 0.5;
    vec2 cB = floor(gB / r);
    vec2 hB = gB - (cB + 0.5) * r;
    bool useA = dot(hA, hA) < dot(hB, hB);
    q = useA ? hA : hB;
    vec2 ci = useA ? cA : cB;
    cen = (useA ? (cA + 0.5) * r : (cB + 0.5) * r + r * 0.5);
    cid = synthHashCombine(synthHashCombine(uint(int(ci.x)), uint(int(ci.y))), useA ? 3u : 4u);
  } else {
    vec2 ci = floor(gp);
    q = gp - ci - 0.5;
    cen = ci + 0.5;
    cid = synthHashCombine(uint(int(ci.x)), uint(int(ci.y)));
  }

  // ---- flip clock: wave direction fixed by seed, cells lag along it ----
  float wa = synthRand(${seedUniform}, ${nsUniform}, 77u) * 6.28318530718;
  vec2 wdir = vec2(cos(wa), sin(wa));
  float h0 = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(cid, 1u));
  float h1 = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(cid, 2u));
  float h2 = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(cid, 3u));
  // a beat nudges every cell's phase forward a little (weighted per cell) so hits twitch the cards
  float kick = clamp(uBeat, 0.0, 1.0) * 0.16 * (0.4 + 0.6 * h0);
  float ph = uTime * rate + dot(cen, wdir) * 0.11 + h0 * 0.12 + kick;
  float kf = floor(ph);
  float u = ph - kf;
  int kInt = int(kf);

  // flip occupies the first part of each cycle, the card rests the remainder
  float flipDur = 0.34;
  float f = clamp(u / flipDur, 0.0, 1.0);
  float ease = f * f * (3.0 - 2.0 * f);
  float phi = 3.14159265359 * ease;
  float cphi = cos(phi);
  float sphi = sin(phi);
  float c = max(abs(cphi), 0.025);

  // hashed flip axis per (cell, flip index)
  uint fid = synthHashCombine(cid, uint(kInt) + 1000u);
  float axisA = synthRand(${seedUniform}, ${nsUniform}, fid) * 3.14159265359;
  vec2 axisDir = vec2(cos(axisA), sin(axisA));
  vec2 nrm = vec2(-axisDir.y, axisDir.x);

  // foreshorten the card across the axis: sample the card face at q' = q + n * (q.n) * (1/c - 1)
  float qn = dot(q, nrm);
  vec2 qc = q + nrm * (qn * (1.0 / c - 1.0));

  // ---- tile footprint (grout = 0 density) ----
  float limit = 0.5 - gap * 0.5;
  float dc = ${shapeDist}(qc, hex);
  float edge = limit - dc;
  float px = clamp(fwidth(dc) * 0.9, 1e-3, 0.5);
  float inside = smoothstep(-px, px, edge);

  // ---- face shading: two hashed face tones, alternating each flip ----
  bool frontShown = cphi >= 0.0;
  int parity = (kInt & 1);
  int shownFace = frontShown ? parity : 1 - parity;
  float tone = shownFace == 0 ? 0.5 + 0.38 * h1 : 0.42 + 0.4 * h2;
  // lit gradient across the card, rotates with the card's axis
  vec2 lightDir = normalize(vec2(-0.6, 0.8));
  float lit = dot(qc, lightDir);
  float shade = tone * (0.82 + 0.5 * lit);
  // bevel: lighter rim just inside the grout, falling away into the face
  float bevel = (1.0 - smoothstep(0.0, 0.14, edge)) * 0.26;
  // card curvature darkens as it turns away from the viewer
  float turned = 1.0 - 0.45 * (1.0 - c);
  // specular glint sweeping across the card mid-flip
  float sweep = 0.5 + 0.5 * sin(dot(qc, nrm) * 5.0 + dot(qc, axisDir) * 2.0 + 3.0 * phi);
  float glint = pow(sphi, 3.0) * (0.35 + 0.65 * pow(sweep, 3.0)) * 0.7;
  float dens = (shade + bevel) * turned + glint;
  return clamp(dens * inside, 0.0, 1.0);
}
`.trim();
  },
};
