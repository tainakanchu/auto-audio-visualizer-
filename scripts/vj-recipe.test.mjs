// vj-recipe.mjs の CLI 契約（list/show は通信なし・apply --dry-run は検証を通った
// draft を返す・不正な recipe はクラッシュせず ok:false で返す）のテスト。
// vj-ctl.mjs をネットワーク不要のスタブに差し替え、実際の CLI を子プロセスとして
// 起動して stdout/stderr/exit code を検証する。ライブの VJ_URL には一切接続しない。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const VJ_RECIPE_PATH = join(SCRIPT_DIR, 'vj-recipe.mjs');

// vj-tweak.test.mjs と同じ最小カタログ。vj-gen.mjs（base patch 生成）・
// vj-recipe.mjs（tweaks 適用）の両方がこの一枚だけを見ればいいように、
// source/field/modifier/material を最低1個ずつ揃えてある。
const FIXTURE_CATALOG = [
  {
    id: 'noiseSource',
    version: 1,
    category: 'source',
    tags: {},
    parameters: [{ id: 'amount', kind: 'number', min: 0, max: 1, default: 0.5, modulatable: true }],
  },
  {
    id: 'sway',
    version: 1,
    category: 'field',
    tags: {},
    parameters: [{ id: 'freq', kind: 'number', min: 0.5, max: 4, default: 1, modulatable: true }],
  },
  {
    id: 'repeat',
    version: 1,
    category: 'modifier',
    tags: {},
    parameters: [{ id: 'count', kind: 'int', min: 1, max: 8, default: 1, modulatable: false }],
  },
  {
    id: 'bathroomGlaze',
    version: 1,
    category: 'material',
    tags: {},
    parameters: [{ id: 'tint', kind: 'number', min: 0, max: 1, default: 0.2, modulatable: true }],
  },
];

/** vj-ctl.mjs のネットワーク I/O をスタブする偽実装。catalog だけを返す（state は使わない）。 */
function stubSource() {
  return `
const command = process.argv[4];
if (command === 'catalog') {
  process.stdout.write(JSON.stringify(${JSON.stringify(FIXTURE_CATALOG)}));
  process.exit(0);
}
process.stderr.write('stub-vj-ctl: unexpected command "' + command + '" (this suite only allows catalog)\\n');
process.exit(1);
`;
}

const FIXTURE_RECIPE = {
  name: 'fixture-recipe',
  mood: ['雲'],
  seed: 'fixture-seed-v1',
  tweaks: ['mat0.tint=0.9', 'mod0.count=3', '+sway:fld1', 'fld1.freq=2'],
  notes: 'fixture note for vj-recipe tests',
};

const BAD_RECIPE = {
  name: 'bad-recipe',
  mood: ['雲'],
  seed: 'fixture-seed-v1',
  tweaks: ['src0:=nonexistentGenerator'],
  notes: 'tweaks reference a generator not in the fixture catalog',
};

let tmpDir;
let stubPath;
let recipesDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vj-recipe-test-'));
  stubPath = join(tmpDir, 'vj-ctl-stub.mjs');
  writeFileSync(stubPath, stubSource());

  recipesDir = join(tmpDir, 'recipes');
  mkdirSync(recipesDir);
  writeFileSync(join(recipesDir, 'fixture-recipe.json'), JSON.stringify(FIXTURE_RECIPE, null, 2));
  writeFileSync(join(recipesDir, 'bad-recipe.json'), JSON.stringify(BAD_RECIPE, null, 2));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runVjRecipe(args, { withNetworkStub = true } = {}) {
  const env = { ...process.env, VJ_RECIPES_DIR: recipesDir };
  if (withNetworkStub) {
    env.VJ_CTL_PATH = stubPath;
    env.VJ_URL = 'ws://stub.invalid/room/test';
  } else {
    // list/show が本当に通信しないことを確認するため、わざと壊れた
    // VJ_CTL_PATH を渡す（叩かれたら子プロセス起動自体が失敗して見える化する）。
    env.VJ_CTL_PATH = join(tmpDir, 'does-not-exist.mjs');
  }
  return spawnSync(process.execPath, [VJ_RECIPE_PATH, ...args], { encoding: 'utf8', env });
}

describe('vj-recipe.mjs list', () => {
  it('shows a fixture recipe name + notes and touches no network', () => {
    const result = runVjRecipe(['list'], { withNetworkStub: false });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('fixture-recipe — fixture note for vj-recipe tests');
    expect(result.stdout).toContain(
      'bad-recipe — tweaks reference a generator not in the fixture catalog',
    );
  });
});

describe('vj-recipe.mjs show', () => {
  it('prints the validated recipe and touches no network', () => {
    const result = runVjRecipe(['show', 'fixture-recipe'], { withNetworkStub: false });
    expect(result.status).toBe(0);
    const printed = JSON.parse(result.stdout);
    expect(printed).toEqual(FIXTURE_RECIPE);
  });

  it('fails cleanly (no crash/stack trace) for an unknown recipe name', () => {
    const result = runVjRecipe(['show', 'does-not-exist'], { withNetworkStub: false });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/at .*vj-recipe\.mjs/); // no unhandled-exception stack trace
    const printed = JSON.parse(result.stdout);
    expect(printed.ok).toBe(false);
    expect(printed.issues.length).toBeGreaterThan(0);
  });
});

describe('vj-recipe.mjs apply', () => {
  it('--dry-run succeeds and prints a valid draft patch with tweaks applied', () => {
    const result = runVjRecipe(['apply', 'fixture-recipe', '--dry-run', '--refresh-catalog']);
    expect(result.status).toBe(0);
    const draft = JSON.parse(result.stdout);
    expect(draft.seed).toBe('fixture-seed-v1');
    const mat0 = draft.operators.find((op) => op.id === 'mat0');
    expect(mat0.parameters.tint).toBe(0.9);
    const mod0 = draft.operators.find((op) => op.id === 'mod0');
    expect(mod0.parameters.count).toBe(3);
    const fld1 = draft.operators.find((op) => op.id === 'fld1');
    expect(fld1.generatorId).toBe('sway');
    expect(fld1.parameters.freq).toBe(2);
  });

  it('--dry-run fails with ok:false and a useful issue when a tweak references a nonexistent generator', () => {
    const result = runVjRecipe(['apply', 'bad-recipe', '--dry-run', '--refresh-catalog']);
    expect(result.status).toBe(1);
    const printed = JSON.parse(result.stdout);
    expect(printed.ok).toBe(false);
    expect(printed.issues.some((i) => i.includes('nonexistentGenerator'))).toBe(true);
    expect(result.stderr).toMatch(/nonexistentGenerator/);
  });

  it('fails cleanly (no crash/stack trace) for an unknown recipe name', () => {
    const result = runVjRecipe(['apply', 'totally-unknown', '--dry-run', '--refresh-catalog']);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/at .*vj-recipe\.mjs/);
    const printed = JSON.parse(result.stdout);
    expect(printed.ok).toBe(false);
  });
});

// --url も VJ_URL も渡さない実行。runVjRecipe は常に VJ_URL を付けるので、専用の
// ヘルパーで process.env から VJ_URL を確実に取り除く（withNetworkStub と同様、
// VJ_CTL_PATH は存在しないパスにして「叩かれたら見える化する」ようにしておく）。
// extraEnv で個別テストごとの env 上書き（VJ_CATALOG_CACHE_PATH 等）を追加できる。
function runVjRecipeWithoutUrl(args, extraEnv = {}) {
  const env = {
    ...process.env,
    VJ_RECIPES_DIR: recipesDir,
    VJ_CTL_PATH: join(tmpDir, 'does-not-exist.mjs'),
    ...extraEnv,
  };
  delete env.VJ_URL;
  return spawnSync(process.execPath, [VJ_RECIPE_PATH, ...args], { encoding: 'utf8', env });
}

describe('vj-recipe.mjs apply --dry-run without --url/VJ_URL (catalog cache)', () => {
  // 本物の scripts/.vj-catalog-cache.json には一切触れず、各テストが自分の tmpDir
  // 配下だけに置く隔離パスを VJ_CATALOG_CACHE_PATH 経由で渡す。vitest はテスト
  // ファイルを並列実行するため、vj-gen.test.mjs / vj-tweak.test.mjs が同じ実ファイルの
  // beforeEach/afterEach で退避・上書き・削除を行っていると競合しうる — mkdtempSync が
  // 呼び出しごとに一意なディレクトリを作るので、この隔離により衝突は起きない。

  it('succeeds offline (no network) when a catalog cache file exists', () => {
    const cachePath = join(tmpDir, 'catalog-cache.json');
    writeFileSync(cachePath, JSON.stringify(FIXTURE_CATALOG));
    const result = runVjRecipeWithoutUrl(['apply', 'fixture-recipe', '--dry-run'], {
      VJ_CATALOG_CACHE_PATH: cachePath,
    });
    expect(result.status).toBe(0);
    const draft = JSON.parse(result.stdout);
    expect(draft.seed).toBe('fixture-seed-v1');
    const mat0 = draft.operators.find((op) => op.id === 'mat0');
    expect(mat0.parameters.tint).toBe(0.9);
  });

  it('fails with exit 1 and a clear hint when no cache exists', () => {
    // 作成しない = 存在しないことが保証された隔離パス（tmpDir はこのテスト専用）。
    const cachePath = join(tmpDir, 'no-such-cache.json');
    const result = runVjRecipeWithoutUrl(['apply', 'fixture-recipe', '--dry-run'], {
      VJ_CATALOG_CACHE_PATH: cachePath,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--dry-run でも catalog が必要/);
  });

  it('still requires --url when --refresh-catalog is combined with --dry-run', () => {
    const cachePath = join(tmpDir, 'catalog-cache.json');
    writeFileSync(cachePath, JSON.stringify(FIXTURE_CATALOG));
    const result = runVjRecipeWithoutUrl(
      ['apply', 'fixture-recipe', '--dry-run', '--refresh-catalog'],
      { VJ_CATALOG_CACHE_PATH: cachePath },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--refresh-catalog/);
  });
});
