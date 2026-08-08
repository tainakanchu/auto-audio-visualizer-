// scripts/vj-set.mjs の `load` サブコマンドのサブプロセスレベルの回帰テスト。
// vj-tweak.test.mjs と同じパターン: vj-ctl.mjs をネットワーク不要のスタブに
// 差し替え（VJ_CTL_PATH）、実際の CLI (vj-set.mjs) を子プロセスとして起動して
// stdout/stderr/exit code を検証する。ライブの bridge/relay には一切接続しない。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const VJ_SET_PATH = join(SCRIPT_DIR, 'vj-set.mjs');
const REAL_CACHE_PATH = join(SCRIPT_DIR, '.vj-catalog-cache.json');

const FIXTURE_CATALOG = [
  {
    id: 'noiseSource',
    version: 1,
    category: 'source',
    parameters: [{ id: 'amount', kind: 'number', min: 0, max: 1, default: 0.5, modulatable: true }],
  },
  {
    id: 'repeat',
    version: 1,
    category: 'modifier',
    parameters: [{ id: 'count', kind: 'int', min: 1, max: 8, default: 1, modulatable: false }],
  },
  {
    id: 'bathroomGlaze',
    version: 1,
    category: 'material',
    parameters: [{ id: 'tint', kind: 'number', min: 0, max: 1, default: 0.2, modulatable: true }],
  },
];

function fixturePatch(hue) {
  return {
    schemaVersion: 1,
    seed: `fixture-${hue}`,
    operators: [
      { id: 'src0', generatorId: 'noiseSource', generatorVersion: 1, parameters: { amount: 0.5 } },
      { id: 'mod0', generatorId: 'repeat', generatorVersion: 1, parameters: { count: 1 } },
      { id: 'mat0', generatorId: 'bathroomGlaze', generatorVersion: 1, parameters: { tint: 0.2 } },
    ],
    routes: [],
    palette: { mode: 'mono', hueOffset: hue, saturation: 30, lightness: 50 },
    composition: { symmetry: 1, scale: 1, speed: 0.2 },
    qualityTier: 'medium',
  };
}

/** 検証ゲートで確実に落ちる patch（palette.mode が不正）。 */
function invalidPatch() {
  return {
    ...fixturePatch(0),
    palette: { mode: 'not-a-mode', hueOffset: 0, saturation: 30, lightness: 50 },
  };
}

/**
 * vj-ctl.mjs のネットワーク I/O をスタブする偽実装。
 * 呼び出しごとに argv を JSON 行として CALL_LOG_PATH（環境変数）へ追記する
 * ので、テスト側は「何回・どのコマンドが呼ばれたか」を検証できる。
 * STATE_FIXTURE_PATH（環境変数）に置いた JSON をそのまま `state` の応答にする。
 */
function stubSource() {
  return `
import { appendFileSync, readFileSync } from 'node:fs';

// vj-set.mjs は vj-ctl.mjs を [VJ_CTL_PATH, ...targetArgs, command, ...extraArgs] で
// spawn する。既定 (--url/--port 指定なし) なら targetArgs は空なので、
// 子プロセスの argv は [node, script, command, ...] になり、index 2 が command。
const command = process.argv[2];
const rest = process.argv.slice(3);

if (process.env.VJ_SET_TEST_CALL_LOG) {
  appendFileSync(process.env.VJ_SET_TEST_CALL_LOG, JSON.stringify({ command, rest }) + '\\n');
}

if (command === 'state') {
  const state = JSON.parse(readFileSync(process.env.VJ_SET_TEST_STATE_FIXTURE, 'utf8'));
  process.stdout.write(JSON.stringify(state));
  process.exit(0);
}
if (command === 'catalog') {
  process.stdout.write(JSON.stringify(${JSON.stringify(FIXTURE_CATALOG)}));
  process.exit(0);
}
if (command === 'event' && rest[0] === 'add') {
  process.stdout.write(JSON.stringify({ ok: true, event: { id: 'ctl-stub' } }) + '\\n');
  process.exit(0);
}
if (command === 'fire') {
  process.stdout.write(JSON.stringify({ ok: true, due: [] }) + '\\n');
  process.exit(0);
}
process.stderr.write('stub-vj-ctl: unexpected command "' + command + '" (this suite only allows state/catalog/event add/fire)\\n');
process.exit(1);
`;
}

let tmpDir;
let stubPath;
let callLogPath;
let stateFixturePath;
let savedCache; // Buffer | undefined — undefined means "本物のキャッシュは無かった"

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vj-set-test-'));
  stubPath = join(tmpDir, 'vj-ctl-stub.mjs');
  writeFileSync(stubPath, stubSource());
  callLogPath = join(tmpDir, 'calls.jsonl');
  stateFixturePath = join(tmpDir, 'state.json');
  // デフォルトの state fixture: 空の Timeline。個々のテストで上書きしてよい。
  writeFileSync(
    stateFixturePath,
    JSON.stringify({
      nowSec: 10,
      barCount: 2,
      timeline: { lockedUntilSec: 0, events: [] },
      firedIds: [],
    }),
  );
  // --refresh-catalog を必ず付けるので実際には読まれないはずだが、本物の
  // scripts/.vj-catalog-cache.json を書き換えてしまう副作用（loadCatalog の
  // ベストエフォート書き戻し）から開発者のローカル環境を守るため、退避しておく。
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

function runVjSet(args) {
  return spawnSync(process.execPath, [VJ_SET_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VJ_CTL_PATH: stubPath,
      VJ_SET_TEST_CALL_LOG: callLogPath,
      VJ_SET_TEST_STATE_FIXTURE: stateFixturePath,
    },
  });
}

function readCallLog() {
  try {
    return readFileSync(callLogPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function writeSetFile(dir, name, setObj) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(setObj, null, 2));
  return path;
}

function writePatchFile(dir, name, patch) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(patch, null, 2));
  return path;
}

describe('vj-set.mjs load', () => {
  it('有効な2シーンのセットを読み込む: scene1 は --in 0、scene2 は --cue で送られる', () => {
    writePatchFile(tmpDir, 's1.json', fixturePatch(0));
    writePatchFile(tmpDir, 's2.json', fixturePatch(120));
    const setPath = writeSetFile(tmpDir, 'set.json', {
      name: 'taiwan-night',
      scenes: [
        { cue: 's1', patch: 's1.json', label: '湿気', transition: 'slow' },
        { cue: 's2', patch: 's2.json', label: '騎楼' },
      ],
    });

    const result = runVjSet(['load', setPath, '--refresh-catalog']);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out).toEqual({
      ok: true,
      name: 'taiwan-night',
      applied: ['s1', 's2'],
      skipped: [],
      failures: [],
    });

    const calls = readCallLog();
    expect(calls.map((c) => c.command)).toEqual(['catalog', 'state', 'event', 'event']);

    const [, , firstAdd, secondAdd] = calls;
    expect(firstAdd.rest).toContain('--in');
    expect(firstAdd.rest).toContain('0');
    expect(firstAdd.rest).toContain('--transition');
    expect(firstAdd.rest).toContain('slow');
    expect(firstAdd.rest).not.toContain('--cue');

    expect(secondAdd.rest).toContain('--cue');
    expect(secondAdd.rest).toContain('s2');
    expect(secondAdd.rest).toContain('--transition');
    expect(secondAdd.rest).toContain('default');
  });

  it('いずれかのシーンの patch がローカル検証で落ちたら、何も送らずに exit 1 で issues を出す', () => {
    writePatchFile(tmpDir, 's1.json', fixturePatch(0));
    writePatchFile(tmpDir, 's2.json', invalidPatch());
    const setPath = writeSetFile(tmpDir, 'set.json', {
      name: 'broken-set',
      scenes: [
        { cue: 's1', patch: 's1.json' },
        { cue: 's2', patch: 's2.json' },
      ],
    });

    const result = runVjSet(['load', setPath, '--refresh-catalog']);

    expect(result.status).toBe(1);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(false);
    expect(out.issues.some((i) => i.includes('s2') && i.includes('palette.mode'))).toBe(true);
    expect(result.stderr).toMatch(/palette\.mode/);

    // catalog は検証のために引かれるが、event add は一切呼ばれてはいけない。
    const calls = readCallLog();
    expect(calls.map((c) => c.command)).not.toContain('event');
  });

  it('同じ cue を複数シーンで使っていたら、どの通信もする前に拒否する', () => {
    writePatchFile(tmpDir, 's1.json', fixturePatch(0));
    writePatchFile(tmpDir, 's2.json', fixturePatch(120));
    const setPath = writeSetFile(tmpDir, 'set.json', {
      name: 'dup-cue-set',
      scenes: [
        { cue: 'same', patch: 's1.json' },
        { cue: 'same', patch: 's2.json' },
      ],
    });

    const result = runVjSet(['load', setPath, '--refresh-catalog']);

    expect(result.status).toBe(1);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(false);
    expect(out.issues.join('\n')).toMatch(/"same"/);
    expect(out.issues.join('\n')).toMatch(/scenes\[0, 1\]/);

    // 通信は一切していないはず（catalog すら引かない）。
    expect(readCallLog()).toEqual([]);
  });

  it('2番目のシーンの cue が既に Timeline 上にある場合はスキップし、1番目は再送する', () => {
    writePatchFile(tmpDir, 's1.json', fixturePatch(0));
    writePatchFile(tmpDir, 's2.json', fixturePatch(120));
    const setPath = writeSetFile(tmpDir, 'set.json', {
      name: 'reload-set',
      scenes: [
        { cue: 's1', patch: 's1.json' },
        { cue: 's2', patch: 's2.json' },
      ],
    });

    // s2 は既に external anchor として Timeline に乗っている（前回の load 相当）。
    writeFileSync(
      stateFixturePath,
      JSON.stringify({
        nowSec: 40,
        barCount: 6,
        timeline: {
          lockedUntilSec: 0,
          events: [
            {
              id: 'ctl-existing',
              start: { kind: 'external', id: 's2' },
              duration: { kind: 'untilNext' },
              intent: {},
              transition: {
                paletteMs: 0,
                parameterMs: 0,
                modulationMs: 0,
                topologyMs: 0,
                easing: 'linear',
              },
              confidence: 1,
              locked: false,
            },
          ],
        },
        firedIds: [],
      }),
    );

    const result = runVjSet(['load', setPath, '--refresh-catalog']);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.applied).toEqual(['s1']);
    expect(out.skipped).toEqual(['s2']);

    const calls = readCallLog();
    // event add は scene1 の分だけ呼ばれる（scene2 は skip されるので呼ばれない）。
    expect(calls.filter((c) => c.command === 'event')).toHaveLength(1);
  });

  it('--help は stub に一切触れずに usage を出して exit 0', () => {
    const result = runVjSet(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/vj-set\.mjs load/);
    expect(readCallLog()).toEqual([]);
  });
});
