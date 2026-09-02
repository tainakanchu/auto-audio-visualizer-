import { describe, expect, it } from 'vitest';
import { circularHueDelta } from './hue';

describe('circularHueDelta', () => {
  it('wraps across 360 (359→1 = 2)', () => {
    expect(circularHueDelta(359, 1)).toBe(2);
  });

  it('is 180 at the opposite hue (0→180)', () => {
    expect(circularHueDelta(0, 180)).toBe(180);
  });

  it('picks the short arc past 180 (0→181 = 179)', () => {
    expect(circularHueDelta(0, 181)).toBe(179);
  });
});
