import { describe, expect, it } from 'vitest';
import {
  BLEND_MODES,
  blendModeToGlobalCompositeOperation,
  resolveBlendApplication,
  resolveBlendMode,
} from './blend';

describe('resolveBlendMode', () => {
  it('treats null as normal with no warning', () => {
    expect(resolveBlendMode(null)).toEqual({ mode: 'normal', warning: null });
  });

  it('treats undefined as normal with no warning', () => {
    expect(resolveBlendMode(undefined)).toEqual({ mode: 'normal', warning: null });
  });

  it('treats an empty string as normal with no warning', () => {
    expect(resolveBlendMode('')).toEqual({ mode: 'normal', warning: null });
  });

  it('treats whitespace-only as normal with no warning', () => {
    expect(resolveBlendMode('   ')).toEqual({ mode: 'normal', warning: null });
  });

  it('accepts each valid mode (canonical lowercase)', () => {
    for (const mode of BLEND_MODES) {
      expect(resolveBlendMode(mode)).toEqual({ mode, warning: null });
    }
  });

  it('trims surrounding whitespace before matching', () => {
    expect(resolveBlendMode('  screen  ')).toEqual({ mode: 'screen', warning: null });
  });

  it('matches case-insensitively and stores canonical lowercase', () => {
    expect(resolveBlendMode('SCREEN')).toEqual({ mode: 'screen', warning: null });
    expect(resolveBlendMode('Color-Dodge')).toEqual({ mode: 'color-dodge', warning: null });
    expect(resolveBlendMode('HARD-LIGHT')).toEqual({ mode: 'hard-light', warning: null });
  });

  it('falls back to normal with a warning naming the bad value', () => {
    const result = resolveBlendMode('nope');
    expect(result.mode).toBe('normal');
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain('nope');
  });

  it('includes the raw (trimmed) unknown value in the warning', () => {
    const result = resolveBlendMode('  soft-light  ');
    expect(result.mode).toBe('normal');
    expect(result.warning).toContain('soft-light');
  });
});

describe('resolveBlendApplication', () => {
  it('returns none when there is no overlay', () => {
    expect(resolveBlendApplication('2d', null)).toBe('none');
    expect(resolveBlendApplication('gl', null)).toBe('none');
    expect(resolveBlendApplication(null, null)).toBe('none');
  });

  it('returns none when there is no base', () => {
    expect(resolveBlendApplication(null, '2d')).toBe('none');
    expect(resolveBlendApplication(null, 'gl')).toBe('none');
  });

  it('2d base + gl overlay uses CSS on the GL canvas', () => {
    expect(resolveBlendApplication('2d', 'gl')).toBe('css-gl');
  });

  it('gl base + 2d overlay uses CSS on the 2D canvas', () => {
    expect(resolveBlendApplication('gl', '2d')).toBe('css-2d');
  });

  it('2d + 2d uses canvas globalCompositeOperation', () => {
    expect(resolveBlendApplication('2d', '2d')).toBe('gco');
  });

  it('gl + gl is unsupported for non-normal CSS/GCO blend', () => {
    expect(resolveBlendApplication('gl', 'gl')).toBe('unsupported-gl');
  });
});

describe('blendModeToGlobalCompositeOperation', () => {
  it('maps normal to source-over', () => {
    expect(blendModeToGlobalCompositeOperation('normal')).toBe('source-over');
  });

  it('passes through other modes under the same CSS name', () => {
    expect(blendModeToGlobalCompositeOperation('screen')).toBe('screen');
    expect(blendModeToGlobalCompositeOperation('color-dodge')).toBe('color-dodge');
  });
});
