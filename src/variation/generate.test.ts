import { describe, expect, it } from 'vitest';
import { nextVisualSeed } from './generate';

describe('nextVisualSeed', () => {
  it('keeps the visual seed when settings.seed was adopted via seed:set', () => {
    expect(nextVisualSeed('live-look', 'restored-main', 'restored-main')).toBe('live-look');
  });

  it('follows settings.seed for gacha / panel edits', () => {
    expect(nextVisualSeed('live-look', 'fresh-gacha', null)).toBe('fresh-gacha');
    expect(nextVisualSeed('live-look', 'typed-in', 'restored-main')).toBe('typed-in');
  });
});
