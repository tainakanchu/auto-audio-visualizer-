import type { GlScene, GlSceneContext } from './types';
import {
  compileProgram,
  createEmptyVao,
  createFbo,
  disposeFbo,
  drawFullscreen,
  type Fbo,
  FULLSCREEN_VERT,
  Uniforms,
} from '../render/glutil';
import { gatePatchProposal } from '../synth/apply';
import { createCatalog } from '../synth/catalog';
import {
  notifySynthControlChanged,
  registerSynthControl,
  type SynthControlBackend,
} from '../synth/control';
import { DEFAULT_BUDGETS } from '../synth/cost';
import { derivePatch } from '../synth/derive';
import { assemblePatch, SEED_UNIFORM, type AssembledShader } from '../synth/gl/assemble';
import { allGeneratorDefinitions, inlineCatalog } from '../synth/generators';
import {
  base64ToBlob,
  type DecodedImage,
  getImage,
  loadImages,
  putImage,
  subscribeImages,
} from '../synth/images';
import {
  applyModulation,
  createModulationEngine,
  type ModulationEngine,
} from '../synth/modulation';
import { createMotionClock } from '../synth/motion';
import { createQualityController, type QualityController } from '../synth/quality';
import {
  createRecorder,
  parseRecording,
  replayTimeline,
  serializeRecording,
} from '../synth/recording';
import { namespaceToU32, seedToU32 } from '../synth/rng';
import { parsePatch, serializePatch } from '../synth/schema';
import {
  applyOp,
  collectDue,
  createSchedulerState,
  type DueEvent,
  fireExternal as fireExternalEvents,
  type PerformanceTimeline,
  type SchedulerState,
  timeContextFrom,
  type TimeContext,
  type TimelineOp,
} from '../synth/timeline';
import { createTransition, sameTopology, type Transition } from '../synth/transition';
import { DEFAULT_TRANSITION, type TransitionSpec, type VisualPatch } from '../synth/types';

/**
 * Semantic Synth — the generative scene.
 *
 * Derives a Patch from the variation seed, assembles GLSL, modulates params
 * from audio, and caches compiled programs (LRU, async when available).
 *
 * Two mechanisms sit on top of that:
 * - A/B decks. A seed change that keeps the operator topology morphs in place
 *   on a single deck (same shader, interpolated uniforms). A topology change
 *   warms a second deck up and crossfades once its program has linked.
 * - Internal resolution scaling. Below 1.0 the decks render into an offscreen
 *   FBO that is blitted back up to the drawing buffer.
 *
 * On top of both sits the Timeline: scheduled events, external triggers and UI
 * proposals all queue a target patch that the deck machine picks up on the next
 * frame it is free. The scene publishes itself through the External Control
 * Interface (synth/control) so none of those callers has to know about it.
 */

const CACHE_LIMIT = 8;
/** Recording metadata; tracks the package version. */
const ENGINE_VERSION = '1.0.0';

/** Internal-resolution ladder, highest first. Mirrors the quality controller. */
const SCALE_STEPS = [1.0, 0.75, 0.5] as const;
/** Floor of the ladder — we never step below this on our own. */
const MIN_SCALE = 0.5;

/**
 * Upscale pass for the internal-resolution path. The offscreen colour is
 * already premultiplied, so it is passed straight through and composited by the
 * renderer's ONE / ONE_MINUS_SRC_ALPHA blend.
 */
const BLIT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
void main() {
  fragColor = texture(uSrc, vUv);
}`;

type CacheEntry = {
  key: string;
  prog: WebGLProgram;
  uni: Uniforms;
};

/**
 * One playable patch: its program plus the CPU-side state that has to survive
 * across frames (modulation smoothing, an in-place parameter morph).
 */
type SynthDeck = {
  seed: string;
  /** The patch this deck settles on. */
  patch: VisualPatch;
  /** What is actually rendered this frame (interpolated while morphing). */
  live: VisualPatch;
  /** Same-topology parameter morph running on this deck, if any. */
  morph: Transition | null;
  assembled: AssembledShader;
  prog: WebGLProgram;
  uni: Uniforms;
  modEngine: ModulationEngine;
};

/** A patch whose program is being resolved (cache hit or compile). */
type Loading = {
  seed: string;
  key: string;
  patch: VisualPatch;
  assembled: AssembledShader;
};

/** GL objects of an in-flight async compile. Always paired with {@link loading}. */
type PendingCompile = {
  prog: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
};

/** A linked program plus its uniform-location cache. */
type Compiled = {
  prog: WebGLProgram;
  uni: Uniforms;
};

/**
 * Deck state machine.
 * - idle:   one deck on screen (possibly morphing in place)
 * - warmup: a topology change is being compiled; only the old deck draws
 * - fading: both decks draw, crossfaded by the transition
 */
type DeckPhase = 'idle' | 'warmup' | 'fading';

let vao: WebGLVertexArrayObject | null = null;
/** Edge detector for the va.seed path. Written there and nowhere else. */
let observedVaSeed: string | null = null;
/** 現在セットアップ中／進行中の遷移に使う spec。 */
let activeSpec: TransitionSpec = DEFAULT_TRANSITION;
let phase: DeckPhase = 'idle';
/** Deck A: what the audience sees. */
let front: SynthDeck | null = null;
/** Deck B: only present while crossfading. */
let incoming: SynthDeck | null = null;
/** The crossfade between the two decks; set only while phase === 'fading'. */
let deckFade: Transition | null = null;
let loading: Loading | null = null;
let pending: PendingCompile | null = null;
/** LRU: oldest at index 0, newest at end. */
const programCache: CacheEntry[] = [];
let parallelCompile: { COMPLETION_STATUS_KHR: number } | null | undefined;

/**
 * シェーダの `uTime` を進める時計。実時間ではなく音のエネルギーで進むので、
 * 無音では画がほぼ止まる。トランジション / Timeline は実時間 (`t`) のままで、
 * ここは見た目の動きだけを担当する。
 */
const motion = createMotionClock();

// ---- internal resolution ----
let quality: QualityController | null = null;
let scaleTarget: Fbo | null = null;
let blit: Compiled | null = null;
/** 直近フレームの実効解像度スケール。 */
let lastScale = 1;

// ---- image textures ----
/**
 * Content hash → GL texture. Keyed by hash rather than by slot so the same
 * picture uploads once no matter how many operators (or decks) point at it.
 */
const textureCache = new Map<string, WebGLTexture>();
/** 1×1 transparent texel. 画像が無いスロットに刺さり、stamp を v=0 に落とす。 */
let dummyTexture: WebGLTexture | null = null;
/** 解決できなかった参照。警告はキーごとに1回だけ出す（毎フレーム出さない）。 */
const warnedImages = new Set<string>();
let unsubscribeImages: (() => void) | null = null;

// ---- timeline / external control ----
let timeline: PerformanceTimeline = { lockedUntilSec: 0, events: [] };
let scheduler: SchedulerState = createSchedulerState();
let recorder: ReturnType<typeof createRecorder> | null = null;
/** 直近フレームの TimeContext。UI からの op 適用に使う。 */
let lastCtx: TimeContext = { nowSec: 0, barCount: 0, barPhase: 0, bpm: 0, tempoLocked: false };
/** 次にフェード可能になったフレームで適用する遷移先。Timeline / UI 提案が積む。 */
let pendingTarget: { seed: string; patch: VisualPatch; spec: TransitionSpec } | null = null;
let unregisterControl: (() => void) | null = null;
/** Metadata-only catalog for the proposal gate; assembled once. */
const metaCatalog = createCatalog(allGeneratorDefinitions());

function getParallelCompileExt(
  gl: WebGL2RenderingContext,
): { COMPLETION_STATUS_KHR: number } | null {
  if (parallelCompile !== undefined) return parallelCompile;
  const ext = gl.getExtension('KHR_parallel_shader_compile') as {
    COMPLETION_STATUS_KHR: number;
  } | null;
  parallelCompile = ext;
  return ext;
}

function setParamUniform(
  gl: WebGL2RenderingContext,
  u: Uniforms,
  name: string,
  kind: 'number' | 'int' | 'bool' | 'enum',
  value: number | string | boolean,
  options?: string[],
): void {
  switch (kind) {
    case 'number':
      u.f1(name, typeof value === 'number' ? value : Number(value));
      break;
    case 'int':
      u.i1(name, typeof value === 'number' ? value | 0 : Number(value) | 0);
      break;
    case 'bool':
      u.i1(name, value ? 1 : 0);
      break;
    case 'enum': {
      const opts = options ?? [];
      const idx = typeof value === 'string' ? opts.indexOf(value) : Number(value) | 0;
      u.i1(name, idx < 0 ? 0 : idx);
      break;
    }
  }
  void gl;
}

/**
 * The fallback bound to any slot without a usable image.
 *
 * A transparent texel makes the contract fall out of the shader for free:
 * stamp multiplies by alpha, so a missing image renders as an empty field
 * rather than as a black rectangle or a GL error.
 */
function ensureDummyTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
  if (dummyTexture) return dummyTexture;
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
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
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  dummyTexture = tex;
  return tex;
}

/**
 * Upload decoded pixels to a fresh texture.
 *
 * LINEAR without mipmaps and CLAMP_TO_EDGE on both axes: logos are arbitrary
 * sizes, and non-power-of-two textures are only complete under exactly these
 * settings.
 *
 * UNPACK_FLIP_Y_WEBGL is deliberately left alone: it is *ignored* for
 * ImageBitmap sources, so synth/images already hands over bottom-row-first
 * pixels (see its orientation contract). Setting it here would flip canvas
 * sources — rasterized SVGs — and nothing else.
 */
function uploadTexture(gl: WebGL2RenderingContext, decoded: DecodedImage): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // stamp reads luminance and alpha separately, so the alpha must stay straight.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, decoded);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function warnMissingImage(key: string, detail: string): void {
  if (warnedImages.has(key)) return;
  warnedImages.add(key);
  console.warn(`[semantic-synth] texture slot "${key}": ${detail}; drawing empty`);
}

/** Resolve a Patch image reference to an uploaded texture, or null. */
function resolveTexture(
  gl: WebGL2RenderingContext,
  key: string,
  ref: { name: string; hash: string },
): { tex: WebGLTexture; w: number; h: number } | null {
  const record = getImage(ref.hash) ?? getImage(ref.name);
  if (!record) {
    warnMissingImage(key, `image "${ref.name}" (${ref.hash.slice(0, 8)}) is not loaded`);
    return null;
  }
  if (!record.decoded) {
    warnMissingImage(key, `image "${record.name}" could not be decoded`);
    return null;
  }
  const cached = textureCache.get(record.hash);
  if (cached) return { tex: cached, w: record.width, h: record.height };

  const tex = uploadTexture(gl, record.decoded);
  if (!tex) {
    warnMissingImage(key, `GL texture upload failed for "${record.name}"`);
    return null;
  }
  textureCache.set(record.hash, tex);
  return { tex, w: record.width, h: record.height };
}

/**
 * Bind one texture unit per declared slot, in the assembler's declaration order.
 * Unassigned or unresolvable slots get the transparent dummy so the draw always
 * has a complete texture on every sampler.
 */
function bindTextures(
  gl: WebGL2RenderingContext,
  uni: Uniforms,
  assembled: AssembledShader,
  patch: VisualPatch,
): void {
  if (assembled.textures.length === 0) return;

  let unit = 0;
  for (const slot of assembled.textures) {
    const ref = patch.images?.[slot.key];
    if (!ref) warnMissingImage(slot.key, 'no image assigned');
    const resolved = ref ? resolveTexture(gl, slot.key, ref) : null;
    const tex = resolved ? resolved.tex : ensureDummyTexture(gl);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    uni.i1(slot.name, unit);
    uni.f2(slot.sizeName, resolved ? resolved.w : 1, resolved ? resolved.h : 1);
    unit++;
  }
  // Leave unit 0 active: the blit pass and every other scene assume it.
  gl.activeTexture(gl.TEXTURE0);
}

/** Free every image texture (context teardown). */
function disposeTextures(gl: WebGL2RenderingContext): void {
  for (const tex of textureCache.values()) gl.deleteTexture(tex);
  textureCache.clear();
  if (dummyTexture) {
    gl.deleteTexture(dummyTexture);
    dummyTexture = null;
  }
  warnedImages.clear();
}

/** True while a live deck still needs this program — eviction must skip it. */
function progInUse(prog: WebGLProgram): boolean {
  return front?.prog === prog || incoming?.prog === prog;
}

function cacheLookup(key: string): CacheEntry | null {
  const idx = programCache.findIndex((e) => e.key === key);
  if (idx < 0) return null;
  const [entry] = programCache.splice(idx, 1);
  if (!entry) return null;
  programCache.push(entry);
  return entry;
}

function cacheInsert(gl: WebGL2RenderingContext, entry: CacheEntry): void {
  const existing = programCache.findIndex((e) => e.key === entry.key);
  if (existing >= 0) {
    const old = programCache.splice(existing, 1)[0]!;
    if (old.prog !== entry.prog && !progInUse(old.prog)) {
      gl.deleteProgram(old.prog);
    }
  }
  programCache.push(entry);
  while (programCache.length > CACHE_LIMIT) {
    let victimIdx = -1;
    for (let i = 0; i < programCache.length; i++) {
      if (!progInUse(programCache[i]!.prog)) {
        victimIdx = i;
        break;
      }
    }
    if (victimIdx < 0) break;
    const [victim] = programCache.splice(victimIdx, 1);
    if (victim) gl.deleteProgram(victim.prog);
  }
}

function abandonPending(gl: WebGL2RenderingContext): void {
  if (!pending) return;
  gl.deleteShader(pending.vs);
  gl.deleteShader(pending.fs);
  gl.deleteProgram(pending.prog);
  pending = null;
}

/** Drop a warmup whose target is no longer wanted. */
function cancelLoad(gl: WebGL2RenderingContext): void {
  abandonPending(gl);
  loading = null;
}

/**
 * Start compiling `assembled`. Returns the finished program when the driver has
 * no async-compile extension (compilation is synchronous there); otherwise the
 * link is polled by {@link advanceLoad}.
 */
function beginCompile(gl: WebGL2RenderingContext, assembled: AssembledShader): Compiled | null {
  const ext = getParallelCompileExt(gl);
  if (!ext) {
    try {
      const prog = compileProgram(gl, FULLSCREEN_VERT, assembled.fragSrc);
      return { prog, uni: new Uniforms(gl, prog) };
    } catch (e) {
      console.error('[semantic-synth] shader compile failed:', e);
      return null;
    }
  }

  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (prog) gl.deleteProgram(prog);
    console.error('[semantic-synth] failed to create shader/program objects');
    return null;
  }

  gl.shaderSource(vs, FULLSCREEN_VERT);
  gl.compileShader(vs);
  gl.shaderSource(fs, assembled.fragSrc);
  gl.compileShader(fs);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  pending = { prog, vs, fs };
  return null;
}

function makeDeck(l: Loading, compiled: Compiled): SynthDeck {
  return {
    seed: l.seed,
    patch: l.patch,
    live: l.patch,
    morph: null,
    assembled: l.assembled,
    prog: compiled.prog,
    uni: compiled.uni,
    modEngine: createModulationEngine(l.patch.routes),
  };
}

/**
 * Hand the freshly resolved program to a deck. With no deck on screen it takes
 * over directly (cold start); otherwise it becomes deck B and the crossfade
 * starts here — never earlier, so the fade can't stall on a pending link.
 */
function installLoaded(gl: WebGL2RenderingContext, compiled: Compiled, nowMs: number): void {
  const l = loading;
  if (!l) return;
  loading = null;

  const deck = makeDeck(l, compiled);
  if (!front) {
    // Cold start: nothing to fade from.
    front = deck;
    phase = 'idle';
  } else {
    // warmup → fading. startMs is *now*, so the fade covers its full duration
    // regardless of how long the compile took.
    incoming = deck;
    deckFade = createTransition(front.live, deck.patch, activeSpec, nowMs);
    phase = 'fading';
  }
  // Insert after the deck exists so eviction can see the program is in use.
  cacheInsert(gl, { key: l.key, prog: compiled.prog, uni: compiled.uni });
  // Either branch changes what getState() reports: a cold start puts the first
  // patch on screen, a warmup turns into a running crossfade.
  notifySynthControlChanged();
}

/**
 * Begin warming a new topology up. Replaces whatever warmup was in flight —
 * seed changes never queue, only the newest one matters.
 */
function startLoad(
  gl: WebGL2RenderingContext,
  seed: string,
  patch: VisualPatch,
  nowMs: number,
): void {
  const key = serializePatch(patch);
  const assembled = assemblePatch(patch, inlineCatalog);

  // Same topology as the warmup already linking → identical shader source, so
  // keep that link running and just retarget its parameters.
  if (loading && pending && sameTopology(loading.patch, patch)) {
    loading = { seed, key, patch, assembled };
    return;
  }

  cancelLoad(gl);
  loading = { seed, key, patch, assembled };
  // idle → warmup. The old deck keeps drawing alone until the program links.
  phase = 'warmup';

  const hit = cacheLookup(key);
  if (hit) {
    installLoaded(gl, { prog: hit.prog, uni: hit.uni }, nowMs);
    return;
  }
  const compiled = beginCompile(gl, assembled);
  if (compiled) installLoaded(gl, compiled, nowMs);
}

/** Drive an in-flight compile: install it once linked, drop it if it failed. */
function advanceLoad(gl: WebGL2RenderingContext, nowMs: number): void {
  if (!loading || !pending) return;
  const ext = getParallelCompileExt(gl);
  if (!ext) return;

  const done = gl.getProgramParameter(pending.prog, ext.COMPLETION_STATUS_KHR);
  if (!done) return;

  const { prog, vs, fs } = pending;
  pending = null;

  const vsOk = gl.getShaderParameter(vs, gl.COMPILE_STATUS);
  const fsOk = gl.getShaderParameter(fs, gl.COMPILE_STATUS);
  const linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS);

  if (!vsOk || !fsOk || !linkOk) {
    const vsLog = gl.getShaderInfoLog(vs) ?? '';
    const fsLog = gl.getShaderInfoLog(fs) ?? '';
    const progLog = gl.getProgramInfoLog(prog) ?? '';
    console.error('[semantic-synth] async shader compile/link failed:\n', vsLog, fsLog, progLog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteProgram(prog);
    // warmup → idle. Give up on this patch; the old deck keeps playing.
    loading = null;
    phase = 'idle';
    return;
  }

  gl.detachShader(prog, vs);
  gl.detachShader(prog, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  installLoaded(gl, { prog, uni: new Uniforms(gl, prog) }, nowMs);
}

/** どのソース（va.seed / Timeline / UI 提案）から来た Patch でも、ここを通して遷移させる。 */
function gotoPatch(
  gl: WebGL2RenderingContext,
  seed: string,
  patch: VisualPatch,
  spec: TransitionSpec,
  nowMs: number,
): void {
  // installLoaded may run several frames later, so the spec has to be parked
  // here rather than passed down.
  activeSpec = spec;

  if (front && sameTopology(front.live, patch)) {
    // Same operator graph → same shader. Morph in place on the single deck; the
    // warmup (if any) targeted a topology nobody wants any more.
    cancelLoad(gl);
    phase = 'idle';
    front.morph = createTransition(front.live, patch, spec, nowMs);
    front.patch = patch;
    notifySynthControlChanged();
    return;
  }

  // Different graph → a second deck has to be compiled before anything fades.
  startLoad(gl, seed, patch, nowMs);
  notifySynthControlChanged();
}

/** React to a va.seed change. The topology decides which kind of transition runs. */
function syncSeed(gl: WebGL2RenderingContext, seed: string, nowMs: number): void {
  if (seed === observedVaSeed) return;
  // クロスフェード中は新しい seed を始められない。observedVaSeed をわざと古いまま
  // 残すので、idle に戻った最初のフレームで再発火する。
  if (phase === 'fading') return;

  observedVaSeed = seed;
  gotoPatch(gl, seed, derivePatch(seed, { catalog: inlineCatalog }), DEFAULT_TRANSITION, nowMs);
}

/**
 * Turn a fired event into a pending target. collectDue hands events over in
 * fire-time order, so when several land on the same frame the last one wins.
 */
function handleDue(d: DueEvent): void {
  recorder?.recordFired(lastCtx.nowSec, d.event.id);

  const { patch, seed } = d.event.intent;
  if (patch) {
    pendingTarget = { seed: patch.seed, patch, spec: d.event.transition };
    return;
  }
  if (seed !== undefined) {
    pendingTarget = {
      seed,
      patch: derivePatch(seed, { catalog: inlineCatalog }),
      spec: d.event.transition,
    };
  }
  // An intent carrying neither is a label-only marker — nothing to show.
}

/** Advance a deck's in-place morph and refresh what it renders this frame. */
function updateDeck(deck: SynthDeck, nowMs: number): void {
  const morph = deck.morph;
  if (!morph) return;

  const sample = morph.sample(nowMs);
  deck.live = sample.patch;
  if (sample.done) {
    deck.live = deck.patch;
    deck.morph = null;
    // Swap the modulation engine only once the routes have settled: rebuilding
    // it per frame would reset the exponential smoothing state every frame.
    deck.modEngine = createModulationEngine(deck.patch.routes);
    notifySynthControlChanged();
  }
}

/** Advance the crossfade and return each deck's uFade for this frame. */
function advanceFade(nowMs: number): { fadeA: number; fadeB: number } {
  if (phase !== 'fading' || !deckFade || !incoming) return { fadeA: 1, fadeB: 0 };

  const sample = deckFade.sample(nowMs);
  if (sample.done) {
    // fading → idle. The old deck is released: its modulation engine goes with
    // it, its program stays in the LRU cache (and becomes evictable again).
    front = incoming;
    incoming = null;
    deckFade = null;
    phase = 'idle';
    // observedVaSeed is deliberately left alone. It tracks the va.seed path only;
    // writing front.seed back here would make a Timeline-driven transition look
    // like an unhandled va.seed change and snap the visual back to the URL seed
    // on the very next frame.
    notifySynthControlChanged();
    return { fadeA: 1, fadeB: 0 };
  }
  return { fadeA: sample.fadeA, fadeB: sample.fadeB };
}

/** Draw one deck at the given fade level into whatever target is bound. */
function drawDeck(
  s: GlSceneContext,
  deck: SynthDeck,
  fade: number,
  renderW: number,
  renderH: number,
): void {
  const { gl, t, dt, audio, hue } = s;
  const { assembled, prog, uni, modEngine } = deck;
  const patch = deck.live;

  const resolved = modEngine.update(audio, t, dt);
  const values = applyModulation(patch, inlineCatalog, resolved);

  // ビートは音量で殺す。テンポグリッドはブレイク中もフリーホイールするので、
  // 生の gridPulse をそのまま渡すと無音でも画が拍ごとに跳ねてしまう。
  const pulse = audio.tempoLocked ? audio.gridPulse : audio.beatIntensity;

  gl.useProgram(prog);
  // uRes is the size of the *render target*, so the internal-resolution path
  // keeps the aspect correct (fwidth-based AA follows the target on its own).
  uni.f2('uRes', renderW, renderH);
  // 実時間ではなく音駆動の時計。無音でほぼ止まるのはここが効いている。
  uni.f1('uTime', motion.time);
  uni.f1('uBass', audio.bass);
  uni.f1('uMid', audio.mid);
  uni.f1('uTreble', audio.treble);
  uni.f1('uLevel', audio.level);
  uni.f1('uBeat', pulse);
  uni.f1('uPunch', pulse * motion.energy);
  uni.f1('uEnergy', motion.energy);
  uni.f1('uFade', fade);

  const seedLoc = gl.getUniformLocation(prog, SEED_UNIFORM);
  if (seedLoc) {
    gl.uniform1ui(seedLoc, seedToU32(patch.seed) >>> 0);
  }

  for (const { opId, name } of assembled.nsUniforms) {
    const loc = gl.getUniformLocation(prog, name);
    if (loc) {
      gl.uniform1ui(loc, namespaceToU32(`op:${opId}`) >>> 0);
    }
  }

  for (const { opId, paramId, name } of assembled.uniforms) {
    const op = patch.operators.find((o) => o.id === opId);
    if (!op) continue;
    const gen = inlineCatalog.get(op.generatorId);
    if (!gen) continue;
    const paramDef = gen.def.parameters.find((p) => p.id === paramId);
    if (!paramDef) continue;
    const key = `${opId}.${paramId}`;
    const raw = values.get(key) ?? op.parameters[paramId] ?? paramDef.default;
    // Patch の hue を絶対値ではなくレンダラ hue からのオフセットとして扱う。
    // hue サイクルと固定 hue の UI をこのシーンでも効かせるため。
    const value = paramId === 'hue' && typeof raw === 'number' ? (raw + hue) % 360 : raw;
    setParamUniform(gl, uni, name, paramDef.kind, value, paramDef.options);
  }

  bindTextures(gl, uni, assembled, patch);

  if (vao) drawFullscreen(gl, vao);
}

/** The next lower rung of {@link SCALE_STEPS}, never raising the resolution. */
function stepDownScale(scale: number): number {
  for (const step of SCALE_STEPS) {
    if (step < scale - 1e-6) return step;
  }
  // Already at (or below) the floor — hold there rather than dropping further.
  return Math.min(scale, MIN_SCALE);
}

/** Offscreen target for the internal-resolution path, sized to pxW/pxH * scale. */
function ensureScaleTarget(
  gl: WebGL2RenderingContext,
  pxW: number,
  pxH: number,
  scale: number,
): Fbo | null {
  const w = Math.max(1, Math.round(pxW * scale));
  const h = Math.max(1, Math.round(pxH * scale));
  if (scaleTarget && scaleTarget.w === w && scaleTarget.h === h) return scaleTarget;

  if (scaleTarget) {
    disposeFbo(gl, scaleTarget);
    scaleTarget = null;
  }
  try {
    // RGBA8: the decks output premultiplied 8-bit colour, same as the canvas.
    scaleTarget = createFbo(gl, w, h);
  } catch (e) {
    console.error('[semantic-synth] offscreen target failed; drawing at full res:', e);
    scaleTarget = null;
  }
  return scaleTarget;
}

/** Upscale the offscreen colour onto the drawing buffer. */
function blitToScreen(gl: WebGL2RenderingContext, src: Fbo, pxW: number, pxH: number): void {
  if (!blit || !vao) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, pxW, pxH);
  gl.useProgram(blit.prog);
  // createFbo already set LINEAR / CLAMP_TO_EDGE on the texture, which is
  // exactly what the upscale wants; only the unit binding is ours to make.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, src.tex);
  blit.uni.i1('uSrc', 0);
  drawFullscreen(gl, vao);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/**
 * The scene's side of the External Control Interface. Everything that would
 * start a transition only queues {@link pendingTarget}: the deck machine owns
 * when a change is allowed to happen, and draw() is the single place that
 * decides it.
 */
const control: SynthControlBackend = {
  getState() {
    return {
      currentPatch: front ? front.patch : null,
      timeline,
      transitionActive:
        phase !== 'idle' || loading !== null || (front !== null && front.morph !== null),
      qualityScale: lastScale,
      recordingActive: recorder !== null,
      nowSec: lastCtx.nowSec,
      barCount: lastCtx.barCount,
      tempoLocked: lastCtx.tempoLocked,
      firedIds: scheduler.firedIds,
    };
  },

  proposePatch(input: unknown) {
    // The budget is per quality tier, so the tier has to be read off the input
    // before the gate can be handed one.
    const parsed = parsePatch(input);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };

    const result = gatePatchProposal(input, metaCatalog, DEFAULT_BUDGETS[parsed.patch.qualityTier]);
    if (!result.ok || !result.patch) {
      return { ok: false, issues: result.issues.map((i) => i.message) };
    }
    pendingTarget = { seed: result.patch.seed, patch: result.patch, spec: DEFAULT_TRANSITION };
    notifySynthControlChanged();
    return { ok: true, issues: [] };
  },

  proposeSeed(seed: string) {
    pendingTarget = {
      seed,
      patch: derivePatch(seed, { catalog: inlineCatalog }),
      spec: DEFAULT_TRANSITION,
    };
    notifySynthControlChanged();
  },

  async setImage(name: string, bytesBase64: string, mime: string) {
    const trimmed = name.trim();
    if (trimmed === '') return { ok: false, issues: ['image name must not be empty'] };

    let blob: Blob;
    try {
      blob = base64ToBlob(bytesBase64, mime);
    } catch (e) {
      return {
        ok: false,
        issues: [`invalid base64 payload: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
    if (blob.size === 0) return { ok: false, issues: ['image payload is empty'] };

    try {
      const meta = await putImage(trimmed, blob);
      if (meta.width === 0 || meta.height === 0) {
        return { ok: false, issues: [`"${trimmed}" could not be decoded as an image`] };
      }
      // A newly available image can rescue a slot that was drawing empty; the
      // image-store subscription clears the warned set, so it can warn again if
      // the same slot breaks later.
      notifySynthControlChanged();
      return { ok: true, issues: [], hash: meta.hash, name: meta.name };
    } catch (e) {
      return { ok: false, issues: [e instanceof Error ? e.message : String(e)] };
    }
  },

  applyTimelineOp(op: TimelineOp) {
    const result = applyOp(timeline, op, lastCtx);
    if (!result.ok) return { ok: false, issue: result.issue };

    timeline = result.timeline;
    // Record the op, not its effect: replay rebuilds the timeline by re-applying.
    recorder?.recordOp(lastCtx.nowSec, op);
    notifySynthControlChanged();
    return { ok: true };
  },

  fireExternal(id: string) {
    const { due, state } = fireExternalEvents(timeline, scheduler, id, lastCtx);
    if (due.length === 0) return;
    scheduler = state;
    for (const d of due) handleDue(d);
    notifySynthControlChanged();
  },

  startRecording() {
    // Without a deck on screen there is no initial patch to record against.
    if (recorder || !front) return;
    recorder = createRecorder(ENGINE_VERSION, front.patch.seed, front.patch);
    notifySynthControlChanged();
  },

  stopRecording() {
    if (!recorder) return null;
    const json = serializeRecording(recorder.snapshot());
    recorder = null;
    notifySynthControlChanged();
    return json;
  },

  loadRecording(json: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      return { ok: false, issues: [`invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const parsed = parseRecording(raw);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };

    timeline = replayTimeline(parsed.rec, Number.POSITIVE_INFINITY);
    scheduler = createSchedulerState();
    // Rewind the visuals too: the recorded events were authored against this
    // patch, so replaying from anywhere else would drift immediately.
    pendingTarget = {
      seed: parsed.rec.initialPatch.seed,
      patch: parsed.rec.initialPatch,
      spec: DEFAULT_TRANSITION,
    };
    notifySynthControlChanged();
    return { ok: true, issues: [] };
  },
};

export const semanticSynthScene: GlScene = {
  kind: 'gl',
  id: 'semantic-synth',
  name: 'Semantic Synth',

  init(gl: WebGL2RenderingContext) {
    // Called on first activation and after a context loss: every GL object from
    // a previous context is already gone, so drop the references and rebuild.
    vao = createEmptyVao(gl);
    observedVaSeed = null;
    activeSpec = DEFAULT_TRANSITION;
    phase = 'idle';
    front = null;
    incoming = null;
    deckFade = null;
    loading = null;
    pending = null;
    programCache.length = 0;
    parallelCompile = undefined;
    scaleTarget = null;
    lastScale = 1;
    quality = createQualityController();

    // Textures belong to the context that just went away — drop the handles
    // without deleting them (deleting against the new context is a no-op at
    // best) and let the next frame re-upload from the image store.
    textureCache.clear();
    dummyTexture = null;
    warnedImages.clear();
    // Persisted images have to come back before a Patch that references them can
    // draw. Fire and forget: until it lands the slots fall back to the dummy.
    void loadImages();
    unsubscribeImages?.();
    // A late-arriving image should be able to warn again if it disappears later.
    unsubscribeImages = subscribeImages(() => {
      warnedImages.clear();
    });

    // timeline / scheduler / recorder は GL コンテキストのリソースではなく演奏中の
    // セッション状態なので、ここではリセットしない。init はコンテキストロスト
    // 復帰でも呼ばれるため、ここで初期化すると復帰のたびに組んだイベントが無言で
    // 消え、firedIds も失われて発火済みイベントが再発火してしまう。それらは
    // dispose（シーンの完全な破棄）でのみ捨てる。
    pendingTarget = null;
    unregisterControl = registerSynthControl(control);

    try {
      const prog = compileProgram(gl, FULLSCREEN_VERT, BLIT_FRAG);
      blit = { prog, uni: new Uniforms(gl, prog) };
    } catch (e) {
      console.error('[semantic-synth] blit program failed; internal scaling disabled:', e);
      blit = null;
    }
  },

  draw(s: GlSceneContext) {
    const { gl, pxW, pxH, t, dt, audio, va } = s;
    if (!vao) return;

    // Scene time drives every transition — never wall-clock, so the scene stays
    // reproducible under a stubbed clock.
    const nowMs = t * 1000;
    lastCtx = timeContextFrom(audio, t);

    // Collect whatever came due this frame and queue it.
    const { due, state } = collectDue(timeline, scheduler, lastCtx);
    if (due.length > 0) {
      scheduler = state;
      for (const d of due) handleDue(d);
      notifySynthControlChanged();
    }

    if (pendingTarget) {
      // Timeline / UI proposals outrank va.seed. A crossfade owns both decks, so
      // a queued target simply waits for the frame that reaches idle.
      if (phase !== 'fading') {
        const target = pendingTarget;
        pendingTarget = null;
        // Mark the current va.seed consumed on the frame the Timeline takes over:
        // otherwise syncSeed fires next frame and overwrites what just landed.
        observedVaSeed = va.seed;
        gotoPatch(gl, target.seed, target.patch, target.spec, nowMs);
      }
    } else {
      syncSeed(gl, va.seed, nowMs);
    }

    advanceLoad(gl, nowMs);

    if (front) updateDeck(front, nowMs);
    if (incoming) updateDeck(incoming, nowMs);
    const { fadeA, fadeB } = advanceFade(nowMs);

    // Patch ごとの動きの速さ。クロスフェード中は incoming の速さへ補間するので、
    // デッキが入れ替わった瞬間に動きの速度が飛ばない。
    const speedA = front?.live.composition.speed ?? 1;
    const speedB = incoming?.live.composition.speed ?? speedA;
    const patchSpeed = phase === 'fading' ? speedA + (speedB - speedA) * fadeB : speedA;
    // 描画しないフレームでも進めておく（音が鳴っている間に時計が止まらないように）。
    motion.advance(audio, dt, patchSpeed);

    // Keep the controller fed even on frames that draw nothing.
    let scale = quality ? quality.update(dt * 1000, nowMs) : 1;
    if (phase === 'fading') {
      // Both decks run their full-screen shader this frame, so fill rate roughly
      // doubles. Drop one rung below whatever the controller asked for — cheap
      // insurance against a stutter landing right on the transition.
      scale = stepDownScale(scale);
    }
    lastScale = scale;

    if (!front) return;

    // scale === 1 stays on the direct path: no FBO, no blit, zero overhead when
    // nothing is struggling.
    const target = scale < 1 && blit ? ensureScaleTarget(gl, pxW, pxH, scale) : null;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
      // Transparent clear, same premultiplied contract as the renderer's.
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    const renderW = target ? target.w : pxW;
    const renderH = target ? target.h : pxH;

    // Old deck first, new deck over it — premultiplied blend does the rest.
    drawDeck(s, front, fadeA, renderW, renderH);
    if (phase === 'fading' && incoming) {
      drawDeck(s, incoming, fadeB, renderW, renderH);
    }

    if (target) blitToScreen(gl, target, pxW, pxH);
  },

  resize(gl: WebGL2RenderingContext) {
    // The offscreen target is sized from the drawing buffer; drop it and let the
    // next frame rebuild it at the new size.
    if (scaleTarget) {
      disposeFbo(gl, scaleTarget);
      scaleTarget = null;
    }
  },

  dispose(gl: WebGL2RenderingContext) {
    unregisterControl?.();
    unregisterControl = null;
    unsubscribeImages?.();
    unsubscribeImages = null;
    disposeTextures(gl);
    // Session state (timeline / scheduler / recorder) is only ever dropped here,
    // when the scene itself goes away — not in init(), which also runs on
    // context-restore and must not wipe out a performance in progress.
    timeline = { lockedUntilSec: 0, events: [] };
    scheduler = createSchedulerState();
    recorder = null;
    // init() ではなくここでだけ戻す。コンテキストロスト復帰で巻き戻すと、
    // 復帰した瞬間に画の位相が飛んでしまう。
    motion.reset();
    pendingTarget = null;
    abandonPending(gl);
    loading = null;
    const deleted = new Set<WebGLProgram>();
    for (const entry of programCache) {
      if (!deleted.has(entry.prog)) {
        gl.deleteProgram(entry.prog);
        deleted.add(entry.prog);
      }
    }
    programCache.length = 0;
    for (const deck of [front, incoming]) {
      if (deck && !deleted.has(deck.prog)) {
        gl.deleteProgram(deck.prog);
        deleted.add(deck.prog);
      }
    }
    front = null;
    incoming = null;
    deckFade = null;
    phase = 'idle';
    observedVaSeed = null;
    if (scaleTarget) {
      disposeFbo(gl, scaleTarget);
      scaleTarget = null;
    }
    if (blit) {
      gl.deleteProgram(blit.prog);
      blit = null;
    }
    quality = null;
    if (vao) gl.deleteVertexArray(vao);
    vao = null;
    parallelCompile = undefined;
  },
};
