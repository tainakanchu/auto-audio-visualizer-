/**
 * seed → VisualPatch の決定的導出。
 *
 * 描画は行わない。カタログから Generator を選び、パラメータ・palette・composition を
 * 名前付き RNG で埋め、validate / budget を満たすパッチを返す。
 */
import { createCatalog } from './catalog';
import { DEFAULT_BUDGETS, estimateCost, fitsBudget } from './cost';
import type { InlineGenerator, InlineGeneratorCatalog } from './generators/types';
import { DEFAULT_SMOOTHING } from './modulation';
import { namespaceToU32, pickWeightedByRendezvous, rand } from './rng';
import { CURRENT_SCHEMA_VERSION } from './schema';
import type {
  GeneratorCategory,
  ModulationRoute,
  ParameterDefinition,
  PaletteMode,
  QualityTier,
  VisualOperator,
  VisualPatch,
} from './types';
import { validatePatch } from './validate';

export interface DeriveOptions {
  /** 使う Generator カタログ。 */
  catalog: InlineGeneratorCatalog;
  /** 品質ティア（既定 'medium'）。 */
  qualityTier?: QualityTier;
}

const PALETTE_MODES: readonly PaletteMode[] = [
  'mono',
  'analogous',
  'complementary',
  'triadic',
  'rainbow',
];

interface RouteSource {
  id: string;
  /** 選ばれやすさ。大きいほど選ばれやすい（重み付きランデブー）。 */
  weight: number;
  /** amount 比率の補正。ソースごとに実効レンジが違うのを吸収する。 */
  drive: number;
  /** 拍で立ち上がって減衰するパルス系か。平滑と極性の扱いが変わる。 */
  pulse: boolean;
}

/**
 * Audio→param route の source 候補。
 *
 * `audio:beatPhase` / `audio:barPhase` は**入っていない**。あれはテンポグリッド
 * 上の位置を返すノコギリ波で、音量に関係なく（無音でも）回り続けるため、
 * 変調に使っても「音に反応している」感には一切ならない。
 *
 * 同じ理由で拍系は `audio:gridPulse` ではなく `audio:beatIntensity` を使う。
 * gridPulse はブレイク中もフリーホイールするので無音でも脈打つ。
 *
 * `drive` は「そのソースが実際にどこまで振れるか」の補正。`level` は RMS なので
 * 帯域平均より一桁小さく、同じ比率だと変調が見えない（これが「音に反応して
 * いる感が無い」原因のひとつだった）。
 */
export const ROUTE_SOURCES: readonly RouteSource[] = [
  { id: 'audio:bass', weight: 3, drive: 1.0, pulse: false },
  { id: 'audio:mid', weight: 2, drive: 1.1, pulse: false },
  { id: 'audio:treble', weight: 2, drive: 1.3, pulse: false },
  { id: 'audio:level', weight: 2, drive: 2.2, pulse: false },
  { id: 'audio:beatIntensity', weight: 3, drive: 1.0, pulse: true },
];

/**
 * derive が変調してよいパラメータ名の**許可リスト**を、「何に効くか」で分類した
 * もの。{@link SAFE_TARGET_PARAMS} と {@link TARGET_WEIGHT_BY_PARAM} はどちらも
 * ここから導出する（2 つの名簿が食い違うのを構造的に防ぐため）。
 *
 * 拒否リストではなく許可リストなのは、「音に反応して画が消える」ことを
 * 構造的に禁止するため。`threshold` / `gate` / `dropout` のように**上げると絵が
 * 消える**パラメータが 105 個の Generator に散らばっていて、名前で危険なものを
 * 数え上げるやり方だと必ず取りこぼす。クラブの大音量下でずっと真っ暗、という
 * 事故は「たまに起きる」では済まないので、安全側が既定になる形にしてある。
 *
 * ここに載るのは「増える = 見える / 動く」方向のパラメータだけ。極性を
 * unipolar に固定してあるので（{@link buildRoutes}）、音は常に**足す**方向にしか
 * 効かない = 無音時の見た目が Patch の下限で、音が入るほど増える。
 *
 * 手で組んだ Patch はこの制限を受けない（proposePatch は validate だけ通る）。
 *
 * **weight を種類ごとに分けているのは単調さ対策**。許可リストは結果として
 * 大きさ系がいちばん多く、候補を等確率で引くと選ばれるのもほぼ大きさ系に
 * なる。どの Patch も「拍で大きくなる」だけの反応に収束していた（「音に連動
 * するのが拡大縮小ばかり」の正体はこれ）。候補が少ない種類ほど重くして、
 * 歪み・輝き・動きにも同じくらい票が回るようにしてある。
 */
const TARGET_KINDS = {
  /** 大きさ: 候補がいちばん多いので最も軽い = 相対的に選ばれにくい。 */
  size: {
    weight: 1,
    params: ['scale', 'size', 'thickness', 'radius', 'width', 'depth', 'zoom'],
  },
  /** 量・密度 */
  density: { weight: 2, params: ['amount', 'density', 'count'] },
  /** 輝き */
  light: {
    weight: 2,
    params: ['intensity', 'strength', 'glow', 'brightness', 'sparkle', 'sheen'],
  },
  /** 動き */
  motion: {
    weight: 2,
    params: [
      'speed',
      'rate',
      'spin',
      'twist',
      'wobble',
      'drift',
      'flow',
      'vortex',
      'pull',
      'tension',
    ],
  },
  /** 空間の歪み: 候補がいちばん少ないので最も重い。 */
  warp: { weight: 3, params: ['warp', 'shift'] },
} as const satisfies Record<string, { weight: number; params: readonly string[] }>;

/** 変調してよい paramId。{@link TARGET_KINDS} の全 params。 */
export const SAFE_TARGET_PARAMS = new Set<string>(
  Object.values(TARGET_KINDS).flatMap((kind) => kind.params),
);

/** paramId → 選ばれやすさ。{@link TARGET_KINDS} から導出するので取りこぼしが無い。 */
const TARGET_WEIGHT_BY_PARAM = new Map<string, number>(
  Object.values(TARGET_KINDS).flatMap((kind) =>
    kind.params.map((id): [string, number] => [id, kind.weight]),
  ),
);

/**
 * 既に route が刺さっている Operator の target に掛ける係数。
 *
 * 1 つの Operator に 3 本まとまると、音が動かすのは画のごく一部だけになる。
 * 禁止ではなく減点なのは、変調できる Operator が 1 つしか無い Patch でも
 * route が引けなくならないようにするため。
 */
const SAME_OPERATOR_PENALTY = 0.35;

/**
 * 動きの速さそのものを持つパラメータ。{@link SAFE_TARGET_PARAMS} の部分集合で、
 * 変調の振り幅だけ別に絞る（{@link MOTION_RATIO_MAX}）。
 *
 * ここを他と同じ幅で振ると、大音量のときだけ「BPM と関係なくギュインギュイン
 * 動く」が戻ってくる。音で速くなること自体は反応として欲しいので、禁止では
 * なく上限で抑える。
 */
export const MOTION_TARGET_PARAMS = new Set(['speed', 'rate', 'spin', 'twist', 'drift', 'flow']);

/** 動き系 target の amount 比率の上限。 */
export const MOTION_RATIO_MAX = 0.3;

/** route 本数の下限 / 上限。 */
const MIN_ROUTES = 2;
const MAX_ROUTES = 4;

/**
 * amount がパラメータレンジに占める比率の下限 / 上限（drive 前）。
 *
 * 上限を 0.5 で止めるのは、レンジいっぱいまで足すと今度は逆に「大音量で
 * 塗り潰されて何も見えない」に振れるため。
 */
const AMOUNT_RATIO_MIN = 0.2;
const AMOUNT_RATIO_MAX = 0.5;

/** パルス系 route の平滑時定数（秒）。拍の立ち上がりを潰さない程度に短く。 */
const PULSE_SMOOTHING_MIN = 0.05;
const PULSE_SMOOTHING_MAX = 0.15;

const MAX_STRIP_ATTEMPTS = 32;

/** 画像入力を要求する Generator か。derive の候補からは外す。 */
function needsTexture(gen: InlineGenerator): boolean {
  return (gen.def.textures?.length ?? 0) > 0;
}

/** 単体 Patch を組むための固定値。予算判定は operators と qualityTier しか見ない。 */
const PROBE_PALETTE: VisualPatch['palette'] = {
  mode: 'mono',
  hueOffset: 0,
  saturation: 0,
  lightness: 50,
};
const PROBE_COMPOSITION: VisualPatch['composition'] = { symmetry: 1, scale: 1, speed: 1 };

/**
 * その Generator **1 個だけ**の Patch が、その tier の予算に既に違反しないか。
 *
 * 違反する Generator を候補に残すと、strip では逃げ切れない seed が生まれる:
 * stripOneOperator は source が 1 個になると null を返すので、単体で予算オーバー
 * する source が src0 に座った瞬間 derivePatch が throw する（low tier の
 * `maxHeavyGenerators === 0` に heavy な source がぶつかるのが典型）。
 *
 * costClass === 'heavy' の決め打ちではなく estimateCost + fitsBudget で判定する
 * ので、passes 上限・stateful 上限にも同じ規則が自動的に効く。rendezvous hashing
 * なので、除外の影響は該当 slot だけに閉じる（他 slot の seed→Generator は不変）。
 */
function fitsBudgetAlone(
  gen: InlineGenerator,
  defCatalog: ReturnType<typeof createCatalog>,
  qualityTier: QualityTier,
): boolean {
  const probe: VisualPatch = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    seed: '',
    operators: [
      {
        id: 'probe',
        generatorId: gen.def.id,
        generatorVersion: gen.def.version,
        parameters: {},
      },
    ],
    routes: [],
    palette: PROBE_PALETTE,
    composition: PROBE_COMPOSITION,
    qualityTier,
  };
  return fitsBudget(estimateCost(probe, defCatalog), DEFAULT_BUDGETS[qualityTier]).length === 0;
}

/** Inclusive integer in [min, max]. Avoids off-by-one when rand is in [0, 1). */
function randInt(seed: string, ns: string, index: number, min: number, max: number): number {
  if (max <= min) return min;
  const r = rand(seed, ns, index);
  return Math.min(max, min + Math.floor(r * (max - min + 1)));
}

function pickParameter(
  seed: string,
  opId: string,
  param: ParameterDefinition,
): number | string | boolean {
  const ns = `patch:param:${opId}:${param.id}`;
  switch (param.kind) {
    case 'number': {
      const min = param.min ?? 0;
      const max = param.max ?? 1;
      return min + rand(seed, ns, 0) * (max - min);
    }
    case 'int': {
      const min = param.min ?? 0;
      const max = param.max ?? min;
      return randInt(seed, ns, 0, min, max);
    }
    case 'bool':
      return rand(seed, ns, 0) < 0.5;
    case 'enum': {
      const options = param.options ?? [];
      if (options.length === 0) {
        if (typeof param.default === 'string') return param.default;
        throw new Error(`pickParameter: enum "${param.id}" has no options`);
      }
      const idx = randInt(seed, ns, 0, 0, options.length - 1);
      return options[idx]!;
    }
    default: {
      const _exhaustive: never = param.kind;
      return _exhaustive;
    }
  }
}

/**
 * Highest-random-weight (rendezvous) selection for a slot.
 *
 * WHY rendezvous hashing (not array-index / `floor(rand * n)`):
 * When a new generator is added to the catalog, index-based picks reshuffle almost all
 * existing seed→generator mappings (every seed whose residual lands past the insert point).
 * Rendezvous assigns each candidate an independent weight `rand(seed, slot, hash(id))` and
 * takes the max. Adding or removing one generator only changes the winner when the newcomer
 * beats the previous max (probability ~1/(n+1)), so most seeds keep a stable mapping.
 * カタログに Generator を追加しても、既存 seed の選択が全面シャッフルされないことが重要。
 */
function pickByRendezvous(
  seed: string,
  slot: string,
  candidates: InlineGenerator[],
): InlineGenerator {
  if (candidates.length === 0) {
    throw new Error(`pickByRendezvous: no candidates for slot "${slot}"`);
  }
  const weight = (genId: string) => rand(seed, `patch:pick:${slot}`, namespaceToU32(genId));
  return candidates.reduce((best, c) => (weight(c.def.id) > weight(best.def.id) ? c : best));
}

function operatorsByCategory(
  operators: VisualOperator[],
  defCatalog: ReturnType<typeof createCatalog>,
): Record<GeneratorCategory, number[]> {
  const result: Record<GeneratorCategory, number[]> = {
    source: [],
    field: [],
    modifier: [],
    material: [],
  };
  for (let i = 0; i < operators.length; i++) {
    const op = operators[i]!;
    const def = defCatalog.get(op.generatorId);
    if (!def) continue;
    result[def.category].push(i);
  }
  return result;
}

/**
 * Drop one operator to reduce cost while respecting min counts.
 * Prefer fields → extra modifiers (down to 1) → extra sources (down to 1). Keep material.
 */
function stripOneOperator(
  operators: VisualOperator[],
  defCatalog: ReturnType<typeof createCatalog>,
): VisualOperator[] | null {
  const byCat = operatorsByCategory(operators, defCatalog);
  let dropIndex: number | undefined;

  if (byCat.field.length > 0) {
    dropIndex = byCat.field[byCat.field.length - 1];
  } else if (byCat.modifier.length > 1) {
    dropIndex = byCat.modifier[byCat.modifier.length - 1];
  } else if (byCat.source.length > 1) {
    dropIndex = byCat.source[byCat.source.length - 1];
  } else {
    return null;
  }

  return operators.filter((_, i) => i !== dropIndex);
}

function buildOperator(seed: string, opId: string, gen: InlineGenerator): VisualOperator {
  const parameters: Record<string, number | string | boolean> = {};
  for (const param of gen.def.parameters) {
    parameters[param.id] = pickParameter(seed, opId, param);
  }
  return {
    id: opId,
    generatorId: gen.def.id,
    generatorVersion: gen.def.version,
    parameters,
  };
}

function pickOperatorsForCategory(
  seed: string,
  category: GeneratorCategory,
  count: number,
  pool: InlineGenerator[],
  chosenIds: Set<string>,
  idPrefix: string,
  slotPrefix: string,
): VisualOperator[] {
  const ops: VisualOperator[] = [];
  for (let i = 0; i < count; i++) {
    const candidates = pool.filter((g) => !chosenIds.has(g.def.id));
    if (candidates.length === 0) break;
    const gen = pickByRendezvous(seed, `${slotPrefix}${i}`, candidates);
    chosenIds.add(gen.def.id);
    ops.push(buildOperator(seed, `${idPrefix}${i}`, gen));
  }
  if (ops.length === 0 && category !== 'field') {
    // source / modifier / material require at least one when pool is non-empty; empty pool is fatal.
    if (pool.length === 0) {
      throw new Error(`derivePatch: catalog has no "${category}" generators`);
    }
  }
  return ops;
}

function buildPalette(seed: string): VisualPatch['palette'] {
  const modeIdx = randInt(seed, 'patch:palette:mode', 0, 0, PALETTE_MODES.length - 1);
  return {
    mode: PALETTE_MODES[modeIdx]!,
    hueOffset: rand(seed, 'patch:palette:hue', 0) * 360,
    saturation: rand(seed, 'patch:palette:sat', 0) * 100,
    lightness: rand(seed, 'patch:palette:lit', 0) * 100,
  };
}

/**
 * `composition.speed` は Patch 全体の動きの速さで、シーンの MotionClock が
 * `uTime` の進む速さに掛ける（それまでは Patch に入っているだけで誰も見て
 * いなかった）。
 *
 * 上限を 1 で止めてあるのは、実際に効かせるようにした以上、これまで一律
 * 等速だったものより**速くなる Patch を作らない**ため。引きによっては
 * 「BPM と関係なくギュインギュイン動く」のが邪魔、という問題への対処なので、
 * 大半の Patch はこれで今までよりゆっくりになる。
 */
function buildComposition(seed: string): VisualPatch['composition'] {
  return {
    symmetry: randInt(seed, 'patch:comp:symmetry', 0, 1, 8),
    scale: 0.5 + rand(seed, 'patch:comp:scale', 0) * 1.5,
    speed: 0.3 + rand(seed, 'patch:comp:speed', 0) * 0.7,
  };
}

function isValidInBudget(
  patch: VisualPatch,
  defCatalog: ReturnType<typeof createCatalog>,
): boolean {
  if (validatePatch(patch, defCatalog).length > 0) return false;
  const budget = DEFAULT_BUDGETS[patch.qualityTier];
  return fitsBudget(estimateCost(patch, defCatalog), budget).length === 0;
}

interface RouteTargetCandidate {
  key: string;
  opId: string;
  min: number;
  max: number;
}

/**
 * 変調先の候補を集める。{@link SAFE_TARGET_PARAMS} に無いパラメータは、
 * modulatable でも候補にしない（音で画が消えないための第一の関門）。
 */
function collectRouteTargets(
  operators: VisualOperator[],
  defCatalog: ReturnType<typeof createCatalog>,
): RouteTargetCandidate[] {
  const out: RouteTargetCandidate[] = [];
  for (const op of operators) {
    const def = defCatalog.get(op.generatorId);
    if (!def) continue;
    for (const param of def.parameters) {
      if (!param.modulatable) continue;
      if (!SAFE_TARGET_PARAMS.has(param.id)) continue;
      if (param.kind !== 'number' && param.kind !== 'int') continue;
      if (typeof param.min !== 'number' || typeof param.max !== 'number') continue;
      if (!(param.max > param.min)) continue;
      out.push({
        key: `${op.id}.${param.id}`,
        opId: op.id,
        min: param.min,
        max: param.max,
      });
    }
  }
  return out;
}

/** target の paramId 部分。`<opId>.<paramId>` 前提。 */
function paramIdOf(targetKey: string): string {
  return targetKey.slice(targetKey.indexOf('.') + 1);
}

/**
 * Build {@link MIN_ROUTES}–{@link MAX_ROUTES} audio→param routes against final
 * operators. No duplicate targets.
 *
 * Generator 側は 105 個中 8 個しか音の uniform を読まないので、Patch のどの
 * パラメータが音に反応するかは実質ここで決まる（画面全体に効く共通の反応は
 * gl/reactions のリアクション層が担当する）。
 *
 * target は **何に効くか** で重みを付けて引く（{@link TARGET_WEIGHT_BY_PARAM}）。
 * 等確率だと候補数がそのまま出て「拍で大きくなる」ばかりになるため。同じ
 * Operator に集中しないよう、既に route が刺さった Operator は減点する。
 *
 * **不変条件: 音は足す方向にしか効かない。**
 * - target は {@link SAFE_TARGET_PARAMS}（増える = 見える / 動く）だけ
 * - polarity は常に unipolar なので、変調量は必ず 0 以上
 *
 * つまり無音時の見た目が下限で、音が入るほど増える。大音量が続いても画が
 * 消える方向には絶対に振れない（クラブでずっと真っ暗、が起きない）。
 */
function buildRoutes(
  seed: string,
  operators: VisualOperator[],
  defCatalog: ReturnType<typeof createCatalog>,
): ModulationRoute[] {
  const targets = collectRouteTargets(operators, defCatalog);
  if (targets.length === 0) return [];

  const count = Math.min(
    randInt(seed, 'patch:route:count', 0, MIN_ROUTES, MAX_ROUTES),
    targets.length,
  );
  if (count <= 0) return [];

  const remaining = [...targets];
  const routes: ModulationRoute[] = [];
  /** 既に route が刺さった Operator。次の target の重みを下げるのに使う。 */
  const usedOps = new Set<string>();

  for (let i = 0; i < count; i++) {
    const source = pickWeightedByRendezvous(
      seed,
      `patch:route:${i}:source`,
      ROUTE_SOURCES,
      (s) => s.id,
      (s) => s.weight,
    );
    const target = pickWeightedByRendezvous(
      seed,
      `patch:route:${i}:target`,
      remaining,
      (t) => t.key,
      // 候補は SAFE_TARGET_PARAMS 由来なので、weight は必ず引ける（?? は保険）。
      (t) =>
        (TARGET_WEIGHT_BY_PARAM.get(paramIdOf(t.key)) ?? 1) *
        (usedOps.has(t.opId) ? SAME_OPERATOR_PENALTY : 1),
    );
    remaining.splice(remaining.indexOf(target), 1);
    usedOps.add(target.opId);

    const ratioRaw =
      AMOUNT_RATIO_MIN +
      rand(seed, `patch:route:${i}:amount`, 0) * (AMOUNT_RATIO_MAX - AMOUNT_RATIO_MIN);
    // drive を掛けたあとレンジ全体で頭打ちにする。これを超えても、ソースが少し
    // 振れただけでパラメータが max に張り付くだけで、動きは増えない。
    const cap = MOTION_TARGET_PARAMS.has(paramIdOf(target.key)) ? MOTION_RATIO_MAX : 1;
    const ratio = Math.min(cap, ratioRaw * source.drive);
    const amount = (target.max - target.min) * ratio;

    const smoothing = source.pulse
      ? PULSE_SMOOTHING_MIN +
        rand(seed, `patch:route:${i}:smoothing`, 0) * (PULSE_SMOOTHING_MAX - PULSE_SMOOTHING_MIN)
      : Math.min(
          1.6,
          Math.max(
            0.4,
            DEFAULT_SMOOTHING + (rand(seed, `patch:route:${i}:smoothing`, 0) * 2 - 1) * 0.4,
          ),
        );

    routes.push({
      source: source.id,
      target: target.key,
      amount,
      // 常に unipolar。bipolar は無音時に -amount という定数オフセットになり、
      // 「音が無いと薄くなる / 消える」を作ってしまう。
      polarity: 'unipolar',
      smoothing,
    });
  }

  return routes;
}

function withRoutes(patch: VisualPatch, defCatalog: ReturnType<typeof createCatalog>): VisualPatch {
  const routes = buildRoutes(patch.seed, patch.operators, defCatalog);
  const next = { ...patch, routes };
  // Safety: never return routes that invalidate the patch.
  if (validatePatch(next, defCatalog).length > 0) {
    return { ...patch, routes: [] };
  }
  return next;
}

/** seed から決定的に VisualPatch を組み立てる。 */
export function derivePatch(seed: string, opts: DeriveOptions): VisualPatch {
  const qualityTier: QualityTier = opts.qualityTier ?? 'medium';
  const gens = opts.catalog.all();
  // defCatalog は validate / cost 用なので、除外前の全 Generator を載せる。
  // 手で組んだ Patch（stamp 入り）も derive と同じカタログで検証されるべきなので。
  const defCatalog = createCatalog(gens.map((g) => g.def));

  // Generators with a texture input never appear in a derived patch: a picture
  // is something the operator deliberately brings, so the seed gacha must not
  // make the event logo pop in and out on its own. They stay fully available to
  // hand-built patches (proposePatch) — only the rendezvous pools exclude them.
  //
  // Same place, same style: a Generator that blows the tier budget on its own is
  // dropped from the pools too. Otherwise the strip loop can be handed a patch it
  // is structurally unable to shrink (see fitsBudgetAlone).
  const selectable = gens.filter(
    (g) => !needsTexture(g) && fitsBudgetAlone(g, defCatalog, qualityTier),
  );

  const pool: Record<GeneratorCategory, InlineGenerator[]> = {
    source: selectable.filter((g) => g.def.category === 'source'),
    field: selectable.filter((g) => g.def.category === 'field'),
    modifier: selectable.filter((g) => g.def.category === 'modifier'),
    material: selectable.filter((g) => g.def.category === 'material'),
  };

  // Counts within validate.ts limits, capped by available candidates.
  let sourceCount = Math.min(randInt(seed, 'patch:count:source', 0, 1, 2), pool.source.length);
  let fieldCount = Math.min(randInt(seed, 'patch:count:field', 0, 0, 2), pool.field.length);
  let modifierCount = Math.min(
    randInt(seed, 'patch:count:modifier', 0, 1, 3),
    pool.modifier.length,
  );
  const materialCount = Math.min(1, pool.material.length);

  if (sourceCount < 1) {
    throw new Error('derivePatch: need at least 1 source generator in catalog');
  }
  if (modifierCount < 1) {
    throw new Error('derivePatch: need at least 1 modifier generator in catalog');
  }
  if (materialCount < 1) {
    throw new Error('derivePatch: need at least 1 material generator in catalog');
  }

  const chosenIds = new Set<string>();
  // Stage order required by validate: Source → Field → Modifier → Material
  const sources = pickOperatorsForCategory(
    seed,
    'source',
    sourceCount,
    pool.source,
    chosenIds,
    'src',
    'source',
  );
  const fields = pickOperatorsForCategory(
    seed,
    'field',
    fieldCount,
    pool.field,
    chosenIds,
    'fld',
    'field',
  );
  const modifiers = pickOperatorsForCategory(
    seed,
    'modifier',
    modifierCount,
    pool.modifier,
    chosenIds,
    'mod',
    'modifier',
  );
  const materials = pickOperatorsForCategory(
    seed,
    'material',
    materialCount,
    pool.material,
    chosenIds,
    'mat',
    'material',
  );

  let operators: VisualOperator[] = [...sources, ...fields, ...modifiers, ...materials];
  const palette = buildPalette(seed);
  const composition = buildComposition(seed);

  let patch: VisualPatch = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    seed,
    operators,
    routes: [],
    palette,
    composition,
    qualityTier,
  };

  // Prefer full rolled counts; strip fields → extra modifiers → extra sources until in budget.
  // Routes stay empty during strip so validate only checks operators/budget.
  for (let attempt = 0; attempt < MAX_STRIP_ATTEMPTS; attempt++) {
    if (isValidInBudget(patch, defCatalog)) {
      return withRoutes(patch, defCatalog);
    }
    const next = stripOneOperator(patch.operators, defCatalog);
    if (!next) break;
    operators = next;
    patch = { ...patch, operators, routes: [] };
  }

  const validateIssues = validatePatch(patch, defCatalog);
  const budgetIssues = fitsBudget(estimateCost(patch, defCatalog), DEFAULT_BUDGETS[qualityTier]);
  throw new Error(
    `derivePatch: could not produce a valid in-budget patch for seed ${JSON.stringify(seed)} ` +
      `(validate=${validateIssues.length}, budget=${budgetIssues.length})`,
  );
}
