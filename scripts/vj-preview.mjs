#!/usr/bin/env node
/**
 * `pnpm vj:preview` — render a VisualPatch (or every generator) to PNG offline.
 *
 * The work lives in TypeScript (`src/synth/gl/previewRender.ts`) so it is
 * type-checked alongside the catalog. This file is only the runner: Vite's SSR
 * module loader executes that TypeScript directly (same pattern as
 * measure-coverage.mjs).
 *
 * Local only — no bridge, no vj-ctl, no network. Needs a headless Chromium
 * (`nix develop` sets CHROMIUM_BIN; the harness passes it to launch()).
 *
 * Usage:
 *   node scripts/vj-preview.mjs patch.json out.png
 *   node scripts/vj-preview.mjs --seed "take-1" out.png
 *   node scripts/vj-preview.mjs --contact-sheet out.png
 *   node scripts/vj-preview.mjs --sweep gamma.curve out.png
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..');

const HELP = `vj:preview — offline Patch → PNG (local, no bridge)

Usage:
  node scripts/vj-preview.mjs <patch.json> <out.png>
  node scripts/vj-preview.mjs --seed <seed> <out.png>
  node scripts/vj-preview.mjs --contact-sheet <out.png>
  node scripts/vj-preview.mjs --sweep <generatorId.paramId> <out.png>

Options:
  --seed <s>           derivePatch(seed) then filmstrip (times 0 / 1.7 / 4.3 / 9.1)
  --contact-sheet      every catalog generator as a labeled grid
  --sweep <id.param>   solo-context min..max sweep tiled horizontally
  --size <n>           tile edge in px (patch/seed/sweep; default 256 / 128 for sweep)
  --steps <n>          sweep step count (default 8)
  --cols <n>           contact-sheet columns (default 11)
  --cell-size <n>      contact-sheet cell edge (default 112)
  -h, --help           this help

Needs Chromium (enter \`nix develop\` so CHROMIUM_BIN is set).
`;

function parseArgs(argv) {
  const args = {
    mode: null,
    outPath: null,
    patchPath: null,
    seed: null,
    sweep: null,
    size: undefined,
    steps: undefined,
    cols: undefined,
    cellSize: undefined,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === '--seed') {
      args.mode = 'seed';
      args.seed = argv[++i];
      if (!args.seed) throw new Error('--seed requires a value');
    } else if (a === '--contact-sheet') {
      args.mode = 'contact-sheet';
    } else if (a === '--sweep') {
      args.mode = 'sweep';
      args.sweep = argv[++i];
      if (!args.sweep) throw new Error('--sweep requires generatorId.paramId');
    } else if (a === '--size') {
      args.size = Number(argv[++i]);
      if (!Number.isFinite(args.size) || args.size < 1)
        throw new Error('--size must be a positive number');
    } else if (a === '--steps') {
      args.steps = Number(argv[++i]);
      if (!Number.isFinite(args.steps) || args.steps < 2) throw new Error('--steps must be ≥ 2');
    } else if (a === '--cols') {
      args.cols = Number(argv[++i]);
      if (!Number.isFinite(args.cols) || args.cols < 1)
        throw new Error('--cols must be a positive number');
    } else if (a === '--cell-size') {
      args.cellSize = Number(argv[++i]);
      if (!Number.isFinite(args.cellSize) || args.cellSize < 1) {
        throw new Error('--cell-size must be a positive number');
      }
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option: ${a}`);
    } else {
      pos.push(a);
    }
  }

  if (args.help) return args;

  if (!args.mode) {
    // positional: patch.json out.png
    if (pos.length !== 2) {
      throw new Error('expected <patch.json> <out.png>, or a flag mode + <out.png>');
    }
    args.mode = 'patch';
    args.patchPath = path.resolve(pos[0]);
    args.outPath = path.resolve(pos[1]);
  } else {
    if (pos.length !== 1) {
      throw new Error(`${String(args.mode)} mode expects exactly one argument: <out.png>`);
    }
    args.outPath = path.resolve(pos[0]);
  }

  return args;
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`[vj:preview] ${e instanceof Error ? e.message : String(e)}`);
  console.error('');
  console.error(HELP);
  process.exit(1);
}

if (parsed.help || process.argv.length <= 2) {
  console.log(HELP);
  process.exit(process.argv.length <= 2 ? 1 : 0);
}

const server = await createServer({
  configFile: false,
  root,
  server: { middlewareMode: true, watch: null },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const mod = await server.ssrLoadModule('/src/synth/gl/previewRender.ts');
  const started = Date.now();

  /** @type {import('../src/synth/gl/previewRender.ts').PreviewCliArgs} */
  const cliArgs = {
    mode: parsed.mode,
    outPath: parsed.outPath,
    seed: parsed.seed ?? undefined,
    sweep: parsed.sweep ?? undefined,
    size: parsed.size,
    steps: parsed.steps,
    cols: parsed.cols,
    cellSize: parsed.cellSize,
    onProgress: (msg) => console.log(msg),
  };

  if (parsed.mode === 'patch') {
    const text = await readFile(parsed.patchPath, 'utf8');
    cliArgs.patch = JSON.parse(text);
  }

  const result = await mod.runPreview(cliArgs);

  await mkdir(path.dirname(result.outPath), { recursive: true });
  await writeFile(result.outPath, result.png);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const rel = path.relative(root, result.outPath);
  let extra = '';
  if (result.meta.cells != null) extra = ` cells=${result.meta.cells}`;
  if (result.meta.seed) extra = ` seed=${JSON.stringify(result.meta.seed)}`;
  if (result.meta.sweep) extra = ` sweep=${result.meta.sweep}`;
  console.log('');
  console.log(
    `[vj:preview] wrote ${result.bytes} bytes → ${rel || result.outPath}${extra} in ${seconds}s`,
  );
} catch (e) {
  console.error('[vj:preview] failed:', e instanceof Error ? e.stack : e);
  process.exitCode = 1;
} finally {
  await server.close();
}
