#!/usr/bin/env node
/**
 * vj-validate — VisualPatch の JSON を、送るより前にサーバ側と**同じ**検証ゲートに
 * かけてローカルで確認する CLI。
 *
 * `gatePatchProposal`（src/synth/apply.ts）が本番でやっているのと同じ 3 段階を
 * そのままなぞる:
 *   1. parsePatch    （src/synth/schema.ts）  — スキーマ（valibot）。issues は string[]
 *   2. validatePatch （src/synth/validate.ts）— 構造ルール（id 一意性・generator 実在・
 *                                               ステージ順・員数・パラメータ型域・route・
 *                                               画像テクスチャスロット参照）
 *   3. fitsBudget(estimateCost(...))（src/synth/cost.ts）— コスト / render budget
 *
 * vj-gen.mjs / vj-tweak.mjs のローカル検証は、この 2 と 3 相当を「CLI は .ts を
 * import できない」という前提のもとで手で複製したもの（3 は複製すらされておらず、
 * ローカル検証には budget チェックが**存在しない**）。この前提は誤りで、このスクリプト
 * は Vite の SSR モジュールローダー（`server.ssrLoadModule`、measure-coverage.mjs と
 * 同じ手法）で src/synth/{schema,validate,cost,catalog,generators/index}.ts を
 * そのまま実行する。複製ではなく本物を呼ぶので、サーバ側のルールが変わってもここが
 * 古くなることは構造的に無い。budget チェックも本物なので、ローカル検証では絶対に
 * 拾えなかった「サーバに送ったら render budget 超過で弾かれる」を送信前に検出できる。
 *
 * 出力の約束:
 *   - OK  → `[OK] <file>` の下に、operator 構成（category:generatorId の並び）・
 *           estimated cost（total/passes/heavy/stateful）・qualityTier を 1 ブロックで表示
 *   - NG  → `[NG] <file>` の下に、失敗した段階（json/schema/structural/budget）ごとの
 *           issue を列挙。budget 起因の NG はさらに実測コストと budget の上限を
 *           構造化した行で必ず表示する（message 文字列に頼らない）
 *   - 全ファイル OK → exit 0 / いずれか NG → exit 1
 *   - stdout は結果表示専用、Vite SSR の起動時間などの付帯情報は stderr に出す
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createServer } from 'vite';

const USAGE = `使い方: node vj-validate.mjs <file.json>... [options]
       node vj-validate.mjs --stdin [options]
       node vj-validate.mjs --help

VisualPatch の JSON ファイルを、送信前にサーバ側の proposePatch と同じ検証ゲート
（parsePatch → validatePatch → fitsBudget(estimateCost(...))、src/synth/apply.ts の
gatePatchProposal と同じ並び）にかけてローカルで確認する。vj-gen.mjs / vj-tweak.mjs の
ローカル検証と違い、Vite の SSR モジュールローダーで src/synth/ 配下の .ts を直接
実行するので複製ではない。budget/cost チェック（vj-gen.mjs / vj-tweak.mjs のローカル
検証には無い）も行う。

オプション:
  --stdin               1 つの patch を stdin から読む（file 引数とは同時に指定できない）
  --quality <tier>       budget チェックに使う tier を上書きする（low/medium/high）。
                         省略時は各 patch 自身の qualityTier を使う（本番の
                         proposePatch と同じ挙動 — src/scenes/semanticSynth.ts が
                         DEFAULT_BUDGETS[parsed.patch.qualityTier] を渡しているのに
                         合わせてある）。estimateCost 自体は常に patch.qualityTier を
                         見るので、これは「この patch がより厳しい tier で判定されたら
                         生き残るか」を見るための what-if 専用オプション。
  --help                 このヘルプ

例:
  node vj-validate.mjs patch.json
  node vj-validate.mjs dir/*.json
  node vj-validate.mjs --stdin < patch.json
  node vj-validate.mjs --quality low patch.json`;

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

const BOOLEAN_FLAGS = new Set(['help', 'stdin']);
const KNOWN_FLAGS = new Set(['help', 'stdin', 'quality']);

/** `--flag value` / 真偽フラグ / 位置引数を解釈する（vj-ctl.mjs 系と同じ判定）。 */
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
// 表示
// ---------------------------------------------------------------------------

/** 小数を程よい桁数に丸める（total は relativeFill × scale² の積なので割り切れないことが多い）。 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

function formatCostLine(estimate, budget, tierLabel) {
  return (
    `estimated: total=${round2(estimate.total)} passes=${estimate.passes} ` +
    `heavy=${estimate.heavy} stateful=${estimate.stateful}  ` +
    `budget(${tierLabel}): maxCost=${budget.maxCost} maxPasses=${budget.maxPasses} ` +
    `maxHeavyGenerators=${budget.maxHeavyGenerators} maxStatefulGenerators=${budget.maxStatefulGenerators}`
  );
}

/** NG: 段階ラベル付きで issue を列挙する。budgetCtx があれば実測コスト行も添える。 */
function printNg(label, lines, budgetCtx) {
  process.stdout.write(`[NG] ${label}\n`);
  for (const line of lines) process.stdout.write(`  - ${line}\n`);
  if (budgetCtx) {
    process.stdout.write(
      `  ${formatCostLine(budgetCtx.estimate, budgetCtx.budget, budgetCtx.tierLabel)}\n`,
    );
  }
}

/** OK: operator 構成・estimated cost・qualityTier を 1 ブロックで表示する。 */
function printOk(label, patch, catalog, estimate, tierLabel, qualityOverridden) {
  const ops = patch.operators
    .map((op) => {
      const def = catalog.get(op.generatorId);
      return `${def ? def.category : '?'}:${op.generatorId}`;
    })
    .join(' -> ');
  const overrideNote = qualityOverridden ? ` (checked against --quality ${tierLabel})` : '';

  process.stdout.write(`[OK] ${label}\n`);
  process.stdout.write(`  operators: ${ops || '(none)'}\n`);
  process.stdout.write(
    `  estimated: total=${round2(estimate.total)} passes=${estimate.passes} ` +
      `heavy=${estimate.heavy} stateful=${estimate.stateful}\n`,
  );
  process.stdout.write(`  qualityTier: ${patch.qualityTier}${overrideNote}\n`);
}

// ---------------------------------------------------------------------------
// 検証本体 — gatePatchProposal（src/synth/apply.ts）と同じ 3 段の順で自前に流す。
// gatePatchProposal をそのまま呼ばないのは、OK ケースでも estimateCost を出したい
// （gatePatchProposal は budget 違反のときしか cost を計算した形跡を返さない）ため。
// ---------------------------------------------------------------------------

function validateOne(input, modules, qualityOverride) {
  const { label, text } = input;
  const { schemaMod, validateMod, costMod, catalog } = modules;

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    printNg(label, [`json: ${e instanceof Error ? e.message : String(e)}`]);
    return false;
  }

  // 1. schema — parsePatch の issues は string[]（valibot 由来）。他の 2 段と型が
  // 違うので "schema:" を必ず前置して区別する。
  const parsed = schemaMod.parsePatch(raw);
  if (!parsed.ok) {
    printNg(
      label,
      parsed.issues.map((message) => `schema: ${message}`),
    );
    return false;
  }
  const patch = parsed.patch;

  // 2. structural — ValidationIssue[]（code/message/path）。
  const structuralIssues = validateMod.validatePatch(patch, catalog);
  if (structuralIssues.length > 0) {
    printNg(
      label,
      structuralIssues.map(
        (i) => `structural[${i.code}]: ${i.message}${i.path ? ` (${i.path})` : ''}`,
      ),
    );
    return false;
  }

  // 3. budget — 本番と同じく既定は patch 自身の qualityTier。--quality は
  // fitsBudget に渡す budget だけを差し替える what-if（estimateCost は
  // patch.qualityTier を内部で読むので、ここでは変わらない）。
  const tierLabel = qualityOverride ?? patch.qualityTier;
  const budget = costMod.DEFAULT_BUDGETS[tierLabel];
  const estimate = costMod.estimateCost(patch, catalog);
  const budgetIssues = costMod.fitsBudget(estimate, budget);

  if (budgetIssues.length > 0) {
    printNg(
      label,
      budgetIssues.map((i) => `budget[${i.code}]: ${i.message}${i.path ? ` (${i.path})` : ''}`),
      { estimate, budget, tierLabel },
    );
    return false;
  }

  printOk(label, patch, catalog, estimate, tierLabel, qualityOverride !== undefined);
  return true;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function readTextFile(filePath) {
  return readFileSync(filePath, 'utf8');
}

async function main() {
  try {
    const { positional, flags } = parseArgv(process.argv.slice(2));

    if (flags.has('help')) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }

    const useStdin = flags.has('stdin');
    if (useStdin && positional.length > 0) {
      usageError('--stdin と file 引数は同時に指定できません');
    }
    if (!useStdin && positional.length === 0) {
      usageError('file を1つ以上指定するか --stdin を使ってください');
    }

    const root = path.resolve(import.meta.dirname, '..');
    const overallStarted = Date.now();
    const server = await createServer({
      configFile: false,
      root,
      server: { middlewareMode: true, watch: null },
      appType: 'custom',
      logLevel: 'error',
    });

    try {
      const ssrStarted = Date.now();
      const [schemaMod, validateMod, costMod, catalogMod, generatorsMod] = await Promise.all([
        server.ssrLoadModule('/src/synth/schema.ts'),
        server.ssrLoadModule('/src/synth/validate.ts'),
        server.ssrLoadModule('/src/synth/cost.ts'),
        server.ssrLoadModule('/src/synth/catalog.ts'),
        server.ssrLoadModule('/src/synth/generators/index.ts'),
      ]);
      const ssrMs = Date.now() - ssrStarted;
      process.stderr.write(
        `vj-validate: vite ssr ready in ${ssrMs}ms (createServer ${ssrStarted - overallStarted}ms)\n`,
      );

      if (flags.has('quality') && !(flags.get('quality') in costMod.DEFAULT_BUDGETS)) {
        usageError(`--quality は ${Object.keys(costMod.DEFAULT_BUDGETS).join('/')} のいずれかです`);
      }
      const qualityOverride = flags.has('quality') ? flags.get('quality') : undefined;

      const catalog = catalogMod.createCatalog(generatorsMod.allGeneratorDefinitions());

      const inputs = [];
      if (useStdin) {
        inputs.push({ label: '(stdin)', text: readFileSync(0, 'utf8') });
      } else {
        for (const filePath of positional) {
          try {
            inputs.push({ label: filePath, text: readTextFile(filePath) });
          } catch (e) {
            printNg(filePath, [
              `file: cannot read (${e instanceof Error ? e.message : String(e)})`,
            ]);
            process.exitCode = 1;
          }
        }
      }

      const modules = { schemaMod, validateMod, costMod, catalog };
      let okCount = 0;
      for (const input of inputs) {
        const ok = validateOne(input, modules, qualityOverride);
        if (ok) okCount++;
        else process.exitCode = 1;
      }

      if (inputs.length > 1) {
        process.stdout.write(`\n${okCount}/${inputs.length} OK\n`);
      }
    } finally {
      await server.close();
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`vj-validate: ${e.message}\n\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `vj-validate: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
