import type { Scene } from './types';
import { barsScene } from './bars';
import { waveformScene } from './waveform';
import { particlesScene } from './particles';
import { radialScene } from './radial';
import { ringsScene } from './rings';
import { lissajousScene } from './lissajous';
import { fluidScene } from './fluid';
import { smokeScene } from './smoke';
import { lavaScene } from './lava';
import { auroraScene } from './aurora';

/**
 * Ordered scene registry. The index here maps to keyboard keys 1–9, 0 (=10th).
 * The six Canvas-2D scenes come first, then the WebGL2 "rich" scenes
 * (fluid, smoke, lava, aurora).
 */
export const scenes: Scene[] = [
  barsScene,
  waveformScene,
  particlesScene,
  radialScene,
  ringsScene,
  lissajousScene,
  fluidScene,
  smokeScene,
  lavaScene,
  auroraScene,
];

export function sceneIndexById(id: string): number {
  const i = scenes.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

export function sceneByIndex(i: number): Scene {
  const len = scenes.length;
  const idx = ((i % len) + len) % len;
  return scenes[idx];
}
