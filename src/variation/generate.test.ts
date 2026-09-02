import { describe, expect, it } from 'vitest';
import { nextAdoptedSeed, nextVisualSeed } from './generate';

describe('nextVisualSeed', () => {
  it('keeps the visual seed when settings.seed was adopted via seed:set', () => {
    expect(nextVisualSeed('live-look', 'restored-main', 'restored-main')).toBe('live-look');
  });

  it('follows settings.seed for gacha / panel edits', () => {
    expect(nextVisualSeed('live-look', 'fresh-gacha', null)).toBe('fresh-gacha');
    expect(nextVisualSeed('live-look', 'typed-in', 'restored-main')).toBe('typed-in');
  });
});

describe('nextAdoptedSeed', () => {
  it('keeps the adopted seed while settings still match', () => {
    expect(nextAdoptedSeed('restored-main', 'restored-main')).toBe('restored-main');
    expect(nextAdoptedSeed('live-look', null)).toBeNull();
  });

  it('clears adopted when settings diverge so a later panel commit of that seed can restore the look', () => {
    expect(nextAdoptedSeed('fresh-gacha', 'restored-main')).toBeNull();
    expect(nextVisualSeed('fresh-gacha', 'restored-main', null)).toBe('restored-main');
  });
});
