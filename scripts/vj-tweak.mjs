#!/usr/bin/env node
/**
 * vj-tweak — 今アクティブな VisualPatch に対して、テキストの差分トークン列
 * （`-opId` / `+generatorId` / `opId.paramId=value` など）で局所的な変更を
 * 記述し、ローカルで検証してから送る CLI。
 *
 * vj-ctl.mjs の再実装ではない: WebSocket 通信は一切自前で行わず、
 * 状態取得（state）・カタログ取得（catalog）・送信（patch）はすべて
 * vj-ctl.mjs を子プロセスとして呼び出すことで行う。このスクリプトの仕事は
 * 「現在の Patch + カタログ + <change> トークン列」から次の Patch 案（draft）
 * を組み立て、サーバ側 validate.ts と同じ規則でローカルに事前検証すること。
 *
 * 出力の約束（vj-ctl.mjs に倣う）:
 *   - --help           → USAGE を stdout、exit 0（通信なし）
 *   - ローカル検証 NG  → {ok:false, issues:[...]} を stdout、各 issue を stderr にも箇条書き、exit 1
 *   - --dry-run        → 検証を通った draft を stdout（整形 JSON）、exit 0、送信はしない
 *   - 送信             → vj-ctl.mjs patch の stdout/stderr をそのまま素通し、exit code もそれに合わせる
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** vj-ctl.mjs の実体。同じ scripts/ ディレクトリに並ぶ前提で相対解決する。env で上書き可能。 */
const VJ_CTL_PATH = process.env.VJ_CTL_PATH ?? `${import.meta.dirname}/vj-ctl.mjs`;

/** catalog キャッシュはスクリプト自身と同じディレクトリに置く（scratch dir は毎回同じ場所）。 */
const CATALOG_CACHE_PATH = `${import.meta.dirname}/.vj-catalog-cache.json`;

// 由来: src/synth/validate.ts の CATEGORY_RANK / COUNT_LIMITS をそのまま複製したもの
// （CLI は .ts を import できないため）。サーバ側のゲートと食い違えると
// 「ローカルは通ったのにサーバで弾かれる」が起きるので、値は必ず一致させること。
export const CATEGORY_RANK = { source: 0, field: 1, modifier: 2, material: 3 };
export const COUNT_LIMITS = {
  source: { min: 1, max: 2 },
  field: { min: 0, max: 2 },
  modifier: { min: 1, max: 3 },
  material: { min: 1, max: 1 },
};

/** 由来: src/synth/derive.ts の pickOperatorsForCategory が使う id 命名規則（`${prefix}${n}`）。 */
export const CATEGORY_PREFIX = { source: 'src', field: 'fld', modifier: 'mod', material: 'mat' };

export const PALETTE_MODES = ['mono', 'analogous', 'complementary', 'triadic', 'rainbow'];
export const PALETTE_KEYS = ['mode', 'hueOffset', 'saturation', 'lightness'];
export const COMPOSITION_KEYS = ['symmetry', 'scale', 'speed'];
export const QUALITY_TIERS = ['low', 'medium', 'high'];

const USAGE = `使い方: node vj-tweak.mjs [--url <ws(s)://…>] [--dry-run] [--seed <s>] [--refresh-catalog] <change>...
       node vj-tweak.mjs --help

vj-ctl.mjs（${VJ_CTL_PATH}。VJ_CTL_PATH で上書き可）を子プロセスとして呼び出し、
今アクティブな VisualPatch への差分を <change> トークン列として表現・検証・送信する。
WebSocket 通信は一切自前で行わない。

<change> トークン（7 種類、この順でチェックされる）:
  -<opId>                     operator を削除                                      例: -fld1
  +<generatorId>[:<opId>]     operator を追加（id 省略時は src0 のように自動採番）  例: +threshold:th1
  <opId>:=<generatorId>       operator の generator を差し替え（parameters は初期化） 例: src0:=noise-field
  <opId>.<paramId>=<value>    パラメータを変更                                     例: src0.frequency=4.2
  palette.<key>=<value>       palette を変更（mode/hueOffset/saturation/lightness） 例: palette.mode=triadic
  composition.<key>=<value>   composition を変更（symmetry/scale/speed）           例: composition.speed=1.5
  qualityTier=<value>         qualityTier を変更（${QUALITY_TIERS.join('/')}）             例: qualityTier=high

オプション:
  --url <ws(s)://…>           接続先（省略時は環境変数 VJ_URL を使う）
  --seed <s>                  送る draft の seed を上書き（<change> の有無に関わらず適用）
  --dry-run                   検証だけ行い、通れば draft を stdout に出して送信しない
  --refresh-catalog           catalog キャッシュ（${CATALOG_CACHE_PATH}）を無視して取り直す
  --help                      このヘルプ

例:
  node vj-tweak.mjs --url wss://example.workers.dev/room/xxxx src0.frequency=4.2
  node vj-tweak.mjs --url wss://example.workers.dev/room/xxxx --dry-run +threshold:th1 th1.thresholdValue=0.6
  node vj-tweak.mjs --url wss://example.workers.dev/room/xxxx -fld1 palette.mode=rainbow qualityTier=high
  node vj-tweak.mjs --url wss://example.workers.dev/room/xxxx --refresh-catalog src0:=noise-field`;

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

const BOOLEAN_FLAGS = new Set(['help', 'dry-run', 'refresh-catalog']);
const KNOWN_FLAGS = new Set(['help', 'dry-run', 'refresh-catalog', 'url', 'seed']);

/**
 * `--flag value` / 真偽フラグ / 位置引数を解釈する。<change> トークンは `-opId` のように
 * 単一ハイフンで始まりうるので、フラグ扱いするのは `--` 始まりだけ（vj-ctl.mjs と同じ判定）。
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

/**
 * <change> の右辺値を number → boolean → string の順で緩く解釈する。
 * `Number('')` が `0` になってしまうため、空文字だけは先に弾いて string 側に落とす。
 */
export function parseValue(raw) {
  if (raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

// ---------------------------------------------------------------------------
// vj-ctl.mjs 呼び出し
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

// ---------------------------------------------------------------------------
// catalog + キャッシュ
// ---------------------------------------------------------------------------

/**
 * catalog を読む。--refresh-catalog が無ければまずキャッシュファイルを試し、
 * 壊れている/無い場合や --refresh-catalog 指定時だけ vj-ctl.mjs を叩き直す。
 * キャッシュへの書き戻しはベストエフォート（失敗しても致命的ではない）。
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
      `vj-tweak: catalog キャッシュの書き込みに失敗しました（続行には影響しません）: ${e.message}\n`,
    );
  }
  return { ok: true, catalog };
}

// ---------------------------------------------------------------------------
// 変更トークンの分類
// ---------------------------------------------------------------------------

/**
 * 生トークンを 7 種類のどれかに分類する。ここでは構文だけを見る
 * （operator の実在や catalog との整合は次段の applyChange の仕事）。
 * 形式に合わないものは `{ error }` を返す（例外にはしない — 複数トークンの
 * エラーを一括で集めたいので、classify も apply も「投げずに返す」で統一する）。
 */
export function classifyChange(raw) {
  if (raw.startsWith('-') && !raw.startsWith('--')) {
    return { kind: 'delete', opId: raw.slice(1) };
  }
  if (raw.startsWith('+')) {
    const body = raw.slice(1);
    const idx = body.indexOf(':');
    if (idx === -1) return { kind: 'add', generatorId: body, opId: undefined };
    return { kind: 'add', generatorId: body.slice(0, idx), opId: body.slice(idx + 1) };
  }
  const swapIdx = raw.indexOf(':=');
  if (swapIdx !== -1) {
    return { kind: 'swap', opId: raw.slice(0, swapIdx), generatorId: raw.slice(swapIdx + 2) };
  }
  // ':=' は '=' も含むので、'=' の判定より先に ':=' を弾いておく必要がある（上のブロック）。
  const eqIdx = raw.indexOf('=');
  if (eqIdx !== -1) {
    const key = raw.slice(0, eqIdx);
    const rawValue = raw.slice(eqIdx + 1);
    if (key === 'qualityTier') return { kind: 'qualityTier', rawValue };
    if (key.startsWith('palette.')) {
      return { kind: 'palette', subkey: key.slice('palette.'.length), rawValue };
    }
    if (key.startsWith('composition.')) {
      return { kind: 'composition', subkey: key.slice('composition.'.length), rawValue };
    }
    const dotIdx = key.indexOf('.');
    if (dotIdx !== -1) {
      return {
        kind: 'param',
        opId: key.slice(0, dotIdx),
        paramId: key.slice(dotIdx + 1),
        rawValue,
      };
    }
    return {
      error: `[${raw}] "=" の左辺に "." がありません（<opId>.<paramId>=<value> の形式にしてください）`,
    };
  }
  return { error: `[${raw}] 既知のどの変更トークンの形式にも一致しません` };
}

// ---------------------------------------------------------------------------
// 変更の適用
// ---------------------------------------------------------------------------

export function existingIdsText(draft) {
  return draft.operators.length > 0 ? draft.operators.map((op) => op.id).join(', ') : '(none)';
}

/**
 * "<opId>.<paramId>" を分解する。dot が無い/先頭/末尾にある/2個以上あるものは null。
 * 由来: src/synth/validate.ts の parseTarget と同じ判定(vj-gen.mjs にも同じものがある)。
 */
export function parseTarget(target) {
  if (typeof target !== 'string') return null;
  const dot = target.indexOf('.');
  if (dot <= 0 || dot === target.length - 1) return null;
  if (target.indexOf('.', dot + 1) !== -1) return null;
  return { opId: target.slice(0, dot), paramId: target.slice(dot + 1) };
}

/** ParameterDefinition.kind に応じて value を検証する。エラーなら文字列、OK なら null を返す。 */
function validateParamValue(param, value) {
  if (param.kind === 'number' || param.kind === 'int') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `value ${JSON.stringify(value)} is not a number`;
    }
    if (param.kind === 'int' && !Number.isInteger(value)) {
      return `value ${value} is not an integer`;
    }
    if (param.min !== undefined && value < param.min) {
      return `value ${value} is below min ${param.min}`;
    }
    if (param.max !== undefined && value > param.max) {
      return `value ${value} is above max ${param.max}`;
    }
    return null;
  }
  if (param.kind === 'bool') {
    return typeof value === 'boolean' ? null : `value ${JSON.stringify(value)} is not a boolean`;
  }
  // enum
  const options = param.options ?? [];
  if (typeof value !== 'string' || !options.includes(value)) {
    return `value ${JSON.stringify(value)} is not a valid option (valid: ${options.join(', ')})`;
  }
  return null;
}

export function applyParam(raw, change, draft, catalogMap, errors) {
  const { opId, paramId, rawValue } = change;
  const op = draft.operators.find((o) => o.id === opId);
  if (!op) {
    errors.push(
      `[${raw}] operator "${opId}" が見つかりません（existing ids: ${existingIdsText(draft)}）`,
    );
    return;
  }
  const def = catalogMap.get(op.generatorId);
  if (!def) {
    errors.push(
      `[${raw}] generator "${op.generatorId}" not in the catalog (try --refresh-catalog)`,
    );
    return;
  }
  const param = def.parameters.find((p) => p.id === paramId);
  if (!param) {
    const available =
      def.parameters.length > 0 ? def.parameters.map((p) => p.id).join(', ') : '(none)';
    errors.push(
      `[${raw}] param "${paramId}" not found on generator "${def.id}" (available: ${available})`,
    );
    return;
  }
  const value = parseValue(rawValue);
  const err = validateParamValue(param, value);
  if (err) {
    errors.push(`[${raw}] ${err}`);
    return;
  }
  op.parameters[paramId] = value;
}

export function applyPalette(raw, change, draft, errors) {
  const { subkey, rawValue } = change;
  if (!PALETTE_KEYS.includes(subkey)) {
    errors.push(`[${raw}] palette のキーは ${PALETTE_KEYS.join(' | ')} のいずれかです`);
    return;
  }
  const value = parseValue(rawValue);
  if (subkey === 'mode') {
    if (typeof value !== 'string' || !PALETTE_MODES.includes(value)) {
      errors.push(
        `[${raw}] value ${JSON.stringify(value)} is not a valid palette mode (valid: ${PALETTE_MODES.join(', ')})`,
      );
      return;
    }
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`[${raw}] value ${JSON.stringify(value)} is not a finite number`);
    return;
  }
  draft.palette[subkey] = value;
}

export function applyComposition(raw, change, draft, errors) {
  const { subkey, rawValue } = change;
  if (!COMPOSITION_KEYS.includes(subkey)) {
    errors.push(`[${raw}] composition のキーは ${COMPOSITION_KEYS.join(' | ')} のいずれかです`);
    return;
  }
  const value = parseValue(rawValue);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`[${raw}] value ${JSON.stringify(value)} is not a finite number`);
    return;
  }
  draft.composition[subkey] = value;
}

export function applyQualityTier(raw, change, draft, errors) {
  const value = parseValue(change.rawValue);
  if (typeof value !== 'string' || !QUALITY_TIERS.includes(value)) {
    errors.push(
      `[${raw}] value ${JSON.stringify(value)} is not a valid qualityTier (valid: ${QUALITY_TIERS.join(', ')})`,
    );
    return;
  }
  draft.qualityTier = value;
}

export function applySwap(raw, change, draft, catalogMap, errors) {
  const { opId, generatorId } = change;
  const op = draft.operators.find((o) => o.id === opId);
  if (!op) {
    errors.push(
      `[${raw}] operator "${opId}" が見つかりません（existing ids: ${existingIdsText(draft)}）`,
    );
    return;
  }
  const def = catalogMap.get(generatorId);
  if (!def) {
    errors.push(`[${raw}] generator "${generatorId}" not found in catalog`);
    return;
  }
  // id と配列上の位置は変えない。parameters は新しい generator の default で丸ごと差し替える。
  op.generatorId = def.id;
  op.generatorVersion = def.version;
  op.parameters = Object.fromEntries(def.parameters.map((p) => [p.id, p.default]));
}

export function applyDelete(raw, change, draft, currentIds, errors) {
  const { opId } = change;
  const idx = draft.operators.findIndex((o) => o.id === opId);
  if (idx === -1) {
    errors.push(
      `[${raw}] operator "${opId}" が見つかりません（existing ids: ${existingIdsText(draft)}）`,
    );
    return;
  }
  draft.operators.splice(idx, 1);
  // ぶら下がり参照の掃除: この operator 名前空間の images エントリを削って patch を
  // 自己完結させる。route の掃除は reconcileRoutes(全トークン適用後に1回だけ走る)に
  // 任せる — ここで先取りすると swap 由来の掃除と処理が二重化するため。
  if (draft.images) {
    for (const key of Object.keys(draft.images)) {
      if (key.startsWith(`${opId}.`)) delete draft.images[key];
    }
  }
  currentIds.delete(opId);
}

export function applyAdd(raw, change, draft, currentIds, catalogMap, errors) {
  const { generatorId } = change;
  let { opId } = change;
  const def = catalogMap.get(generatorId);
  if (!def) {
    errors.push(`[${raw}] generator "${generatorId}" not found in catalog`);
    return;
  }
  if (opId) {
    if (currentIds.has(opId)) {
      errors.push(`[${raw}] operator id "${opId}" already exists`);
      return;
    }
  } else {
    // ${prefix}${n} で先頭から空いている番号を探す（derive.ts の命名規則と同じ）。
    const prefix = CATEGORY_PREFIX[def.category];
    let n = 0;
    while (currentIds.has(`${prefix}${n}`)) n++;
    opId = `${prefix}${n}`;
  }

  const newOp = {
    id: opId,
    generatorId: def.id,
    generatorVersion: def.version,
    parameters: Object.fromEntries(def.parameters.map((p) => [p.id, p.default])),
  };

  // 挿入位置: 自分の rank 以下（同じステージまで含む）の operator をすべて飛ばした直後。
  // catalog に無い generatorId を持つ既存 operator（本来起きない想定だが防御的に）は
  // rank -Infinity 扱いにして、新規 operator の挿入判定をブロックしないようにする。
  const newRank = CATEGORY_RANK[def.category];
  let insertAt = draft.operators.length;
  for (let i = 0; i < draft.operators.length; i++) {
    const existingDef = catalogMap.get(draft.operators[i].generatorId);
    const existingRank = existingDef ? CATEGORY_RANK[existingDef.category] : -Infinity;
    if (existingRank > newRank) {
      insertAt = i;
      break;
    }
  }
  draft.operators.splice(insertAt, 0, newOp);
  currentIds.add(opId);
}

export function applyChange(raw, change, draft, currentIds, catalogMap, errors) {
  switch (change.kind) {
    case 'delete':
      return applyDelete(raw, change, draft, currentIds, errors);
    case 'add':
      return applyAdd(raw, change, draft, currentIds, catalogMap, errors);
    case 'swap':
      return applySwap(raw, change, draft, catalogMap, errors);
    case 'param':
      return applyParam(raw, change, draft, catalogMap, errors);
    case 'palette':
      return applyPalette(raw, change, draft, errors);
    case 'composition':
      return applyComposition(raw, change, draft, errors);
    case 'qualityTier':
      return applyQualityTier(raw, change, draft, errors);
    default:
      // classifyChange が新しい kind を返すようになった場合の防御。
      errors.push(`[${raw}] 未対応の変更種別: ${change.kind}`);
  }
}

// ---------------------------------------------------------------------------
// route の追従 — 差し替え/削除で実在しなくなった operator / パラメータを
// target または source に持つ route を落とす(黙って消さない: 必ず stderr に警告)。
// ---------------------------------------------------------------------------

export function routeSummary(route) {
  return `${route.source} -> ${route.target}`;
}

/**
 * draft.routes を in place で更新する。target は「実在する operator の実在する
 * modulatable なパラメータ」を指している必要があり、source が `operator:<opId>` の
 * 場合はその operator が実在する必要がある。どちらも満たさない route は落とし、
 * 理由つきで stderr に警告する。既知の不具合対応: `<opId>:=<generatorId>`(swap)や
 * `-<opId>`(delete)の後に、古い route が検証ゲートまで残ってしまう問題を防ぐ。
 */
export function reconcileRoutes(draft, catalogMap) {
  const opById = new Map(draft.operators.map((op) => [op.id, op]));
  const dropped = [];

  draft.routes = draft.routes.filter((route) => {
    const parsedTarget = parseTarget(route.target);
    if (parsedTarget) {
      const targetOp = opById.get(parsedTarget.opId);
      if (!targetOp) {
        dropped.push(
          `${routeSummary(route)}: target operator "${parsedTarget.opId}" no longer exists`,
        );
        return false;
      }
      const def = catalogMap.get(targetOp.generatorId);
      const paramDef = def?.parameters.find((p) => p.id === parsedTarget.paramId);
      if (!paramDef) {
        dropped.push(
          `${routeSummary(route)}: generator "${targetOp.generatorId}" on operator "${parsedTarget.opId}" has no parameter "${parsedTarget.paramId}"`,
        );
        return false;
      }
      if (!paramDef.modulatable) {
        dropped.push(
          `${routeSummary(route)}: parameter "${parsedTarget.opId}.${parsedTarget.paramId}" is no longer modulatable on generator "${targetOp.generatorId}"`,
        );
        return false;
      }
    }
    if (route.source.startsWith('operator:')) {
      const sourceOpId = route.source.slice('operator:'.length);
      if (!opById.has(sourceOpId)) {
        dropped.push(`${routeSummary(route)}: source operator "${sourceOpId}" no longer exists`);
        return false;
      }
    }
    return true;
  });

  for (const reason of dropped) {
    process.stderr.write(`vj-tweak: dropping route (${reason})\n`);
  }
}

// ---------------------------------------------------------------------------
// patch 全体の検証（トークン単位ではなく draft 全体に対するチェック）
// ---------------------------------------------------------------------------

/**
 * 由来: src/synth/validate.ts のステージ本数チェック / palette.mode チェックをローカルに
 * 複製したもの。個々のトークンとは無関係に、送る draft 全体に対して毎回走らせる。
 */
export function runPatchLevelChecks(draft, catalogMap, errors) {
  for (const [category, limits] of Object.entries(COUNT_LIMITS)) {
    const ids = draft.operators
      .filter((op) => catalogMap.get(op.generatorId)?.category === category)
      .map((op) => op.id);
    if (ids.length < limits.min || ids.length > limits.max) {
      const idsText = ids.length > 0 ? ` (ids: ${ids.join(', ')})` : '';
      errors.push(
        `[patch] ${category} count must be ${limits.min}-${limits.max}, got ${ids.length}${idsText}`,
      );
    }
  }
  if (!PALETTE_MODES.includes(draft.palette.mode)) {
    errors.push(
      `[patch] palette.mode "${draft.palette.mode}" is not a valid mode (valid: ${PALETTE_MODES.join(', ')})`,
    );
  }
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
    if (positional.length === 0) usageError('<change> を1つ以上指定してください');

    // --url / VJ_URL は「引数の誤り」ではなく実行時条件として扱う
    // （USAGE の大ブロックを出すほどのことではないので一行で終わらせる）。
    const url = flags.has('url') ? flags.get('url') : process.env.VJ_URL;
    if (!url) {
      process.stderr.write('vj-tweak: --url が指定されておらず、環境変数 VJ_URL もありません\n');
      process.exitCode = 1;
      return;
    }

    // --- 現在の patch を取得（--dry-run でも常に必要） ---
    const stateResult = runVjCtl(url, 'state');
    if (stateResult.status !== 0) {
      propagateFailure(stateResult);
      return;
    }
    let state;
    try {
      state = JSON.parse(stateResult.stdout);
    } catch (e) {
      process.stderr.write(`vj-tweak: state の JSON 解析に失敗しました: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    const currentPatch = state.currentPatch;
    if (currentPatch == null) {
      process.stderr.write(
        'vj-tweak: no patch is currently active on the synth — open the app / propose a patch first\n',
      );
      process.exitCode = 1;
      return;
    }

    // --- catalog（キャッシュ優先） ---
    const catalogLoad = loadCatalog(url, flags.has('refresh-catalog'));
    if (!catalogLoad.ok) {
      if (catalogLoad.result) {
        propagateFailure(catalogLoad.result);
      } else {
        process.stderr.write(
          `vj-tweak: catalog の JSON 解析に失敗しました: ${catalogLoad.parseError.message}\n`,
        );
        process.exitCode = 1;
      }
      return;
    }
    const catalogMap = new Map(catalogLoad.catalog.map((def) => [def.id, def]));

    // --- draft を組み立てる ---
    const draft = structuredClone(currentPatch);
    if (flags.has('seed')) draft.seed = flags.get('seed');

    const currentIds = new Set(draft.operators.map((op) => op.id));
    const errors = [];

    // 後続のトークンが先行トークンで追加/削除された operator を参照できるよう、
    // draft と currentIds は 1 トークンずつ逐次更新する。
    for (const raw of positional) {
      const change = classifyChange(raw);
      if (change.error) {
        errors.push(change.error);
        continue;
      }
      applyChange(raw, change, draft, currentIds, catalogMap, errors);
    }

    // operator の差し替え・削除で実在しなくなった route を掃除する(黙って消さない)。
    reconcileRoutes(draft, catalogMap);

    runPatchLevelChecks(draft, catalogMap, errors);

    if (errors.length > 0) {
      jsonOut({ ok: false, issues: errors });
      for (const err of errors) process.stderr.write(`- ${err}\n`);
      process.exitCode = 1;
      return;
    }

    if (flags.has('dry-run')) {
      jsonOut(draft);
      return;
    }

    // --- 送信 ---
    let tmpDir;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), 'vj-tweak-'));
      const tmpFile = join(tmpDir, 'patch.json');
      writeFileSync(tmpFile, JSON.stringify(draft, null, 2));
      // vj-ctl.mjs 自身の出力・終了コードをそのまま使わせる（ここで再整形しない）。
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
      process.stderr.write(`vj-tweak: ${e.message}\n\n${USAGE}\n`);
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
