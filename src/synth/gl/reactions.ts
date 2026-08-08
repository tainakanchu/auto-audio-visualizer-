/**
 * オーディオ・リアクション層。
 *
 * これまで「Patch 共通の音への反応」は main() に直書きされた **拡大縮小と明るさ**
 * だけだった。Generator の側は 105 個中 8 個しか音の uniform を読まないので、
 * どの seed を引いても拍で起きることは「ちょっと寄って、ちょっと明るくなる」に
 * 収束していた。単調さの原因はガチャの引きではなく、この共通層が 1 種類しか
 * 無かったこと。
 *
 * ここでは共通層を**カタログ**にする。座標段（`p` を書き換える）と色段（`col` を
 * 書き換える）にそれぞれ数種類ずつ用意し、Patch ごとに座標 1〜2 個 + 色 1 個を
 * 決定的に選ぶ。スライスグリッチ・マクロブロック・RGB ずれ・ネガ反転など、
 * 「拍で何が起きるか」自体が Patch ごとに変わる。
 *
 * 守っている不変条件（README の「音で画が消えることはありません」）:
 *
 * 1. **無音では完全な no-op**。全スニペットが `rPunch = rEnergy = 0` のとき
 *    恒等変換になる（`mix(x, y, 0)` / `* 0.0` / `if (rPunch > ...)`）。音が
 *    止まればリアクション層は消え、Patch は素の見た目に戻る。
 * 2. **持続的に暗くしない**。暗くする方向の効果は拍のエンベロープ (`uPunch`)
 *    にだけ乗せ、音量 (`uEnergy`) では暗くしない。走査線のような効果も
 *    「明るくする」側だけで作る。
 * 3. **プリマルチプライド維持**。色段は `col.rgb <= col.a` を壊さない形しか
 *    使わない（各スニペットのコメントに根拠を書いてある）。OBS の合成が
 *    崩れると縁が光る/黒く抜けるので、ここは見た目の好みではなく契約。
 *
 * 選択は topology（Operator の並び）から決まる。`patch.seed` を混ぜていないのは
 * わざとで、assembler の「同じ topology → 同じ fragSrc」という不変条件を保つため
 * （semanticSynth の `sameTopology` はこれを前提にデッキ上でモーフする）。seed は
 * 実行時に `uSeed` として入るので、同じリアクションでも Patch ごとに乱数パターンは
 * 変わる。
 */
import { namespaceToU32, pickWeightedByRendezvous, rand } from '../rng';
import type { GeneratorDefinition } from '../types';

/** リアクションを差し込む段。 */
export type ReactionStage = 'coord' | 'color';

export interface Reaction {
  id: string;
  stage: ReactionStage;
  /** 重み付きランデブー選択の重み。大きいほど選ばれやすい。 */
  weight: number;
  /**
   * 拍のときだけパイプラインを追加評価する（`synthPipeline` を複数回呼ぶ）。
   * 分岐条件は uniform なのでドローコール内で完全にコヒーレント = 拍以外の
   * フレームはタダだが、拍の瞬間はフィルレートが最大 3 倍になる。
   */
  multiTap?: boolean;
  /** UI / README / デバッグ用の一行説明。 */
  label: string;
  /** main() に差し込む GLSL。`coord` は `p` を、`color` は `col` を書き換える。 */
  glsl: string;
}

/**
 * リアクションが読む駆動値。main() で一度だけ計算して両段から使う。
 *
 * `uBass` などの帯域は生値で、マイクの環境ノイズでも 0 より上に浮く。そのまま
 * 使うと「無音でも反応する」ので、必ず `uEnergy`（ノイズゲート済みの平滑音量）を
 * 掛けてから使う。`uPunch` は scene 側で既にゲート済み。
 *
 * **うねり (`rSwell` / `rSet`) には `uEnergy` を掛けない。** 帯域と違ってこれらは
 * 生値ではなく、有義波高 Hs を通った量で、無音では Hs → 0 とともに構造的に 0 へ
 * 落ちる（swell.ts の不変条件）。つまりゲートは既に効いている。ここで重ねて
 * 掛けると二重ゲートになり、音が入ってから絵が動き出すまでが余計に鈍る —
 * うねりはただでさえ立ち上がりが遅い（GROWTH_TAU = 18 秒）ので、その遅さは
 * 設計どおりの味であって、さらに遅くするものではない。
 */
export const REACTION_DRIVE_GLSL = `  float rPunch = uPunch;
  float rEnergy = uEnergy;
  float rBass = uBass * uEnergy;
  float rMid = uMid * uEnergy;
  float rTreble = uTreble * uEnergy;
  float rSwell = uSwellGroup;
  float rSet = uSwellSet;`;

/** 乱数名前空間の定数名。assembler が Patch ごとの値で宣言する。 */
export const REACTION_NS_CONST = 'kReactNs';

const COORD_REACTIONS: readonly Reaction[] = [
  {
    id: 'punchZoom',
    stage: 'coord',
    weight: 2,
    label: '拍の頭で画面が寄る',
    glsl: `  p *= 1.0 - 0.070 * rPunch;`,
  },
  {
    id: 'sliceShift',
    stage: 'coord',
    weight: 3,
    label: '横帯ごとに水平にずれる（テープが飛ぶようなグリッチ）',
    glsl: `  {
    float rows = 14.0;
    float row = floor(clamp(p.y + 0.5, 0.0, 1.0) * rows);
    float slot = max(floor(uTime * 7.0), 0.0);
    uint i = uint(row) + uint(slot) * 64u;
    // 「ずれる帯を選ぶ乱数」と「ずれる量の乱数」を分ける。1 本で兼ねると
    // 選ばれた帯が必ず同じ向きにずれてしまい、グリッチに見えない。
    float sel = synthRand(uSeed, ${REACTION_NS_CONST}, i);
    float amt = synthRand(uSeed, ${REACTION_NS_CONST}, i + 977u);
    p.x += (amt * 2.0 - 1.0) * 0.24 * step(0.62, sel) * rPunch;
  }`,
  },
  {
    id: 'blockCrush',
    stage: 'coord',
    weight: 3,
    label: '拍でマクロブロックに潰れる',
    glsl: `  {
    float k = smoothstep(0.15, 0.85, rPunch);
    float cells = mix(240.0, 14.0, k);
    p = mix(p, (floor(p * cells) + 0.5) / cells, k);
  }`,
  },
  {
    id: 'jitter',
    stage: 'coord',
    weight: 3,
    label: '拍で画が飛び、高域で細かく震える',
    glsl: `  {
    float slot = max(floor(uTime * 9.0), 0.0);
    uint i = uint(slot);
    float rx = synthRand(uSeed, ${REACTION_NS_CONST}, i * 2u + 11u) * 2.0 - 1.0;
    float ry = synthRand(uSeed, ${REACTION_NS_CONST}, i * 2u + 12u) * 2.0 - 1.0;
    p += vec2(rx, ry) * (0.035 * rPunch + 0.012 * rTreble);
  }`,
  },
  {
    id: 'spinKick',
    stage: 'coord',
    weight: 2,
    label: '拍で回転が蹴られる',
    glsl: `  {
    // rot2 は sdf3d プリリュードにしか無いので、ここでは自前で回す。
    float a = 0.55 * rPunch + 0.18 * rBass;
    float c = cos(a);
    float s = sin(a);
    p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  }`,
  },
  {
    id: 'waveTear',
    stage: 'coord',
    weight: 3,
    label: '走査線が横に裂けて流れる',
    glsl: `  {
    float rows = 80.0;
    float row = floor((p.y + 0.5) * rows) / rows;
    p.x += sin(row * 27.0 + uTime * 3.5) * (0.030 * rPunch + 0.014 * rTreble);
  }`,
  },
  {
    id: 'mirrorSnap',
    stage: 'coord',
    weight: 2,
    label: '拍で鏡像に畳まれる',
    glsl: `  {
    p.x = mix(p.x, abs(p.x), smoothstep(0.20, 0.80, rPunch));
    p.y = mix(p.y, abs(p.y), smoothstep(0.55, 0.95, rPunch));
  }`,
  },
  {
    id: 'swellDrift',
    stage: 'coord',
    weight: 3,
    label: 'うねりが横に流れる（海面が寄せては返す）',
    glsl: `  {
    // 波群の包絡線でゆっくり横に流れる。拍で弾けるものと違い、効きも戻りも
    // 数秒〜十数秒かける（rSwell が持つ波群の周期がそのまま出る）。
    // 空間周波数を低く・時間周波数を遅く取ってあるので、waveTear のような
    // 走査線グリッチではなく「うねっている」に見える。
    float a = 0.055 * rSwell;
    p.x += a * sin(p.y * 3.7 + uTime * 0.45);
    p.y += a * 0.6 * sin(p.x * 2.9 - uTime * 0.31);
  }`,
  },
  {
    id: 'setSurge',
    stage: 'coord',
    weight: 2,
    label: 'セット（長周期のうねり）でゆっくり寄って持ち上がる',
    glsl: `  {
    // 寄る方向にしか振らない。p を広げる（= ズームアウトする）と overlay の
    // 外周にソースの無い余白ができて、合成先が透けてしまう。
    p *= 1.0 - 0.085 * rSet;
    p.y -= 0.020 * rSet;
  }`,
  },
];

const COLOR_REACTIONS: readonly Reaction[] = [
  {
    id: 'rgbSplit',
    stage: 'color',
    weight: 3,
    multiTap: true,
    label: '拍で R/B が横にずれる（色収差グリッチ）',
    glsl: `  if (rPunch > 0.02) {
    vec2 off = vec2(0.030, 0.010) * rPunch;
    vec4 cr = synthPipeline(p + off);
    vec4 cb = synthPipeline(p - off);
    // alpha を 3 タップの max に上げてから各チャンネルを取る。どのタップでも
    // rgb <= 自分の a なので、max を取った a に対しても rgb <= a が保たれる。
    float a = max(col.a, max(cr.a, cb.a));
    col = vec4(cr.r, col.g, cb.b, a);
  }`,
  },
  {
    id: 'echoGhost',
    stage: 'color',
    weight: 2,
    multiTap: true,
    label: '拍で少し縮んだ残像が背後に重なる',
    glsl: `  if (rPunch > 0.02) {
    float k = 0.55 * rPunch;
    vec4 gh = synthPipeline(p * (1.0 - 0.12 * rPunch));
    // プリマルチプライドの「下に敷く」合成 (under)。結果の rgb / a はどちらも
    // col + gh*k*(1-col.a) なので rgb <= a と a <= 1 が同時に保たれる。
    col += gh * k * (1.0 - col.a);
  }`,
  },
  {
    id: 'hueSlam',
    stage: 'color',
    weight: 3,
    label: '拍で色相が飛ぶ',
    glsl: `  {
    // YIQ 系の色相回転行列。線形変換なのでプリマルチプライドのまま掛けてよく、
    // a = 0（回転なし）で恒等になる。結果は col.a で頭打ちにして rgb <= a を守る。
    float a = 2.4 * rPunch + 0.7 * rMid;
    float c = cos(a);
    float s = sin(a);
    vec3 m0 = vec3(0.299 + 0.701 * c + 0.168 * s, 0.587 - 0.587 * c + 0.330 * s, 0.114 - 0.114 * c - 0.497 * s);
    vec3 m1 = vec3(0.299 - 0.299 * c - 0.328 * s, 0.587 + 0.413 * c + 0.035 * s, 0.114 - 0.114 * c + 0.292 * s);
    vec3 m2 = vec3(0.299 - 0.300 * c + 1.250 * s, 0.587 - 0.588 * c - 1.050 * s, 0.114 + 0.886 * c - 0.203 * s);
    col.rgb = clamp(vec3(dot(col.rgb, m0), dot(col.rgb, m1), dot(col.rgb, m2)), 0.0, col.a);
  }`,
  },
  {
    id: 'posterCrush',
    stage: 'color',
    weight: 3,
    label: '拍で階調が段々に潰れる（ビットクラッシュ）',
    glsl: `  {
    float k = smoothstep(0.20, 0.90, rPunch);
    float steps = mix(48.0, 3.0, k);
    // 量子化はストレートな色に対して行う。プリマルチプライドのまま刻むと
    // 暗い縁だけ段が細かくなって輪郭が汚れる。
    float a = max(col.a, 1e-4);
    vec3 straight = clamp(col.rgb / a, 0.0, 1.0);
    col.rgb = mix(col.rgb, floor(straight * steps + 0.5) / steps * a, k);
  }`,
  },
  {
    id: 'invertFlash',
    stage: 'color',
    weight: 2,
    label: '強い拍だけ一瞬ネガになる',
    glsl: `  {
    // 0 <= rgb <= a なので a - rgb も同じ範囲に収まる = プリマルチプライド維持。
    // 強い拍だけに絞ってあるので、暗転が持続することはない。
    col.rgb = mix(col.rgb, col.a - col.rgb, smoothstep(0.55, 0.95, rPunch));
  }`,
  },
  {
    id: 'scanGlow',
    stage: 'color',
    weight: 2,
    label: '走査バンドが流れ、拍で光る',
    glsl: `  {
    // 明るくする側だけで走査線を作る。暗くする側を混ぜると音量に応じた
    // 持続的な減光になり、「音で画が消えない」の不変条件を崩す。
    float band = 0.5 + 0.5 * sin((p.y + 0.5) * 90.0 - uTime * 5.0);
    float k = 0.20 * rEnergy + 0.55 * rPunch;
    col = min(col * (1.0 + k * band), vec4(1.0));
  }`,
  },
  {
    id: 'channelRoll',
    stage: 'color',
    weight: 2,
    label: '強い拍で RGB が入れ替わる',
    glsl: `  {
    // 成分の入れ替えと補間だけなので、どの成分も max(rgb) <= a を超えない。
    col.rgb = mix(col.rgb, col.gbr, smoothstep(0.50, 0.85, rPunch));
  }`,
  },
  {
    id: 'crestGlow',
    stage: 'color',
    weight: 3,
    label: 'うねりの峰がゆっくり通り抜けて明るむ',
    glsl: `  {
    // 太くて遅い帯が縦にゆっくり流れる。scanGlow（90 本 / uTime*5.0）と違って
    // 2.6 本 / uTime*0.5 なので、走査線ではなく「うねりの峰」に見える。
    //
    // 明るくする側だけ。暗くする側を混ぜると音量に応じた持続的な減光になり、
    // 「音で画が消えない」の不変条件を崩す（rSwell/rSet は拍ではなく音量側の
    // 量なので、暗転に使ってよい rPunch とは扱いが違う）。
    //
    // プリマルチプライド維持: rgb と a に同じ係数を掛けてから、同じ上限 1.0 で
    // 各成分を切る。min は単調なので rgb <= a は切ったあとも保たれる（scanGlow
    // と同じ論法）。
    float crest = 0.5 + 0.5 * sin((p.y + 0.5) * 2.6 - uTime * 0.5);
    float k = (0.34 * rSwell + 0.20 * rSet) * crest;
    col = min(col * (1.0 + k), vec4(1.0));
  }`,
  },
];

/** 全リアクション（座標段 → 色段の順）。 */
export const ALL_REACTIONS: readonly Reaction[] = [...COORD_REACTIONS, ...COLOR_REACTIONS];

const BY_ID = new Map(ALL_REACTIONS.map((r) => [r.id, r]));

/** 2 個目の座標リアクションが載る確率。 */
const SECOND_COORD_CHANCE = 0.3;

/**
 * `costClass` の重み。`cost.ts` の COST_WEIGHT と同じ意味だが、あちらは
 * qualityTier の解像度スケールまで込みの「予算」用。ここが欲しいのは
 * 「このパイプラインをもう 2 回踏んでよいか」だけなので生の値を使う。
 */
const FILL_WEIGHT: Record<GeneratorDefinition['costClass'], number> = {
  micro: 1,
  light: 3,
  medium: 10,
  heavy: 30,
};

/**
 * multiTap リアクションを許す生フィル負荷の上限。
 *
 * 導出パッチの生フィル負荷は p50≈8.6 / p75≈13.5 なので、12 はおよそ 3 分の 2 の
 * Patch が通る線。拍の瞬間だけとはいえフィルレートが 3 倍になるため、元から
 * 重い Patch（heavy 入り・厚いスタック）には載せない。
 */
export const MULTITAP_MAX_FILL = 12;

/** Operator 定義の並びから、解像度スケールを掛けない生のフィル負荷を出す。 */
export function rawFillCost(defs: Iterable<GeneratorDefinition>): number {
  let total = 0;
  for (const def of defs) total += FILL_WEIGHT[def.costClass] * def.cost.relativeFill;
  return total;
}

/** その Operator 構成で、パイプラインの追加評価を許してよいか。 */
export function allowsMultiTap(defs: readonly GeneratorDefinition[]): boolean {
  if (defs.some((d) => d.costClass === 'heavy')) return false;
  return rawFillCost(defs) <= MULTITAP_MAX_FILL;
}

/**
 * Operator の並びから、リアクション選択用の安定なキーを作る。
 *
 * `sameTopology`（transition.ts）が同じと判定する 2 つの Patch は、必ず同じキーに
 * なること。ここが食い違うと「同じデッキ上でモーフしているのにシェーダだけ
 * 別物」という状態が作れてしまう。
 */
export function topologyKey(
  operators: readonly { id: string; generatorId: string; generatorVersion: number }[],
): string {
  return operators.map((o) => `${o.id}:${o.generatorId}@${o.generatorVersion}`).join('|');
}

/** 選ばれたリアクション。座標段 1〜2 個 + 色段 1 個。 */
export interface ReactionSelection {
  coord: Reaction[];
  color: Reaction[];
}

/**
 * topology キーからリアクションを決定的に選ぶ。
 *
 * 座標段と色段から必ず 1 個ずつ選ぶので、どの Patch も「形の反応」と「色の反応」を
 * 両方持つ。座標段はさらに {@link SECOND_COORD_CHANCE} の確率で 2 個目が載り、
 * グリッチが重なる引きが出る。
 */
export function selectReactions(key: string, opts: { allowMultiTap: boolean }): ReactionSelection {
  const colorPool = opts.allowMultiTap
    ? COLOR_REACTIONS
    : COLOR_REACTIONS.filter((r) => !r.multiTap);

  const coord0 = pickWeightedByRendezvous(
    key,
    'react:coord:0',
    COORD_REACTIONS,
    (r) => r.id,
    (r) => r.weight,
  );
  const color0 = pickWeightedByRendezvous(
    key,
    'react:color:0',
    colorPool,
    (r) => r.id,
    (r) => r.weight,
  );

  const coord: Reaction[] = [coord0];
  if (rand(key, 'react:coord:extra', 0) < SECOND_COORD_CHANCE) {
    const rest = COORD_REACTIONS.filter((r) => r.id !== coord0.id);
    coord.push(
      pickWeightedByRendezvous(
        key,
        'react:coord:1',
        rest,
        (r) => r.id,
        (r) => r.weight,
      ),
    );
  }

  return { coord, color: [color0] };
}

/** id の並びを Reaction に解決する。未知の id は黙って捨てずに throw する。 */
export function reactionsByIds(ids: readonly string[]): ReactionSelection {
  const coord: Reaction[] = [];
  const color: Reaction[] = [];
  for (const id of ids) {
    const r = BY_ID.get(id);
    if (!r) {
      throw new Error(
        `unknown audio reaction "${id}" (known: ${ALL_REACTIONS.map((x) => x.id).join(', ')})`,
      );
    }
    (r.stage === 'coord' ? coord : color).push(r);
  }
  return { coord, color };
}

/** 選択に使う乱数名前空間の u32。GLSL には定数として埋め込まれる。 */
export function reactionNamespace(key: string): number {
  return namespaceToU32(`react:${key}`);
}
