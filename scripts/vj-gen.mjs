#!/usr/bin/env node
/**
 * vj-gen — 気分語（"雲 静寂 青" のような日本語/英語トークン列）から、決定的な
 * VisualPatch を合成する CLI。
 *
 * 手書きプリセットは無い。vj-vocab.json（語 → タグ制約 + 数値ヒント）を引き、
 * 101 個の Generator カタログに対してタグ重み付き決定的サンプリング
 * （Efraimidis–Spirakis 重み付き非復元抽出）を行って operators/palette/
 * composition/routes を組み立てる。RNG は src/synth/rng.ts の rand(seed,ns,index)
 * を移植したものだけを使う（Math.random() は禁止）。
 *
 * vj-tweak.mjs 同様、WebSocket 通信は一切自前で行わない。状態取得（state）・
 * カタログ取得（catalog）・送信（patch）はすべて vj-ctl.mjs を子プロセストして
 * 呼び出す。
 *
 * 出力の約束（vj-tweak.mjs に倣う）:
 *   - --help              → USAGE を stdout、exit 0（通信なし）
 *   - ローカル検証 NG     → {ok:false, issues:[...]} を stdout、各 issue を stderr にも
 *                           箇条書き、exit 1、送信はしない
 *   - --count <n>         → 候補配列を stdout（JSON）、exit 0/1、送信は絶対にしない
 *   - --dry-run           → 検証を通った patch を stdout（整形 JSON）、送信しない
 *   - 送信                → vj-ctl.mjs patch の stdout/stderr をそのまま素通し、
 *                           exit code もそれに合わせる
 * stdout は常に「送る／送らない patch そのもの」だけに使う。語の解決結果・
 * 警告・実効 seed などの付帯情報はすべて stderr に出す
 * （同じ mood + 同じ --seed なら stdout はバイト単位で同一になる必要があるため）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** vj-ctl.mjs の実体。同じ scripts/ ディレクトリに並ぶ前提で相対解決する。env で上書き可能。 */
const VJ_CTL_PATH = process.env.VJ_CTL_PATH ?? `${import.meta.dirname}/vj-ctl.mjs`;

/**
 * catalog キャッシュはスクリプト自身と同じディレクトリに置く。
 * vj-tweak.mjs と同じファイルを共有する（同じディレクトリに両スクリプトが
 * 置かれる前提。片方が更新したキャッシュをもう片方もそのまま使える）。
 */
const CATALOG_CACHE_PATH = `${import.meta.dirname}/.vj-catalog-cache.json`;

/** 気分語の語彙。ユーザーが後で手編集して語を増やしていく前提の、素の { 語: entry } マップ。 */
const VOCAB_PATH = `${import.meta.dirname}/vj-vocab.json`;

// ---------------------------------------------------------------------------
// RNG — src/synth/rng.ts からの移植（bit-exact に保つため、アルゴリズムは変更しない）
// ---------------------------------------------------------------------------
//
// 名前付き乱数ストリーム。同じ (seed, namespace, index) から常に同じ 0..1 を返す
// 決定的ハッシュ。呼び出し順に依存しない。
//   - 32bit 整数ハッシュ: lowbias32 (Chris Wellons)
//   - 文字列 → u32: FNV-1a 32bit
//   - 合成: hashCombine(a, b) = hashU32(a ^ hashU32(b))
//   - 0..1 変換: 上位 24bit のみ使用（float32/float64 双方で正確に表現できる幅）

/** lowbias32 — 32bit 整数ハッシュ (Chris Wellons)。 */
function hashU32(x) {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** FNV-1a 32bit — 文字列を u32 に落とす。 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** hashCombine(a, b) = hashU32(a ^ hashU32(b)) */
function hashCombine(a, b) {
  return hashU32((a >>> 0) ^ hashU32(b >>> 0));
}

/** ハッシュ値を [0, 1) に写す（上位 24bit のみ使用）。 */
function rand01(h) {
  return (h >>> 8) / 16777216;
}

const namespaceCache = new Map();

/** 文字列 seed を u32 に落とす。 */
function seedToU32(seed) {
  return fnv1a32(seed);
}

/** 名前空間文字列を u32 に落とす（結果はキャッシュしてよい）。 */
function namespaceToU32(namespace) {
  let v = namespaceCache.get(namespace);
  if (v === undefined) {
    v = fnv1a32(namespace);
    namespaceCache.set(namespace, v);
  }
  return v;
}

/** 決定的な 0..1。(seed, namespace, index) だけで決まる。 */
function rand(seed, namespace, index) {
  const seedU = seedToU32(seed);
  const nsU = namespaceToU32(namespace);
  const h = hashCombine(hashCombine(seedU, nsU), index >>> 0);
  return rand01(h);
}

// ---------------------------------------------------------------------------
// 由来: src/synth/validate.ts / schema.ts / derive.ts の定数をそのまま複製したもの
// （CLI は .ts を import できないため）。サーバ側のゲートと食い違えると
// 「ローカルは通ったのにサーバで弾かれる」が起きるので、値は必ず一致させること。
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION = 1; // src/synth/schema.ts

export const PALETTE_MODES = ['mono', 'analogous', 'complementary', 'triadic', 'rainbow'];

export const CATEGORY_RANK = { source: 0, field: 1, modifier: 2, material: 3 };

export const COUNT_LIMITS = {
  source: { min: 1, max: 2 },
  field: { min: 0, max: 2 },
  modifier: { min: 1, max: 3 },
  material: { min: 1, max: 1 },
};

/**
 * 由来: src/synth/derive.ts の ROUTE_SOURCES。生成時の route source 候補プールは
 * これだけを使う。
 *
 * `audio:beatPhase` / `audio:barPhase` は**入っていない**。あれはテンポグリッド
 * 上の位置を返すノコギリ波で、音量に関係なく（無音でも）回り続けるため、
 * 変調に使っても「音に反応している」感には一切ならない。同じ理由で拍系は
 * `audio:gridPulse` / `audio:barPulse` ではなく `audio:beatIntensity` を使う —
 * gridPulse/barPulse はブレイク中もフリーホイールするので無音でも脈打つ。
 */
export const ROUTE_SOURCES = [
  'audio:bass',
  'audio:mid',
  'audio:treble',
  'audio:level',
  'audio:beatIntensity',
];

/** 由来: src/synth/validate.ts の AUDIO_SOURCES。検証だけはこちらの広い集合を使う。 */
export const AUDIO_SOURCES = new Set([
  'audio:bass',
  'audio:mid',
  'audio:treble',
  'audio:level',
  'audio:beat',
  'audio:beatIntensity',
  'audio:gridPulse',
  'audio:barPulse',
  'audio:barPhase',
  'audio:beatPhase',
]);

/**
 * 由来: src/synth/derive.ts の TARGET_KINDS / SAFE_TARGET_PARAMS / TARGET_WEIGHT_BY_PARAM。
 * 変調してよいパラメータ名の許可リストを「何に効くか」で分類したもの。拒否リスト
 * ではなく許可リストなのは、「音に反応して画が消える」ことを構造的に禁止するため。
 * threshold / gate / dropout のように上げると絵が消えるパラメータがカタログ全体に
 * 散らばっていて、名前で危険なものを数え上げるやり方だと必ず取りこぼす。ここに
 * 載るのは「増える = 見える / 動く」方向のパラメータだけ。weight は候補が少ない
 * 種類ほど重くして、大きさ系ばかりに選択が偏らないようにするためのもの。
 */
const TARGET_KINDS = {
  size: { weight: 1, params: ['scale', 'size', 'thickness', 'radius', 'width', 'depth', 'zoom'] },
  density: { weight: 2, params: ['amount', 'density', 'count'] },
  light: {
    weight: 2,
    params: ['intensity', 'strength', 'glow', 'brightness', 'sparkle', 'sheen'],
  },
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
  warp: { weight: 3, params: ['warp', 'shift'] },
};

/** 変調してよい paramId。derive.ts の SAFE_TARGET_PARAMS 相当。 */
export const SAFE_TARGET_PARAMS = new Set(Object.values(TARGET_KINDS).flatMap((k) => k.params));

/** paramId → 選ばれやすさ。derive.ts の TARGET_WEIGHT_BY_PARAM 相当。 */
const TARGET_WEIGHT_BY_PARAM = new Map(
  Object.values(TARGET_KINDS).flatMap((k) => k.params.map((id) => [id, k.weight])),
);

/**
 * 由来: src/synth/derive.ts の MOTION_TARGET_PARAMS / MOTION_RATIO_MAX。動きの速さ
 * そのものを持つパラメータは変調の振り幅を別に絞る。ここを他と同じ幅で振ると、
 * 大音量のときだけ「BPM と関係なくギュインギュイン動く」になる。音で速くなる
 * こと自体は反応として欲しいので、上限で抑える。
 */
export const MOTION_TARGET_PARAMS = new Set(['speed', 'rate', 'spin', 'twist', 'drift', 'flow']);
export const MOTION_RATIO_MAX = 0.3;

const TAG_AXES = ['affect', 'motion', 'material', 'environment', 'culturalTexture'];

const USAGE = `使い方: node vj-gen.mjs [--url <ws(s)://…>] "<mood words>" [options]
       node vj-gen.mjs --help

<mood words>（例: "雲 静寂 青"）を vj-vocab.json（${VOCAB_PATH}）で解決し、
タグ制約 + 重み付き決定的サンプリングで 101 個の Generator カタログから
VisualPatch を合成する。手書きプリセットは無い — 同じ小さな語彙から
無限のバリエーションが生まれる。

オプション:
  --url <ws(s)://…>    接続先（省略時は環境変数 VJ_URL を使う）
  --seed <s>            RNG の実効 seed を上書き（省略時は語から決定的に導出）
  --count <n>            n 個の独立した候補を生成して配列で出す（送信はしない）
  --dry-run              検証だけ行い、通れば patch を stdout に出して送信しない
  --base                 今アクティブな Patch をベースに、タグの合わない
                         operator だけを差し替える（palette/composition は不変）
  --refresh-catalog      catalog キャッシュ（${CATALOG_CACHE_PATH}）を無視して取り直す
  --help                 このヘルプ

例:
  node vj-gen.mjs --url wss://example.workers.dev/room/xxxx --dry-run "雲 静寂 青"
  node vj-gen.mjs --url wss://example.workers.dev/room/xxxx --count 3 "攻めた 派手"
  node vj-gen.mjs --url wss://example.workers.dev/room/xxxx --base --dry-run "夜 青"`;

/** 引数の誤り。main が USAGE を出して exit 1 にする。 */
class UsageError extends Error {}

// process.exit は書き込み途中の stdout を切り落とすことがあるので使わない。
// 例外で main の catch まで戻し、exitCode を立てて自然に終了させる。
function usageError(message) {
  throw new UsageError(message);
}

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(['help', 'dry-run', 'base', 'refresh-catalog']);
const KNOWN_FLAGS = new Set(['help', 'dry-run', 'base', 'refresh-catalog', 'url', 'seed', 'count']);

/**
 * `--flag value` / 真偽フラグ / 位置引数を解釈する。mood トークンは `--` では
 * 始まらない前提なので、フラグ扱いするのは `--` 始まりだけ（vj-ctl.mjs / vj-tweak.mjs
 * と同じ判定）。
 */
function parseArgv(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!KNOWN_FLAGS.has(name)) usageError(`不明なフラグ: --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      usageError(`--${name} には値が必要です`);
    }
    flags.set(name, value);
    i++;
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// vj-ctl.mjs 呼び出し + catalog キャッシュ（vj-tweak.mjs と同一パターン）
// ---------------------------------------------------------------------------

/** vj-ctl.mjs を子プロセスとして叩き、stdout/stderr/status をキャプチャする。ネットワーク I/O はここだけ。 */
function runVjCtl(url, command, extraArgs = []) {
  return spawnSync(process.execPath, [VJ_CTL_PATH, '--url', url, command, ...extraArgs], {
    encoding: 'utf8',
  });
}

/** vj-ctl.mjs 側の失敗（接続エラー・ok:false 等）をそのまま伝播する。独自の例外に潰さない。 */
function propagateFailure(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}

/** 整形 JSON を stdout に出す。vj-ctl.mjs の jsonOut に倣った命名。 */
function jsonOut(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * catalog を読む。--refresh-catalog が無ければまずキャッシュファイルを試し、
 * 壊れている/無い場合や --refresh-catalog 指定時だけ vj-ctl.mjs を叩き直す。
 * --dry-run でも catalog（パラメータ定義・タグ・modulatable フラグ）は必要なので、
 * ネットワークを叩かないためにもキャッシュ優先が重要。
 */
function loadCatalog(url, refreshCache) {
  if (!refreshCache) {
    try {
      const parsed = JSON.parse(readFileSync(CATALOG_CACHE_PATH, 'utf8'));
      if (Array.isArray(parsed)) return { ok: true, catalog: parsed };
    } catch {
      // キャッシュ未作成 or 壊れている → 下で取り直す
    }
  }

  const result = runVjCtl(url, 'catalog');
  if (result.status !== 0) return { ok: false, result };

  let catalog;
  try {
    catalog = JSON.parse(result.stdout);
  } catch (e) {
    return { ok: false, parseError: e };
  }

  try {
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify(catalog));
  } catch (e) {
    process.stderr.write(
      `vj-gen: catalog キャッシュの書き込みに失敗しました（続行には影響しません）: ${e.message}\n`,
    );
  }
  return { ok: true, catalog };
}

// ---------------------------------------------------------------------------
// 小さなユーティリティ
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 画像入力を要求する Generator か。derive.ts の needsTexture と同じ判断。候補から外す。 */
function needsTexture(gen) {
  return (gen.textures?.length ?? 0) > 0;
}

/** カタログ配列（フラットな GeneratorDefinition[]）を category ごと、テクスチャ Generator 抜きで分ける。 */
function buildPool(catalogArray) {
  const selectable = catalogArray.filter((g) => !needsTexture(g));
  return {
    source: selectable.filter((g) => g.category === 'source'),
    field: selectable.filter((g) => g.category === 'field'),
    modifier: selectable.filter((g) => g.category === 'modifier'),
    material: selectable.filter((g) => g.category === 'material'),
  };
}

/** Inclusive integer in [min, max]. derive.ts の randInt と同じ、off-by-one を避ける形。 */
function randInt(seed, ns, index, min, max) {
  if (max <= min) return min;
  const r = rand(seed, ns, index);
  return Math.min(max, min + Math.floor(r * (max - min + 1)));
}

/**
 * `entries` の中で `path`（例: ['composition','speed']）を定義しているものだけを
 * 平均する（後勝ちではなく平均 — 語の順番やエイリアスの選び方で結果が変わらない
 * ようにするため）。誰も定義していなければ undefined を返す（呼び出し側で
 * seed 由来の既定値にフォールバックする）。
 */
function mergedMean(entries, path) {
  const vals = [];
  for (const entry of entries) {
    let v = entry;
    for (const key of path) {
      if (v == null) {
        v = undefined;
        break;
      }
      v = v[key];
    }
    if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return undefined;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ---------------------------------------------------------------------------
// vj-vocab.json による語の解決
// ---------------------------------------------------------------------------

/**
 * 生トークン列を vj-vocab.json のキーへ解決する。完全一致 → aliases のケース
 * フォールド一致（日本語は大文字/小文字の区別が無いのでケースフォールドしても
 * 安全 = 英語/ローマ字とまとめて同じロジックで扱える）の順で試す。
 * 見つからなければ unknownTokens に積む（例外は投げない）。
 */
function resolveTokens(tokens, vocab) {
  const canonicalWords = [];
  const unknownTokens = [];
  for (const token of tokens) {
    if (Object.prototype.hasOwnProperty.call(vocab, token)) {
      canonicalWords.push(token);
      continue;
    }
    let found;
    for (const [word, entry] of Object.entries(vocab)) {
      const aliases = entry.aliases ?? [];
      if (aliases.some((a) => a.toLowerCase() === token.toLowerCase())) {
        found = word;
        break;
      }
    }
    if (found) {
      canonicalWords.push(found);
    } else {
      unknownTokens.push(token);
    }
  }
  return { canonicalWords, unknownTokens };
}

/**
 * seed 未指定時の基底 seed。canonical word をソートしてから join することで、
 * 入力語順やどのエイリアスで打ったかに依存せず「同じ mood → 同じ絵」になる。
 */
function computeBaseSeed(canonicalWords) {
  const sorted = [...new Set(canonicalWords)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `mood:${sorted.join('-')}`;
}

/** matched な vocab entry 群からタグ集合（軸ごとの Set）と数値ヒントの平均値を作る。 */
function buildMoodContext(matched) {
  const moodTagSets = {};
  for (const axis of TAG_AXES) {
    const set = new Set();
    for (const entry of matched) {
      for (const v of entry.tags?.[axis] ?? []) set.add(v);
    }
    moodTagSets[axis] = set;
  }

  const rawEnergyMean = mergedMean(matched, ['energy']);
  const energy = clamp(rawEnergyMean ?? 0.4, 0, 1);

  const moodMeans = {
    composition: {
      symmetry: mergedMean(matched, ['composition', 'symmetry']),
      scale: mergedMean(matched, ['composition', 'scale']),
      speed: mergedMean(matched, ['composition', 'speed']),
    },
    palette: {
      hueOffset: mergedMean(matched, ['palette', 'hueOffset']),
      saturation: mergedMean(matched, ['palette', 'saturation']),
      lightness: mergedMean(matched, ['palette', 'lightness']),
    },
  };

  return { moodTagSets, moodMeans, energy };
}

// ---------------------------------------------------------------------------
// タグスコアリング
// ---------------------------------------------------------------------------

function tagScore(genTags, moodTagSets) {
  let score = 0;
  let matchedAxes = 0;
  for (const axis of TAG_AXES) {
    const moodVals = moodTagSets[axis];
    if (!moodVals || moodVals.size === 0) continue;
    const genVals = genTags?.[axis] ?? [];
    let overlap = 0;
    for (const v of genVals) if (moodVals.has(v)) overlap++;
    if (overlap > 0) {
      score += overlap;
      matchedAxes++;
    }
  }
  if (matchedAxes > 1) score += (matchedAxes - 1) * 0.5; // cross-axis bonus
  return score;
}

/** floor keeps diversity even at score 0 — 0 点の Generator も僅かながら選ばれ得る。 */
function tagWeight(score) {
  return 0.05 + score;
}

// ---------------------------------------------------------------------------
// 重み付き非復元抽出 (Efraimidis–Spirakis) — derive.ts の pickByRendezvous（等重み
// rendezvous ハッシュ）を「重み付き・複数選択」に一般化したもの。
//
// candidate の *id 文字列そのもの* を RNG の index にハッシュして使う（配列上の
// 位置は絶対に使わない）ことで、vj-vocab.json / catalog.json が後から増えても、
// 既存の (seed, mood) の組の選択結果がほとんど変わらない、という rendezvous
// ハッシュの性質を保つ。
// ---------------------------------------------------------------------------

/** candidate から id 文字列を取り出す。文字列そのもの / {id} / {key} のいずれにも対応。 */
function idOf(c) {
  if (typeof c === 'string') return c;
  if (c && typeof c.id === 'string') return c.id;
  if (c && typeof c.key === 'string') return c.key;
  throw new Error('weightedPickWithoutReplacement: cannot determine id for candidate');
}

function weightedPickWithoutReplacement(seed, ns, candidates, weightFn, n) {
  const keyed = candidates.map((c) => {
    const w = Math.max(1e-6, weightFn(c));
    const u = rand(seed, ns, namespaceToU32(idOf(c)));
    return { c, key: Math.pow(u, 1 / w) };
  });
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, Math.max(0, n)).map((k) => k.c);
}

// ---------------------------------------------------------------------------
// パラメータ値の選択（energy バイアス付き）
// ---------------------------------------------------------------------------

const ENERGY_BIAS_RE = /speed|rate|amount|strength|flicker|intensity/i;

/** energy 0→p=4（低い方に偏る）、0.5→p=1（一様）、1→p=0.25（高い方に偏る）。 */
function biasedT(t, energy) {
  const e = typeof energy === 'number' ? energy : 0.4;
  const p = Math.pow(2, (0.5 - e) * 4);
  return Math.pow(t, p);
}

function pickParameter(seed, opId, param, energy) {
  const ns = `gen:param:${opId}:${param.id}`;
  const biasEligible = ENERGY_BIAS_RE.test(param.id);
  switch (param.kind) {
    case 'number': {
      const min = param.min ?? 0;
      const max = param.max ?? 1;
      let t = rand(seed, ns, 0);
      if (biasEligible) t = biasedT(t, energy);
      return min + t * (max - min);
    }
    case 'int': {
      const min = param.min ?? 0;
      const max = param.max ?? min;
      if (max <= min) return min;
      let t = rand(seed, ns, 0);
      if (biasEligible) t = biasedT(t, energy);
      return Math.min(max, min + Math.floor(t * (max - min + 1)));
    }
    case 'bool':
      return rand(seed, ns, 0) < 0.5;
    case 'enum': {
      const options = param.options ?? [];
      if (options.length === 0) return param.default;
      const idx = Math.min(options.length - 1, Math.floor(rand(seed, ns, 0) * options.length));
      return options[idx];
    }
    default:
      throw new Error(`pickParameter: unknown kind "${param.kind}"`);
  }
}

function buildOperator(seed, opId, gen, energy) {
  const parameters = {};
  for (const param of gen.parameters) {
    parameters[param.id] = pickParameter(seed, opId, param, energy);
  }
  return {
    id: opId,
    generatorId: gen.id,
    generatorVersion: gen.version,
    parameters,
  };
}

// ---------------------------------------------------------------------------
// palette / composition
// ---------------------------------------------------------------------------

function paletteModeWeights(saturation, energy) {
  if (saturation < 35)
    return { mono: 3, analogous: 2, complementary: 1, triadic: 0.5, rainbow: 0.2 };
  if (saturation > 60 || energy > 0.7) {
    return { mono: 0.3, analogous: 1, complementary: 1.5, triadic: 2, rainbow: 2 };
  }
  return { mono: 1, analogous: 1, complementary: 1, triadic: 1, rainbow: 1 };
}

function buildPalette(seed, moodMeans, energy) {
  const hueOffset = moodMeans.palette.hueOffset ?? rand(seed, 'gen:palette:hue', 0) * 360;
  const saturation =
    moodMeans.palette.saturation ??
    clamp(30 + (rand(seed, 'gen:palette:sat', 0) - 0.5) * 16, 0, 100);
  const lightness =
    moodMeans.palette.lightness ??
    clamp(50 + (rand(seed, 'gen:palette:lit', 0) - 0.5) * 40, 0, 100);

  const weights = paletteModeWeights(saturation, energy);
  const mode = weightedPickWithoutReplacement(
    seed,
    'gen:palette:mode',
    PALETTE_MODES,
    (m) => weights[m],
    1,
  )[0];

  return { mode, hueOffset, saturation, lightness };
}

function buildComposition(seed, moodMeans, energy) {
  const symmetry =
    moodMeans.composition.symmetry !== undefined
      ? Math.max(1, Math.round(moodMeans.composition.symmetry))
      : randInt(seed, 'gen:comp:symmetry', 0, 1, 8);
  const scale = moodMeans.composition.scale ?? 0.5 + rand(seed, 'gen:comp:scale', 0) * 1.5;
  const speed =
    moodMeans.composition.speed !== undefined ? moodMeans.composition.speed : 0.06 + energy * 0.4;
  return { symmetry, scale, speed };
}

// ---------------------------------------------------------------------------
// routes — derive.ts の collectRouteTargets を踏襲
// ---------------------------------------------------------------------------

/** target の paramId 部分。`<opId>.<paramId>` 前提。由来: src/synth/derive.ts の paramIdOf。 */
function paramIdOf(targetKey) {
  return targetKey.slice(targetKey.indexOf('.') + 1);
}

/**
 * 変調先の候補を集める。SAFE_TARGET_PARAMS に無いパラメータは、modulatable でも
 * 候補にしない（音で画が消えないための第一の関門）。由来: src/synth/derive.ts の
 * collectRouteTargets。
 */
function collectRouteTargets(operators, catalogMap) {
  const out = [];
  for (const op of operators) {
    const def = catalogMap.get(op.generatorId);
    if (!def) continue;
    for (const param of def.parameters) {
      if (!param.modulatable) continue;
      if (!SAFE_TARGET_PARAMS.has(param.id)) continue;
      if (param.kind !== 'number' && param.kind !== 'int') continue;
      if (typeof param.min !== 'number' || typeof param.max !== 'number') continue;
      if (!(param.max > param.min)) continue;
      out.push({ key: `${op.id}.${param.id}`, min: param.min, max: param.max });
    }
  }
  return out;
}

/** energy 0.2 → ratio≈0.075, energy 0.8 → ratio≈0.45（アンカー通り）。 */
function energyToRouteRatio(energy) {
  return Math.min(0.6, Math.max(0.02, 0.625 * energy - 0.05));
}

/** energy 0.2 → smoothing≈2.5, energy 0.8 → smoothing≈0.35（アンカー通り）。 */
function energyToSmoothingBase(energy) {
  return Math.min(3.5, Math.max(0.15, 3.2167 - 3.583 * energy));
}

/**
 * `targets` に対して 1–3 本の route を組み立てる。`nsPrefix` は呼び出し文脈ごとに
 * 変える（新規生成は 'gen:route'、--base の route 補充は 'gen:base:route'）。
 */
function buildRoutesFromTargets(seed, nsPrefix, targets, energy) {
  if (targets.length === 0) return [];
  const count = Math.min(randInt(seed, `${nsPrefix}:count`, 0, 1, 3), targets.length);
  if (count <= 0) return [];

  const remaining = [...targets];
  const routes = [];

  for (let i = 0; i < count; i++) {
    const source = weightedPickWithoutReplacement(
      seed,
      `${nsPrefix}:${i}:source`,
      ROUTE_SOURCES,
      () => 1,
      1,
    )[0];
    const target = weightedPickWithoutReplacement(
      seed,
      `${nsPrefix}:${i}:target`,
      remaining,
      (t) => TARGET_WEIGHT_BY_PARAM.get(paramIdOf(t.key)) ?? 1,
      1,
    )[0];
    const idx = remaining.findIndex((t) => t.key === target.key);
    remaining.splice(idx, 1);

    let ratio =
      energyToRouteRatio(energy) * (0.85 + rand(seed, `${nsPrefix}:${i}:amount`, 0) * 0.3);
    // 動きの速さそのものを持つパラメータは振り幅を別に絞る。ここを他と同じ幅で
    // 振ると、大音量のときだけ「BPM と関係なくギュインギュイン動く」になる。
    // 由来: src/synth/derive.ts の MOTION_TARGET_PARAMS / MOTION_RATIO_MAX。
    if (MOTION_TARGET_PARAMS.has(paramIdOf(target.key))) {
      ratio = Math.min(ratio, MOTION_RATIO_MAX);
    }
    const amount = ratio * (target.max - target.min);

    const smoothing =
      energyToSmoothingBase(energy) * (0.9 + rand(seed, `${nsPrefix}:${i}:smoothing`, 0) * 0.2);

    // 常に unipolar。bipolar は無音時に -amount という定数オフセットになり、
    // 「音が無いと薄くなる / 消える」を作ってしまう。不変条件: 音は常に
    // Patch の見た目に**足す**方向にしか効かない（無音時が下限）。
    // 由来: src/synth/derive.ts の buildRoutes のコメント。
    const polarity = 'unipolar';

    routes.push({ source, target: target.key, amount, polarity, smoothing });
  }

  return routes;
}

// ---------------------------------------------------------------------------
// 新規生成
// ---------------------------------------------------------------------------

const CATEGORY_PREFIX = { source: 'src', field: 'fld', modifier: 'mod', material: 'mat' };

function generatePatch(seed, pool, catalogMap, moodTagSets, moodMeans, energy) {
  const sourceCount = Math.min(randInt(seed, 'gen:count:source', 0, 1, 2), pool.source.length);
  const fieldCount = Math.min(randInt(seed, 'gen:count:field', 0, 0, 2), pool.field.length);
  const modifierCount = Math.min(
    randInt(seed, 'gen:count:modifier', 0, 1, 3),
    pool.modifier.length,
  );
  const materialCount = Math.min(1, pool.material.length);

  if (sourceCount < 1)
    throw new Error('generatePatch: need at least 1 source generator in catalog');
  if (modifierCount < 1)
    throw new Error('generatePatch: need at least 1 modifier generator in catalog');
  if (materialCount < 1)
    throw new Error('generatePatch: need at least 1 material generator in catalog');

  const weightFn = (g) => tagWeight(tagScore(g.tags, moodTagSets));

  const counts = {
    source: sourceCount,
    field: fieldCount,
    modifier: modifierCount,
    material: materialCount,
  };
  const operators = [];
  // stage 順（source → field → modifier → material）で連結するだけで
  // stage-order 検証を自動的に満たす。並べ替えは行わない。
  for (const category of ['source', 'field', 'modifier', 'material']) {
    const picked = weightedPickWithoutReplacement(
      seed,
      `gen:pick:${category}`,
      pool[category],
      weightFn,
      counts[category],
    );
    const prefix = CATEGORY_PREFIX[category];
    picked.forEach((gen, i) => {
      operators.push(buildOperator(seed, `${prefix}${i}`, gen, energy));
    });
  }

  const palette = buildPalette(seed, moodMeans, energy);
  const composition = buildComposition(seed, moodMeans, energy);
  const routes = buildRoutesFromTargets(
    seed,
    'gen:route',
    collectRouteTargets(operators, catalogMap),
    energy,
  );

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    seed,
    operators,
    routes,
    palette,
    composition,
    qualityTier: 'medium',
  };
}

// ---------------------------------------------------------------------------
// --base: 今アクティブな Patch の operator だけを差し替える
// ---------------------------------------------------------------------------

/**
 * draft.operators を in place で更新する。タグの生スコア（重みではなく素点）が
 * 0 の operator だけを差し替える。0 より大きければ「合っている」ので触らない
 * （ゼロから作り直さない、という仕様）。
 */
function applyBaseOperators(seed, draft, catalogMap, pool, moodTagSets, energy, warn) {
  const inUse = new Set(draft.operators.map((op) => op.generatorId));

  for (const op of draft.operators) {
    const def = catalogMap.get(op.generatorId);
    if (!def) continue; // unknown generator: category が分からないので触らない（validate が拾う）
    const score = tagScore(def.tags, moodTagSets);
    if (score > 0) continue; // 合っている operator はゼロから作り直さない

    inUse.delete(op.generatorId);
    const candidates = (pool[def.category] ?? []).filter((g) => !inUse.has(g.id));
    const picked = weightedPickWithoutReplacement(
      seed,
      `gen:base:pick:${op.id}`,
      candidates,
      (g) => tagWeight(tagScore(g.tags, moodTagSets)),
      1,
    )[0];

    if (!picked) {
      // 置き換え候補が尽きた（101 個のカタログでは通常起きない想定）。元のまま残す。
      inUse.add(op.generatorId);
      warn?.(
        `operator "${op.id}" はタグが合いませんが、置き換え候補が無いため元の generator "${op.generatorId}" を維持します`,
      );
      continue;
    }

    op.generatorId = picked.id;
    op.generatorVersion = picked.version;
    op.parameters = {};
    for (const param of picked.parameters) {
      op.parameters[param.id] = pickParameter(seed, op.id, param, energy);
    }
    inUse.add(picked.id);
  }
}

/** parseTarget: "<opId>.<paramId>" を分解する（validate.ts と同じ判定）。 */
function parseTarget(target) {
  const dot = target.indexOf('.');
  if (dot <= 0 || dot === target.length - 1) return null;
  if (target.indexOf('.', dot + 1) !== -1) return null;
  return { opId: target.slice(0, dot), paramId: target.slice(dot + 1) };
}

/**
 * draft.routes のうち、target が「実在する operator の実在する modulatable な
 * パラメータ」を指さなくなったものを落とす。1 本も残らなければ、
 * collectRouteTargets(draft.operators, ...) から 1–3 本を補充する。
 */
function fixupBaseRoutes(seed, draft, catalogMap, energy) {
  const opById = new Map(draft.operators.map((op) => [op.id, op]));

  const survivors = draft.routes.filter((route) => {
    const parsed = parseTarget(route.target);
    if (!parsed) return false;
    const op = opById.get(parsed.opId);
    if (!op) return false;
    const def = catalogMap.get(op.generatorId);
    const paramDef = def?.parameters.find((p) => p.id === parsed.paramId);
    return !!paramDef && paramDef.modulatable === true;
  });

  if (survivors.length >= 1) {
    draft.routes = survivors;
    return;
  }

  const allTargets = collectRouteTargets(draft.operators, catalogMap);
  if (allTargets.length === 0) {
    draft.routes = survivors; // 空のまま（=空配列）。補充のしようがない。
    return;
  }

  const usedKeys = new Set(survivors.map((r) => r.target));
  const remainingTargets = allTargets.filter((t) => !usedKeys.has(t.key));
  const topUp = buildRoutesFromTargets(seed, 'gen:base:route', remainingTargets, energy);
  draft.routes = [...survivors, ...topUp];
}

// ---------------------------------------------------------------------------
// ローカル検証 — src/synth/validate.ts の忠実な複製（.ts を import できないため）
// ---------------------------------------------------------------------------

function validateParamValueLocal(paramDef, value, path) {
  const issues = [];
  switch (paramDef.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(
          `parameter "${paramDef.id}" expects finite number, got ${typeof value} (${path})`,
        );
        break;
      }
      if (paramDef.min !== undefined && value < paramDef.min) {
        issues.push(
          `parameter "${paramDef.id}" value ${value} is below min ${paramDef.min} (${path})`,
        );
      }
      if (paramDef.max !== undefined && value > paramDef.max) {
        issues.push(
          `parameter "${paramDef.id}" value ${value} is above max ${paramDef.max} (${path})`,
        );
      }
      break;
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        issues.push(`parameter "${paramDef.id}" expects integer, got ${String(value)} (${path})`);
        break;
      }
      if (paramDef.min !== undefined && value < paramDef.min) {
        issues.push(
          `parameter "${paramDef.id}" value ${value} is below min ${paramDef.min} (${path})`,
        );
      }
      if (paramDef.max !== undefined && value > paramDef.max) {
        issues.push(
          `parameter "${paramDef.id}" value ${value} is above max ${paramDef.max} (${path})`,
        );
      }
      break;
    }
    case 'bool': {
      if (typeof value !== 'boolean') {
        issues.push(`parameter "${paramDef.id}" expects boolean, got ${typeof value} (${path})`);
      }
      break;
    }
    case 'enum': {
      if (typeof value !== 'string') {
        issues.push(
          `parameter "${paramDef.id}" expects string enum, got ${typeof value} (${path})`,
        );
        break;
      }
      const options = paramDef.options ?? [];
      if (!options.includes(value)) {
        issues.push(
          `parameter "${paramDef.id}" value "${value}" is not in options [${options.join(', ')}] (${path})`,
        );
      }
      break;
    }
  }
  return issues;
}

function validatePatchLocal(patch, catalogArray) {
  const issues = [];
  const catalogMap = new Map(catalogArray.map((d) => [d.id, d]));
  const operators = patch.operators;
  const opById = new Map();
  const seenIds = new Set();

  // 1. unique operator ids
  for (let i = 0; i < operators.length; i++) {
    const op = operators[i];
    if (seenIds.has(op.id)) {
      issues.push(`duplicate operator id "${op.id}" (operators[${i}])`);
    } else {
      seenIds.add(op.id);
      opById.set(op.id, op);
    }
  }

  // 2-3. generator existence + version; 6. parameters
  const categories = [];
  for (let i = 0; i < operators.length; i++) {
    const op = operators[i];
    const def = catalogMap.get(op.generatorId);
    if (!def) {
      issues.push(
        `generator "${op.generatorId}" not found in catalog (operators[${i}].generatorId)`,
      );
      categories.push(undefined);
      continue;
    }
    if (def.version !== op.generatorVersion) {
      issues.push(
        `generator "${op.generatorId}" version ${op.generatorVersion} does not match catalog version ${def.version} (operators[${i}].generatorVersion)`,
      );
    }
    categories.push(def.category);

    const paramDefs = new Map(def.parameters.map((p) => [p.id, p]));
    for (const [paramId, value] of Object.entries(op.parameters)) {
      const path = `operators[${i}].parameters.${paramId}`;
      const pd = paramDefs.get(paramId);
      if (!pd) {
        issues.push(
          `parameter "${paramId}" is not defined on generator "${op.generatorId}" (${path})`,
        );
        continue;
      }
      issues.push(...validateParamValueLocal(pd, value, path));
    }
  }

  // 4. stage order: non-decreasing category rank
  let lastRank = -1;
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    if (cat === undefined) continue;
    const rank = CATEGORY_RANK[cat];
    if (rank < lastRank) {
      issues.push(
        `operators must be ordered Source → Field → Modifier → Material; found "${cat}" after higher stage (operators[${i}])`,
      );
    }
    lastRank = Math.max(lastRank, rank);
  }

  // 5. count limits
  const counts = { source: 0, field: 0, modifier: 0, material: 0 };
  for (const cat of categories) if (cat !== undefined) counts[cat] += 1;
  for (const cat of Object.keys(COUNT_LIMITS)) {
    const { min, max } = COUNT_LIMITS[cat];
    const n = counts[cat];
    if (n < min || n > max) issues.push(`${cat} count must be ${min}-${max}, got ${n} (operators)`);
  }

  // 7-10. routes
  for (let i = 0; i < patch.routes.length; i++) {
    const route = patch.routes[i];
    const basePath = `routes[${i}]`;

    if (typeof route.amount !== 'number' || !Number.isFinite(route.amount)) {
      issues.push(`route amount must be a finite number (${basePath}.amount)`);
    }
    if (typeof route.smoothing !== 'number' || !Number.isFinite(route.smoothing)) {
      issues.push(`route smoothing must be a finite number (${basePath}.smoothing)`);
    } else if (route.smoothing < 0) {
      issues.push(`route smoothing must be >= 0 (${basePath}.smoothing)`);
    }

    const parsedTarget = parseTarget(route.target);
    if (!parsedTarget) {
      issues.push(`route target "${route.target}" must be "<opId>.<paramId>" (${basePath}.target)`);
    } else {
      const targetOp = opById.get(parsedTarget.opId);
      if (!targetOp) {
        issues.push(
          `route target operator "${parsedTarget.opId}" does not exist (${basePath}.target)`,
        );
      } else {
        const def = catalogMap.get(targetOp.generatorId);
        const paramDef = def?.parameters.find((p) => p.id === parsedTarget.paramId);
        if (!def || !paramDef) {
          issues.push(
            `route target parameter "${parsedTarget.paramId}" not found on operator "${parsedTarget.opId}" (${basePath}.target)`,
          );
        } else if (!paramDef.modulatable) {
          issues.push(
            `parameter "${parsedTarget.paramId}" on operator "${parsedTarget.opId}" is not modulatable (${basePath}.target)`,
          );
        }
      }

      if (route.source.startsWith('operator:')) {
        const sourceOpId = route.source.slice('operator:'.length);
        if (sourceOpId === parsedTarget.opId) {
          issues.push(
            `operator "${sourceOpId}" cannot modulate itself in the same frame (${basePath})`,
          );
        }
      }
    }

    const source = route.source;
    if (source === 'time' || AUDIO_SOURCES.has(source)) {
      // ok
    } else if (source.startsWith('operator:')) {
      const sourceOpId = source.slice('operator:'.length);
      if (!sourceOpId || !opById.has(sourceOpId)) {
        issues.push(`route source operator "${sourceOpId}" does not exist (${basePath}.source)`);
      }
    } else {
      issues.push(
        `route source "${source}" is not a known form (audio:*, time, operator:<opId>) (${basePath}.source)`,
      );
    }
  }

  // 11. palette.mode
  if (!PALETTE_MODES.includes(patch.palette.mode)) {
    issues.push(
      `palette.mode "${patch.palette.mode}" is not a valid mode (valid: ${PALETTE_MODES.join(', ')})`,
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  try {
    const { positional, flags } = parseArgv(process.argv.slice(2));

    if (flags.has('help')) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }

    const moodText = positional.join(' ');
    const tokens = moodText
      .split(/[\s、,]+/u)
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) usageError('mood 語を1つ以上指定してください');

    // --url / VJ_URL は「引数の誤り」ではなく実行時条件として扱う。
    const url = flags.has('url') ? flags.get('url') : process.env.VJ_URL;
    if (!url) {
      process.stderr.write('vj-gen: --url が指定されておらず、環境変数 VJ_URL もありません\n');
      process.exitCode = 1;
      return;
    }

    // --- vj-vocab.json ---
    let vocab;
    try {
      vocab = JSON.parse(readFileSync(VOCAB_PATH, 'utf8'));
    } catch (e) {
      process.stderr.write(
        `vj-gen: vj-vocab.json の読み込みに失敗しました (${VOCAB_PATH}): ${e.message}\n`,
      );
      process.exitCode = 1;
      return;
    }

    // --- 語の解決 ---
    const { canonicalWords, unknownTokens } = resolveTokens(tokens, vocab);
    const matchedSet = new Set(canonicalWords);
    if (matchedSet.size === 0) {
      process.stderr.write(`vj-gen: 既知の mood 語がありません（入力: ${tokens.join(' ')}）\n`);
      process.exitCode = 1;
      return;
    }
    for (const t of unknownTokens) {
      process.stderr.write(`vj-gen: 未知の語 "${t}" を無視します\n`);
    }
    process.stderr.write(`vj-gen: 解決した語: ${[...matchedSet].join(', ')}\n`);

    const matched = [...matchedSet].map((w) => vocab[w]);
    const { moodTagSets, moodMeans, energy } = buildMoodContext(matched);

    const seedBase = flags.has('seed') ? flags.get('seed') : computeBaseSeed([...matchedSet]);
    process.stderr.write(`vj-gen: base seed = "${seedBase}"\n`);

    // --- catalog（キャッシュ優先。--dry-run でも必要） ---
    const catalogLoad = loadCatalog(url, flags.has('refresh-catalog'));
    if (!catalogLoad.ok) {
      if (catalogLoad.result) {
        propagateFailure(catalogLoad.result);
      } else {
        process.stderr.write(
          `vj-gen: catalog の JSON 解析に失敗しました: ${catalogLoad.parseError.message}\n`,
        );
        process.exitCode = 1;
      }
      return;
    }
    const catalogArray = catalogLoad.catalog;
    const catalogMap = new Map(catalogArray.map((def) => [def.id, def]));
    const pool = buildPool(catalogArray);

    // --- --base: 現在の patch を取得 ---
    const baseMode = flags.has('base');
    let currentPatch;
    if (baseMode) {
      const stateResult = runVjCtl(url, 'state');
      if (stateResult.status !== 0) {
        propagateFailure(stateResult);
        return;
      }
      let state;
      try {
        state = JSON.parse(stateResult.stdout);
      } catch (e) {
        process.stderr.write(`vj-gen: state の JSON 解析に失敗しました: ${e.message}\n`);
        process.exitCode = 1;
        return;
      }
      currentPatch = state.currentPatch;
      if (currentPatch == null) {
        process.stderr.write(
          'vj-gen: no patch is currently active on the synth — open the app / propose a patch first\n',
        );
        process.exitCode = 1;
        return;
      }
    }

    function generateCandidate(seed) {
      if (baseMode) {
        const draft = structuredClone(currentPatch);
        draft.seed = seed;
        applyBaseOperators(seed, draft, catalogMap, pool, moodTagSets, energy, (msg) =>
          process.stderr.write(`vj-gen: [base] ${msg}\n`),
        );
        fixupBaseRoutes(seed, draft, catalogMap, energy);
        return draft;
      }
      return generatePatch(seed, pool, catalogMap, moodTagSets, moodMeans, energy);
    }

    // --- --count: n 個の独立候補を生成。送信は絶対にしない。 ---
    if (flags.has('count')) {
      const n = Number(flags.get('count'));
      if (!Number.isInteger(n) || n < 1) usageError('--count は 1 以上の整数で指定してください');

      const results = [];
      let anyFailed = false;
      for (let i = 0; i < n; i++) {
        const seed = `${seedBase}#${i}`;
        const patch = generateCandidate(seed);
        const issues = validatePatchLocal(patch, catalogArray);
        if (issues.length > 0) {
          anyFailed = true;
          process.stderr.write(
            `vj-gen: candidate #${i} (seed=${JSON.stringify(seed)}) はローカル検証に失敗しました（想定外 — バグの兆候）:\n`,
          );
          for (const issue of issues) process.stderr.write(`- ${issue}\n`);
          continue;
        }
        results.push({ index: i, seed, patch });
      }
      jsonOut(results);
      if (anyFailed) process.exitCode = 1;
      return;
    }

    // --- 単一生成 ---
    const seed = seedBase;
    const patch = generateCandidate(seed);
    const issues = validatePatchLocal(patch, catalogArray);
    if (issues.length > 0) {
      jsonOut({ ok: false, issues });
      for (const issue of issues) process.stderr.write(`- ${issue}\n`);
      process.exitCode = 1;
      return;
    }

    if (flags.has('dry-run')) {
      jsonOut(patch);
      return;
    }

    // --- 送信 ---
    let tmpDir;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), 'vj-gen-'));
      const tmpFile = join(tmpDir, 'patch.json');
      writeFileSync(tmpFile, JSON.stringify(patch, null, 2));
      const result = spawnSync(process.execPath, [VJ_CTL_PATH, '--url', url, 'patch', tmpFile], {
        stdio: 'inherit',
      });
      process.exitCode = result.status ?? 1;
    } finally {
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // 掃除に失敗しても致命的ではない
        }
      }
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`vj-gen: ${e.message}\n\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    // 想定外の例外は握りつぶさずそのまま投げる（Node のデフォルト処理で exit code が立つ）。
    throw e;
  }
}

// main() は直接実行時のみ走らせる。ドリフトテストが定数だけを import
// したいときに main() が誤って走る(process.exitCode 汚染や argv の誤爆)のを防ぐ。
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
