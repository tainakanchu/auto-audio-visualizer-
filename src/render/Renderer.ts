import type { AudioEngine } from '../audio/AudioEngine';
import type { GlScene, Scene, Scene2D, SceneContext, GlSceneContext } from '../scenes/types';
import type { Variation } from '../variation/types';
import { checkFloatColorSupport, type FloatColorSupport } from './glutil';

/** Degrees the base hue advances per second when cycling. */
const HUE_CYCLE_PER_SEC = 6;
/** Largest dt handed to scenes, so a stalled tab can't explode physics. */
const MAX_DT = 0.1;
/** Hard DPR cap for the laptop-iGPU GL canvas (procedural fullscreen passes). */
const GL_MAX_DPR = 1.5;

export interface RendererOptions {
  /** The Canvas-2D overlay canvas. */
  canvas: HTMLCanvasElement;
  /** The WebGL2 overlay canvas (stacked underneath / above with CSS). */
  glCanvas: HTMLCanvasElement;
  engine: AudioEngine;
  /** Returns the live gain multiplier (0.5..4). */
  getGain: () => number;
  /** Returns the fixed hue, or null to cycle. */
  getFixedHue: () => number | null;
  /** Initial seeded variation (the renderer always holds one). */
  variation: Variation;
}

/**
 * Owns the requestAnimationFrame loop, BOTH canvases (Canvas-2D + WebGL2),
 * DPR sizing, hue cycling, and trail compositing. React never touches a canvas
 * per frame. The GL context is created lazily on first GL-scene activation and
 * gracefully skipped if WebGL2 is unavailable.
 */
export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly glCanvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly engine: AudioEngine;
  private readonly getGain: () => number;
  private readonly getFixedHue: () => number | null;

  private variation: Variation;

  private scenes: Scene[] = [];
  private current: Scene | null = null;

  // ---- WebGL2 (lazy) ----
  private gl: WebGL2RenderingContext | null = null;
  private glInitTried = false;
  private glSupported = false;
  private floatSupport: FloatColorSupport | null = null;
  /** GL scenes whose init() has run against the live context. */
  private readonly initedGl = new Set<GlScene>();

  private rafId = 0;
  private startTime = 0;
  private lastTime = 0;
  private hue = 200;

  // CSS-pixel logical size (shared by both canvases).
  private cssW = 0;
  private cssH = 0;
  // Physical drawing-buffer size of the GL canvas (DPR-capped).
  private glPxW = 0;
  private glPxH = 0;

  private readonly resizeObserver: ResizeObserver;

  constructor(opts: RendererOptions) {
    this.canvas = opts.canvas;
    this.glCanvas = opts.glCanvas;
    this.engine = opts.engine;
    this.getGain = opts.getGain;
    this.getFixedHue = opts.getFixedHue;
    this.variation = opts.variation;

    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.glCanvas.addEventListener('webglcontextlost', this.onContextLost);
    this.glCanvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    window.addEventListener('resize', this.resize);
  }

  /** Register the ordered scene list (does not change the active scene). */
  setScenes(scenes: Scene[]): void {
    this.scenes = scenes;
    if (!this.current && scenes.length > 0) {
      this.setScene(scenes[0].id);
    }
  }

  /**
   * Whether WebGL2 is available. The UI greys out GL scenes when false. This
   * reflects the result of the (lazy) context creation; before the first GL
   * activation it optimistically reports true unless creation has been tried
   * and failed.
   */
  get glAvailable(): boolean {
    return this.glInitTried ? this.glSupported : this.probeGlAvailable();
  }

  /**
   * Cheap one-shot capability probe used by the UI before any GL scene is
   * activated. Does not allocate the real context — it tests support on a
   * throwaway canvas and caches the boolean on the instance.
   */
  private probedAvailable: boolean | null = null;
  private probeGlAvailable(): boolean {
    if (this.probedAvailable !== null) return this.probedAvailable;
    try {
      const test = document.createElement('canvas');
      this.probedAvailable = test.getContext('webgl2') !== null;
    } catch {
      this.probedAvailable = false;
    }
    return this.probedAvailable;
  }

  /** Activate a scene by id and run its init/setup. */
  setScene(id: string): void {
    const next = this.scenes.find((s) => s.id === id);
    if (!next) return;

    // Refuse to activate a GL scene when WebGL2 can't be obtained — stay put.
    if (next.kind === 'gl' && !this.ensureGl()) return;

    const prev = this.current;
    if (prev && prev !== next) this.deactivate(prev);

    this.current = next;

    if (next.kind === '2d') {
      next.init?.();
      this.ctx.clearRect(0, 0, this.cssW, this.cssH);
      this.hide2dCanvas(false);
      this.hideGlCanvas(true);
    } else {
      this.activateGl(next);
      this.hideGlCanvas(false);
      this.hide2dCanvas(true);
      // Drop any residual 2D content so it can't bleed through.
      this.ctx.clearRect(0, 0, this.cssW, this.cssH);
    }
  }

  /** Tear down visibility/state for the scene being left (keeps GPU resources). */
  private deactivate(scene: Scene): void {
    if (scene.kind === '2d') {
      this.ctx.clearRect(0, 0, this.cssW, this.cssH);
    } else if (this.gl) {
      this.clearGl();
    }
  }

  /** Ensure a GL scene's resources exist and it is sized for the buffer. */
  private activateGl(scene: GlScene): void {
    const gl = this.gl;
    if (!gl) return;
    if (!this.initedGl.has(scene)) {
      scene.init(gl);
      this.initedGl.add(scene);
    }
    if (this.glPxW > 0 && this.glPxH > 0) {
      scene.resize?.(gl, this.glPxW, this.glPxH);
    }
    this.clearGl();
  }

  /**
   * Swap the seeded variation. For 2D scenes this re-inits the active scene (so
   * element-count arrays re-allocate) and clears the canvas. GL scenes read
   * `va` per frame and derive per-element values via va.rand, so a seed change
   * needs no GPU churn — just clear once for a clean snap.
   */
  setVariation(v: Variation): void {
    if (v === this.variation) return;
    this.variation = v;
    const cur = this.current;
    if (!cur) return;
    if (cur.kind === '2d') {
      cur.init?.();
      this.ctx.clearRect(0, 0, this.cssW, this.cssH);
    } else if (this.gl) {
      this.clearGl();
    }
  }

  get activeSceneId(): string | null {
    return this.current?.id ?? null;
  }

  start(): void {
    if (this.rafId) return;
    this.startTime = performance.now();
    this.lastTime = this.startTime;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.resize);
    this.glCanvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.glCanvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    const gl = this.gl;
    if (gl) {
      for (const scene of this.initedGl) scene.dispose(gl);
      this.initedGl.clear();
    }
  }

  // ---- WebGL2 lifecycle ----------------------------------------------------

  /** Lazily create the WebGL2 context. Returns true if GL is usable. */
  private ensureGl(): boolean {
    if (this.gl) return true;
    if (this.glInitTried && !this.glSupported) return false;
    this.glInitTried = true;
    const gl = this.glCanvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      this.glSupported = false;
      this.probedAvailable = false;
      return false;
    }
    this.gl = gl;
    this.glSupported = true;
    this.probedAvailable = true;
    this.floatSupport = checkFloatColorSupport(gl);
    // Premultiplied-alpha straight blend over the transparent page.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.syncGlBufferSize();
    return true;
  }

  /** Float-colour render support (null until the GL context exists). */
  get glFloatSupport(): FloatColorSupport | null {
    return this.floatSupport;
  }

  private clearGl(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.glPxW, this.glPxH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private hide2dCanvas(hidden: boolean): void {
    this.canvas.classList.toggle('canvas-hidden', hidden);
  }

  private hideGlCanvas(hidden: boolean): void {
    this.glCanvas.classList.toggle('canvas-hidden', hidden);
  }

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    // The context object is invalid now; drop it and forget which scenes were
    // inited so they re-create resources after restore.
    this.gl = null;
    this.initedGl.clear();
  };

  private readonly onContextRestored = (): void => {
    // Re-acquire and re-init the active GL scene if one is showing.
    if (!this.ensureGl()) return;
    const cur = this.current;
    if (cur && cur.kind === 'gl') this.activateGl(cur);
  };

  // ---- Sizing --------------------------------------------------------------

  private readonly resize = (): void => {
    const dpr2d = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;

    this.cssW = cssW;
    this.cssH = cssH;

    const bufW = Math.round(cssW * dpr2d);
    const bufH = Math.round(cssH * dpr2d);
    if (this.canvas.width !== bufW) this.canvas.width = bufW;
    if (this.canvas.height !== bufH) this.canvas.height = bufH;
    this.ctx.setTransform(dpr2d, 0, 0, dpr2d, 0, 0);

    this.syncGlBufferSize();
  };

  /** Resize the GL drawing buffer (DPR-capped) and notify the active scene. */
  private syncGlBufferSize(): void {
    const dprGl = Math.max(1, Math.min(window.devicePixelRatio || 1, GL_MAX_DPR));
    const pxW = Math.max(1, Math.round(this.cssW * dprGl));
    const pxH = Math.max(1, Math.round(this.cssH * dprGl));
    const changed = pxW !== this.glPxW || pxH !== this.glPxH;
    this.glPxW = pxW;
    this.glPxH = pxH;
    const gl = this.gl;
    if (!gl) return;
    if (this.glCanvas.width !== pxW) this.glCanvas.width = pxW;
    if (this.glCanvas.height !== pxH) this.glCanvas.height = pxH;
    if (changed) {
      const cur = this.current;
      if (cur && cur.kind === 'gl' && this.initedGl.has(cur)) {
        cur.resize?.(gl, pxW, pxH);
      }
    }
  }

  // ---- Frame loop ----------------------------------------------------------

  private readonly tick = (now: number): void => {
    this.rafId = requestAnimationFrame(this.tick);

    const t = (now - this.startTime) / 1000;
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > MAX_DT) dt = MAX_DT;
    if (dt < 0) dt = 0;

    const va = this.variation;

    // Advance / fix the base hue. Cycle speed scales with the variation.
    const fixed = this.getFixedHue();
    if (fixed != null) {
      this.hue = fixed;
    } else {
      this.hue = (this.hue + HUE_CYCLE_PER_SEC * va.speed * dt) % 360;
    }

    // Scenes see the variation's hueOffset folded into the base hue.
    const hue = (this.hue + va.hueOffset) % 360;

    const audio = this.engine.getFrame(this.getGain());
    const scene = this.current;
    if (!scene) return;

    if (scene.kind === '2d') {
      this.draw2d(scene, t, dt, audio, hue, va);
    } else {
      this.drawGl(scene, t, dt, audio, hue, va);
    }
  };

  private draw2d(
    scene: Scene2D,
    t: number,
    dt: number,
    audio: ReturnType<AudioEngine['getFrame']>,
    hue: number,
    va: Variation,
  ): void {
    this.applyTrail(scene.trail);
    const sceneCtx: SceneContext = {
      ctx: this.ctx,
      w: this.cssW,
      h: this.cssH,
      t,
      dt,
      audio,
      hue,
      va,
    };
    scene.draw(sceneCtx);
  }

  private drawGl(
    scene: GlScene,
    t: number,
    dt: number,
    audio: ReturnType<AudioEngine['getFrame']>,
    hue: number,
    va: Variation,
  ): void {
    const gl = this.gl;
    if (!gl) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.glPxW, this.glPxH);
    // Clear to transparent each frame so the scene's premultiplied-alpha output
    // composites over a clean buffer (no feedback accumulation, transparency
    // preserved for OBS). Scenes that want feedback own their own FBOs.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const sceneCtx: GlSceneContext = {
      gl,
      w: this.cssW,
      h: this.cssH,
      pxW: this.glPxW,
      pxH: this.glPxH,
      t,
      dt,
      audio,
      hue,
      va,
    };
    scene.draw(sceneCtx);
  }

  /**
   * Prepare the 2D canvas for this frame's drawing while preserving real
   * transparency (critical for OBS overlay use).
   *
   * trail === 0: hard clear. Otherwise fade existing pixels' alpha using
   * destination-out, which lowers alpha without ever painting opaque colour.
   */
  private applyTrail(trail: number): void {
    const ctx = this.ctx;
    if (trail <= 0) {
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      return;
    }
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${1 - trail})`;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.globalCompositeOperation = prev;
  }
}
