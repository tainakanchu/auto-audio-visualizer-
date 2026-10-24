import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Pencil cross-hatching (鉛筆の線影) — density becomes graphite hatch strokes.
 * Low density gets a single diagonal layer; each extra layer (cross direction,
 * then a near-horizontal one, then a steep one) fades in as density climbs, so
 * dark areas read as 2–4 crossing directions. Strokes are broken by pencil
 * pressure and a paper tooth, and every line wobbles slowly in time like a
 * hand-drawn boil. Directional lines on a faint cream paper wash — not dots or
 * grain like halftone / riso / xerox. Zero density stays fully transparent.
 * Returns premultiplied alpha.
 */
export const hatchingDef: GeneratorDefinition = {
  id: 'hatching',
  version: 1,
  category: 'material',
  costClass: 'medium',
  impl: 'inline',
  output: 'color',
  tags: {
    material: ['pencil', 'graphite', 'line'],
    motion: ['breathe'],
    affect: ['tactile', 'handmade'],
  },
  parameters: [
    {
      id: 'scale',
      label: 'Line Density',
      kind: 'number',
      min: 15,
      max: 120,
      default: 48,
      modulatable: true,
    },
    {
      id: 'wobble',
      label: 'Wobble',
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.5,
      modulatable: true,
    },
    {
      id: 'paper',
      label: 'Paper',
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.5,
      modulatable: true,
    },
    {
      id: 'hue',
      label: 'Graphite Tint',
      kind: 'number',
      min: 0,
      max: 360,
      default: 225,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 0.6, stateful: false },
};

export const hatchingGenerator: InlineGenerator = {
  def: hatchingDef,
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uScale = uniform('scale');
    const uWobble = uniform('wobble');
    const uPaper = uniform('paper');
    const uHue = uniform('hue');
    const hsl2rgb = `${fnName}_hsl2rgb`;
    const vnoise = `${fnName}_vnoise`;
    return /* glsl */ `
// hatching material: density-driven graphite cross-hatch over a faint paper wash
vec3 ${hsl2rgb}(float h, float s, float l) {
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float hp = mod(h, 1.0) * 6.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb;
  if (hp < 1.0) rgb = vec3(c, x, 0.0);
  else if (hp < 2.0) rgb = vec3(x, c, 0.0);
  else if (hp < 3.0) rgb = vec3(0.0, c, x);
  else if (hp < 4.0) rgb = vec3(0.0, x, c);
  else if (hp < 5.0) rgb = vec3(x, 0.0, c);
  else rgb = vec3(c, 0.0, x);
  float m = l - 0.5 * c;
  return rgb + m;
}
// smooth value noise on the integer lattice (synthRand corners)
float ${vnoise}(vec2 q, uint salt) {
  vec2 i = floor(q);
  vec2 f = fract(q);
  vec2 u = f * f * (3.0 - 2.0 * f);
  uint ix = uint(int(i.x));
  uint iy = uint(int(i.y));
  float a = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(synthHashCombine(ix, iy), salt));
  float b = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(synthHashCombine(ix + 1u, iy), salt));
  float c = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(synthHashCombine(ix, iy + 1u), salt));
  float d = synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(synthHashCombine(ix + 1u, iy + 1u), salt));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec4 ${fnName}(float v, vec2 p) {
  float dens = clamp(v, 0.0, 1.0);
  float sc = clamp(${uScale}, 15.0, 120.0);
  float wob = clamp(${uWobble}, 0.0, 1.0);
  float paperAmt = clamp(${uPaper}, 0.0, 1.0);
  float hue = mod(${uHue}, 360.0) / 360.0;
  float t = uTime;

  // paper tooth: coarse fibre + fine pits, shared by the wash and the strokes
  float tooth = 0.6 * ${vnoise}(p * sc * 3.5, 90u) + 0.4 * ${vnoise}(p * sc * 11.0, 91u);

  // per-seed jitter so two patches do not hatch at identical angles
  float jit = (synthRand(${seedUniform}, ${nsUniform}, 7u) - 0.5) * 0.14;

  // 4 hatch layers: diagonal, cross diagonal, near-horizontal, steep
  float keep = 1.0;
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    float ang = 0.7853982;
    float thr = 0.06;
    float spacing = 1.0;
    if (k == 1) { ang = 2.3561945; thr = 0.34; spacing = 1.03; }
    else if (k == 2) { ang = 0.17; thr = 0.6; spacing = 0.94; }
    else if (k == 3) { ang = 1.2915; thr = 0.82; spacing = 0.88; }
    ang += jit * (0.6 + 0.4 * fk);
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 nrm = vec2(-dir.y, dir.x);
    float along = dot(p, dir);
    float across = dot(p, nrm);
    // line-space coordinate with a slow, smooth hand wobble
    float u = across * sc * spacing;
    u += wob * 0.34 * (sin(along * 7.0 + t * 0.9 + fk * 1.7) * 0.6
                     + sin(across * 3.1 - t * 0.6 + fk * 2.9) * 0.4);
    float px = clamp(fwidth(u) * 0.75, 0.002, 0.5);
    float act = smoothstep(thr, thr + 0.14, dens);
    if (act <= 0.0) continue;
    float li = floor(u);
    uint lid = synthHashCombine(uint(int(li)), 101u + uint(k));
    float lr = synthRand(${seedUniform}, ${nsUniform}, lid);
    // hand-drawn lines are not evenly spaced: nudge each stroke off its cell centre
    float dist = abs(u - li - 0.5 - (lr - 0.5) * 0.3);
    // heavier tone → fatter strokes; each stroke has its own pressure
    float hw = (0.09 + 0.24 * dens) * (0.75 + 0.5 * lr);
    hw = clamp(hw, 0.03, 0.3);
    float line = 1.0 - smoothstep(hw - px, hw + px, dist);
    // strokes break up along their length (lifting the pencil)
    float press = ${vnoise}(vec2(along * sc * 0.22, li * 1.37 + fk * 5.1), 17u);
    float stroke = mix(0.55, 1.0, smoothstep(0.15, 0.6, press));
    // graphite only catches the tooth peaks
    float catchPeak = mix(1.0, smoothstep(0.2, 0.7, tooth), 0.55);
    float ink = line * act * stroke * catchPeak;
    keep *= 1.0 - clamp(ink * 0.92, 0.0, 1.0);
  }
  float cover = clamp(1.0 - keep, 0.0, 1.0);

  // faint cream paper wash, only under drawn areas
  float wash = paperAmt * smoothstep(0.0, 0.14, dens) * (0.55 + 0.45 * tooth);
  vec3 paperCol = vec3(0.95, 0.93, 0.87) * (0.9 + 0.1 * tooth);
  vec3 graphite = ${hsl2rgb}(hue, 0.3, 0.13 + 0.12 * (1.0 - tooth));

  float alpha = cover + wash * (1.0 - cover);
  vec3 col = graphite * cover + paperCol * wash * (1.0 - cover);
  alpha = clamp(alpha, 0.0, 1.0);
  return vec4(clamp(col, 0.0, 1.0), alpha);
}
`.trim();
  },
};
