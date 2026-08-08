#!/usr/bin/env node
/**
 * vj-set — 「セット」(複数シーンの本番用プレイリスト) を Timeline へ cue として
 * 仕込み (`load`)、本番中にその cue を手で進める (`next` / `status`) CLI。
 *
 * `event add --in <sec>` / `--bar <n>` は「決めた時刻/小節に自動的に切り替える」
 * ための予約。会話の中で相対時刻を積み上げていくと、絶対時刻の逆算が古くなって
 * 意図しないタイミングで発火する事故が起きうる（実際に起きた）。`event add --cue <id>`
 * （external anchor）は絶対に自動発火しない — `fire <id>` を叩いた瞬間にしか発火
 * しない。vj-set.mjs はこの「タイミングは本番の手に残す」パターンをセット単位で
 * まとめて扱うための道具: セット全体を事前に仕込んでおき (`load`)、本番中は
 * `next` を叩くだけで次のシーンへ進める。
 *
 * vj-gen.mjs / vj-tweak.mjs 同様、WebSocket 通信は一切自前で行わない。状態取得
 * （state）・カタログ取得（catalog）・送信（event add）・発火（fire）はすべて
 * vj-ctl.mjs を子プロセスとして呼び出す。
 *
 * vj-gen.mjs / vj-tweak.mjs との違い（意図的）: あちらは `--url` / `VJ_URL` が必須
 * （AI Director から使う想定）。vj-set.mjs は本番中にオペレーターが手元の
 * `pnpm bridge` に対して直接叩く想定なので、`--url` も `--port` も無指定なら
 * vj-ctl.mjs 自身の既定（ws://127.0.0.1:7877）にそのまま任せる。
 *
 * 出力の約束（vj-gen.mjs / vj-tweak.mjs に倣う）:
 *   - --help              → USAGE を stdout、exit 0（通信なし）
 *   - ローカル検証 NG     → {ok:false, issues:[...]} を stdout、各 issue を stderr にも
 *                           箇条書き、exit 1、送信は一切しない
 *   - load 成功            → {ok, name, applied, skipped, failures} を stdout
 *   - next / status         → {ok:true, ...} を stdout
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** vj-ctl.mjs の実体。同じ scripts/ ディレクトリに並ぶ前提で相対解決する。env で上書き可能。 */
const VJ_CTL_PATH = process.env.VJ_CTL_PATH ?? `${import.meta.dirname}/vj-ctl.mjs`;

/**
 * catalog キャッシュはスクリプト自身と同じディレクトリに置く。
 * vj-gen.mjs / vj-tweak.mjs と同じファイルを共有する（同じディレクトリに3スクリプトが
 * 置かれる前提。どれかが更新したキャッシュを他も使える）。
 */
const CATALOG_CACHE_PATH = `${import.meta.dirname}/.vj-catalog-cache.json`;

// ---------------------------------------------------------------------------
// 由来: src/synth/validate.ts の定数/関数をそのまま複製したもの（CLI は .ts を
// import できないため）。scripts/vj-gen.mjs / scripts/vj-tweak.mjs にも同じ複製が
// ある（CLI 間で import し合わない、という既存の方針に従う）。サーバ側のゲートと
// 食い違うと「ローカルは通ったのにサーバで弾かれる」が起きるので、validate.ts を
// 変えたらここも合わせて直すこと。
// ---------------------------------------------------------------------------

const PALETTE_MODES = ['mono', 'analogous', 'complementary', 'triadic', 'rainbow'];

const CATEGORY_RANK = { source: 0, field: 1, modifier: 2, material: 3 };

const COUNT_LIMITS = {
  source: { min: 1, max: 2 },
  field: { min: 0, max: 2 },
  modifier: { min: 1, max: 3 },
  material: { min: 1, max: 1 },
};

/** 由来: src/synth/validate.ts の AUDIO_SOURCES。 */
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
 * 由来: scripts/vj-ctl.mjs の TRANSITION_PRESETS のキー一覧だけを複製したもの。
 * 実際の ms 値（paletteMs 等）は vj-ctl.mjs 側（event add --transition）が解決するので、
 * ここでは名前が3つのうちどれかであることだけをローカルで確かめる。
 */
const TRANSITION_KEYS = ['default', 'slow', 'cut'];

/** parseTarget: "<opId>.<paramId>" を分解する（validate.ts と同じ判定）。 */
function parseTarget(target) {
  if (typeof target !== 'string') return null;
  const dot = target.indexOf('.');
  if (dot <= 0 || dot === target.length - 1) return null;
  if (target.indexOf('.', dot + 1) !== -1) return null;
  return { opId: target.slice(0, dot), paramId: target.slice(dot + 1) };
}

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

/**
 * validatePatchLocal は operators[] / routes[] / palette がすでにその形である
 * ことを前提にしている（vj-gen.mjs / vj-tweak.mjs の draft は常にその形なので
 * 問題にならない）。vj-set.mjs は任意の JSON ファイルをそのまま読むので、その
 * 前提が崩れていたら validatePatchLocal に投げる前にここで弾き、例外ではなく
 * issue として報告する。
 */
function validatePatchShapeLocal(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return ['patch must be a JSON object'];
  }
  if (!Array.isArray(patch.operators)) return ['patch.operators must be an array'];
  if (!Array.isArray(patch.routes)) return ['patch.routes must be an array'];
  if (patch.palette === null || typeof patch.palette !== 'object') {
    return ['patch.palette must be an object'];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

const USAGE = `使い方: node scripts/vj-set.mjs load <set.json> [--url <ws(s)://…> | --port <n>] [--refresh-catalog]
       node scripts/vj-set.mjs next [--url <ws(s)://…> | --port <n>]
       node scripts/vj-set.mjs status [--url <ws(s)://…> | --port <n>]
       node scripts/vj-set.mjs --help

vj-ctl.mjs（${VJ_CTL_PATH}。VJ_CTL_PATH で上書き可）を子プロセスとして呼び出し、
セット（複数シーンのプレイリスト）を Timeline に "cue" として仕込み (load)、
本番中に手で進める (next / status)。WebSocket 通信は一切自前で行わない。

<set.json> の形式:
  {
    "name": "taiwan-night",
    "scenes": [
      { "cue": "s1", "patch": "scenes/s1.json", "label": "湿気", "transition": "slow" },
      { "cue": "s2", "patch": "scenes/s2.json", "label": "騎楼", "transition": "slow" }
    ]
  }
  - "cue" / "patch" は各シーンに必須。"label" / "transition" は省略可（transition の
    既定は "default"）。"patch" は <set.json> と同じディレクトリからの相対パスとして解決する。
  - "cue" はセット内で一意でなければならない（同じ cue を fire すると全部まとめて
    発火してしまうため、重複はロード前に弾く）。

コマンド:
  load <set.json>   すべてのシーンをローカル検証してから Timeline に仕込む。
                     scenes[0] は --in 0（次フレームでほぼ即発火）で常に (再) 適用し、
                     scenes[1..] は --cue <cue>（fire するまで発火しない）で追加する。
                     scenes[1..] のうち、cue が既に Timeline 上にある（前回の load 等）
                     ものは送らずスキップする — load を再実行しても事故らないための措置。
                     中身が違う同名 cue を検出はしない（cue が既にあれば無条件でスキップ）。
                     差し替えたいときは先に \`vj-ctl.mjs event remove <id>\` すること。
  next               まだ発火していない external anchor の cue のうち、Timeline 上で
                     いちばん手前のものを 1 つ発火する（内部的に fire <cue> を呼ぶ）。
                     もう無ければ ok:true / next:null で正常終了する（エラーではない）。
  status             現在発火中の cue と次に発火する cue、残り本数を表示する。

オプション:
  --url <ws(s)://…>     接続先（vj-ctl.mjs にそのまま渡す）
  --port <n>             bridge のポート（--url と同時指定不可。これも vj-ctl.mjs にそのまま渡す）
                         どちらも無指定なら vj-ctl.mjs 自身の既定（ws://127.0.0.1:7877）に任せる
  --refresh-catalog       catalog キャッシュ（${CATALOG_CACHE_PATH}）を無視して取り直す（load のみ）
  --help                  このヘルプ

例:
  node scripts/vj-set.mjs load sets/taiwan-night.json
  node scripts/vj-set.mjs next
  node scripts/vj-set.mjs status
  node scripts/vj-set.mjs load sets/taiwan-night.json --port 7878
  node scripts/vj-set.mjs next --url wss://example.workers.dev/room/xxxx`;

/** 引数の誤り。main が USAGE を出して exit 1 にする。 */
class UsageError extends Error {}

// process.exit は書き込み途中の stdout を切り落とすことがあるので使わない。
// 例外で main の catch まで戻し、exitCode を立てて自然に終了させる。
function usageError(message) {
  throw new UsageError(message);
}

const BOOLEAN_FLAGS = new Set(['help', 'refresh-catalog']);
const KNOWN_FLAGS = new Set(['help', 'refresh-catalog', 'url', 'port']);

/**
 * `--flag value` / 真偽フラグ / 位置引数を解釈する（vj-ctl.mjs / vj-gen.mjs /
 * vj-tweak.mjs と同じ判定: `--` で始まるものだけをフラグ扱いする）。
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
 * `--url` / `--port` から vj-ctl.mjs へそのまま渡す追加 argv を作る。
 * vj-gen.mjs / vj-tweak.mjs と違い、どちらも無指定なら空配列を返す —
 * vj-ctl.mjs 自身の既定（ws://127.0.0.1:7877）にそのまま任せるのが vj-set.mjs の方針。
 */
function resolveTargetArgs(flags) {
  if (flags.has('url') && flags.has('port')) {
    usageError('--url と --port は同時に指定できません');
  }
  if (flags.has('url')) return ['--url', flags.get('url')];
  if (flags.has('port')) return ['--port', flags.get('port')];
  return [];
}

// ---------------------------------------------------------------------------
// vj-ctl.mjs 呼び出し + catalog キャッシュ
// ---------------------------------------------------------------------------

/** vj-ctl.mjs を子プロセスとして叩き、stdout/stderr/status をキャプチャする。ネットワーク I/O はここだけ。 */
function runVjCtl(targetArgs, command, extraArgs = []) {
  return spawnSync(process.execPath, [VJ_CTL_PATH, ...targetArgs, command, ...extraArgs], {
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

/** issues をまとめて {ok:false, issues} で報告する。stdout は JSON、stderr は箇条書き。 */
function reportIssues(issues) {
  jsonOut({ ok: false, issues });
  for (const issue of issues) process.stderr.write(`- ${issue}\n`);
  process.exitCode = 1;
}

/**
 * catalog を読む。--refresh-catalog が無ければまずキャッシュファイルを試し、
 * 壊れている/無い場合や --refresh-catalog 指定時だけ vj-ctl.mjs を叩き直す。
 * キャッシュへの書き戻しはベストエフォート（失敗しても致命的ではない）。
 * vj-gen.mjs / vj-tweak.mjs の loadCatalog(url, refreshCache) と同じ構造だが、
 * vj-set.mjs は url 文字列ではなく resolveTargetArgs() が返す argv 断片を渡す
 * （--url / --port どちらでも無指定でもよい、という vj-set.mjs 独自の接続方針のため）。
 */
function loadCatalog(targetArgs, refreshCache) {
  if (!refreshCache) {
    try {
      const parsed = JSON.parse(readFileSync(CATALOG_CACHE_PATH, 'utf8'));
      if (Array.isArray(parsed)) return { ok: true, catalog: parsed };
    } catch {
      // キャッシュ未作成 or 壊れている → 下で取り直す
    }
  }

  const result = runVjCtl(targetArgs, 'catalog');
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
      `vj-set: catalog キャッシュの書き込みに失敗しました（続行には影響しません）: ${e.message}\n`,
    );
  }
  return { ok: true, catalog };
}

// ---------------------------------------------------------------------------
// セットファイルの検証
// ---------------------------------------------------------------------------

/** set 全体の形（name / scenes / 各 scene の必須・任意フィールド）を検証する。ALL issue を集める。 */
function validateSetShape(setObj) {
  if (setObj === null || typeof setObj !== 'object' || Array.isArray(setObj)) {
    return ['set file must be a JSON object'];
  }

  const issues = [];
  if (typeof setObj.name !== 'string' || setObj.name.trim() === '') {
    issues.push('"name" must be a non-empty string');
  }
  if (!Array.isArray(setObj.scenes) || setObj.scenes.length === 0) {
    issues.push('"scenes" must be a non-empty array');
    return issues; // scenes が配列ですらないと個々のシーンを見ようがない
  }

  setObj.scenes.forEach((scene, i) => {
    const path = `scenes[${i}]`;
    if (scene === null || typeof scene !== 'object' || Array.isArray(scene)) {
      issues.push(`${path} must be an object`);
      return;
    }
    if (typeof scene.cue !== 'string' || scene.cue.trim() === '') {
      issues.push(`${path}.cue must be a non-empty string`);
    }
    if (typeof scene.patch !== 'string' || scene.patch.trim() === '') {
      issues.push(`${path}.patch must be a non-empty string`);
    }
    if (scene.label !== undefined && typeof scene.label !== 'string') {
      issues.push(`${path}.label must be a string`);
    }
    if (scene.transition !== undefined && !TRANSITION_KEYS.includes(scene.transition)) {
      issues.push(`${path}.transition must be one of ${TRANSITION_KEYS.join(' | ')}`);
    }
  });

  return issues;
}

/**
 * 同じ cue が複数のシーンで使われていないか確認する。fire <externalId> は
 * 同じ id を持つイベントを *まとめて* 発火する（src/synth/timeline.ts の
 * fireExternal）ので、セット内での cue 重複はほぼ確実に操作ミスであり、
 * ロード前に弾く。validateSetShape が通った（=各 scene.cue が非空文字列である）
 * ことを前提にする。
 */
function findDuplicateCues(scenes) {
  const indicesByCue = new Map();
  scenes.forEach((scene, i) => {
    if (!indicesByCue.has(scene.cue)) indicesByCue.set(scene.cue, []);
    indicesByCue.get(scene.cue).push(i);
  });

  const issues = [];
  for (const [cue, indices] of indicesByCue) {
    if (indices.length > 1) {
      issues.push(`cue "${cue}" is used by more than one scene (scenes[${indices.join(', ')}])`);
    }
  }
  return issues;
}

/**
 * 各シーンの patch ファイル（<set.json> と同じディレクトリからの相対パス）を
 * 読んで JSON.parse する。読めない/パースできないものは issue に積んで
 * patch: null を返す（呼び出し側は issues が空のときだけ先に進む）。
 */
function loadScenePatches(setDir, scenes) {
  const issues = [];
  const resolved = scenes.map((scene, i) => {
    const patchPath = resolve(setDir, scene.patch);
    let raw;
    try {
      raw = readFileSync(patchPath, 'utf8');
    } catch (e) {
      issues.push(
        `scenes[${i}] cue="${scene.cue}": cannot read patch file ${patchPath} (${e.message})`,
      );
      return { patchPath, patch: null };
    }
    try {
      return { patchPath, patch: JSON.parse(raw) };
    } catch (e) {
      issues.push(
        `scenes[${i}] cue="${scene.cue}": patch file is not valid JSON: ${patchPath} (${e.message})`,
      );
      return { patchPath, patch: null };
    }
  });
  return { resolved, issues };
}

// ---------------------------------------------------------------------------
// next / status が使う純粋関数（cursor はどこにも保存せず、毎回 state から導出する）
// ---------------------------------------------------------------------------

/**
 * Timeline 順（= state.timeline.events の配列順。applyOp の 'add' は常に push
 * するだけなので、この順序は load がシーンを積んだ順と一致する）で見ていって、
 * まだ firedIds に無い最初の external anchor イベントを返す。
 *
 * external 以外（seconds/bar）は無視する: fire / next はそもそも external にしか
 * 効かない（fireExternal が start.kind !== 'external' を弾く）ので、たまたま同じ
 * Timeline に乗っている --in / --bar の予約を「次の cue」と誤認しないようにする。
 */
export function deriveNextCue(events, firedIds) {
  const fired = new Set(firedIds);
  for (const event of events) {
    if (event.start.kind !== 'external') continue;
    if (fired.has(event.id)) continue;
    return { cue: event.start.id, id: event.id, label: event.intent?.label };
  }
  return null;
}

/**
 * 「いま出ている」cue を、Timeline の並び順ではなく実際に発火した順
 * （state.firedIds、末尾が最新）から探す。手動で順番を飛ばして fire した
 * 場合でも「最後に発火したもの」が正しく current になるようにするため。
 */
export function deriveCurrentCue(events, firedIds) {
  const byId = new Map(events.map((e) => [e.id, e]));
  for (let i = firedIds.length - 1; i >= 0; i--) {
    const event = byId.get(firedIds[i]);
    if (event && event.start.kind === 'external') {
      return { cue: event.start.id, id: event.id, label: event.intent?.label };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------------

function fetchState(targetArgs) {
  const result = runVjCtl(targetArgs, 'state');
  if (result.status !== 0) return { ok: false, result };
  try {
    return { ok: true, state: JSON.parse(result.stdout) };
  } catch (e) {
    return { ok: false, parseError: e };
  }
}

function reportStateFailure(fetched) {
  if (fetched.result) {
    propagateFailure(fetched.result);
  } else {
    process.stderr.write(
      `vj-set: state の JSON 解析に失敗しました: ${fetched.parseError.message}\n`,
    );
    process.exitCode = 1;
  }
}

function cmdLoad(rest, flags, targetArgs) {
  if (rest.length === 0) usageError('load には <set.json> が必要です');
  const setFilePath = rest[0];
  const absSetPath = resolve(setFilePath);
  const setDir = dirname(absSetPath);

  // 1. 読む + JSON parse（この時点ではまだ通信を一切しない）
  let raw;
  try {
    raw = readFileSync(absSetPath, 'utf8');
  } catch (e) {
    jsonOut({ error: `cannot read set file: ${absSetPath}` });
    process.stderr.write(`vj-set: ${absSetPath} を読めません (${e.message})\n`);
    process.exitCode = 1;
    return;
  }
  let setObj;
  try {
    setObj = JSON.parse(raw);
  } catch (e) {
    jsonOut({ error: `set file is not valid JSON: ${absSetPath}` });
    process.stderr.write(`vj-set: ${absSetPath} が JSON として不正です (${e.message})\n`);
    process.exitCode = 1;
    return;
  }

  // 2. set 全体の形を検証（ALL issue を集める）
  const shapeIssues = validateSetShape(setObj);
  if (shapeIssues.length > 0) {
    reportIssues(shapeIssues);
    return;
  }

  // 3. cue の一意性（このセット内だけ）
  const dupIssues = findDuplicateCues(setObj.scenes);
  if (dupIssues.length > 0) {
    reportIssues(dupIssues);
    return;
  }

  // 4. 各シーンの patch を読む + parse（まだ送らない）
  const { resolved, issues: readIssues } = loadScenePatches(setDir, setObj.scenes);
  if (readIssues.length > 0) {
    reportIssues(readIssues);
    return;
  }

  // 5. catalog を引いて全シーンの patch をローカル検証（1つでも落ちたら誰にも送らない）
  const catalogLoad = loadCatalog(targetArgs, flags.has('refresh-catalog'));
  if (!catalogLoad.ok) {
    if (catalogLoad.result) {
      propagateFailure(catalogLoad.result);
    } else {
      process.stderr.write(
        `vj-set: catalog の JSON 解析に失敗しました: ${catalogLoad.parseError.message}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  const patchIssues = [];
  setObj.scenes.forEach((scene, i) => {
    const patch = resolved[i].patch;
    const shapeIssues2 = validatePatchShapeLocal(patch);
    if (shapeIssues2.length > 0) {
      for (const issue of shapeIssues2)
        patchIssues.push(`scenes[${i}] cue="${scene.cue}": ${issue}`);
      return;
    }
    for (const issue of validatePatchLocal(patch, catalogLoad.catalog)) {
      patchIssues.push(`scenes[${i}] cue="${scene.cue}": ${issue}`);
    }
  });
  if (patchIssues.length > 0) {
    reportIssues(patchIssues);
    return;
  }

  // 6. ここまで全部通ったので、初めて live state を引く
  const fetched = fetchState(targetArgs);
  if (!fetched.ok) {
    reportStateFailure(fetched);
    return;
  }
  const state = fetched.state;

  // 7. 冪等性ガード: 既に Timeline に乗っている external cue を集める
  //    （firedIds かどうかは問わない — 「まだ待機中」でも「発火済み」でも "live" として扱う）。
  const liveCues = new Set(
    (state.timeline?.events ?? [])
      .filter((e) => e?.start?.kind === 'external')
      .map((e) => e.start.id),
  );

  const applied = [];
  const skipped = [];
  const failures = [];

  const sendScene = (scene, patchPath, anchorArgs) => {
    const args = [
      ...anchorArgs,
      '--patch',
      patchPath,
      '--transition',
      scene.transition ?? 'default',
    ];
    if (scene.label !== undefined) args.push('--label', scene.label);
    const result = runVjCtl(targetArgs, 'event', ['add', ...args]);
    if (result.status !== 0) {
      if (result.stderr) process.stderr.write(result.stderr);
      let detail;
      try {
        detail = JSON.parse(result.stdout);
      } catch {
        detail = result.stdout.trim();
      }
      failures.push({ cue: scene.cue, error: detail });
      return;
    }
    applied.push(scene.cue);
  };

  // 8. scenes[0] は毎回 (再) 適用する — load の再実行は「このセットを (再) 開始する」の意味。
  sendScene(setObj.scenes[0], resolved[0].patchPath, ['--in', '0']);

  // 9. scenes[1..] は cue として積む。既に live な cue はスキップ（中身の比較はしない）。
  for (let i = 1; i < setObj.scenes.length; i++) {
    const scene = setObj.scenes[i];
    if (liveCues.has(scene.cue)) {
      skipped.push(scene.cue);
      continue;
    }
    sendScene(scene, resolved[i].patchPath, ['--cue', scene.cue]);
  }

  // 10. まとめて報告
  jsonOut({ ok: failures.length === 0, name: setObj.name, applied, skipped, failures });
  if (failures.length > 0) process.exitCode = 1;
}

function cmdNext(targetArgs) {
  const fetched = fetchState(targetArgs);
  if (!fetched.ok) {
    reportStateFailure(fetched);
    return;
  }
  const state = fetched.state;
  const next = deriveNextCue(state.timeline?.events ?? [], state.firedIds ?? []);
  if (!next) {
    // 発火できる cue がもう無いのはセットの終端という正常系であって、エラーではない。
    jsonOut({ ok: true, next: null, message: 'no more cues to fire' });
    return;
  }

  const fireResult = runVjCtl(targetArgs, 'fire', [next.cue]);
  if (fireResult.status !== 0) {
    propagateFailure(fireResult);
    return;
  }
  jsonOut({ ok: true, fired: next });
}

function cmdStatus(targetArgs) {
  const fetched = fetchState(targetArgs);
  if (!fetched.ok) {
    reportStateFailure(fetched);
    return;
  }
  const state = fetched.state;
  const events = state.timeline?.events ?? [];
  const firedIds = state.firedIds ?? [];
  const firedSet = new Set(firedIds);
  const remaining = events.filter((e) => e.start.kind === 'external' && !firedSet.has(e.id)).length;

  jsonOut({
    ok: true,
    current: deriveCurrentCue(events, firedIds),
    next: deriveNextCue(events, firedIds),
    remaining,
  });
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
    if (positional.length === 0) usageError('コマンドを指定してください（load / next / status）');

    const [command, ...rest] = positional;
    const targetArgs = resolveTargetArgs(flags);

    switch (command) {
      case 'load':
        cmdLoad(rest, flags, targetArgs);
        return;
      case 'next':
        cmdNext(targetArgs);
        return;
      case 'status':
        cmdStatus(targetArgs);
        return;
      default:
        usageError(`不明なコマンド: ${command}（load / next / status のいずれかです）`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`vj-set: ${e.message}\n\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    // 想定外の例外は握りつぶさずそのまま投げる（Node のデフォルト処理で exit code が立つ）。
    throw e;
  }
}

// deriveNextCue / deriveCurrentCue をテストから直接 import できるよう export した
// ため、このファイルは「スクリプトとして実行される」だけでなく「モジュールとして
// import される」経路も持つ。import された側で main() まで動くと、テストプロセスの
// argv 次第で vj-ctl.mjs を子プロセス起動してしまいかねない（本番の bridge/relay に
// 触れてはいけない、という制約に抵触する）ので、直接実行されたときだけ起動する。
// `node scripts/vj-set.mjs ...` として動かしたときの挙動はこれまでと変わらない。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
