// vj-tweak.mjs の route 追従バグ(operator の差し替え/削除後に古い route が
// 残ってしまう不具合)の回帰テスト。vj-ctl.mjs をネットワーク不要のスタブに
// 差し替え、実際の CLI を子プロセスとして起動して stdout/stderr を検証する。
// ライブの VJ_URL には一切接続しない。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgv, parseRerollSpec } from './vj-tweak.mjs';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const VJ_TWEAK_PATH = join(SCRIPT_DIR, 'vj-tweak.mjs');
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
  {
    id: 'riso',
    version: 1,
    category: 'material',
    // 意図的に "tint" を持たない — mat0 をこの generator に差し替えると
    // mat0.tint を target にしていた route が壊れることを再現する。
    parameters: [{ id: 'hue', kind: 'number', min: 0, max: 360, default: 0, modulatable: true }],
  },
];

const FIXTURE_PATCH = {
  schemaVersion: 1,
  seed: 'fixture',
  operators: [
    { id: 'src0', generatorId: 'noiseSource', generatorVersion: 1, parameters: { amount: 0.5 } },
    { id: 'mod0', generatorId: 'repeat', generatorVersion: 1, parameters: { count: 1 } },
    { id: 'mod1', generatorId: 'repeat', generatorVersion: 1, parameters: { count: 1 } },
    { id: 'mat0', generatorId: 'bathroomGlaze', generatorVersion: 1, parameters: { tint: 0.2 } },
  ],
  routes: [
    // mat0 を差し替えると壊れる(riso に tint が無いため)
    { source: 'audio:level', target: 'mat0.tint', amount: 0.1, polarity: 'unipolar', smoothing: 1 },
    // mod1 を削除すると壊れる(source が operator:mod1 を指しているため)
    {
      source: 'operator:mod1',
      target: 'src0.amount',
      amount: 0.05,
      polarity: 'unipolar',
      smoothing: 1,
    },
    // どちらの変更でも壊れない対照 route(生き残るはず)
    {
      source: 'audio:bass',
      target: 'src0.amount',
      amount: 0.2,
      polarity: 'unipolar',
      smoothing: 1,
    },
  ],
  palette: { mode: 'mono', hueOffset: 0, saturation: 30, lightness: 50 },
  composition: { symmetry: 1, scale: 1, speed: 0.2 },
  qualityTier: 'medium',
};

/** vj-ctl.mjs のネットワーク I/O をスタブする偽実装。state/catalog だけを返す。 */
function stubSource() {
  return `
// vj-tweak.mjs は vj-ctl.mjs を [VJ_CTL_PATH, '--url', url, command, ...] で spawn する。
// 子プロセスの argv は [node, script, '--url', url, command, ...] なので index 4。
const command = process.argv[4];
if (command === 'state') {
  process.stdout.write(JSON.stringify({ currentPatch: ${JSON.stringify(FIXTURE_PATCH)} }));
  process.exit(0);
}
if (command === 'catalog') {
  process.stdout.write(JSON.stringify(${JSON.stringify(FIXTURE_CATALOG)}));
  process.exit(0);
}
process.stderr.write('stub-vj-ctl: unexpected command "' + command + '" (this suite only allows state/catalog)\\n');
process.exit(1);
`;
}

let tmpDir;
let stubPath;
let savedCache; // Buffer | undefined — undefined means "本物のキャッシュは無かった"

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vj-tweak-test-'));
  stubPath = join(tmpDir, 'vj-ctl-stub.mjs');
  writeFileSync(stubPath, stubSource());
  // このテストは --refresh-catalog を必ず付けるので実際には読まれないはずだが、
  // 本物の scripts/.vj-catalog-cache.json を書き換えてしまう副作用(loadCatalog の
  // ベストエフォート書き戻し)から開発者のローカル環境を守るため、退避しておく。
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

function runVjTweak(args) {
  return spawnSync(process.execPath, [VJ_TWEAK_PATH, '--dry-run', '--refresh-catalog', ...args], {
    encoding: 'utf8',
    env: { ...process.env, VJ_CTL_PATH: stubPath, VJ_URL: 'ws://stub.invalid/room/test' },
  });
}

describe('vj-tweak.mjs route reconciliation', () => {
  it('drops routes that reference an operator/parameter removed by swap or delete, and warns on stderr', () => {
    const result = runVjTweak(['mat0:=riso', '-mod1']);

    expect(result.status).toBe(0);

    const draft = JSON.parse(result.stdout);
    expect(draft.routes).toEqual([
      {
        source: 'audio:bass',
        target: 'src0.amount',
        amount: 0.2,
        polarity: 'unipolar',
        smoothing: 1,
      },
    ]);

    expect(result.stderr).toMatch(/dropping route/);
    expect(result.stderr).toMatch(/mat0\.tint/);
    expect(result.stderr).toMatch(/mod1/);
  });

  it('leaves routes untouched when no operator is swapped or deleted', () => {
    const result = runVjTweak(['src0.amount=0.9']);

    expect(result.status).toBe(0);
    const draft = JSON.parse(result.stdout);
    expect(draft.routes).toHaveLength(3);
    expect(result.stderr).not.toMatch(/dropping route/);
  });
});

// ---------------------------------------------------------------------------
// parseArgv: `--flag=value` inline syntax (added for --reroll=<categories>,
// but the `=` handling itself is generic — exercise it for a couple of flags).
// Pure function, no spawn needed.
// ---------------------------------------------------------------------------

describe('parseArgv', () => {
  it('bare boolean flag still works: --dry-run => true', () => {
    const { flags } = parseArgv(['--dry-run']);
    expect(flags.get('dry-run')).toBe(true);
  });

  it('space-separated value flag still works: --seed foo', () => {
    const { flags, positional } = parseArgv(['--seed', 'foo', 'src0.x=1']);
    expect(flags.get('seed')).toBe('foo');
    expect(positional).toEqual(['src0.x=1']);
  });

  it('bare --reroll (no "=") sets the boolean true', () => {
    const { flags } = parseArgv(['--reroll']);
    expect(flags.get('reroll')).toBe(true);
  });

  it('--reroll=params,palette sets the raw string, not the boolean', () => {
    const { flags, positional } = parseArgv(['--reroll=params,palette', 'src0.x=1']);
    expect(flags.get('reroll')).toBe('params,palette');
    // The inline value must not swallow the following <change> token.
    expect(positional).toEqual(['src0.x=1']);
  });

  it('--reroll-seed foo (space-separated, an ordinary value flag)', () => {
    const { flags } = parseArgv(['--reroll-seed', 'foo']);
    expect(flags.get('reroll-seed')).toBe('foo');
  });

  it('--reroll-seed=foo (inline) also works via the generic "=" handling', () => {
    const { flags } = parseArgv(['--reroll-seed=foo']);
    expect(flags.get('reroll-seed')).toBe('foo');
  });

  it('an inline "=" value is never consumed from the next argv token', () => {
    const { positional } = parseArgv(['--reroll=routes', '-fld1', 'src0.x=1']);
    expect(positional).toEqual(['-fld1', 'src0.x=1']);
  });

  it('unknown --flag=value name is rejected the same way as unknown --flag', () => {
    expect(() => parseArgv(['--bogus=1'])).toThrow(/不明なフラグ/);
  });
});

// ---------------------------------------------------------------------------
// parseRerollSpec: pure function, no spawn needed.
// ---------------------------------------------------------------------------

describe('parseRerollSpec', () => {
  it('bare true (no "=" given) => all 4 categories true', () => {
    expect(parseRerollSpec(true)).toEqual({
      parameters: true,
      routes: true,
      palette: true,
      composition: true,
    });
  });

  it('single category: "palette" => only palette true', () => {
    expect(parseRerollSpec('palette')).toEqual({
      parameters: false,
      routes: false,
      palette: true,
      composition: false,
    });
  });

  it('"params" maps to the "parameters" key', () => {
    expect(parseRerollSpec('params')).toEqual({
      parameters: true,
      routes: false,
      palette: false,
      composition: false,
    });
  });

  it('multiple categories: "params,palette"', () => {
    expect(parseRerollSpec('params,palette')).toEqual({
      parameters: true,
      routes: false,
      palette: true,
      composition: false,
    });
  });

  it('whitespace around category names is trimmed: " params , palette "', () => {
    expect(parseRerollSpec(' params , palette ')).toEqual({
      parameters: true,
      routes: false,
      palette: true,
      composition: false,
    });
  });

  it('duplicate categories are idempotent: "params,params"', () => {
    expect(parseRerollSpec('params,params')).toEqual({
      parameters: true,
      routes: false,
      palette: false,
      composition: false,
    });
  });

  it('unknown category => { error } (does not silently no-op)', () => {
    const result = parseRerollSpec('bogus');
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/bogus/);
  });

  it('empty string => { error }', () => {
    const result = parseRerollSpec('');
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// --reroll integration: this must exercise the REAL src/synth/derive.ts
// rerollPatch via Vite's SSR module loader (server.ssrLoadModule), the same
// mechanism scripts/vj-validate.mjs uses — --reroll bypasses the stub's
// "catalog" command entirely and loads the real, full generator catalog
// straight from source. So the fixture patch below must reference generator
// ids that actually exist in src/synth/generators/index.ts (unlike
// FIXTURE_PATCH above, whose ids are made up and only need to satisfy the
// hand-rolled catalogMap). These are real, currently-stable generators:
//   - source:   grid    (src/synth/generators/grid.ts)
//   - modifier: repeat  (src/synth/generators/repeat.ts)
//   - material: neon    (src/synth/generators/neon.ts)
// The catalog entries below mirror those generators' actual parameter
// definitions, so the CLI-local catalogMap (from the stub's "catalog"
// command, used for reconcileRoutes/runPatchLevelChecks) doesn't disagree
// with the real catalog reroll draws against.
//
// These tests pay Vite's createServer() + ssrLoadModule() startup cost
// (roughly ~1-1.5s observed locally), so they're slower than the rest of
// this file and get a longer per-test timeout.
// ---------------------------------------------------------------------------

const REAL_FIXTURE_CATALOG = [
  {
    id: 'grid',
    version: 1,
    category: 'source',
    parameters: [
      { id: 'cells', kind: 'int', min: 2, max: 64, default: 8, modulatable: true },
      { id: 'thickness', kind: 'number', min: 0, max: 1, default: 0.08, modulatable: true },
    ],
  },
  {
    id: 'repeat',
    version: 1,
    category: 'modifier',
    parameters: [{ id: 'count', kind: 'number', min: 1, max: 16, default: 3, modulatable: true }],
  },
  {
    id: 'neon',
    version: 1,
    category: 'material',
    parameters: [
      { id: 'hue', kind: 'number', min: 0, max: 360, default: 200, modulatable: true },
      { id: 'intensity', kind: 'number', min: 0, max: 2, default: 1.2, modulatable: true },
    ],
  },
];

const REAL_FIXTURE_PATCH = {
  schemaVersion: 1,
  seed: 'real-fixture',
  operators: [
    {
      id: 'src0',
      generatorId: 'grid',
      generatorVersion: 1,
      parameters: { cells: 8, thickness: 0.08 },
    },
    { id: 'mod0', generatorId: 'repeat', generatorVersion: 1, parameters: { count: 3 } },
    {
      id: 'mat0',
      generatorId: 'neon',
      generatorVersion: 1,
      parameters: { hue: 200, intensity: 1.2 },
    },
  ],
  routes: [],
  palette: { mode: 'mono', hueOffset: 0, saturation: 30, lightness: 50 },
  composition: { symmetry: 1, scale: 1, speed: 0.2 },
  qualityTier: 'medium',
};

function stubSourceReal() {
  return `
const command = process.argv[4];
if (command === 'state') {
  process.stdout.write(JSON.stringify({ currentPatch: ${JSON.stringify(REAL_FIXTURE_PATCH)} }));
  process.exit(0);
}
if (command === 'catalog') {
  process.stdout.write(JSON.stringify(${JSON.stringify(REAL_FIXTURE_CATALOG)}));
  process.exit(0);
}
process.stderr.write('stub-vj-ctl: unexpected command "' + command + '" (this suite only allows state/catalog)\\n');
process.exit(1);
`;
}

/** stdout for a --reroll --dry-run run is `vj-tweak: reroll seed = <s>\n` + pretty JSON. */
function parseSeedAndDraft(stdout) {
  const nlIdx = stdout.indexOf('\n');
  const seedLine = stdout.slice(0, nlIdx);
  const draft = JSON.parse(stdout.slice(nlIdx + 1));
  return { seedLine, draft };
}

function topologyOf(patch) {
  return patch.operators.map((op) => ({
    id: op.id,
    generatorId: op.generatorId,
    generatorVersion: op.generatorVersion,
  }));
}

describe('vj-tweak.mjs --reroll (integration, real generator catalog via Vite SSR)', () => {
  let stubPathReal;

  beforeEach(() => {
    // tmpDir already exists by now — the top-level beforeEach (above) runs first.
    stubPathReal = join(tmpDir, 'vj-ctl-stub-real.mjs');
    writeFileSync(stubPathReal, stubSourceReal());
  });

  function runVjTweakReal(args) {
    return spawnSync(process.execPath, [VJ_TWEAK_PATH, '--dry-run', '--refresh-catalog', ...args], {
      encoding: 'utf8',
      env: { ...process.env, VJ_CTL_PATH: stubPathReal, VJ_URL: 'ws://stub.invalid/room/test' },
    });
  }

  it('--reroll (bare, all 4 categories) preserves topology and changes something', () => {
    const result = runVjTweakReal(['--reroll']);
    expect(result.status, result.stderr).toBe(0);

    const { seedLine, draft } = parseSeedAndDraft(result.stdout);
    expect(seedLine).toMatch(/^vj-tweak: reroll seed = \S+$/);
    expect(draft.seed).toBe(seedLine.slice('vj-tweak: reroll seed = '.length));

    expect(topologyOf(draft)).toEqual(topologyOf(REAL_FIXTURE_PATCH));

    const paletteChanged =
      JSON.stringify(draft.palette) !== JSON.stringify(REAL_FIXTURE_PATCH.palette);
    const compositionChanged =
      JSON.stringify(draft.composition) !== JSON.stringify(REAL_FIXTURE_PATCH.composition);
    const paramsChanged = draft.operators.some(
      (op, i) =>
        JSON.stringify(op.parameters) !==
        JSON.stringify(REAL_FIXTURE_PATCH.operators[i].parameters),
    );
    expect(paletteChanged || compositionChanged || paramsChanged).toBe(true);
  }, 20000);

  it('--reroll=palette changes only the palette', () => {
    const result = runVjTweakReal(['--reroll=palette']);
    expect(result.status, result.stderr).toBe(0);

    const { draft } = parseSeedAndDraft(result.stdout);
    expect(draft.operators).toEqual(REAL_FIXTURE_PATCH.operators);
    expect(draft.routes).toEqual(REAL_FIXTURE_PATCH.routes);
    expect(draft.composition).toEqual(REAL_FIXTURE_PATCH.composition);
    expect(draft.palette).not.toEqual(REAL_FIXTURE_PATCH.palette);
  }, 20000);

  it('--reroll --reroll-seed <fixed> is byte-identical across two separate runs', () => {
    const a = runVjTweakReal(['--reroll', '--reroll-seed', 'integration-fixed-seed']);
    const b = runVjTweakReal(['--reroll', '--reroll-seed', 'integration-fixed-seed']);
    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  }, 30000);

  it('a <change> token applied after --reroll wins over the rerolled value', () => {
    const result = runVjTweakReal(['--reroll', 'src0.thickness=0.987']);
    expect(result.status, result.stderr).toBe(0);

    const { draft } = parseSeedAndDraft(result.stdout);
    const src0 = draft.operators.find((op) => op.id === 'src0');
    expect(src0.parameters.thickness).toBe(0.987);
  }, 20000);

  it('--reroll=bogus is rejected with a clear error (fails before touching vj-ctl.mjs or Vite)', () => {
    const result = runVjTweakReal(['--reroll=bogus']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/不明なカテゴリ/);
    expect(result.stderr).toMatch(/bogus/);
  });
});
