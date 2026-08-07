/**
 * Shared headless-GPU harness.
 *
 * Browser launch, WebGL2 setup, uniform/texture binding and `readPixels` used
 * to live inside `render.gpu.test.ts`. The coverage measurement script needs
 * exactly the same rig, so it lives here and both sides import it.
 *
 * Nothing in the app imports this module — it is test/tooling infrastructure
 * that happens to sit under `src/` so `tsc -b` type-checks it.
 *
 * Playwright does NOT read `CHROMIUM_BIN` on its own: the executable path has
 * to be handed to `chromium.launch()` explicitly (see flake.nix).
 */
import { chromium, type Browser, type Page } from 'playwright';
import { FULLSCREEN_VERT } from '../../render/glutil';
import { inlineCatalog } from '../generators';
import { namespaceToU32, seedToU32 } from '../rng';
import type { GeneratorDefinition, VisualOperator, VisualPatch } from '../types';
import { assemblePatch, SEED_UNIFORM, type AssembledShader } from './assemble';

interface GpuEnv {
  CHROMIUM_BIN?: string;
  VJ_GPU_FULL?: string;
}

/** `process.env` without pulling @types/node into the app tsconfig. */
export const gpuEnv: GpuEnv | undefined = (globalThis as { process?: { env?: GpuEnv } }).process
  ?.env;

/** Opt-in exhaustive sweep shared by the GPU suites (`VJ_GPU_FULL=1`). */
export const fullSweep = gpuEnv?.VJ_GPU_FULL === '1';

const executablePath = gpuEnv?.CHROMIUM_BIN;

export const launchOptions = {
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'],
  ...(executablePath ? { executablePath } : {}),
};

export interface GpuSession {
  browser: Browser | null;
  page: Page | null;
  error: unknown;
}

/**
 * Launch Chromium + open a page, reporting failure instead of throwing so a
 * browserless machine can skip with a visible reason.
 *
 * `warning` is the console prefix used when the launch fails.
 */
export async function launchGpu(warning: string): Promise<GpuSession> {
  try {
    const browser = await chromium.launch(launchOptions);
    const page = await browser.newPage();
    return { browser, page, error: null };
  } catch (e) {
    console.warn(warning, e instanceof Error ? e.message : e);
    return { browser: null, page: null, error: e };
  }
}

/** Close a session's page and browser, swallowing teardown errors. */
export async function closeGpu(session: GpuSession): Promise<void> {
  await session.page?.close().catch(() => {});
  await session.browser?.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// patch construction helpers
// ---------------------------------------------------------------------------

/** Role used for patch construction (mirrors assemble's private `roleOf`). */
export type PatchRole = 'source' | 'field' | 'mod_coord' | 'mod_value' | 'material';

export function roleOf(def: GeneratorDefinition): PatchRole {
  if (def.category === 'source') return 'source';
  if (def.category === 'field') return 'field';
  if (def.category === 'material') return 'material';
  if (def.category === 'modifier') {
    if (def.output === 'vector') return 'mod_coord';
    if (def.output === 'field') return 'mod_value';
  }
  throw new Error(`unclassifiable generator ${def.id}`);
}

export function paramsFromDef(def: GeneratorDefinition): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const p of def.parameters) {
    out[p.id] = p.default;
  }
  return out;
}

export function opFromDef(id: string, def: GeneratorDefinition): VisualOperator {
  return {
    id,
    generatorId: def.id,
    generatorVersion: def.version,
    parameters: paramsFromDef(def),
  };
}

/** Minimal valid patch shell. palette/composition are unused by assemblePatch. */
export function basePatch(operators: VisualOperator[], seed: string): VisualPatch {
  return {
    schemaVersion: 1,
    seed,
    operators,
    routes: [],
    palette: { mode: 'mono', hueOffset: 0, saturation: 80, lightness: 55 },
    composition: { symmetry: 4, scale: 1, speed: 1 },
    qualityTier: 'medium',
  };
}

export function requireGen(id: string) {
  const g = inlineCatalog.get(id);
  if (!g) throw new Error(`catalog missing generator "${id}"`);
  return g;
}

export interface NamedPatch {
  label: string;
  patch: VisualPatch;
}

// ---------------------------------------------------------------------------
// uniforms + textures
// ---------------------------------------------------------------------------

export type UniformSpec =
  | { name: string; kind: '1f'; value: number }
  | { name: string; kind: '2f'; value: [number, number] }
  | { name: string; kind: '1i'; value: number }
  | { name: string; kind: '1ui'; value: number };

/**
 * A texture slot to fill before drawing.
 *
 * `pattern` builds a procedural image in-browser (no fixture files, so callers
 * stay hermetic and deterministic); `transparent` is the 1×1 stand-in the scene
 * binds when a Patch references an image nobody has loaded; `firstRows` is
 * opaque only in the rows uploaded first (t≈0) and pins the sampling
 * orientation.
 */
export interface TextureSpec {
  name: string;
  sizeName: string;
  unit: number;
  kind: 'pattern' | 'transparent' | 'firstRows';
}

/** Size of the procedural test image. Large enough to survive the 96px pass. */
export const DUMMY_IMAGE_SIZE = 128;

/** The `uTime` uniform, overridden per draw when several time samples are asked for. */
export const TIME_UNIFORM = 'uTime';

/** Time baked into `buildUniformSpecs` unless a caller overrides it. */
export const DEFAULT_UNIFORM_TIME = 1.0;

/** Bindings for every declared slot, filled with the given kind of image. */
export function textureSpecs(
  assembled: AssembledShader,
  kind: TextureSpec['kind'] = 'pattern',
): TextureSpec[] {
  return assembled.textures.map((t, unit) => ({
    name: t.name,
    sizeName: t.sizeName,
    unit,
    kind,
  }));
}

/**
 * Build serializable uniform values on the Node side (mirrors semanticSynth draw).
 * Parameter values come from `op.parameters`, falling back to the definition default.
 */
export function buildUniformSpecs(
  patch: VisualPatch,
  assembled: AssembledShader,
  size: number,
  time: number = DEFAULT_UNIFORM_TIME,
): UniformSpec[] {
  const specs: UniformSpec[] = [
    { name: TIME_UNIFORM, kind: '1f', value: time },
    { name: 'uRes', kind: '2f', value: [size, size] },
    { name: 'uBass', kind: '1f', value: 0.5 },
    { name: 'uMid', kind: '1f', value: 0.5 },
    { name: 'uTreble', kind: '1f', value: 0.5 },
    { name: 'uLevel', kind: '1f', value: 0.5 },
    { name: 'uBeat', kind: '1f', value: 0.5 },
    // scene 側と同じ関係を保つ: uEnergy は音量、uPunch は拍 × 音量。
    // 他の音 uniform が 0.5 なのに合わせて 0.5 / 0.5*0.5 に置く。
    { name: 'uEnergy', kind: '1f', value: 0.5 },
    { name: 'uPunch', kind: '1f', value: 0.25 },
    { name: 'uFade', kind: '1f', value: 1.0 },
    { name: SEED_UNIFORM, kind: '1ui', value: seedToU32(patch.seed) >>> 0 },
  ];

  for (const { opId, name } of assembled.nsUniforms) {
    specs.push({ name, kind: '1ui', value: namespaceToU32(`op:${opId}`) >>> 0 });
  }

  for (const { opId, paramId, name } of assembled.uniforms) {
    const op = patch.operators.find((o) => o.id === opId);
    if (!op) continue;
    const gen = inlineCatalog.get(op.generatorId);
    if (!gen) continue;
    const paramDef = gen.def.parameters.find((p) => p.id === paramId);
    if (!paramDef) continue;
    const raw = op.parameters[paramId] ?? paramDef.default;

    switch (paramDef.kind) {
      case 'number':
        specs.push({
          name,
          kind: '1f',
          value: typeof raw === 'number' ? raw : Number(raw),
        });
        break;
      case 'int':
        specs.push({
          name,
          kind: '1i',
          value: typeof raw === 'number' ? raw | 0 : Number(raw) | 0,
        });
        break;
      case 'bool':
        specs.push({ name, kind: '1i', value: raw ? 1 : 0 });
        break;
      case 'enum': {
        const opts = paramDef.options ?? [];
        const idx = typeof raw === 'string' ? opts.indexOf(raw) : Number(raw) | 0;
        specs.push({ name, kind: '1i', value: idx < 0 ? 0 : idx });
        break;
      }
    }
  }

  return specs;
}

// ---------------------------------------------------------------------------
// draw
// ---------------------------------------------------------------------------

/**
 * Everything a caller can learn about a drawn frame.
 *
 * Reductions run inside the browser and only these scalars cross the CDP
 * boundary. A 256² RGBA frame is 262,144 JSON numbers; serialising one costs
 * far more than drawing it, and a coverage sweep draws thousands. Nothing here
 * ever returns a pixel array — that is the whole point.
 */
export interface FrameStats {
  /** Mean alpha over every pixel, 0..1. */
  meanAlpha: number;
  /** Fraction of pixels whose alpha exceeds 0.5, 0..1. */
  solidFraction: number;
  /** Pixels with any alpha at all. */
  alphaCount: number;
  /** True when every pixel carries identical RGBA. */
  uniform: boolean;
  /**
   * Distinct non-zero alpha byte values in the frame, 0..255.
   *
   * A proxy for tonal continuity. Flat shading collapses an object into a
   * handful of levels; a shaded 3D surface lands in the hundreds. Only the
   * count crosses the boundary — the histogram itself stays in the browser.
   */
  distinctAlphaLevels: number;
  /**
   * `alphaCount` per horizontal quarter of the frame, bottom-first —
   * readPixels starts at the bottom row, so index 0 is the bottom quarter.
   */
  quarterAlphaCounts: number[];
}

type RunResult = { ok: true; frames: FrameStats[] } | { ok: false; log: string };

/**
 * Compile + link + draw a fullscreen program, once per entry in `times`.
 *
 * `times === null` keeps the `uTime` value already present in `uniforms` and
 * draws exactly once. Reusing one program across several time samples is what
 * makes a full coverage sweep affordable.
 */
async function runInBrowser(
  page: Page,
  spec: {
    vertSrc: string;
    fragSrc: string;
    uniforms: UniformSpec[];
    size: number;
    textures: TextureSpec[];
    imageSize: number;
    times: number[] | null;
    timeUniform: string;
  },
): Promise<RunResult> {
  return page.evaluate(
    ({ vertSrc, fragSrc, uniforms, size, textures, imageSize, times, timeUniform }) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const gl = canvas.getContext('webgl2', {
        antialias: false,
        depth: false,
        stencil: false,
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) {
        return { ok: false as const, log: 'WebGL2 context unavailable' };
      }

      gl.disable(gl.DITHER);
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, size, size);

      function compileShader(g: WebGL2RenderingContext, type: number, src: string): string | null {
        const sh = g.createShader(type);
        if (!sh) return 'Failed to create shader';
        g.shaderSource(sh, src);
        g.compileShader(sh);
        if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
          const log = g.getShaderInfoLog(sh) ?? '(no info log)';
          g.deleteShader(sh);
          const kind = type === g.VERTEX_SHADER ? 'vertex' : 'fragment';
          return `GLSL ${kind} shader compile failed:\n${log}`;
        }
        (g as unknown as { __lastShader?: WebGLShader }).__lastShader = sh;
        return null;
      }

      const vErr = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
      if (vErr) return { ok: false as const, log: vErr };
      const vs = (gl as unknown as { __lastShader: WebGLShader }).__lastShader;

      const fErr = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
      if (fErr) {
        gl.deleteShader(vs);
        return { ok: false as const, log: fErr };
      }
      const fs = (gl as unknown as { __lastShader: WebGLShader }).__lastShader;

      const prog = gl.createProgram();
      if (!prog) {
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return { ok: false as const, log: 'Failed to create program' };
      }
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog) ?? '(no info log)';
        gl.deleteProgram(prog);
        return { ok: false as const, log: `GLSL program link failed:\n${log}` };
      }

      const tex = gl.createTexture();
      if (!tex) {
        gl.deleteProgram(prog);
        return { ok: false as const, log: 'Failed to create texture' };
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const fbo = gl.createFramebuffer();
      if (!fbo) {
        gl.deleteTexture(tex);
        gl.deleteProgram(prog);
        return { ok: false as const, log: 'Failed to create framebuffer' };
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        gl.deleteProgram(prog);
        return { ok: false as const, log: `Framebuffer incomplete: 0x${status.toString(16)}` };
      }

      const vao = gl.createVertexArray();
      if (!vao) {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        gl.deleteProgram(prog);
        return { ok: false as const, log: 'Failed to create VAO' };
      }
      gl.bindVertexArray(vao);
      gl.useProgram(prog);

      // --- texture slots ---
      /** Opaque disc over a checker, transparent outside — luminance AND alpha vary. */
      function patternImage(n: number): ImageData {
        const data = new Uint8ClampedArray(n * n * 4);
        const cell = Math.max(1, n >> 3);
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const i = (y * n + x) * 4;
            const dx = (x + 0.5) / n - 0.5;
            const dy = (y + 0.5) / n - 0.5;
            const inside = dx * dx + dy * dy < 0.45 * 0.45;
            const checker = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
            const level = checker ? 255 : 140;
            data[i] = inside ? level : 0;
            data[i + 1] = inside ? level : 0;
            data[i + 2] = inside ? level : 0;
            data[i + 3] = inside ? 255 : 0;
          }
        }
        return new ImageData(data, n, n);
      }

      /** Opaque white in the rows uploaded first (t≈0), transparent after. */
      function firstRowsImage(n: number): ImageData {
        const data = new Uint8ClampedArray(n * n * 4);
        for (let y = 0; y < n; y++) {
          const lit = y < n / 2;
          for (let x = 0; x < n; x++) {
            const i = (y * n + x) * 4;
            data[i] = lit ? 255 : 0;
            data[i + 1] = lit ? 255 : 0;
            data[i + 2] = lit ? 255 : 0;
            data[i + 3] = lit ? 255 : 0;
          }
        }
        return new ImageData(data, n, n);
      }

      const createdTextures: WebGLTexture[] = [];
      for (const t of textures) {
        const slotTex = gl.createTexture();
        if (!slotTex) continue;
        createdTextures.push(slotTex);
        gl.activeTexture(gl.TEXTURE0 + t.unit);
        gl.bindTexture(gl.TEXTURE_2D, slotTex);
        // UNPACK_FLIP_Y_WEBGL stays untouched, exactly like semanticSynth's
        // uploader — the image store is what owns the orientation.
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        if (t.kind === 'transparent') {
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            1,
            1,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            new Uint8Array([0, 0, 0, 0]),
          );
        } else {
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            t.kind === 'firstRows' ? firstRowsImage(imageSize) : patternImage(imageSize),
          );
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        const texLoc = gl.getUniformLocation(prog, t.name);
        if (texLoc) gl.uniform1i(texLoc, t.unit);
        const sizeLoc = gl.getUniformLocation(prog, t.sizeName);
        const px = t.kind === 'transparent' ? 1 : imageSize;
        if (sizeLoc) gl.uniform2f(sizeLoc, px, px);
      }
      gl.activeTexture(gl.TEXTURE0);

      for (const u of uniforms) {
        const loc = gl.getUniformLocation(prog, u.name);
        if (!loc) continue;
        switch (u.kind) {
          case '1f':
            gl.uniform1f(loc, u.value);
            break;
          case '2f':
            gl.uniform2f(loc, u.value[0], u.value[1]);
            break;
          case '1i':
            gl.uniform1i(loc, u.value);
            break;
          case '1ui':
            gl.uniform1ui(loc, u.value >>> 0);
            break;
        }
      }

      const timeLoc = times === null ? null : gl.getUniformLocation(prog, timeUniform);
      const buf = new Uint8Array(size * size * 4);
      const pixelCount = size * size;
      const QUARTERS = 4;
      const quarterPixels = Math.floor(pixelCount / QUARTERS);
      const frames: Array<{
        meanAlpha: number;
        solidFraction: number;
        alphaCount: number;
        uniform: boolean;
        distinctAlphaLevels: number;
        quarterAlphaCounts: number[];
      }> = [];
      /** Reused across draws; 256 bytes beats allocating a Set per frame. */
      const alphaSeen = new Uint8Array(256);
      // `null` = draw once with the uTime already bound above.
      const draws: Array<number | null> = times === null ? [null] : times;

      for (const t of draws) {
        if (t !== null && timeLoc) gl.uniform1f(timeLoc, t);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);

        // One pass over the frame produces every reduction the callers need.
        // Nothing but these numbers is allowed to leave the browser.
        let sum = 0;
        let solid = 0;
        let nonZero = 0;
        let uniform = true;
        const quarterAlphaCounts: number[] = Array.from({ length: QUARTERS }, () => 0);
        alphaSeen.fill(0);
        const r0 = buf[0]!,
          g0 = buf[1]!,
          b0 = buf[2]!,
          a0 = buf[3]!;

        for (let p = 0; p < pixelCount; p++) {
          const i = p * 4;
          const a = buf[i + 3]!;
          sum += a;
          // alpha > 0.5 in normalized terms ⇔ byte > 127.5 ⇔ byte ≥ 128
          if (a > 127) solid++;
          if (a !== 0) {
            nonZero++;
            alphaSeen[a] = 1;
            // trailing pixels of a non-divisible frame fall in the last quarter
            const q = Math.min(QUARTERS - 1, Math.floor(p / quarterPixels));
            quarterAlphaCounts[q]!++;
          }
          if (uniform && (buf[i]! !== r0 || buf[i + 1]! !== g0 || buf[i + 2]! !== b0 || a !== a0)) {
            uniform = false;
          }
        }

        let distinctAlphaLevels = 0;
        for (let a = 1; a < 256; a++) {
          if (alphaSeen[a] !== 0) distinctAlphaLevels++;
        }

        frames.push({
          meanAlpha: sum / (pixelCount * 255),
          solidFraction: solid / pixelCount,
          alphaCount: nonZero,
          uniform,
          distinctAlphaLevels,
          quarterAlphaCounts,
        });
      }

      gl.deleteVertexArray(vao);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      for (const t of createdTextures) gl.deleteTexture(t);
      gl.deleteProgram(prog);

      return { ok: true as const, frames };
    },
    {
      vertSrc: spec.vertSrc,
      fragSrc: spec.fragSrc,
      uniforms: spec.uniforms,
      size: spec.size,
      textures: spec.textures,
      imageSize: spec.imageSize,
      times: spec.times,
      timeUniform: spec.timeUniform,
    },
  );
}

export type FrameResult = { ok: true; frame: FrameStats } | { ok: false; log: string };
export type FramesResult = { ok: true; frames: FrameStats[] } | { ok: false; log: string };

/** One draw, reduced in-browser. */
export async function renderInBrowser(
  page: Page,
  vertSrc: string,
  fragSrc: string,
  uniforms: UniformSpec[],
  size: number,
  textures: TextureSpec[] = [],
  imageSize: number = DUMMY_IMAGE_SIZE,
): Promise<FrameResult> {
  const res = await runInBrowser(page, {
    vertSrc,
    fragSrc,
    uniforms,
    size,
    textures,
    imageSize,
    times: null,
    timeUniform: TIME_UNIFORM,
  });
  if (!res.ok) return res;
  const frame = res.frames[0];
  if (!frame) return { ok: false, log: 'no frame was rendered' };
  return { ok: true, frame };
}

/**
 * One draw per entry in `times`, all inside a single `page.evaluate` that reuses
 * the compiled program — one round-trip and one compile for the whole series.
 */
export async function measureFramesInBrowser(
  page: Page,
  vertSrc: string,
  fragSrc: string,
  uniforms: UniformSpec[],
  size: number,
  times: number[],
  textures: TextureSpec[] = [],
  imageSize: number = DUMMY_IMAGE_SIZE,
): Promise<FramesResult> {
  const res = await runInBrowser(page, {
    vertSrc,
    fragSrc,
    uniforms,
    size,
    textures,
    imageSize,
    times,
    timeUniform: TIME_UNIFORM,
  });
  if (!res.ok) return res;
  if (res.frames.length !== times.length) {
    return { ok: false, log: `expected ${times.length} frames, got ${res.frames.length}` };
  }
  return { ok: true, frames: res.frames };
}

function assemble(
  patch: VisualPatch,
): { ok: true; shader: AssembledShader } | { ok: false; log: string } {
  try {
    return { ok: true, shader: assemblePatch(patch, inlineCatalog) };
  } catch (e) {
    return {
      ok: false,
      log: `assemblePatch threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Assemble + draw a patch once, returning its in-browser reductions. */
export async function renderPatchFrame(
  page: Page,
  patch: VisualPatch,
  size: number,
  textureKind: TextureSpec['kind'] = 'pattern',
  time: number = DEFAULT_UNIFORM_TIME,
): Promise<FrameResult> {
  const built = assemble(patch);
  if (!built.ok) return built;
  const assembled = built.shader;
  const uniforms = buildUniformSpecs(patch, assembled, size, time);
  const textures = textureSpecs(assembled, textureKind);
  try {
    return await renderInBrowser(
      page,
      FULLSCREEN_VERT,
      assembled.fragSrc,
      uniforms,
      size,
      textures,
    );
  } catch (e) {
    return {
      ok: false,
      log: `GPU error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Assemble + draw a patch once per time sample, returning per-frame reductions. */
export async function measurePatchFrames(
  page: Page,
  patch: VisualPatch,
  size: number,
  times: number[],
  textureKind: TextureSpec['kind'] = 'pattern',
): Promise<FramesResult> {
  const built = assemble(patch);
  if (!built.ok) return built;
  const assembled = built.shader;
  const uniforms = buildUniformSpecs(patch, assembled, size);
  const textures = textureSpecs(assembled, textureKind);
  try {
    return await measureFramesInBrowser(
      page,
      FULLSCREEN_VERT,
      assembled.fragSrc,
      uniforms,
      size,
      times,
      textures,
    );
  } catch (e) {
    return {
      ok: false,
      log: `GPU error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Compile + link only, on a throwaway 4×4 context. */
export async function compileInBrowser(
  page: Page,
  vertSrc: string,
  fragSrc: string,
): Promise<{ ok: true } | { ok: false; log: string }> {
  return page.evaluate(
    ({ vertSrc, fragSrc }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const gl = canvas.getContext('webgl2', {
        antialias: false,
        depth: false,
        stencil: false,
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) {
        return { ok: false as const, log: 'WebGL2 context unavailable' };
      }

      function compileShader(g: WebGL2RenderingContext, type: number, src: string): string | null {
        const sh = g.createShader(type);
        if (!sh) return 'Failed to create shader';
        g.shaderSource(sh, src);
        g.compileShader(sh);
        if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
          const log = g.getShaderInfoLog(sh) ?? '(no info log)';
          g.deleteShader(sh);
          const kind = type === g.VERTEX_SHADER ? 'vertex' : 'fragment';
          return `GLSL ${kind} shader compile failed:\n${log}\n--- source ---\n${src}`;
        }
        (g as unknown as { __lastShader?: WebGLShader }).__lastShader = sh;
        return null;
      }

      const vErr = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
      if (vErr) return { ok: false as const, log: vErr };
      const vs = (gl as unknown as { __lastShader: WebGLShader }).__lastShader;

      const fErr = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
      if (fErr) {
        gl.deleteShader(vs);
        return { ok: false as const, log: fErr };
      }
      const fs = (gl as unknown as { __lastShader: WebGLShader }).__lastShader;

      const prog = gl.createProgram();
      if (!prog) {
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return { ok: false as const, log: 'Failed to create program' };
      }
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog) ?? '(no info log)';
        gl.deleteProgram(prog);
        return { ok: false as const, log: `GLSL program link failed:\n${log}` };
      }
      gl.deleteProgram(prog);
      return { ok: true as const };
    },
    { vertSrc, fragSrc },
  );
}
