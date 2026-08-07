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
import { semanticSynthScene } from './semanticSynth';

/**
 * Ordered scene registry. The index here maps to keyboard keys 1–9, 0 (=10th).
 *
 * semantic-synth が先頭 = 既定であり、キー `1`。以降は Canvas-2D の 6 シーン、
 * WebGL2 のリッチシーン（fluid / smoke / lava / aurora）と続く。
 * 数字キーは 10 個しかないので、末尾の 1 つ（aurora）はキー割り当てが無い。
 * `[` / `]`・シーンピッカー・`?scene=aurora` からは従来どおり選べる。
 */
export const scenes: Scene[] = [
  semanticSynthScene,
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

/** 何も指定が無いときに開くシーン。 */
export const DEFAULT_SCENE_ID = semanticSynthScene.id;

/**
 * WebGL2 が無い環境で {@link DEFAULT_SCENE_ID} を開けなかったときの逃げ先。
 *
 * 既定が GL シーンになった以上、これが無いと非対応環境で「何も描かれない
 * 真っ黒な画面」になる（Renderer は開けない GL シーンの activate を拒否する）。
 */
export const FALLBACK_SCENE_ID = barsScene.id;

export function sceneIndexById(id: string): number {
  const i = scenes.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

export function sceneByIndex(i: number): Scene {
  const len = scenes.length;
  const idx = ((i % len) + len) % len;
  return scenes[idx];
}
