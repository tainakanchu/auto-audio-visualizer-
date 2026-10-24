import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Mandelbox — raymarched 3D fractal hero object (box fold + sphere fold DE)
 * floating in dark space and slowly turning.
 *
 * Source なので返り値は 0..1 の density。クロームっぽさは「反射ベクトルで引く
 * 擬似環境（地平線の帯）+ fresnel リム」を density に写して出す。fold 回数は
 * 小数で持ち、floor 回と floor+1 回の DE を fract で補間するので、音で「階層」
 * が増えても形は連続に育つ（ポップしない）。fold は最大 6 回。
 */
export const sdfMandelboxDef: GeneratorDefinition = {
  id: 'sdfMandelbox',
  version: 1,
  category: 'source',
  costClass: 'heavy',
  impl: 'inline',
  output: 'field',
  tags: {
    material: ['chrome', 'metal'],
    motion: ['spin', 'grow'],
    affect: ['fractal', 'cosmic', 'intricate', 'cinematic'],
  },
  parameters: [
    {
      id: 'fold',
      label: 'Fold Scale',
      kind: 'number',
      min: 1.8,
      max: 2.8,
      default: 2.2,
      modulatable: false,
    },
    {
      id: 'depth',
      label: 'Depth',
      kind: 'number',
      min: 3,
      max: 4.5,
      default: 3.4,
      modulatable: true,
    },
    {
      id: 'grow',
      label: 'Grow',
      kind: 'number',
      min: 0,
      max: 1.5,
      default: 1.1,
      modulatable: true,
    },
    {
      id: 'spin',
      label: 'Spin',
      kind: 'number',
      min: 0,
      max: 1.5,
      default: 0.4,
      modulatable: true,
    },
    {
      id: 'size',
      label: 'Size',
      kind: 'number',
      min: 0.4,
      max: 0.66,
      default: 0.56,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 1.2, stateful: false },
};

export const sdfMandelboxGenerator: InlineGenerator = {
  def: sdfMandelboxDef,
  preludes: ['sdf3d'],
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uFold = uniform('fold');
    const uDepth = uniform('depth');
    const uGrow = uniform('grow');
    const uSpin = uniform('spin');
    const uSize = uniform('size');
    const map = `${fnName}_map`;
    const nrm = `${fnName}_nrm`;
    const level = `${fnName}_level`;
    const orient = `${fnName}_orient`;
    const trap = `${fnName}_trap`;
    /** synthRand shorthand: index is hashCombine(idx, k). */
    const r = (k: string) => `synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(0u, ${k}))`;
    return /* glsl */ `
// sdfMandelbox source: a negative-scale Mandelbox, normalised so its outer box
// is the "size" param. The fold count is fractional: the DE after floor(level)
// and floor(level)+1 folds are blended by fract(level), so when the music pushes
// the level up the object grows new holes continuously instead of popping.
// Orbit trap of the last map() call; read right after the march hit.
float ${trap};

// Fractal level. Energy / slow swell step it up, the beat only nudges it (its
// attack is instant); clamped to 5 so the loop never needs a 7th fold.
float ${level}() {
  float drive = 0.55 * uEnergy + 0.3 * uSwellSet + 0.2 * uPunch;
  return clamp(clamp(${uDepth}, 3.0, 4.5) + clamp(${uGrow}, 0.0, 1.5) * drive, 2.0, 5.0);
}

vec3 ${orient}(vec3 pos) {
  float spin = clamp(${uSpin}, 0.0, 1.5);
  float ax = uTime * spin * (0.31 + 0.2 * ${r('1u')}) + ${r('2u')} * 6.28318530718;
  float ay = uTime * spin * (0.47 + 0.25 * ${r('3u')}) + ${r('4u')} * 6.28318530718;
  vec3 q = pos;
  q.yz = rot2(q.yz, ax);
  q.xz = rot2(q.xz, ay);
  return q;
}

float ${map}(vec3 pos) {
  float s = -clamp(${uFold}, 1.8, 2.8);
  // With 3-6 folds and a box bailout the solid part sits inside |c| < 2 for
  // every fold scale in range; map that onto the world half-size. The
  // scale-dependent escape radius only sizes the bailout box.
  float extent = 2.0 * (-s + 1.0) / (-s - 1.0);
  float k = 2.0 / clamp(${uSize}, 0.4, 0.66);
  vec3 c = pos * k;
  vec3 z = c;
  float dr = 1.0;
  float lv = ${level}();
  int n0 = int(floor(lv));
  float f = lv - float(n0);
  float d0 = 1e4;
  float d1 = 1e4;
  float tr = 1e4;
  for (int i = 0; i < 6; i++) {
    // box fold
    z = clamp(z, -1.0, 1.0) * 2.0 - z;
    // sphere fold (minR² = 0.25, fixedR² = 1)
    float r2 = dot(z, z);
    float m = r2 < 0.25 ? 4.0 : (r2 < 1.0 ? 1.0 / r2 : 1.0);
    z *= m;
    dr *= m;
    z = z * s + c;
    dr = dr * abs(s) + 1.0;
    tr = min(tr, dot(z, z));
    // box-shaped bailout: crisp edges even at 3-5 folds, where the usual
    // length(z)/dr estimate is still a blob
    float de = sd3Box(z, vec3(extent * 0.5)) / abs(dr);
    if (i == n0 - 1) d0 = de;
    if (i == n0) { d1 = de; break; }
  }
  ${trap} = tr;
  return mix(d0, d1, f) / k;
}

vec3 ${nrm}(vec3 pos, float h) {
  vec2 e = vec2(1.0, -1.0) * h;
  return normalize(
    e.xyy * ${map}(pos + e.xyy) + e.yyx * ${map}(pos + e.yyx) +
    e.yxy * ${map}(pos + e.yxy) + e.xxx * ${map}(pos + e.xxx));
}

float ${fnName}(vec2 p) {
  float size = clamp(${uSize}, 0.4, 0.66);
  vec3 roW = vec3(0.0, 0.0, -2.7);
  vec3 rdW = normalize(vec3(p, 0.95));

  // analytic bounding sphere around the (rotating) outer box: a miss is free
  float bound = size * 1.75;
  float tca = dot(-roW, rdW);
  vec3 closest = roW + rdW * tca;
  float perp2 = dot(closest, closest);
  if (perp2 > bound * bound) return 0.0;
  float halfChord = sqrt(max(bound * bound - perp2, 0.0));

  // march in fractal-local space; orient is a pure rotation, so t is shared
  vec3 ro = ${orient}(roW);
  vec3 rd = ${orient}(rdW);
  // hit tolerance follows the pixel footprint: the fractal never resolves
  // detail finer than a pixel, which is what keeps it from sparkling
  float pix = 1.0 / (max(uRes.y, 64.0) * 0.95);
  const int MAX_STEPS = 60;
  float tStart = max(tca - halfChord, 0.02);
  float t = tStart;
  float tEnd = tca + halfChord;
  float d = 1e4;
  int hitStep = -1;
  for (int i = 0; i < MAX_STEPS; i++) {
    d = ${map}(ro + rd * t);
    if (d < 0.75 * pix * t) { hitStep = i; break; }
    // the blended DE is only a bound, undershoot a little
    t += d * 0.85;
    if (t > tEnd) break;
  }
  // out of steps but already grazing the surface: count it, or the deep
  // crevices turn into black pinholes
  if (hitStep < 0 && t < tEnd && d < 6.0 * pix * t) hitStep = MAX_STEPS;
  if (hitStep < 0) return 0.0;
  float orbit = ${trap};

  vec3 pos = ro + rd * t;
  vec3 n = ${nrm}(pos, max(1.2 * pix * t, 0.0012));
  float ndv = clamp(dot(n, -rd), 0.0, 1.0);
  // light lives in camera space, so it stays put while the fractal turns
  vec3 key = ${orient}(normalize(vec3(0.5, 0.72, -0.48)));
  float ndl = clamp(dot(n, key), 0.0, 1.0);
  float head = clamp(dot(n, -rd), 0.0, 1.0);
  // chrome: the reflected ray samples a fake studio — dark floor, soft sky
  // and a bright horizon strip. Varies per pixel even on flat box faces.
  vec3 refl = reflect(rd, n);
  vec3 up = ${orient}(vec3(0.0, 1.0, 0.0));
  float ry = dot(refl, up);
  float env = 0.12 + 0.38 * smoothstep(-0.4, 0.9, ry) + 0.6 * exp(-abs(ry - 0.1) * 7.0);
  float spec = pow(clamp(dot(refl, key), 0.0, 1.0), 16.0);
  float fres = pow(1.0 - ndv, 4.0);
  float ao = mix(0.45, 1.0, clamp(${map}(pos + n * 0.04) / 0.04, 0.0, 1.0));
  float crowd = 1.0 - 0.35 * (float(hitStep) / float(MAX_STEPS));
  // orbit trap tone: deep folds sit darker, outer plates brighter
  float trapTone = 0.7 + 0.3 * clamp(sqrt(orbit) * 0.3, 0.0, 1.0);
  float lamp = 1.0 / (1.0 + 0.1 * t * t);
  float diffuse = (0.1 + 0.3 * ndl + 0.25 * head * lamp) * trapTone;
  float lit = (diffuse + env * (0.28 + 0.4 * fres)) * ao * crowd + 0.35 * spec + 0.25 * fres;
  float fog = exp(-max(t - tStart, 0.0) * 0.3);
  // 0.05..0.92 so the material downstream always gets mid tones
  return clamp((0.05 + 0.87 * clamp(lit, 0.0, 1.0)) * fog, 0.0, 1.0);
}
`.trim();
  },
};
