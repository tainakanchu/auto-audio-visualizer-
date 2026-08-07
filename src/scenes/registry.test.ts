import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENE_ID, FALLBACK_SCENE_ID, sceneByIndex, sceneIndexById, scenes } from './index';

describe('scenes registry', () => {
  it('scene ids are unique', () => {
    const ids = scenes.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the default scene is the first entry (= keyboard key 1)', () => {
    expect(DEFAULT_SCENE_ID).toBe(scenes[0]!.id);
    expect(sceneIndexById(DEFAULT_SCENE_ID)).toBe(0);
  });

  /**
   * 既定が GL シーンなので、WebGL2 非対応環境で必ず開ける 2D の逃げ先が要る。
   * ここが GL になると、そういう環境で何も描画されなくなる。
   */
  it('the fallback scene exists and is a 2D scene', () => {
    const fallback = scenes.find((s) => s.id === FALLBACK_SCENE_ID);
    expect(fallback, `no scene with id "${FALLBACK_SCENE_ID}"`).toBeDefined();
    expect(fallback!.kind).toBe('2d');
  });

  it('at least one 2D scene exists for the no-WebGL2 path', () => {
    expect(scenes.some((s) => s.kind === '2d')).toBe(true);
  });

  it('sceneByIndex wraps in both directions', () => {
    expect(sceneByIndex(0)).toBe(scenes[0]);
    expect(sceneByIndex(scenes.length)).toBe(scenes[0]);
    expect(sceneByIndex(-1)).toBe(scenes[scenes.length - 1]);
  });

  it('sceneIndexById falls back to the first scene for an unknown id', () => {
    expect(sceneIndexById('no-such-scene')).toBe(0);
  });
});
