/**
 * Offline patch → PNG preview.
 *
 * Driven by `pnpm vj:preview` (scripts/vj-preview.mjs). Renders VisualPatches
 * (or every catalog generator as a contact sheet, or a seed-derived patch) to
 * PNG so a director can *look* at what generators do instead of reading GLSL.
 *
 * Solo contexts mirror coverageMeasure (source alone; non-source on shared
 * base `grid`, with mod_coord ordered before the source), but use **default
 * parameters** — contact-sheet stability over coverage's random param sets.
 *
 * Needs a headless Chromium. Inside `nix develop` CHROMIUM_BIN is set; the
 * harness passes it to launch() the same way measure:coverage does.
 */
import type { Page } from 'playwright';
import { derivePatch } from '../derive';
import { inlineCatalog } from '../generators';
import type { VisualPatch } from '../types';
import {
  basePatch,
  capturePatchPngs,
  closeGpu,
  launchGpu,
  opFromDef,
  requireGen,
  roleOf,
  type PatchRole,
} from './gpuHarness';

/** Seed for solo preview contexts. Stable so a contact sheet is reproducible. */
export const PREVIEW_SEED = 'preview-v1';

/** Shared base source for every non-source solo cell (same idea as coverage). */
export const PREVIEW_BASE_SOURCE = 'grid';

/**
 * Default filmstrip times — same set as coverage, so a single patch preview
 * samples enough phases that a blinking generator cannot look empty.
 */
export const PREVIEW_TIMES: readonly number[] = [0.0, 1.7, 4.3, 9.1];

/** Default tile size for a single-patch / seed filmstrip. */
export const PREVIEW_SIZE = 256;

/** Contact sheet cell edge (px). Small enough to fit ~100 gens; large enough to read. */
export const CONTACT_CELL_SIZE = 112;

/** Contact sheet column count. */
export const CONTACT_COLS = 11;

/** Time sample for contact-sheet cells (one frame each). */
export const CONTACT_TIME = 1.0;

/** Param-sweep defaults. */
export const SWEEP_STEPS = 8;
export const SWEEP_SIZE = 128;
export const SWEEP_TIME = 1.0;

// ---------------------------------------------------------------------------
// solo contexts (defaults, not coverage's random param sets)
// ---------------------------------------------------------------------------

/** opId a generator gets in its solo context. The base source always takes `src0`. */
function opIdForRole(role: PatchRole): string {
  switch (role) {
    case 'source':
      return 'src0';
    case 'field':
      return 'fld0';
    case 'mod_coord':
    case 'mod_value':
      return 'mod0';
    case 'material':
      return 'mat0';
  }
}

export interface SoloContext {
  label: string;
  role: PatchRole;
  patch: VisualPatch;
}

/**
 * Patch a generator is previewed in, with catalog defaults.
 *
 * Sources render alone (no material — assemble falls back to `vec4(v,v,v,v)`).
 * Everything else sits on shared base source `grid`. Coord modifiers bend `p`
 * before the source, so they go first; others go after.
 */
export function soloContext(genId: string): SoloContext {
  const gen = requireGen(genId);
  const role = roleOf(gen.def);
  const self = opFromDef(opIdForRole(role), gen.def);

  if (role === 'source') {
    return { label: `source:${genId}`, role, patch: basePatch([self], PREVIEW_SEED) };
  }

  const base = opFromDef('src0', requireGen(PREVIEW_BASE_SOURCE).def);
  const operators = role === 'mod_coord' ? [self, base] : [base, self];
  return {
    label: `${role}:${genId}+source:${PREVIEW_BASE_SOURCE}`,
    role,
    patch: basePatch(operators, PREVIEW_SEED),
  };
}

/** Catalog ids, sorted — same stability contract as coverage's allCoverageIds. */
export function allPreviewIds(): string[] {
  return inlineCatalog
    .all()
    .map((g) => g.def.id)
    .sort();
}

// ---------------------------------------------------------------------------
// browser helpers: composite filmstrips / contact sheets
// ---------------------------------------------------------------------------

function decodePngBase64(b64: string): Uint8Array {
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) return new Uint8Array(B.from(b64, 'base64'));
  // Browser / no Buffer: atob path (not expected in the CLI runner).
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Load base64 PNGs as Images and composite them left-to-right. */
async function compositeHorizontal(page: Page, pngs: string[], tileSize: number): Promise<string> {
  return page.evaluate(
    async ({ pngs: cells, tileSize: size }) => {
      const load = (b64: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('failed to load captured PNG'));
          img.src = `data:image/png;base64,${b64}`;
        });
      const imgs = await Promise.all(cells.map(load));
      const canvas = document.createElement('canvas');
      canvas.width = size * imgs.length;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('2d canvas context unavailable for filmstrip');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < imgs.length; i++) {
        ctx.drawImage(imgs[i]!, i * size, 0, size, size);
      }
      const dataUrl = canvas.toDataURL('image/png');
      const prefix = 'data:image/png;base64,';
      return dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : dataUrl;
    },
    { pngs, tileSize },
  );
}

interface ContactCell {
  png: string;
  id: string;
}

/** Grid of cells with generator id labels burned in under each tile. */
async function compositeContactSheet(
  page: Page,
  cells: ContactCell[],
  cellSize: number,
  cols: number,
): Promise<string> {
  return page.evaluate(
    async ({ cells: items, cellSize: size, cols: nCols }) => {
      const load = (b64: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('failed to load captured PNG'));
          img.src = `data:image/png;base64,${b64}`;
        });
      const imgs = await Promise.all(items.map((c) => load(c.png)));
      const labelH = 14;
      const tileH = size + labelH;
      const rows = Math.ceil(items.length / nCols);
      const canvas = document.createElement('canvas');
      canvas.width = nCols * size;
      canvas.height = rows * tileH;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('2d canvas context unavailable for contact sheet');
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = '10px monospace';
      ctx.textBaseline = 'top';
      for (let i = 0; i < items.length; i++) {
        const col = i % nCols;
        const row = Math.floor(i / nCols);
        const x = col * size;
        const y = row * tileH;
        ctx.drawImage(imgs[i]!, x, y, size, size);
        ctx.fillStyle = '#222';
        ctx.fillRect(x, y + size, size, labelH);
        ctx.fillStyle = '#eee';
        ctx.fillText(items[i]!.id, x + 2, y + size + 2, size - 4);
      }
      const dataUrl = canvas.toDataURL('image/png');
      const prefix = 'data:image/png;base64,';
      return dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : dataUrl;
    },
    { cells, cellSize, cols },
  );
}

// ---------------------------------------------------------------------------
// public render entry points
// ---------------------------------------------------------------------------

export interface PreviewRenderOpts {
  size?: number;
  times?: number[];
}

/**
 * Render one VisualPatch as a horizontal multi-time filmstrip.
 * Default times match coverage: 0, 1.7, 4.3, 9.1.
 */
export async function renderPatchPreview(
  patch: VisualPatch,
  opts?: PreviewRenderOpts,
): Promise<Uint8Array> {
  const size = opts?.size ?? PREVIEW_SIZE;
  const times = opts?.times ?? [...PREVIEW_TIMES];
  const session = await launchGpu('[vj:preview] browser launch failed:');
  const page = session.page;
  if (!page) {
    await closeGpu(session);
    throw browserMissingError(session.error);
  }
  try {
    const res = await capturePatchPngs(page, patch, size, times);
    if (!res.ok) throw new Error(`render failed: ${res.log}`);
    const b64 = await compositeHorizontal(page, res.pngs, size);
    return decodePngBase64(b64);
  } finally {
    await closeGpu(session);
  }
}

/** derivePatch(seed) then filmstrip-preview it. */
export async function renderSeedPreview(
  seed: string,
  opts?: PreviewRenderOpts,
): Promise<Uint8Array> {
  const patch = derivePatch(seed, { catalog: inlineCatalog });
  return renderPatchPreview(patch, opts);
}

export interface ContactSheetOpts {
  cellSize?: number;
  cols?: number;
  time?: number;
  onProgress?: (p: { index: number; total: number; id: string }) => void;
}

/**
 * Contact sheet of every catalog generator.
 *
 * Each cell is that generator's solo context (defaults) at a single time, with
 * the generator id burned in as a label. Returns cell count + ids for CLI logs.
 */
export async function renderContactSheet(
  opts?: ContactSheetOpts,
): Promise<{ png: Uint8Array; cells: number; ids: string[] }> {
  const cellSize = opts?.cellSize ?? CONTACT_CELL_SIZE;
  const cols = opts?.cols ?? CONTACT_COLS;
  const time = opts?.time ?? CONTACT_TIME;
  const ids = allPreviewIds();

  const session = await launchGpu('[vj:preview] browser launch failed:');
  const page = session.page;
  if (!page) {
    await closeGpu(session);
    throw browserMissingError(session.error);
  }

  try {
    const cells: ContactCell[] = [];
    for (const [index, id] of ids.entries()) {
      const ctx = soloContext(id);
      const res = await capturePatchPngs(page, ctx.patch, cellSize, [time]);
      if (!res.ok) {
        throw new Error(`contact sheet: ${ctx.label} failed to render: ${res.log}`);
      }
      const png = res.pngs[0];
      if (!png) throw new Error(`contact sheet: ${ctx.label} produced no PNG`);
      cells.push({ png, id });
      opts?.onProgress?.({ index, total: ids.length, id });
    }
    const b64 = await compositeContactSheet(page, cells, cellSize, cols);
    return { png: decodePngBase64(b64), cells: cells.length, ids };
  } finally {
    await closeGpu(session);
  }
}

export interface ParamSweepOpts {
  steps?: number;
  size?: number;
  time?: number;
}

/**
 * Sweep one numeric parameter across min..max on that generator's solo context.
 * Spec: `"generatorId.paramId"` (e.g. `gamma.curve`).
 */
export async function renderParamSweep(spec: string, opts?: ParamSweepOpts): Promise<Uint8Array> {
  const dot = spec.indexOf('.');
  if (dot <= 0 || dot === spec.length - 1) {
    throw new Error(`--sweep expects "generatorId.paramId", got "${spec}"`);
  }
  const genId = spec.slice(0, dot);
  const paramId = spec.slice(dot + 1);
  const gen = requireGen(genId);
  const param = gen.def.parameters.find((p) => p.id === paramId);
  if (!param) throw new Error(`generator "${genId}" has no parameter "${paramId}"`);
  if (param.kind !== 'number' && param.kind !== 'int') {
    throw new Error(`parameter "${spec}" is ${param.kind}; only number/int can be swept`);
  }
  const min = param.min ?? 0;
  const max = param.max ?? 1;
  const steps = Math.max(2, opts?.steps ?? SWEEP_STEPS);
  const size = opts?.size ?? SWEEP_SIZE;
  const time = opts?.time ?? SWEEP_TIME;

  const session = await launchGpu('[vj:preview] browser launch failed:');
  const page = session.page;
  if (!page) {
    await closeGpu(session);
    throw browserMissingError(session.error);
  }

  try {
    const pngs: string[] = [];
    for (let i = 0; i < steps; i++) {
      const t = steps === 1 ? 0 : i / (steps - 1);
      const raw = min + t * (max - min);
      const value = param.kind === 'int' ? Math.round(raw) : raw;
      const ctx = soloContext(genId);
      const op = ctx.patch.operators.find((o) => o.generatorId === genId);
      if (!op) throw new Error(`solo context missing operator for ${genId}`);
      op.parameters = { ...op.parameters, [paramId]: value };
      const res = await capturePatchPngs(page, ctx.patch, size, [time]);
      if (!res.ok) throw new Error(`sweep ${spec} step ${i}: ${res.log}`);
      const png = res.pngs[0];
      if (!png) throw new Error(`sweep ${spec} step ${i}: no PNG`);
      pngs.push(png);
    }
    const b64 = await compositeHorizontal(page, pngs, size);
    return decodePngBase64(b64);
  } finally {
    await closeGpu(session);
  }
}

// ---------------------------------------------------------------------------
// CLI entry (mjs runner calls this)
// ---------------------------------------------------------------------------

export type PreviewMode = 'patch' | 'seed' | 'contact-sheet' | 'sweep';

export interface PreviewCliArgs {
  mode: PreviewMode;
  outPath: string;
  /** Parsed VisualPatch (mode === 'patch'). JSON is read by the mjs runner. */
  patch?: VisualPatch;
  seed?: string;
  /** "generatorId.paramId" (mode === 'sweep'). */
  sweep?: string;
  size?: number;
  times?: number[];
  cellSize?: number;
  cols?: number;
  steps?: number;
  onProgress?: (msg: string) => void;
}

function browserMissingError(error: unknown): Error {
  return new Error(
    'vj:preview needs a headless Chromium. Enter `nix develop` so CHROMIUM_BIN is set ' +
      `(launch error: ${error instanceof Error ? error.message : String(error)})`,
  );
}

export interface PreviewCliResult {
  outPath: string;
  bytes: number;
  png: Uint8Array;
  meta: {
    mode: PreviewMode;
    cells?: number;
    ids?: string[];
    seed?: string;
    sweep?: string;
  };
}

/**
 * High-level CLI driver. Parses nothing — the mjs runner builds `args` and
 * writes `result.png` to disk. Launch/close Chromium once per invocation.
 */
export async function runPreview(args: PreviewCliArgs): Promise<PreviewCliResult> {
  const log = args.onProgress ?? (() => {});
  let png: Uint8Array;
  const meta: PreviewCliResult['meta'] = { mode: args.mode };

  switch (args.mode) {
    case 'contact-sheet': {
      log('[vj:preview] contact sheet — rendering all generators…');
      const result = await renderContactSheet({
        cellSize: args.cellSize,
        cols: args.cols,
        onProgress: (p) => {
          const n = String(p.index + 1).padStart(String(p.total).length, ' ');
          log(`[vj:preview] ${n}/${p.total} ${p.id}`);
        },
      });
      png = result.png;
      meta.cells = result.cells;
      meta.ids = result.ids;
      log(`[vj:preview] contact sheet: ${result.cells} cells`);
      break;
    }
    case 'seed': {
      if (!args.seed) throw new Error('seed mode requires --seed <string>');
      log(`[vj:preview] seed "${args.seed}"…`);
      meta.seed = args.seed;
      png = await renderSeedPreview(args.seed, { size: args.size, times: args.times });
      break;
    }
    case 'sweep': {
      if (!args.sweep) throw new Error('sweep mode requires --sweep generatorId.paramId');
      log(`[vj:preview] sweep ${args.sweep}…`);
      meta.sweep = args.sweep;
      png = await renderParamSweep(args.sweep, {
        steps: args.steps,
        size: args.size,
      });
      break;
    }
    case 'patch': {
      if (!args.patch) throw new Error('patch mode requires a VisualPatch object');
      log('[vj:preview] patch…');
      png = await renderPatchPreview(args.patch, { size: args.size, times: args.times });
      break;
    }
    default: {
      const _exhaustive: never = args.mode;
      throw new Error(`unknown mode: ${String(_exhaustive)}`);
    }
  }

  return { outPath: args.outPath, bytes: png.byteLength, png, meta };
}
