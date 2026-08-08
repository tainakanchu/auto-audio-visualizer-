// vj-gen.mjs の音声反応セーフティルールの回帰テスト。
//
// derive.ts と揃えたはずのルールが実際には効いていなかった過去のバグ（ROUTE_SOURCES に
// audio:beatPhase/barPhase が混入・target に許可リストが無い・polarity が bipolar にも
// なり得た・motion 系パラメータの振り幅に上限が無かった・AUDIO_SOURCES から
// audio:beatIntensity が抜けていてローカル検証が弾いていた）が全て再発しないことを見る。
//
// vj-ctl.mjs をネットワーク不要のスタブに差し替え、実際の CLI を子プロセスとして
// 起動して stdout/stderr を検証する（vj-tweak.test.mjs と同じ安全策: 本物の
// scripts/.vj-catalog-cache.json は beforeEach/afterEach で退避・復元し、
// 開発者のローカル環境を汚さない）。ライブの VJ_URL には一切接続しない。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MOTION_RATIO_MAX, MOTION_TARGET_PARAMS, ROUTE_SOURCES } from './vj-gen.mjs';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const VJ_GEN_PATH = join(SCRIPT_DIR, 'vj-gen.mjs');
const REAL_CACHE_PATH = join(SCRIPT_DIR, '.vj-catalog-cache.json');

// SAFE_TARGET_PARAMS 許可リストの中の paramId（増える = 見える/動く 方向）。
const SAFE_PARAM_IDS = ['amount', 'speed', 'scale', 'intensity'];
// modulatable だが許可リストには**わざと**入れていない paramId。derive.ts のコメントが
// 挙げる「上げると絵が消える」パラメータの実例に倣った名前（threshold/gate/dropout）。
const UNSAFE_PARAM_IDS = ['threshold', 'gate', 'dropout'];

/**
 * source/field/modifier/material の各プールをちょうど 1 個の Generator にすることで、
 * 「どの seed でもこの Generator が選ばれる」を保証する（重み付き抽出でも候補が
 * 1 個しかなければ結果は一意）。プールを 1 個に絞ることで、route の候補集合が
 * このフィクスチャで設計した通りのものになることが seed に依存せず言える。
 */
const FIXTURE_CATALOG = [
  {
    id: 'noiseSource',
    version: 1,
    category: 'source',
    tags: {},
    parameters: [
      { id: 'amount', kind: 'number', min: 0, max: 1, default: 0.5, modulatable: true },
      { id: 'threshold', kind: 'number', min: 0, max: 1, default: 0.1, modulatable: true },
    ],
  },
  {
    id: 'driftField',
    version: 1,
    category: 'field',
    tags: {},
    parameters: [
      { id: 'speed', kind: 'number', min: 0.1, max: 4, default: 1, modulatable: true },
      { id: 'gate', kind: 'number', min: 0, max: 1, default: 0.1, modulatable: true },
    ],
  },
  {
    id: 'sliceModifier',
    version: 1,
    category: 'modifier',
    tags: {},
    parameters: [
      { id: 'scale', kind: 'number', min: 0.5, max: 8, default: 2, modulatable: true },
      { id: 'dropout', kind: 'number', min: 0, max: 1, default: 0.05, modulatable: true },
    ],
  },
  {
    id: 'glazeMaterial',
    version: 1,
    category: 'material',
    tags: {},
    parameters: [
      { id: 'intensity', kind: 'number', min: 0, max: 1, default: 0.5, modulatable: true },
    ],
  },
];

/** vj-ctl.mjs のネットワーク I/O をスタブする偽実装。catalog だけを返す（--base は使わないので state は不要）。 */
function stubSource() {
  return `
// vj-gen.mjs は vj-ctl.mjs を [VJ_CTL_PATH, '--url', url, command, ...] で spawn する。
// 子プロセスの argv は [node, script, '--url', url, command, ...] なので index 4。
const command = process.argv[4];
if (command === 'catalog') {
  process.stdout.write(JSON.stringify(${JSON.stringify(FIXTURE_CATALOG)}));
  process.exit(0);
}
process.stderr.write('stub-vj-ctl: unexpected command "' + command + '" (this suite only allows catalog)\\n');
process.exit(1);
`;
}

let tmpDir;
let stubPath;
let savedCache; // Buffer | undefined — undefined means "本物のキャッシュは無かった"

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vj-gen-test-'));
  stubPath = join(tmpDir, 'vj-ctl-stub.mjs');
  writeFileSync(stubPath, stubSource());
  // --refresh-catalog を必ず付けるので実際には読まれないはずだが、本物の
  // scripts/.vj-catalog-cache.json を書き換えてしまう副作用(loadCatalog のベスト
  // エフォート書き戻し)から開発者のローカル環境を守るため、退避しておく。
  try {
    savedCache = readFileSync(REAL_CACHE_PATH);
  } catch {
    savedCache = undefined;
  }
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedCache === undefined) {
    try {
      rmSync(REAL_CACHE_PATH);
    } catch {
      // 元々無かったので、無ければ何もしなくてよい
    }
  } else {
    writeFileSync(REAL_CACHE_PATH, savedCache);
  }
});

function runVjGen(args) {
  return spawnSync(
    process.execPath,
    [VJ_GEN_PATH, '--url', 'ws://stub.invalid/room/test', '--refresh-catalog', ...args],
    { encoding: 'utf8', env: { ...process.env, VJ_CTL_PATH: stubPath } },
  );
}

function parseTarget(target) {
  const dot = target.indexOf('.');
  return { opId: target.slice(0, dot), paramId: target.slice(dot + 1) };
}

describe('vj-gen.mjs audio-reactive safety rules', () => {
  it('every route across a large batch respects the allow-list, unipolar-only, motion cap, and real route sources', () => {
    const result = runVjGen(['--seed', 'safety-fixture', '--count', '30', '雲 静寂 青']);

    expect(result.status).toBe(0);
    const results = JSON.parse(result.stdout);
    // 30 件すべてが results に載っている = ローカル検証で 1 件も落ちていない。
    expect(results).toHaveLength(30);

    const catalogMap = new Map(FIXTURE_CATALOG.map((d) => [d.id, d]));
    let routeCount = 0;
    let motionRouteCount = 0;

    for (const { patch } of results) {
      const opDefById = new Map(
        patch.operators.map((op) => [op.id, catalogMap.get(op.generatorId)]),
      );
      for (const route of patch.routes) {
        routeCount++;

        // 4f: polarity は常に unipolar（bipolar のロールは削除済み）。
        expect(route.polarity).toBe('unipolar');

        // 4a: source は実際の ROUTE_SOURCES のみ。audio:beatPhase/barPhase は
        // テンポグリッドのノコギリ波で無音でも回り続けるため候補から除外済み。
        expect(ROUTE_SOURCES).toContain(route.source);
        expect(route.source).not.toBe('audio:beatPhase');
        expect(route.source).not.toBe('audio:barPhase');

        // 4c/4e: target の paramId は許可リストのみ。threshold/gate/dropout の
        // ような「上げると絵が消える」パラメータは候補にすら入らない。
        const { opId, paramId } = parseTarget(route.target);
        expect(SAFE_PARAM_IDS).toContain(paramId);
        expect(UNSAFE_PARAM_IDS).not.toContain(paramId);

        // 4f: motion 系パラメータは振り幅に上限(MOTION_RATIO_MAX)がある。
        if (MOTION_TARGET_PARAMS.has(paramId)) {
          motionRouteCount++;
          const paramDef = opDefById.get(opId).parameters.find((p) => p.id === paramId);
          const ratio = route.amount / (paramDef.max - paramDef.min);
          expect(ratio).toBeLessThanOrEqual(MOTION_RATIO_MAX + 1e-9);
        }
      }
    }

    // フィクスチャの route 候補は非ゼロ(全 operator が modulatable なパラメータを
    // 持つ)なので、30 件も生成すれば route も motion route も最低 1 本は出る —
    // これが 0 のままだとテスト自体がフィクスチャ設計ミスで無意味になる。
    expect(routeCount).toBeGreaterThan(0);
    expect(motionRouteCount).toBeGreaterThan(0);
  });

  it('regression: a route sourced from audio:beatIntensity passes local validation (AUDIO_SOURCES used to be missing it)', () => {
    // AUDIO_SOURCES に audio:beatIntensity が無かった頃は、この source を引いた
    // candidate は丸ごとローカル検証で弾かれ、--count の出力から消えていた
    // (results.length < n になる)。同じバッチの中に audio:beatIntensity の route
    // が実在し、かつ 30 件全部が results に載っていることの両方を見て、
    // 「弾かれずに通った」ことを確認する。
    const result = runVjGen(['--seed', 'safety-fixture', '--count', '30', '雲 静寂 青']);

    expect(result.status).toBe(0);
    const results = JSON.parse(result.stdout);
    expect(results).toHaveLength(30);

    const beatIntensityRoutes = results.flatMap(({ patch }) =>
      patch.routes.filter((r) => r.source === 'audio:beatIntensity'),
    );
    expect(beatIntensityRoutes.length).toBeGreaterThan(0);
  });
});
