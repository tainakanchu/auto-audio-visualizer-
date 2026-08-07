#!/usr/bin/env node
/**
 * vj-recipe — 「気分語 + seed + <change>トークン列（vj-tweak.mjs 形式）」という
 * 小さな "recipe" JSON（recipes/*.json）から、その都度 VisualPatch を作り直す CLI。
 *
 * recipe を Patch そのもの（生の JSON）として保存しないのは、
 * src/synth/validate.ts が `generatorVersion` を catalog の現行 version と厳密一致で
 * 検証するため（catalog は最新版しか保持しない — 生の Patch JSON は generator の
 * version が上がった瞬間に静かに腐る）。recipe は「作り直す指示」だけを持つので、
 * catalog がどれだけ変わっても vj-gen.mjs が現行 catalog に対して作り直せる。
 *
 * 実行方式:
 *   - 生成（mood + seed → base patch）は vj-gen.mjs を子プロセスとして呼ぶ
 *     （vj-gen.mjs は --dry-run で patch を stdout に出すだけの綺麗な契約を
 *     既に持っているので、そのまま再利用する）。
 *   - tweaks の適用は vj-tweak.mjs の純粋関数（classifyChange / applyChange /
 *     reconcileRoutes / runPatchLevelChecks 等）を動的 import して直接呼ぶ
 *     （vj-tweak.mjs の main() は「今アクティブな patch」を前提に state を
 *     取りに行ってしまうので、子プロセストしては再利用できない）。
 *   - 最終 draft は vj-tweak.mjs 側のチェックに加えて vj-gen.mjs の
 *     validatePatchLocal（ステージ順まで見る、より広い検証）も通す。
 *   - list / show は catalog にも vj-gen.mjs / vj-tweak.mjs にも一切触れない
 *     （recipe ファイルを読んで schema 検証するだけ）。動的 import は apply の
 *     中でしか行わない。
 *
 * 出力の約束（vj-gen.mjs / vj-tweak.mjs に倣う）:
 *   - --help              → USAGE を stdout、exit 0（通信なし）
 *   - list                → 1行1recipe（`name — notes`）を stdout、通信なし
 *   - show <name>          → 検証済み recipe を整形 JSON で stdout、通信なし
 *   - ローカル検証 NG     → {ok:false, issues:[...]} を stdout、各 issue を stderr にも
 *                           箇条書き、exit 1、送信はしない
 *   - apply --dry-run     → 検証を通った draft patch を stdout（整形 JSON）、送信しない。
 *                           catalog キャッシュがあれば --url/VJ_URL 無しでも動く
 *                           （--refresh-catalog 指定時は dry-run でも取り直すため要 --url）
 *   - apply（送信）        → vj-ctl.mjs patch の stdout/stderr をそのまま素通し、
 *                           exit code もそれに合わせる
 *
 * 終了コードの約束: 成功時のみ exit 0。--help を除くすべてのエラー経路
 * （recipe 未検出/schema 違反/tweaks 適用失敗/検証ゲート/catalog 取得失敗/送信失敗）は
 * 必ず exit 1 にする（vj-ctl.mjs / vj-gen.mjs / vj-tweak.mjs と同じ約束）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRecipe } from './vj-recipe-schema.mjs';

/** vj-ctl.mjs の実体。同じ scripts/ ディレクトリに並ぶ前提で相対解決する。env で上書き可能。 */
const VJ_CTL_PATH = process.env.VJ_CTL_PATH ?? `${import.meta.dirname}/vj-ctl.mjs`;

/** vj-gen.mjs の実体。base patch の生成（子プロセス）と validatePatchLocal の動的 import の両方で使う。 */
const VJ_GEN_PATH = process.env.VJ_GEN_PATH ?? `${import.meta.dirname}/vj-gen.mjs`;

/** vj-tweak.mjs の実体。tweaks 適用ロジック（純粋関数群）を動的 import するために使う。 */
const VJ_TWEAK_PATH = process.env.VJ_TWEAK_PATH ?? `${import.meta.dirname}/vj-tweak.mjs`;

/** recipe ファイルの置き場所。既定はリポジトリ直下の recipes/。env でテスト用に差し替え可能。 */
const RECIPES_DIR = process.env.VJ_RECIPES_DIR ?? `${import.meta.dirname}/../recipes`;

/** catalog キャッシュ。vj-gen.mjs / vj-tweak.mjs と同じファイルを共有する。 */
const CATALOG_CACHE_PATH = `${import.meta.dirname}/.vj-catalog-cache.json`;

/**
 * apply --dry-run で catalog キャッシュが使えるときに vj-gen.mjs 子プロセスへ渡す
 * ダミー値。vj-gen.mjs は --url が無いと即エラーになる契約だが、catalog キャッシュが
 * 命中する限りこの値が実際にネットワーク接続へ使われることはない（vj-gen.mjs 自身も
 * --refresh-catalog を渡さない限りキャッシュ優先で読むため）。
 */
const OFFLINE_DUMMY_URL = 'ws://offline-dry-run.invalid';

const USAGE = `使い方: node vj-recipe.mjs list
       node vj-recipe.mjs show <name>
       node vj-recipe.mjs apply <name> [--url <ws(s)://…>] [--dry-run] [--refresh-catalog]
       node vj-recipe.mjs --help

recipe（${RECIPES_DIR}/<name>.json）は「気分語 + seed + vj-tweak.mjs 形式の <change>
トークン列」という作り直し可能な小さな指示書。生の Patch JSON を直接保存しない —
catalog の generator version が上がっても腐らないようにするため、毎回
vj-gen.mjs で作り直してから tweaks を重ねる。

コマンド:
  list                  recipes/*.json を一覧表示する（通信なし）
  show <name>            recipe の中身を検証して表示する（通信なし）
  apply <name>            mood+seed から base patch を作り、tweaks を適用して送る

apply のオプション:
  --url <ws(s)://…>     接続先（省略時は環境変数 VJ_URL を使う。--dry-run は catalog
                         キャッシュ（${CATALOG_CACHE_PATH}）があれば省略可）
  --dry-run              検証だけ行い、通れば draft を stdout に出して送信しない
                         （catalog キャッシュがあればネットワーク不要）
  --refresh-catalog      catalog キャッシュを無視して取り直す（--dry-run でも通信する）
  --help                 このヘルプ

例:
  node vj-recipe.mjs list
  node vj-recipe.mjs show humid-qilou-night
  node vj-recipe.mjs apply humid-qilou-night --url wss://example.workers.dev/room/xxxx --dry-run
  node vj-recipe.mjs apply humid-qilou-night --url wss://example.workers.dev/room/xxxx`;

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
const KNOWN_FLAGS = new Set(['help', 'dry-run', 'refresh-catalog', 'url']);

/**
 * `--flag value` / 真偽フラグ / 位置引数を解釈する。フラグ扱いするのは `--` 始まりだけ
 * （vj-ctl.mjs / vj-gen.mjs / vj-tweak.mjs と同じ判定）。
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

/** 整形 JSON を stdout に出す。vj-ctl.mjs の jsonOut に倣った命名。 */
function jsonOut(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// recipe ファイルの読み込み + 検証（list / show / apply 共通、通信なし）
// ---------------------------------------------------------------------------

/** `<name>.json` を読んで parseRecipe に通す。ファイル無し/JSON壊れ/schema NG のいずれも issues として返す（例外は投げない）。 */
function loadRecipeFile(name) {
  const filePath = join(RECIPES_DIR, `${name}.json`);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, issues: [`recipe "${name}" not found (${filePath}): ${e.message}`] };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      issues: [`recipe "${name}" is not valid JSON (${filePath}): ${e.message}`],
    };
  }
  const parsed = parseRecipe(json);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues.map((issue) => `${filePath}: ${issue}`) };
  }
  return { ok: true, recipe: parsed.recipe, filePath };
}

// ---------------------------------------------------------------------------
// list / show（通信なし。vj-gen.mjs / vj-tweak.mjs / catalog には一切触れない）
// ---------------------------------------------------------------------------

function cmdList() {
  let files;
  try {
    files = readdirSync(RECIPES_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (e) {
    process.stderr.write(
      `vj-recipe: recipes ディレクトリの読み込みに失敗しました (${RECIPES_DIR}): ${e.message}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const lines = [];
  for (const file of files) {
    const name = file.slice(0, -'.json'.length);
    const loaded = loadRecipeFile(name);
    if (!loaded.ok) {
      process.stderr.write(`vj-recipe: skipping "${file}" (invalid recipe):\n`);
      for (const issue of loaded.issues) process.stderr.write(`  - ${issue}\n`);
      continue;
    }
    const { recipe } = loaded;
    lines.push(`${recipe.name} — ${recipe.notes ? recipe.notes : '(no notes)'}`);
  }
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdShow(name) {
  if (!name) usageError('show には recipe 名を1つ指定してください');
  const loaded = loadRecipeFile(name);
  if (!loaded.ok) {
    jsonOut({ ok: false, issues: loaded.issues });
    for (const issue of loaded.issues) process.stderr.write(`- ${issue}\n`);
    process.exitCode = 1;
    return;
  }
  jsonOut(loaded.recipe);
}

// ---------------------------------------------------------------------------
// apply（唯一、通信し得るコマンド）
// ---------------------------------------------------------------------------

/** vj-ctl.mjs を子プロセスとして叩き、stdout/stderr/status をキャプチャする。 */
function runVjCtl(url, command, extraArgs = []) {
  return spawnSync(process.execPath, [VJ_CTL_PATH, '--url', url, command, ...extraArgs], {
    encoding: 'utf8',
  });
}

/** vj-ctl.mjs 側の失敗をそのまま伝播する。 */
function propagateFailure(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}

/**
 * catalog キャッシュを読めるだけ読む。無い/壊れている場合は null（例外は投げない）。
 * --dry-run で --url/VJ_URL が無いときに「キャッシュがあるかどうか」を事前判定するため
 * にも使う（vj-gen.mjs / vj-tweak.mjs が読むのと同じファイル）。
 */
function readCachedCatalog() {
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_CACHE_PATH, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // キャッシュ未作成 or 壊れている
  }
  return null;
}

/**
 * catalog を読む（vj-gen.mjs / vj-tweak.mjs と同じキャッシュ優先ロジックの複製）。
 * tweaks を適用するには generator の存在・parameter 定義が要るため、apply では
 * vj-gen.mjs のサブプロセスとは別に、ここでも自前で catalog を読む。
 */
function loadCatalog(url, refreshCache) {
  if (!refreshCache) {
    const cached = readCachedCatalog();
    if (cached) return { ok: true, catalog: cached };
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
      `vj-recipe: catalog キャッシュの書き込みに失敗しました（続行には影響しません）: ${e.message}\n`,
    );
  }
  return { ok: true, catalog };
}

async function cmdApply(name, flags) {
  if (!name) usageError('apply には recipe 名を1つ指定してください');

  const loaded = loadRecipeFile(name);
  if (!loaded.ok) {
    jsonOut({ ok: false, issues: loaded.issues });
    for (const issue of loaded.issues) process.stderr.write(`- ${issue}\n`);
    process.exitCode = 1;
    return;
  }
  const { recipe } = loaded;

  // --url / VJ_URL は「引数の誤り」ではなく実行時条件として扱う（vj-gen.mjs / vj-tweak.mjs と同じ）。
  const dryRun = flags.has('dry-run');
  const refreshCatalog = flags.has('refresh-catalog');
  let url = flags.has('url') ? flags.get('url') : process.env.VJ_URL;

  if (!url) {
    if (refreshCatalog) {
      // --refresh-catalog は明示的な取り直し要求 = 必ず通信する。--dry-run でも例外なし。
      process.stderr.write(
        'vj-recipe: --refresh-catalog は catalog を取り直すため --url（または VJ_URL）が必要です\n',
      );
      process.exitCode = 1;
      return;
    }
    if (dryRun && readCachedCatalog() !== null) {
      // --dry-run は送信しない。catalog キャッシュがあるならネットワークに一切触れず
      // 完結できる。vj-gen.mjs 子プロセスは --url が無いと即エラーになる契約なので、
      // ダミー値を渡す（キャッシュ命中で完結するため実際に使われることはない）。
      url = OFFLINE_DUMMY_URL;
    } else if (dryRun) {
      process.stderr.write(
        `vj-recipe: --dry-run でも catalog が必要です。--url を指定するか、一度オンライン` +
          `で実行してキャッシュ（${CATALOG_CACHE_PATH}）を作ってください\n`,
      );
      process.exitCode = 1;
      return;
    } else {
      process.stderr.write('vj-recipe: --url が指定されておらず、環境変数 VJ_URL もありません\n');
      process.exitCode = 1;
      return;
    }
  }

  // --- 1) base patch: vj-gen.mjs を子プロセスとして呼ぶ ---
  const genArgs = [VJ_GEN_PATH, '--url', url, '--seed', recipe.seed, '--dry-run'];
  if (refreshCatalog) genArgs.push('--refresh-catalog');
  genArgs.push(...recipe.mood);
  const genResult = spawnSync(process.execPath, genArgs, { encoding: 'utf8' });
  if (genResult.status !== 0) {
    if (genResult.stdout) process.stdout.write(genResult.stdout);
    if (genResult.stderr) process.stderr.write(genResult.stderr);
    process.exitCode = genResult.status ?? 1;
    return;
  }
  let basePatch;
  try {
    basePatch = JSON.parse(genResult.stdout);
  } catch (e) {
    process.stderr.write(`vj-recipe: vj-gen.mjs の出力の JSON 解析に失敗しました: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  // --- 2) catalog（tweaks 適用・検証に使う） ---
  const catalogLoad = loadCatalog(url, refreshCatalog);
  if (!catalogLoad.ok) {
    if (catalogLoad.result) {
      propagateFailure(catalogLoad.result);
    } else {
      process.stderr.write(
        `vj-recipe: catalog の JSON 解析に失敗しました: ${catalogLoad.parseError.message}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  const catalogArray = catalogLoad.catalog;
  const catalogMap = new Map(catalogArray.map((def) => [def.id, def]));

  // --- 3) vj-tweak.mjs / vj-gen.mjs の純粋関数を動的 import ---
  // list / show では絶対に読み込まない（apply の中でだけ import する）。
  const vjTweak = await import(pathToFileURL(VJ_TWEAK_PATH).href);
  const vjGen = await import(pathToFileURL(VJ_GEN_PATH).href);

  // --- 4) draft = base patch + tweaks（vj-tweak.mjs main() の逐次適用ループと同じ形） ---
  const draft = structuredClone(basePatch);
  const currentIds = new Set(draft.operators.map((op) => op.id));
  const errors = [];

  for (const raw of recipe.tweaks) {
    const change = vjTweak.classifyChange(raw);
    if (change.error) {
      errors.push(change.error);
      continue;
    }
    vjTweak.applyChange(raw, change, draft, currentIds, catalogMap, errors);
  }

  // operator の差し替え・削除で実在しなくなった route を掃除する（黙って消さない）。
  vjTweak.reconcileRoutes(draft, catalogMap);
  vjTweak.runPatchLevelChecks(draft, catalogMap, errors);
  // vj-gen.mjs 側のフルの検証（ステージ順まで見る、runPatchLevelChecks の上位互換）を
  // 最終安全網として重ねる。
  errors.push(...vjGen.validatePatchLocal(draft, catalogArray));

  if (errors.length > 0) {
    jsonOut({ ok: false, issues: errors });
    for (const err of errors) process.stderr.write(`- ${err}\n`);
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    jsonOut(draft);
    return;
  }

  // --- 5) 送信 ---
  let tmpDir;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'vj-recipe-'));
    const tmpFile = join(tmpDir, 'patch.json');
    writeFileSync(tmpFile, JSON.stringify(draft, null, 2));
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
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  try {
    const { positional, flags } = parseArgv(process.argv.slice(2));

    if (flags.has('help')) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }

    const [command, ...rest] = positional;
    if (!command) usageError('command を1つ指定してください（list / show / apply）');

    switch (command) {
      case 'list':
        cmdList();
        return;
      case 'show':
        cmdShow(rest[0]);
        return;
      case 'apply':
        await cmdApply(rest[0], flags);
        return;
      default:
        usageError(`不明な command: "${command}"（list / show / apply のいずれか）`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`vj-recipe: ${e.message}\n\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    // 想定外の例外は握りつぶさずそのまま投げる（Node のデフォルト処理で exit code が立つ）。
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // main は async（apply が動的 import を待つため）。想定外の例外は握りつぶさずそのまま
  // 投げたいので .catch では揉み消さず、void で「意図的に await しない」ことだけ明示する
  // （Node は既定で unhandled rejection を uncaught exception と同様に扱い、非 0 exit で落ちる）。
  void main();
}
