import type {
  GeneratorDefinition,
  ParameterDefinition,
  VisualOperator,
  VisualPatch,
} from '../types';
import type { InlineGenerator, InlineGeneratorCatalog } from '../generators/types';
import { RNG_GLSL } from '../rng.glsl';
import { resolvePreludes } from './preludes';

export const SEED_UNIFORM = 'uSeed';

/**
 * Patch 共通のオーディオ反応の強さ。
 *
 * Generator は 106 個中 8 個しか音の uniform を読まないので、Generator 任せに
 * すると「音に反応している感が無い Patch」が大量に出る。どんな組み合わせを
 * 引いても最低限は音に反応するように、main() の中で全 Patch 共通に効かせる。
 * 演出の主役ではなく下地なので、いずれも控えめな値にしてある。
 */
/** 拍の頭で画面を寄せる量（0.05 = 5% ズームイン）。 */
const PUNCH_ZOOM = 0.05;
/** 拍の頭で色を持ち上げる量。プリマルチプライドなので軽いグローになる。 */
const PUNCH_LIFT = 0.25;
/** 無音時に画面を引く量（0.06 = 6% ズームアウト）。音量で息をするように見える。 */
const ENERGY_ZOOM = 0.06;

/** Sanitize opId so the result is a valid GLSL identifier fragment. */
export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

export function uniformName(opId: string, paramId: string): string {
  return `u_${sanitizeId(opId)}_${paramId}`;
}

export function nsUniformName(opId: string): string {
  return `uNs_${sanitizeId(opId)}`;
}

/** sampler2D uniform for a declared texture slot. */
export function textureUniformName(opId: string, slot: string): string {
  return `u_${sanitizeId(opId)}_tex_${sanitizeId(slot)}`;
}

/**
 * Pixel size of the image bound to a slot, as a vec2.
 *
 * Emitted next to every sampler so a generator can correct for the image's own
 * aspect ratio without the CPU having to bake it into a parameter.
 */
export function textureSizeUniformName(opId: string, slot: string): string {
  return `${textureUniformName(opId, slot)}_size`;
}

/** One declared texture slot of one operator, with the uniforms bound to it. */
export interface TextureBinding {
  opId: string;
  slot: string;
  /** Patch.images のキー（`<opId>.<slot>`）。 */
  key: string;
  /** sampler2D uniform 名。 */
  name: string;
  /** vec2 の実サイズ uniform 名。 */
  sizeName: string;
}

export interface AssembledShader {
  fragSrc: string;
  uniforms: Array<{ opId: string; paramId: string; name: string }>;
  nsUniforms: Array<{ opId: string; name: string }>;
  /**
   * 宣言順のテクスチャスロット。シーンはこの順にテクスチャユニットを割り当てる。
   * テクスチャを使わない Patch では空配列。
   */
  textures: TextureBinding[];
}

/** Role used for fn naming and main() stage ordering. */
type OpRole = 'source' | 'field' | 'mod_coord' | 'mod_value' | 'material';

interface ResolvedOp {
  op: VisualOperator;
  gen: InlineGenerator;
  def: GeneratorDefinition;
  role: OpRole;
  fnName: string;
  nsName: string;
  /** This operator's slots, in declaration order. Empty for most generators. */
  textures: TextureBinding[];
}

function roleOf(def: GeneratorDefinition): OpRole {
  if (def.category === 'source') return 'source';
  if (def.category === 'field') return 'field';
  if (def.category === 'material') return 'material';
  // modifier: vector = coord transform, field = value transform
  if (def.category === 'modifier') {
    if (def.output === 'vector') return 'mod_coord';
    if (def.output === 'field') return 'mod_value';
  }
  throw new Error(
    `Cannot classify generator "${def.id}" (category=${def.category}, output=${def.output}) for assembly`,
  );
}

function glslUniformType(param: ParameterDefinition): string {
  switch (param.kind) {
    case 'number':
      return 'float';
    case 'int':
    case 'bool':
    case 'enum':
      return 'int';
    default: {
      const _exhaustive: never = param.kind;
      return _exhaustive;
    }
  }
}

/**
 * Assemble a VisualPatch into a single fullscreen fragment shader.
 *
 * Deterministic: same Patch + catalog → same fragSrc always.
 * Operator order is patch.operators array order; stages in main() follow:
 *   coord modifiers → fields (* amount) → sources (max) → value modifiers → material
 */
export function assemblePatch(
  patch: VisualPatch,
  catalog: InlineGeneratorCatalog,
): AssembledShader {
  const uniforms: AssembledShader['uniforms'] = [];
  const nsUniforms: AssembledShader['nsUniforms'] = [];
  const textures: TextureBinding[] = [];
  /** Prelude keys in operator order; resolvePreludes dedupes and keeps first-seen order. */
  const preludeKeys: string[] = [];

  // Resolve operators in stable order (patch.operators appearance order).
  const resolved: ResolvedOp[] = [];
  const roleCounts: Record<OpRole, number> = {
    source: 0,
    field: 0,
    mod_coord: 0,
    mod_value: 0,
    material: 0,
  };

  for (const op of patch.operators) {
    const gen = catalog.get(op.generatorId);
    if (!gen) {
      throw new Error(`assemblePatch: generator "${op.generatorId}" not found in catalog`);
    }
    if (gen.def.impl !== 'inline') {
      throw new Error(
        `assemblePatch: generator "${op.generatorId}" impl is "${gen.def.impl}", expected "inline"`,
      );
    }
    const role = roleOf(gen.def);
    const idx = roleCounts[role]++;
    const fnName = `${role}_${idx}`;
    const nsName = nsUniformName(op.id);
    const opTextures: TextureBinding[] = (gen.def.textures ?? []).map((slot) => ({
      opId: op.id,
      slot,
      key: `${op.id}.${slot}`,
      name: textureUniformName(op.id, slot),
      sizeName: textureSizeUniformName(op.id, slot),
    }));
    textures.push(...opTextures);
    preludeKeys.push(...(gen.preludes ?? []));
    resolved.push({ op, gen, def: gen.def, role, fnName, nsName, textures: opTextures });
    nsUniforms.push({ opId: op.id, name: nsName });
    for (const param of gen.def.parameters) {
      uniforms.push({
        opId: op.id,
        paramId: param.id,
        name: uniformName(op.id, param.id),
      });
    }
  }

  const lines: string[] = [];

  // ---- header ----
  lines.push('#version 300 es');
  lines.push('precision highp float;');
  lines.push('precision highp int;');
  if (textures.length > 0) {
    // GLSL ES 3.00 defaults samplers to lowp in the fragment stage. Only emitted
    // when a slot exists so texture-free patches keep byte-identical sources.
    lines.push('precision highp sampler2D;');
  }
  lines.push('');
  lines.push(RNG_GLSL.trim());
  lines.push('');
  lines.push('in vec2 vUv;');
  lines.push('out vec4 fragColor;');
  lines.push('uniform vec2 uRes;');
  lines.push('uniform float uTime;');
  lines.push('uniform float uBass, uMid, uTreble, uLevel, uBeat;');
  // uPunch / uEnergy は「音そのもの」ではなく、無音でゲートされた演出用の量。
  // uBeat と違ってブレイク中のフリーホイールでは動かない（scene 側でゲート済み）。
  lines.push('uniform float uPunch, uEnergy;');
  lines.push('uniform float uFade;');
  lines.push(`uniform uint ${SEED_UNIFORM};`);
  lines.push('');

  // ---- param + ns uniforms (operators array order, params in definition order) ----
  lines.push('// --- operator uniforms ---');
  for (const r of resolved) {
    for (const param of r.def.parameters) {
      const name = uniformName(r.op.id, param.id);
      lines.push(`uniform ${glslUniformType(param)} ${name};`);
    }
    for (const tex of r.textures) {
      lines.push(`uniform sampler2D ${tex.name};`);
      lines.push(`uniform vec2 ${tex.sizeName};`);
    }
    lines.push(`uniform uint ${r.nsName};`);
  }
  lines.push('');

  // ---- shared preludes (declared via InlineGenerator.preludes) ----
  // Emitted once per Patch, ahead of every generator function, so several
  // generators can share e.g. the 3D SDF primitives without duplicate defs.
  const preludeSrc = resolvePreludes(preludeKeys);
  if (preludeSrc.length > 0) {
    lines.push('// --- shared preludes ---');
    lines.push(preludeSrc);
    lines.push('');
  }

  // ---- emitted generator functions (operators array order) ----
  lines.push('// --- generator functions ---');
  for (const r of resolved) {
    const declaredSlots = new Set(r.textures.map((t) => t.slot));
    /** Fail loud: a generator asking for a slot it never declared is a bug. */
    const requireSlot = (slot: string): void => {
      if (!declaredSlots.has(slot)) {
        throw new Error(
          `assemblePatch: generator "${r.def.id}" requested texture slot "${slot}" ` +
            `which it does not declare (textures: [${(r.def.textures ?? []).join(', ')}])`,
        );
      }
    };
    const body = r.gen.emit({
      fnName: r.fnName,
      uniform: (paramId: string) => uniformName(r.op.id, paramId),
      nsUniform: r.nsName,
      seedUniform: SEED_UNIFORM,
      texUniform: (slot: string) => {
        requireSlot(slot);
        return textureUniformName(r.op.id, slot);
      },
      texSizeUniform: (slot: string) => {
        requireSlot(slot);
        return textureSizeUniformName(r.op.id, slot);
      },
    });
    lines.push(body);
    lines.push('');
  }

  // ---- main: strict pipeline stages ----
  const coordMods = resolved.filter((r) => r.role === 'mod_coord');
  const fields = resolved.filter((r) => r.role === 'field');
  const sources = resolved.filter((r) => r.role === 'source');
  const valueMods = resolved.filter((r) => r.role === 'mod_value');
  const materials = resolved.filter((r) => r.role === 'material');

  lines.push('void main() {');
  lines.push('  // aspect-corrected, origin-centered coords');
  lines.push('  vec2 uv = vUv;');
  lines.push('  float aspect = uRes.x / uRes.y;');
  lines.push('  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);');
  lines.push('');

  lines.push('  // 0. shared audio response — every patch reacts, whatever it picked');
  lines.push(
    `  p *= (1.0 + ${ENERGY_ZOOM.toFixed(3)} * (1.0 - uEnergy)) * (1.0 - ${PUNCH_ZOOM.toFixed(
      3,
    )} * uPunch);`,
  );
  lines.push('');

  lines.push('  // 1. coord modifiers (modifier + output:vector) in patch order');
  for (const r of coordMods) {
    lines.push(`  p = ${r.fnName}(p);`);
  }
  lines.push('');

  lines.push('  // 2. fields — displacement always scaled by amount uniform');
  for (const r of fields) {
    const hasAmount = r.def.parameters.some((p) => p.id === 'amount');
    if (hasAmount) {
      lines.push(`  p += ${r.fnName}(p) * ${uniformName(r.op.id, 'amount')};`);
    } else {
      lines.push(`  p += ${r.fnName}(p) * 1.0;`);
    }
  }
  lines.push('');

  lines.push('  // 3. sources combined with max');
  lines.push('  float v = 0.0;');
  for (const r of sources) {
    lines.push(`  v = max(v, ${r.fnName}(p));`);
  }
  lines.push('');

  lines.push('  // 4. value modifiers (modifier + output:field) in patch order');
  for (const r of valueMods) {
    lines.push(`  v = ${r.fnName}(v, p);`);
  }
  lines.push('');

  lines.push('  // 5. material(s) — last wins if multiple');
  if (materials.length === 0) {
    lines.push('  fragColor = vec4(v, v, v, v);');
  } else {
    for (const r of materials) {
      lines.push(`  fragColor = ${r.fnName}(v, p);`);
    }
  }
  // rgb だけ持ち上げる。alpha まで触ると OBS 側で透過そのものが拍ごとに揺れる。
  lines.push(`  fragColor.rgb *= 1.0 + ${PUNCH_LIFT.toFixed(3)} * uPunch;`);
  lines.push('  fragColor *= uFade;');
  lines.push('}');
  lines.push('');

  return {
    fragSrc: lines.join('\n'),
    uniforms,
    nsUniforms,
    textures,
  };
}
