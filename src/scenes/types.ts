import type { AudioFrame } from '../audio/types';
import type { Variation } from '../variation/types';

/** Per-frame drawing context handed to a 2D scene's {@link Scene2D.draw}. */
export interface SceneContext {
  ctx: CanvasRenderingContext2D;
  /** Logical width in CSS pixels (ctx is already scaled for DPR). */
  w: number;
  /** Logical height in CSS pixels. */
  h: number;
  /** Seconds since the renderer started. */
  t: number;
  /** Seconds since the previous frame, clamped to <= 0.1. */
  dt: number;
  /** Current analysed audio. */
  audio: AudioFrame;
  /** Current base hue, 0..360 (already includes the variation's hueOffset). */
  hue: number;
  /** Seeded "look gacha" variation driving colour, motion, layout, etc. */
  va: Variation;
}

/** A self-contained Canvas-2D audio-reactive visual. */
export interface Scene2D {
  /** Discriminates the rendering path. */
  kind: '2d';
  /** Stable identifier used in settings / URLs. */
  id: string;
  /** Human-readable label for the UI. */
  name: string;
  /**
   * Motion-trail amount. 0 clears fully each frame; 0..1 fades previous
   * content by that fraction for a persistence-of-vision trail.
   */
  trail: number;
  /** Reset internal state when the scene becomes active. */
  init?(): void;
  /** Draw one frame. */
  draw(s: SceneContext): void;
}

/**
 * Per-frame context handed to a GL scene's {@link GlScene.draw}. All sizes are
 * already resolved; the viewport is set by the renderer before draw is called.
 */
export interface GlSceneContext {
  gl: WebGL2RenderingContext;
  /** Logical width in CSS pixels. */
  w: number;
  /** Logical height in CSS pixels. */
  h: number;
  /** Physical drawing-buffer width in device pixels. */
  pxW: number;
  /** Physical drawing-buffer height in device pixels. */
  pxH: number;
  /** Seconds since the renderer started. */
  t: number;
  /** Seconds since the previous frame, clamped to <= 0.1. */
  dt: number;
  /** Current analysed audio. */
  audio: AudioFrame;
  /** Current base hue, 0..360 (already includes the variation's hueOffset). */
  hue: number;
  /** Seeded "look gacha" variation driving colour, motion, layout, etc. */
  va: Variation;
}

/**
 * A self-contained WebGL2 audio-reactive visual. GPU resources are created in
 * {@link GlScene.init} (first activation / context restore) and freed in
 * {@link GlScene.dispose}. Variation is read per-frame from the context, so a
 * seed change needs no resource churn — derive per-element values via va.rand.
 */
export interface GlScene {
  /** Discriminates the rendering path. */
  kind: 'gl';
  /** Stable identifier used in settings / URLs. */
  id: string;
  /** Human-readable label for the UI. */
  name: string;
  /** (Re)create GPU resources. Called on first activation and context restore. */
  init(gl: WebGL2RenderingContext): void;
  /** Draw one frame. */
  draw(s: GlSceneContext): void;
  /** Resize FBO-owning resources. Called on drawing-buffer size change. */
  resize?(gl: WebGL2RenderingContext, pxW: number, pxH: number): void;
  /** Free all GPU resources. */
  dispose(gl: WebGL2RenderingContext): void;
}

/** Any registered scene. */
export type Scene = Scene2D | GlScene;
