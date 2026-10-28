import type { GeneratorDefinition } from '../types';
import type { EmitContext, InlineGenerator } from './types';

/**
 * Mechanical eye — raymarched 3D hero object: a ring of hinged plates around a
 * multi-blade iris, a glass lens dome over a glowing core, and thin orbit rings.
 *
 * Source なので返り値は 0..1 の density。プレートは polar domain repetition で
 * 1 枚分の SDF しか評価しない（プレート数ぶんのループは回さない）。レンズは
 * 解析的な球キャップで、march の外で「半透明のガラス」として合成する（fresnel
 * で縁ほど濃く、中央からは奥の絞りとコアが透けて見える）。
 *
 * 音: キック (uPunch / uBeat) でプレートが外へ開き、絞りが締まる。低音でレンズが
 * 前にせり出し、高音でコアが光る。無音でも uTime でゆっくり呼吸する。
 */
export const sdfMagicEyeDef: GeneratorDefinition = {
  id: 'sdfMagicEye',
  version: 1,
  category: 'source',
  costClass: 'heavy',
  impl: 'inline',
  output: 'field',
  tags: {
    material: ['metal', 'glass'],
    motion: ['pulse', 'spin', 'open'],
    affect: ['mechanical', 'uncanny', 'graphic', 'cinematic'],
  },
  parameters: [
    {
      id: 'plates',
      label: 'Plates',
      kind: 'int',
      min: 24,
      max: 72,
      default: 40,
      modulatable: false,
    },
    {
      id: 'blades',
      label: 'Iris Blades',
      kind: 'int',
      min: 5,
      max: 12,
      default: 8,
      modulatable: false,
    },
    {
      id: 'rings',
      label: 'Orbit Rings',
      kind: 'int',
      min: 1,
      max: 2,
      default: 2,
      modulatable: false,
    },
    {
      id: 'open',
      label: 'Kick Open',
      kind: 'number',
      min: 0,
      max: 1.5,
      default: 0.9,
      modulatable: true,
    },
    {
      id: 'size',
      label: 'Size',
      kind: 'number',
      min: 0.5,
      max: 0.8,
      default: 0.66,
      modulatable: true,
    },
  ],
  cost: { passes: 0, relativeFill: 1.0, stateful: false },
};

export const sdfMagicEyeGenerator: InlineGenerator = {
  def: sdfMagicEyeDef,
  preludes: ['sdf3d'],
  emit(ctx: EmitContext): string {
    const { fnName, uniform, nsUniform, seedUniform } = ctx;
    const uPlates = uniform('plates');
    const uBlades = uniform('blades');
    const uRings = uniform('rings');
    const uOpen = uniform('open');
    const uSize = uniform('size');
    const map = `${fnName}_map`;
    const nrm = `${fnName}_nrm`;
    const orient = `${fnName}_orient`;
    const mat = `${fnName}_mat`;
    /** synthRand shorthand: index is hashCombine(idx, k). */
    const r = (k: string) => `synthRand(${seedUniform}, ${nsUniform}, synthHashCombine(0u, ${k}))`;
    return /* glsl */ `
// sdfMagicEye source. Eye-local frame: the eye looks down -z at the camera.
// Material id of the last map() call: 0 plate/bezel, 1 iris, 2 core, 3 ring.
int ${mat};

// world -> eye-local. Seed picks a resting tilt so the plates always show some
// depth; the gaze then wanders slowly around it.
vec3 ${orient}(vec3 pos) {
  float tx = (${r('1u')} - 0.5) * 0.7 + 0.22 * sin(uTime * 0.23 + ${r('2u')} * 6.2831853);
  float ty = (${r('3u')} - 0.5) * 0.8 + 0.28 * sin(uTime * 0.17 + ${r('4u')} * 6.2831853);
  vec3 q = pos;
  q.yz = rot2(q.yz, tx);
  q.xz = rot2(q.xz, ty);
  // the whole mechanism turns slowly about its own axis
  q.xy = rot2(q.xy, uTime * 0.07 + ${r('5u')} * 6.2831853);
  return q;
}

float ${map}(vec3 q) {
  float S = clamp(${uSize}, 0.5, 0.8);
  float TAU = 6.28318530718;
  float rr = length(q.xy);
  // the epsilon keeps atan(0, 0) (exactly on the axis) defined
  float a = atan(q.y, q.x + 1e-7);

  // ---- plate ring: polar repetition, own sector + the nearer neighbour ----
  // Neighbouring plates flip by slightly different angles (the wave below), so
  // the nearer neighbour is evaluated too; otherwise a ray crossing a sector
  // boundary overshoots into the next plate. Still 2 boxes, never n.
  float n = float(clamp(${uPlates}, 24, 72));
  float sec = TAU / n;
  float idx0 = floor(a / sec + 0.5);
  float side = (a - idx0 * sec) < 0.0 ? -1.0 : 1.0;
  float ri = 0.6 * S;
  float lp = 0.34 * S;
  float th = 0.011 * S;
  float open = clamp(${uOpen}, 0.0, 1.5);
  float kick = open * (0.55 * uPunch + 0.15 * uBeat);
  float dPlate = 1e4;
  for (int j = 0; j < 2; j++) {
    float idx = idx0 + float(j) * side;
    float la = a - idx * sec;
    float u = rr * cos(la);
    float v = rr * sin(la);
    // idle breathing + kick. A slow wave runs round the ring so the flip reads
    // as mechanical sequencing, not a uniform scale.
    float wave = 0.5 + 0.5 * sin(idx * TAU * 3.0 / n - uTime * 1.3);
    float flip = min(0.2 + 0.09 * sin(uTime * 0.9) + kick * (0.7 + 0.3 * wave), 1.05);
    vec2 w = rot2(vec2(u - ri, q.z), flip);
    // wedge width follows the plate's projected radius, so a flipped plate
    // never grows past its own sector
    float hw = (ri + max(w.x, 0.0) * cos(flip)) * tan(sec * 0.5) * 0.8;
    dPlate = min(dPlate, sd3Box(vec3(w.x - lp * 0.5, v, w.y), vec3(lp * 0.5, hw, th)) * 0.9);
  }

  // bezel the plates hinge on
  float dBezel = length(vec2(rr - (ri - 0.012 * S), q.z + 0.004 * S)) - 0.028 * S;

  // ---- iris: overlapping blades as a sawtooth step in z around the annulus ----
  float m = float(clamp(${uBlades}, 5, 12));
  float ra = S * (0.21 + 0.025 * sin(uTime * 0.7) - 0.06 * clamp(uPunch, 0.0, 1.0));
  float ro2 = ri - 0.03 * S;
  float bsec = TAU / m;
  float blade = fract((a + 2.4 * (rr - ra) / S) / bsec);
  float zoff = 0.018 * S * blade;
  float dIris = max(abs(q.z - zoff - 0.01 * S) - 0.007 * S, max(rr - ro2, ra - rr)) * 0.8;

  // ---- core: sits just behind the aperture ----
  float dCore = sd3Sphere(q - vec3(0.0, 0.0, 0.05 * S), 0.11 * S);

  // ---- orbit rings ----
  int nr = clamp(${uRings}, 1, 2);
  float dRing = 1e4;
  for (int i = 0; i < 2; i++) {
    if (i >= nr) break;
    float fi = float(i);
    vec3 k = q;
    k.yz = rot2(k.yz, 1.1 + fi * 0.9 + uTime * (0.21 + 0.1 * fi) * (1.0 + 0.4 * uMid));
    k.xy = rot2(k.xy, uTime * (0.13 - 0.06 * fi) + fi * 2.1);
    dRing = min(dRing, sd3Torus(k, vec2(S * (1.02 + 0.13 * fi), 0.007 * S)));
  }

  float d = dPlate;
  ${mat} = 0;
  if (dBezel < d) { d = dBezel; ${mat} = 0; }
  if (dIris < d) { d = dIris; ${mat} = 1; }
  if (dCore < d) { d = dCore; ${mat} = 2; }
  if (dRing < d) { d = dRing; ${mat} = 3; }
  return d;
}

vec3 ${nrm}(vec3 q) {
  vec2 e = vec2(1.0, -1.0) * 0.0016;
  return normalize(
    e.xyy * ${map}(q + e.xyy) + e.yyx * ${map}(q + e.yyx) +
    e.yxy * ${map}(q + e.yxy) + e.xxx * ${map}(q + e.xxx));
}

float ${fnName}(vec2 p) {
  float S = clamp(${uSize}, 0.5, 0.8);
  vec3 roW = vec3(0.0, 0.0, -2.6);
  vec3 rdW = normalize(vec3(p, 0.95));

  // bounding sphere: opened plates and the outer ring all stay inside 1.2 S
  float bound = 1.2 * S;
  float tca = dot(-roW, rdW);
  vec3 closest = roW + rdW * tca;
  float perp2 = dot(closest, closest);
  if (perp2 > bound * bound) return 0.0;
  float halfChord = sqrt(max(bound * bound - perp2, 0.0));

  // march in eye-local space (orient is a rotation, so t is shared)
  vec3 ro = ${orient}(roW);
  vec3 rd = ${orient}(rdW);
  const int MAX_STEPS = 56;
  float tStart = max(tca - halfChord, 0.02);
  float t = tStart;
  float tEnd = tca + halfChord;
  float d = 0.0;
  int hitStep = -1;
  for (int i = 0; i < MAX_STEPS; i++) {
    d = ${map}(ro + rd * t);
    if (d < 0.0012) { hitStep = i; break; }
    t += d * 0.9;
    if (t > tEnd) break;
  }

  float body = 0.0;
  if (hitStep >= 0) {
    int id = ${mat};
    vec3 pos = ro + rd * t;
    vec3 n = ${nrm}(pos);
    vec3 key = ${orient}(normalize(vec3(0.45, 0.75, -0.5)));
    float ndl = clamp(dot(n, key), 0.0, 1.0);
    float head = clamp(dot(n, -rd), 0.0, 1.0);
    float fres = pow(1.0 - head, 3.0);
    float spec = pow(clamp(dot(reflect(rd, n), key), 0.0, 1.0), 18.0);
    float lamp = 1.0 / (1.0 + 0.12 * t * t);
    float ao = mix(0.35, 1.0, clamp(${map}(pos + n * 0.06) / 0.06, 0.0, 1.0));
    float rr = length(pos.xy);
    if (id == 2) {
      // the core is emissive: treble lights it, a fresnel ring keeps it round
      body = 0.45 + 0.45 * clamp(uTreble, 0.0, 1.0) + 0.12 * head + 0.1 * fres;
    } else if (id == 3) {
      body = 0.3 + 0.45 * ndl + 0.3 * spec + 0.2 * fres;
    } else if (id == 1) {
      // iris: darker blades, brighter toward the aperture lip
      float lip = 1.0 - smoothstep(0.0, 0.25 * S, rr - 0.2 * S);
      body = ((0.08 + 0.32 * ndl + 0.22 * head * lamp) * ao + 0.25 * spec) * (0.7 + 0.4 * lip);
    } else {
      // plates: brushed metal, radial falloff so each plate fades to its tip
      float radial = 0.75 + 0.25 * smoothstep(0.95 * S, 0.6 * S, rr);
      body = ((0.12 + 0.48 * ndl + 0.3 * head * lamp) * ao * radial + 0.35 * spec + 0.25 * fres);
    }
    float fog = exp(-max(t - tStart, 0.0) * 0.3);
    body = (0.05 + 0.88 * clamp(body, 0.0, 1.0)) * fog;
  }

  // ---- glass lens dome (analytic sphere cap, composited over the body) ----
  float rl = 0.3 * S;
  // bass pushes the dome forward: the sphere centre slides toward the camera
  float zc = (0.16 - 0.1 * clamp(uBass, 0.0, 1.0)) * S;
  vec3 oc = ro - vec3(0.0, 0.0, zc);
  float bq = dot(oc, rd);
  float cq = dot(oc, oc) - rl * rl;
  float disc = bq * bq - cq;
  float outv = body;
  if (disc > 0.0) {
    float td = -bq - sqrt(disc);
    vec3 dp = ro + rd * td;
    // only the cap in front of the iris plane, and only if it is nearer
    if (dp.z < 0.0 && (hitStep < 0 || td < t)) {
      vec3 dn = normalize(dp - vec3(0.0, 0.0, zc));
      float dv = clamp(dot(dn, -rd), 0.0, 1.0);
      float dfres = pow(1.0 - dv, 2.5);
      vec3 key = ${orient}(normalize(vec3(0.45, 0.75, -0.5)));
      float dspec = pow(clamp(dot(reflect(rd, dn), key), 0.0, 1.0), 40.0);
      // a secondary soft highlight from the opposite side sells the curvature
      float dsoft = pow(clamp(dot(reflect(rd, dn), ${orient}(normalize(vec3(-0.6, -0.3, -0.7)))), 0.0, 1.0), 6.0);
      // the seam where the glass meets the iris plane catches a bright line
      float seam = smoothstep(-0.035 * S, 0.0, dp.z);
      // the cap is cut by the iris plane before the sphere's own silhouette, so
      // plain fresnel stays weak there; a radial term across the cap stands in
      float capR = sqrt(max(rl * rl - zc * zc, 1e-6));
      float rho = clamp(length(dp.xy) / capR, 0.0, 1.0);
      float edge = rho * rho * rho;
      float alpha = clamp(0.2 + 0.5 * edge + 0.5 * dfres + 0.25 * seam, 0.0, 0.92);
      float glass = 0.28 + 0.4 * edge + 0.3 * dfres + 0.3 * dsoft + 0.2 * seam + 0.6 * dspec;
      outv = mix(body, clamp(glass, 0.0, 1.0), alpha);
      outv = max(outv, dspec * 0.95);
    }
  }

  // core halo: closest approach of the ray to the core, a soft treble glow that
  // reaches 0 well inside the bounding sphere
  vec3 cc = vec3(0.0, 0.0, 0.05 * S) - ro;
  float tc = max(dot(cc, rd), 0.0);
  float dc = length(cc - rd * tc) / S;
  float halo = exp(-dc * dc * 40.0) * (0.12 + 0.35 * clamp(uTreble, 0.0, 1.0));
  halo *= 1.0 - smoothstep(0.3, 0.45, dc);
  return clamp(max(outv, 0.0) + halo * (1.0 - outv), 0.0, 1.0);
}
`.trim();
  },
};
