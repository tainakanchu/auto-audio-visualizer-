import { describe, expect, it } from 'vitest';
import { resolveOverlaySceneId } from './overlay';

const KNOWN = ['semantic-synth', 'bars', 'rings', 'aurora'] as const;
const BASE = 'semantic-synth';

describe('resolveOverlaySceneId', () => {
  it('treats a null raw value as no request', () => {
    expect(resolveOverlaySceneId(null, BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('treats an undefined raw value as no request', () => {
    expect(resolveOverlaySceneId(undefined, BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('treats an empty string as no request', () => {
    expect(resolveOverlaySceneId('', BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('treats a whitespace-only string as no request', () => {
    expect(resolveOverlaySceneId('   ', BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('disables via "none" without a warning', () => {
    expect(resolveOverlaySceneId('none', BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('disables via "off" without a warning', () => {
    expect(resolveOverlaySceneId('off', BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('disables via "0" without a warning', () => {
    expect(resolveOverlaySceneId('0', BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('disables via "NONE" (case-insensitive)', () => {
    expect(resolveOverlaySceneId('NONE', BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('disables via "Off" (case-insensitive)', () => {
    expect(resolveOverlaySceneId('Off', BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('disables via a whitespace-padded disable value', () => {
    expect(resolveOverlaySceneId('  none  ', BASE, KNOWN)).toEqual({ id: null, warning: null });
  });

  it('rejects an unknown scene id with null id and a warning naming it', () => {
    const result = resolveOverlaySceneId('bogus-scene', BASE, KNOWN);
    expect(result.id).toBe(null);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain('bogus-scene');
  });

  it('rejects an overlay equal to the base scene with null id and a warning', () => {
    const result = resolveOverlaySceneId(BASE, BASE, KNOWN);
    expect(result.id).toBe(null);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain(BASE);
  });

  it('accepts a valid, distinct overlay scene id', () => {
    expect(resolveOverlaySceneId('rings', BASE, KNOWN)).toEqual({ id: 'rings', warning: null });
  });

  it('trims surrounding whitespace before matching a valid id', () => {
    expect(resolveOverlaySceneId(' rings ', BASE, KNOWN)).toEqual({
      id: 'rings',
      warning: null,
    });
  });

  it('trims surrounding whitespace before comparing against the base scene', () => {
    const result = resolveOverlaySceneId(` ${BASE} `, BASE, KNOWN);
    expect(result.id).toBe(null);
    expect(result.warning).toBeTruthy();
  });
});
