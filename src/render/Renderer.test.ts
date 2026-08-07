import { describe, expect, it } from 'vitest';
import { resolveEffectiveOverlay, resolveLayerVisibility } from './Renderer';

describe('resolveLayerVisibility', () => {
  // The single-scene behaviour this replaced: exactly one canvas shown, the GL
  // canvas never lifted. Any change here is a user-visible regression for every
  // session that never touches the overlay.
  describe('no overlay reproduces single-scene behaviour', () => {
    it('a 2D base shows only the 2D canvas', () => {
      expect(resolveLayerVisibility('2d', null)).toEqual({
        show2d: true,
        showGl: false,
        liftGl: false,
      });
    });

    it('a GL base shows only the GL canvas', () => {
      expect(resolveLayerVisibility('gl', null)).toEqual({
        show2d: false,
        showGl: true,
        liftGl: false,
      });
    });

    it('never lifts the GL canvas without an overlay', () => {
      for (const base of ['2d', 'gl', null] as const) {
        expect(resolveLayerVisibility(base, null).liftGl).toBe(false);
      }
    });
  });

  describe('with an overlay', () => {
    it('2D base + GL overlay shows both and lifts GL above the 2D base', () => {
      expect(resolveLayerVisibility('2d', 'gl')).toEqual({
        show2d: true,
        showGl: true,
        liftGl: true,
      });
    });

    it('GL base + 2D overlay shows both and leaves GL underneath', () => {
      expect(resolveLayerVisibility('gl', '2d')).toEqual({
        show2d: true,
        showGl: true,
        liftGl: false,
      });
    });

    it('2D base + 2D overlay share the 2D canvas only', () => {
      expect(resolveLayerVisibility('2d', '2d')).toEqual({
        show2d: true,
        showGl: false,
        liftGl: false,
      });
    });

    it('GL base + GL overlay share the GL canvas only', () => {
      expect(resolveLayerVisibility('gl', 'gl')).toEqual({
        show2d: false,
        showGl: true,
        liftGl: false,
      });
    });
  });

  describe('degenerate pairings', () => {
    it('no base and no overlay hides both canvases', () => {
      expect(resolveLayerVisibility(null, null)).toEqual({
        show2d: false,
        showGl: false,
        liftGl: false,
      });
    });

    it('an overlay without a base still shows its own canvas', () => {
      expect(resolveLayerVisibility(null, '2d')).toEqual({
        show2d: true,
        showGl: false,
        liftGl: false,
      });
      expect(resolveLayerVisibility(null, 'gl')).toEqual({
        show2d: false,
        showGl: true,
        liftGl: false,
      });
    });
  });

  it('shows a canvas exactly when some layer renders on it', () => {
    for (const base of ['2d', 'gl', null] as const) {
      for (const overlay of ['2d', 'gl', null] as const) {
        const v = resolveLayerVisibility(base, overlay);
        expect(v.show2d).toBe(base === '2d' || overlay === '2d');
        expect(v.showGl).toBe(base === 'gl' || overlay === 'gl');
        // Lifting only ever matters when GL sits over a 2D base; in every other
        // pairing the default stacking is already correct.
        expect(v.liftGl).toBe(base === '2d' && overlay === 'gl');
        // Lifting a canvas that isn't shown would be nonsense.
        if (v.liftGl) expect(v.showGl).toBe(true);
      }
    }
  });
});

describe('resolveEffectiveOverlay', () => {
  const bars = { id: 'bars' };
  const rings = { id: 'rings' };

  it('passes a distinct overlay through unchanged', () => {
    expect(resolveEffectiveOverlay(bars, rings)).toBe(rings);
  });

  it('suppresses an overlay that duplicates the base', () => {
    expect(resolveEffectiveOverlay(bars, bars)).toBeNull();
  });

  it('suppresses by id, not identity, so a re-registered scene still matches', () => {
    expect(resolveEffectiveOverlay(bars, { id: 'bars' })).toBeNull();
  });

  it('returns null when there is no overlay', () => {
    expect(resolveEffectiveOverlay(bars, null)).toBeNull();
    expect(resolveEffectiveOverlay(null, null)).toBeNull();
  });

  it('keeps an overlay that has no base to collide with', () => {
    expect(resolveEffectiveOverlay(null, rings)).toBe(rings);
  });

  it('is reversible: switching the base away restores the overlay', () => {
    expect(resolveEffectiveOverlay(rings, rings)).toBeNull();
    expect(resolveEffectiveOverlay(bars, rings)).toBe(rings);
  });
});
