import { describe, expect, it } from 'vitest';
import { nextSlot, shouldAdvanceBars, type AutoOrder } from './autoAdvance';

describe('nextSlot', () => {
  it('sequential は 0..size-1 をラップする', () => {
    expect(nextSlot(0, 'sequential', 8, 0)).toBe(1);
    expect(nextSlot(6, 'sequential', 8, 0)).toBe(7);
    expect(nextSlot(7, 'sequential', 8, 0)).toBe(0);
  });

  it('size<=1 は常に 0', () => {
    expect(nextSlot(0, 'sequential', 1, 0.5)).toBe(0);
    expect(nextSlot(3, 'random', 1, 0.9)).toBe(0);
    expect(nextSlot(0, 'sequential', 0, 0.2)).toBe(0);
  });

  it('random は size>1 のとき現在スロットを返さない', () => {
    const size = 8;
    for (let current = 0; current < size; current++) {
      for (let i = 0; i <= 20; i++) {
        const slot = nextSlot(current, 'random', size, i / 20);
        expect(slot).not.toBe(current);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThan(size);
      }
    }
  });

  it('random は rand01 を現在以外のスロットへ写す', () => {
    // size=4, current=1 → 残り 0,2,3。三分した rand01 を順に割り当て。
    expect(nextSlot(1, 'random', 4, 0)).toBe(0);
    expect(nextSlot(1, 'random', 4, 0.34)).toBe(2);
    expect(nextSlot(1, 'random', 4, 0.67)).toBe(3);
    expect(nextSlot(1, 'random', 4, 0.999)).toBe(3);

    // current=0 なら残り 1,2,3。0 は出ない。
    expect(nextSlot(0, 'random', 4, 0)).toBe(1);
    expect(nextSlot(0, 'random', 4, 0.34)).toBe(2);
    expect(nextSlot(0, 'random', 4, 0.67)).toBe(3);
  });

  it('rand01 が範囲外でもスロットは有効', () => {
    const order: AutoOrder = 'random';
    expect(nextSlot(2, order, 5, -1)).not.toBe(2);
    expect(nextSlot(2, order, 5, 1)).not.toBe(2);
    expect(nextSlot(2, order, 5, Number.NaN)).not.toBe(2);
  });
});

describe('shouldAdvanceBars', () => {
  it('floor(barCount) - lastFiredBar >= n のとき true', () => {
    expect(shouldAdvanceBars(8, 0, 8)).toBe(true);
    expect(shouldAdvanceBars(7.9, 0, 8)).toBe(false);
    expect(shouldAdvanceBars(8.9, 8, 8)).toBe(false);
    expect(shouldAdvanceBars(16, 8, 8)).toBe(true);
    expect(shouldAdvanceBars(15.2, 8, 8)).toBe(false);
    expect(shouldAdvanceBars(0, 0, 8)).toBe(false);
  });
});
