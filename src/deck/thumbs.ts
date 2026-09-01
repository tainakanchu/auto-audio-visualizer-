/**
 * Scene Deck のオフスクリーン WebGL2 サムネイル。
 *
 * gpuHarness は playwright を引くのでここからは import しない。assemble +
 * glutil だけで、同トポロジのバンクは fragSrc キャッシュにより 1 compile +
 * 8 draw になる。
 */
import {
  compileProgram,
  createEmptyVao,
  drawFullscreen,
  FULLSCREEN_VERT,
  Uniforms,
} from '../render/glutil';
import { inlineCatalog } from '../synth/generators';
import { assemblePatch, SEED_UNIFORM } from '../synth/gl/assemble';
import { namespaceToU32, seedToU32 } from '../synth/rng';
import type { VisualPatch } from '../synth/types';

export interface ThumbRenderer {
  render(patch: VisualPatch): string | null;
  dispose(): void;
}

const THUMB_TIME = 1.7;
const AUDIO_LEVEL = 0.5;
const SWELL_LEVEL = 0.5;

interface CachedProgram {
  prog: WebGLProgram;
  uni: Uniforms;
}

/** 同トポロジのバンクなら 1〜2 本で足りる。多相バンクでも青天井にしない。 */
const CACHE_LIMIT = 4;

export function createThumbRenderer(w = 192, h = 108): ThumbRenderer {
  const width = Number.isFinite(w) && w > 0 ? Math.max(1, Math.round(w)) : 192;
  const height = Number.isFinite(h) && h > 0 ? Math.max(1, Math.round(h)) : 108;

  if (typeof document === 'undefined') {
    return { render: () => null, dispose: () => {} };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
  });

  if (!gl) {
    return { render: () => null, dispose: () => {} };
  }

  let vao: WebGLVertexArrayObject;
  let dummy: WebGLTexture;
  try {
    vao = createEmptyVao(gl);
    dummy = makeDummyTexture(gl);
  } catch {
    return { render: () => null, dispose: () => {} };
  }

  const cache = new Map<string, CachedProgram | 'fail'>();
  let disposed = false;
  // コンテキストロスト後は program も vao も dummy も無効。restore で組み直す。
  let ready = true;

  const onContextLost = (e: Event): void => {
    // preventDefault しないとブラウザは復帰させてくれない。
    e.preventDefault();
    ready = false;
  };
  const onContextRestored = (): void => {
    // ロスト前の program は無効。deleteProgram は呼ばずに捨てる。
    cache.clear();
    try {
      vao = createEmptyVao(gl);
      dummy = makeDummyTexture(gl);
      ready = true;
    } catch {
      ready = false;
    }
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  const render = (patch: VisualPatch): string | null => {
    if (disposed || !ready || gl.isContextLost()) return null;
    try {
      const assembled = assemblePatch(patch, inlineCatalog, { reactions: 'off' });
      const cached = getProgram(gl, cache, assembled.fragSrc);
      if (!cached) return null;

      const { prog, uni } = cached;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);

      uni.f2('uRes', width, height);
      uni.f1('uTime', THUMB_TIME);
      uni.f1('uBass', AUDIO_LEVEL);
      uni.f1('uMid', AUDIO_LEVEL);
      uni.f1('uTreble', AUDIO_LEVEL);
      uni.f1('uLevel', AUDIO_LEVEL);
      uni.f1('uBeat', AUDIO_LEVEL);
      uni.f1('uEnergy', AUDIO_LEVEL);
      // drawDeck の uPunch = pulse * energy。凍結値 0.5 * 0.5。
      uni.f1('uPunch', AUDIO_LEVEL * AUDIO_LEVEL);
      uni.f1('uSwellWave', SWELL_LEVEL);
      uni.f1('uSwellGroup', SWELL_LEVEL);
      uni.f1('uSwellSet', SWELL_LEVEL);
      uni.f1('uSwellSurge', SWELL_LEVEL);
      uni.f1('uFade', 1);

      setUint(gl, prog, SEED_UNIFORM, seedToU32(patch.seed));
      for (const { opId, name } of assembled.nsUniforms) {
        setUint(gl, prog, name, namespaceToU32(`op:${opId}`));
      }

      for (const { opId, paramId, name } of assembled.uniforms) {
        const op = patch.operators.find((o) => o.id === opId);
        if (!op) continue;
        const gen = inlineCatalog.get(op.generatorId);
        if (!gen) continue;
        const paramDef = gen.def.parameters.find((p) => p.id === paramId);
        if (!paramDef) continue;
        const raw = op.parameters[paramId] ?? paramDef.default;
        // サムネにレンダラ hue は無い。patch の値をそのまま使う。
        setParamUniform(uni, paramDef.kind, name, raw, paramDef.options);
      }

      bindDummyTextures(gl, uni, assembled.textures, dummy);
      drawFullscreen(gl, vao);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    for (const entry of cache.values()) {
      if (entry !== 'fail') gl.deleteProgram(entry.prog);
    }
    cache.clear();
    gl.deleteVertexArray(vao);
    gl.deleteTexture(dummy);
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  };

  return { render, dispose };
}

function getProgram(
  gl: WebGL2RenderingContext,
  cache: Map<string, CachedProgram | 'fail'>,
  fragSrc: string,
): CachedProgram | null {
  const hit = cache.get(fragSrc);
  if (hit === 'fail') return null;
  if (hit) return hit;
  try {
    const prog = compileProgram(gl, FULLSCREEN_VERT, fragSrc);
    const entry: CachedProgram = { prog, uni: new Uniforms(gl, prog) };
    cache.set(fragSrc, entry);
    evictOldest(gl, cache);
    return entry;
  } catch {
    cache.set(fragSrc, 'fail');
    evictOldest(gl, cache);
    return null;
  }
}

/** 挿入順 LRU。Map は挿入順を保つので先頭が最古。 */
function evictOldest(gl: WebGL2RenderingContext, cache: Map<string, CachedProgram | 'fail'>): void {
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    const entry = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (entry !== undefined && entry !== 'fail') gl.deleteProgram(entry.prog);
  }
}

function setUint(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  name: string,
  value: number,
): void {
  const loc = gl.getUniformLocation(prog, name);
  if (loc) gl.uniform1ui(loc, value >>> 0);
}

function setParamUniform(
  uni: Uniforms,
  kind: 'number' | 'int' | 'bool' | 'enum',
  name: string,
  value: number | string | boolean,
  options?: string[],
): void {
  switch (kind) {
    case 'number':
      uni.f1(name, typeof value === 'number' ? value : Number(value));
      break;
    case 'int':
      uni.i1(name, typeof value === 'number' ? value | 0 : Number(value) | 0);
      break;
    case 'bool':
      uni.i1(name, value ? 1 : 0);
      break;
    case 'enum': {
      const opts = options ?? [];
      const idx = typeof value === 'string' ? opts.indexOf(value) : Number(value) | 0;
      uni.i1(name, idx < 0 ? 0 : idx);
      break;
    }
  }
}

function makeDummyTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('thumb dummy texture failed');
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
  return tex;
}

function bindDummyTextures(
  gl: WebGL2RenderingContext,
  uni: Uniforms,
  textures: Array<{ name: string; sizeName: string }>,
  dummy: WebGLTexture,
): void {
  if (textures.length === 0) return;
  let unit = 0;
  for (const slot of textures) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, dummy);
    uni.i1(slot.name, unit);
    uni.f2(slot.sizeName, 1, 1);
    unit++;
  }
  gl.activeTexture(gl.TEXTURE0);
}
