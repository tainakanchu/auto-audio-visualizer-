import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Small planet — a slowly turning globe floating in dark space: fbm continents
 * over a flat ocean, a soft terminator with city-light speckles on the night
 * side, and a thin atmosphere halo around the limb.
 *
 * Source なので返り値は 0..1 の density。海は暗く滑らか（太陽のグリントだけ）、
 * 陸は起伏の法線で明るさが揺れる。夜側は陸の海岸寄りにだけ小さな明点（都市の
 * 灯り）が出る。大気リムは球の外へ指数で減衰し、外周で厳密に 0 に落ちる。
 *
 * 球との交差は解析的に取り、地形は外殻から内側へ短い march で詰めるだけなので
 * 他の SDF source より軽い（fbm は 4 octave の value noise）。
 */
export const sdfPlanetDef: GeneratorDefinition = {
  id: 'sdfPlanet',
  version: 1,
  category: 'source',
  costClass: 'medium',
  impl: 'inline',
  output: 'field',
  tags: {
    environment: ['space'],
    material: ['rock', 'water'],
    motion: ['spin', 'drift'],
    affect: ['cosmic', 'calm', 'cinematic', 'distant'],
  },
  parameters: [
    {
      id: 'sea',
      label: 'Sea Level',
      kind: 'number',
      min: 0.4,
      max: 0.62,
      default: 0.5,
      modulatable: true,
    },
    {
      id: 'continents',
      label: 'Continent Scale',
      kind: 'number',
      min: 1.2,
      max: 3.0,
      default: 1.9,
      modulatable: false,
    },
    {
      id: 'cities',
      label: 'City Lights',
      kind: 'number',
      min: 0,
      max: 1,
      default: 0.6,
      modulatable: true,
    },
    {
      id: 'spin',
      label: 'Spin',
      kind: 'number',
      min: 0,
      max: 1.5,
      default: 0.5,
      modulatable: true,
    },
    {
      id: 'size',
      label: 'Size',
      kind: 'number',
      min: 0.36,
      max: 0.6,
      default: 0.5,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 1.2, stateful: false },
};

export const sdfPlanetGenerator: InlineGenerator = {
  def: sdfPlanetDef,
  preludes: ['sdf3d'],
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uSea = uniform('sea');
    const uCont = uniform('continents');
    const uCities = uniform('cities');
    const uSpin = uniform('spin');
    const uSize = uniform('size');
    const hash = `${fnName}_hash`;
    const vnoise = `${fnName}_vnoise`;
    const fbm = `${fnName}_fbm`;
    const frame = `${fnName}_frame`;
    /** synthRand shorthand: index is hashCombine(idx, k). */
    const r = (k: string) => `synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(0u, ${k}))`;
    return /* glsl */ `
// sdfPlanet source. Planet frame: the globe turns about a seed-tilted axis;
// the sun stays fixed in camera space so the terminator holds still while the
// continents (and their cities) roll through it.
float ${hash}(vec3 c, uint salt) {
  // +512 keeps every lattice coordinate positive before the uint cast
  uvec3 u = uvec3(ivec3(c) + 512);
  return float(synthHashU32(u.x * 0x8da6b343u ^ u.y * 0xd8163841u ^ u.z * 0xcb1ab31fu ^ salt) >> 8u) /
    16777216.0;
}

float ${vnoise}(vec3 x, uint salt) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = ${hash}(i, salt);
  float n100 = ${hash}(i + vec3(1.0, 0.0, 0.0), salt);
  float n010 = ${hash}(i + vec3(0.0, 1.0, 0.0), salt);
  float n110 = ${hash}(i + vec3(1.0, 1.0, 0.0), salt);
  float n001 = ${hash}(i + vec3(0.0, 0.0, 1.0), salt);
  float n101 = ${hash}(i + vec3(1.0, 0.0, 1.0), salt);
  float n011 = ${hash}(i + vec3(0.0, 1.0, 1.0), salt);
  float n111 = ${hash}(i + vec3(1.0, 1.0, 1.0), salt);
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

// 4 octaves, normalised to ~0..1
float ${fbm}(vec3 x, uint salt) {
  float s = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    s += amp * ${vnoise}(x, salt);
    x = x * 2.03 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return s / 0.9375;
}

// world -> planet frame (rotation only). The two rotations are uniform per
// frame, so their cos/sin come in precomputed (cs.xy tilt, cs.zw spin) instead
// of being re-derived on every march step.
vec3 ${frame}(vec3 v, vec4 cs) {
  vec3 q = v;
  q.xy = vec2(cs.x * q.x - cs.y * q.y, cs.y * q.x + cs.x * q.y);
  q.xz = vec2(cs.z * q.x - cs.w * q.z, cs.w * q.x + cs.z * q.z);
  return q;
}

float ${fnName}(vec2 p) {
  float R = clamp(${uSize}, 0.36, 0.6);
  float sea = clamp(${uSea}, 0.4, 0.62);
  float freq = clamp(${uCont}, 1.2, 3.0);
  uint salt = synthHashCombine(${seedUniform}, ${nsUniform});
  vec3 ro = vec3(0.0, 0.0, -2.6);
  vec3 rd = normalize(vec3(p, 0.95));
  // sun from one side and slightly behind, so a crescent of night always shows
  float sa = (${r('4u')} < 0.5 ? -1.0 : 1.0) * (1.2 + 0.45 * ${r('5u')});
  vec3 sun = normalize(vec3(sin(sa), 0.35 * (${r('6u')} - 0.5), -cos(sa) * 0.8));

  float hAmp = 0.05 * R;
  float atm = R * 0.055;
  float outer = R + hAmp;
  float haloEdge = R + atm * 3.2;

  float tca = dot(-ro, rd);
  vec3 closest = ro + rd * tca;
  float b = length(closest);
  if (b > haloEdge) return 0.0;

  // ---- atmosphere halo, outside the disc: falls to exactly 0 at haloEdge ----
  float sunSide = smoothstep(-0.45, 0.6, dot(closest / max(b, 1e-4), sun));
  float glowBoost = 1.0 + 0.35 * clamp(uBass, 0.0, 1.0) + 0.25 * clamp(uPunch, 0.0, 1.0);
  float halo = exp(-max(b - R, 0.0) / atm) * (0.05 + 0.6 * sunSide * sunSide) * glowBoost;
  halo *= 1.0 - smoothstep(R + atm * 1.6, haloEdge, b);
  if (b > outer) return clamp(halo * 0.85, 0.0, 1.0);

  float tilt = (0.25 + 0.35 * ${r('1u')}) * (${r('2u')} < 0.5 ? -1.0 : 1.0);
  float spin = clamp(${uSpin}, 0.0, 1.5) * (1.0 + 0.15 * uBass);
  float turn = uTime * spin * 0.16 + ${r('3u')} * 6.28318530718;
  vec4 cs = vec4(cos(tilt), sin(tilt), cos(turn), sin(turn));

  // ---- terrain: enter the outer shell, then a short march down to the ground ----
  float tIn = tca - sqrt(max(outer * outer - b * b, 0.0));
  float t = tIn;
  float land = 0.0;
  bool hit = false;
  for (int i = 0; i < 16; i++) {
    vec3 pos = ro + rd * t;
    float rr = length(pos);
    vec3 q = ${frame}(pos / rr, cs);
    land = max(${fbm}(q * freq, salt) - sea, 0.0);
    float ground = R + hAmp * min(land * 3.2, 1.0);
    float d = rr - ground;
    if (d < 0.0008) { hit = true; break; }
    t += d * 0.7;
    if (rr > outer + 0.002 && i > 0) break;
  }
  // grazing rays that skim the mountains and leave: only the halo
  if (!hit) return clamp(halo * 0.85, 0.0, 1.0);

  vec3 pos = ro + rd * t;
  vec3 ns = normalize(pos);
  vec3 q = ${frame}(ns, cs);
  float mu = dot(ns, sun);
  // soft terminator: 0 night .. 1 day
  float day = smoothstep(-0.12, 0.3, mu);
  float isLand = smoothstep(0.0, 0.012, land);

  // bumped normal on land from two extra fbm taps (finite difference along a
  // tangent frame); oceans keep the sphere normal so they stay smooth
  vec3 tx = normalize(cross(ns, abs(ns.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 ty = cross(ns, tx);
  float eps = 0.02;
  float h0 = land;
  float hx = max(${fbm}(${frame}(normalize(ns + tx * eps), cs) * freq, salt) - sea, 0.0);
  float hy = max(${fbm}(${frame}(normalize(ns + ty * eps), cs) * freq, salt) - sea, 0.0);
  float relief = 0.9 * isLand;
  vec3 nb = normalize(ns - relief * ((hx - h0) * tx + (hy - h0) * ty) / eps);
  float ndl = clamp(dot(nb, sun), 0.0, 1.0);

  float view = clamp(dot(ns, -rd), 0.0, 1.0);
  // limb darkening: the edge of the disc dims, the atmosphere takes over
  float limb = 0.55 + 0.45 * pow(view, 0.6);

  // ocean: dim, smooth, with a sun glint
  float glint = pow(clamp(dot(reflect(rd, ns), sun), 0.0, 1.0), 28.0);
  float ocean = (0.05 + 0.34 * clamp(mu, 0.0, 1.0)) * limb + 0.45 * glint * day;
  // land: brighter by light, highlands brighter still (snow-ish caps)
  float alt = clamp(land * 5.0, 0.0, 1.0);
  float ground = (0.16 + 0.52 * ndl + 0.18 * alt) * limb * (0.35 + 0.65 * day);
  float surf = mix(ocean, ground, isLand) * mix(0.12, 1.0, day);

  // ---- city lights: sparse bright points, coastal lowlands, night side only ----
  float cities = clamp(${uCities}, 0.0, 1.0);
  vec3 cp = q * 26.0;
  vec3 cell = floor(cp);
  vec3 jitter = vec3(${hash}(cell, salt ^ 0x51u), ${hash}(cell, salt ^ 0xa3u), ${hash}(cell, salt ^ 0x77u));
  float cd = length(fract(cp) - (0.3 + 0.4 * jitter));
  float pop = smoothstep(0.0, 0.012, land) * (1.0 - smoothstep(0.08, 0.2, land));
  float lit = step(${hash}(cell, salt ^ 0x3cu), 0.8 * cities);
  float twinkle = 0.75 + 0.25 * clamp(uTreble, 0.0, 1.0);
  float city = (1.0 - smoothstep(0.08, 0.3, cd)) * lit * pop * twinkle * (1.0 - day);

  // atmosphere over the disc: a thin day-side fresnel band at the limb
  float rim = pow(1.0 - view, 3.0) * (0.08 + 0.6 * sunSide * sunSide) * glowBoost;

  float v = max(surf, city * 0.95) + rim * 0.6;
  return clamp(v, 0.0, 1.0);
}
`.trim();
  },
};
