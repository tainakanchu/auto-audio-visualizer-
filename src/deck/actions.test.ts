import { describe, expect, it, vi } from 'vitest';
import {
  dispatchDeckAction,
  keyToAction,
  type DeckAction,
  type DeckActionContext,
  type DeckKeyView,
} from './actions';

function evt(code: string, init: { shiftKey?: boolean; repeat?: boolean } = {}): KeyboardEvent {
  return {
    code,
    shiftKey: init.shiftKey ?? false,
    repeat: init.repeat ?? false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  } as KeyboardEvent;
}

const view: DeckKeyView = {
  hueMode: 'cycle',
  fixedHue: 200,
  hue: 213,
  background: 'black',
  autoCycle: false,
  locked: false,
};

describe('keyToAction', () => {
  it('maps the pad / auto / bank keys', () => {
    expect(keyToAction(evt('Digit1'))).toEqual({ type: 'trigger', slot: 0 });
    expect(keyToAction(evt('Digit8'))).toEqual({ type: 'trigger', slot: 7 });
    expect(keyToAction(evt('Digit3', { shiftKey: true }))).toEqual({
      type: 'trigger',
      slot: 2,
      cut: true,
    });
    expect(keyToAction(evt('ArrowLeft'))).toEqual({ type: 'cursor', dir: 'left' });
    expect(keyToAction(evt('ArrowRight'))).toEqual({ type: 'cursor', dir: 'right' });
    expect(keyToAction(evt('ArrowUp'))).toEqual({ type: 'cursor', dir: 'up' });
    expect(keyToAction(evt('ArrowDown'))).toEqual({ type: 'cursor', dir: 'down' });
    expect(keyToAction(evt('Enter'))).toEqual({ type: 'fireCursor' });
    expect(keyToAction(evt('Space'))).toEqual({ type: 'fireCursor' });
    expect(keyToAction(evt('KeyA'))).toEqual({ type: 'auto.toggle' });
    expect(keyToAction(evt('KeyM'))).toEqual({ type: 'auto.mode' });
    expect(keyToAction(evt('Minus'))).toEqual({ type: 'auto.interval', dir: -1 });
    expect(keyToAction(evt('Equal'))).toEqual({ type: 'auto.interval', dir: 1 });
    expect(keyToAction(evt('KeyR'))).toEqual({ type: 'bank.rebuild' });
    expect(keyToAction(evt('KeyG'))).toEqual({ type: 'bank.gacha' });
  });

  it('moves T to tempo:tap and X to cycleTransition', () => {
    expect(keyToAction(evt('KeyT'))).toEqual({
      type: 'command',
      command: { kind: 'tempo:tap' },
    });
    expect(keyToAction(evt('KeyX'))).toEqual({ type: 'cycleTransition' });
    expect(keyToAction(evt('KeyT', { repeat: true }))).toBeNull();
  });

  it('maps the console command keys', () => {
    expect(keyToAction(evt('Comma'))).toEqual({
      type: 'command',
      command: { kind: 'tempo:multiply', factor: 0.5 },
    });
    expect(keyToAction(evt('Period'))).toEqual({
      type: 'command',
      command: { kind: 'tempo:multiply', factor: 2 },
    });
    expect(keyToAction(evt('Slash'))).toEqual({
      type: 'command',
      command: { kind: 'tempo:auto' },
    });
    expect(keyToAction(evt('KeyQ'))).toEqual({
      type: 'command',
      command: { kind: 'seed:gacha' },
    });
    expect(keyToAction(evt('KeyW'))).toEqual({
      type: 'command',
      command: { kind: 'patch:rerollDetails' },
    });
    expect(keyToAction(evt('KeyB'), view)).toEqual({
      type: 'command',
      command: { kind: 'background:set', background: 'transparent' },
    });
    expect(keyToAction(evt('KeyB'), { ...view, background: 'transparent' })).toEqual({
      type: 'command',
      command: { kind: 'background:set', background: 'black' },
    });
    expect(keyToAction(evt('KeyH'), view)).toEqual({
      type: 'command',
      command: { kind: 'hue:fixed', hue: 213 },
    });
    expect(keyToAction(evt('KeyH'), { ...view, hueMode: 'fixed' })).toEqual({
      type: 'command',
      command: { kind: 'hue:mode', mode: 'cycle' },
    });
    expect(keyToAction(evt('BracketLeft'), view)).toEqual({
      type: 'command',
      command: { kind: 'hue:fixed', hue: 198 },
    });
    expect(keyToAction(evt('BracketRight'), { ...view, hueMode: 'fixed', fixedHue: 350 })).toEqual({
      type: 'command',
      command: { kind: 'hue:fixed', hue: 5 },
    });
    expect(keyToAction(evt('KeyL'), view)).toEqual({
      type: 'command',
      command: { kind: 'timeline:lock', seconds: 30 },
    });
    expect(keyToAction(evt('KeyL'), { ...view, locked: true })).toEqual({
      type: 'command',
      command: { kind: 'timeline:lock', seconds: 0 },
    });
    expect(keyToAction(evt('KeyA', { shiftKey: true }), view)).toEqual({
      type: 'command',
      command: { kind: 'autoCycle:set', on: true },
    });
    expect(keyToAction(evt('KeyA', { shiftKey: true }), { ...view, autoCycle: true })).toEqual({
      type: 'command',
      command: { kind: 'autoCycle:set', on: false },
    });
  });

  it('maps Shift+Arrow to scene:shift and does not also move the cursor', () => {
    expect(keyToAction(evt('ArrowLeft', { shiftKey: true }))).toEqual({
      type: 'command',
      command: { kind: 'scene:shift', delta: -1 },
    });
    expect(keyToAction(evt('ArrowRight', { shiftKey: true }))).toEqual({
      type: 'command',
      command: { kind: 'scene:shift', delta: 1 },
    });
    expect(keyToAction(evt('ArrowUp', { shiftKey: true }))).toEqual({
      type: 'cursor',
      dir: 'up',
    });
    expect(keyToAction(evt('ArrowDown', { shiftKey: true }))).toEqual({
      type: 'cursor',
      dir: 'down',
    });
  });

  it('returns null for toggle/hue keys when the view is missing (legacy host)', () => {
    expect(keyToAction(evt('KeyB'))).toBeNull();
    expect(keyToAction(evt('KeyH'))).toBeNull();
    expect(keyToAction(evt('BracketLeft'))).toBeNull();
    expect(keyToAction(evt('KeyL'))).toBeNull();
    expect(keyToAction(evt('KeyA', { shiftKey: true }))).toBeNull();
  });

  it('ignores keys that are not bound', () => {
    expect(keyToAction(evt('KeyZ'))).toBeNull();
    expect(keyToAction(evt('Digit9'))).toBeNull();
    expect(keyToAction(evt('KeyF'))).toBeNull();
  });
});

describe('dispatchDeckAction', () => {
  function stubCtx(overrides: Partial<DeckActionContext> = {}): DeckActionContext {
    return {
      fireSlot: vi.fn(),
      fireCursor: vi.fn(),
      moveCursor: vi.fn(),
      cycleTransition: vi.fn(),
      toggleAuto: vi.fn(),
      cycleAutoMode: vi.fn(),
      bumpInterval: vi.fn(),
      rebuildBank: vi.fn(),
      gachaBank: vi.fn(),
      postCommand: vi.fn(),
      ...overrides,
    };
  }

  it('routes each action type to the matching context method', () => {
    const table: Array<[DeckAction, keyof DeckActionContext, unknown[]]> = [
      [{ type: 'trigger', slot: 3, cut: true }, 'fireSlot', [3, true]],
      [{ type: 'fireCursor' }, 'fireCursor', []],
      [{ type: 'cursor', dir: 'left' }, 'moveCursor', ['left']],
      [{ type: 'cycleTransition' }, 'cycleTransition', []],
      [{ type: 'auto.toggle' }, 'toggleAuto', []],
      [{ type: 'auto.mode' }, 'cycleAutoMode', []],
      [{ type: 'auto.interval', dir: 1 }, 'bumpInterval', [1]],
      [{ type: 'bank.rebuild' }, 'rebuildBank', []],
      [{ type: 'bank.gacha' }, 'gachaBank', []],
      [{ type: 'command', command: { kind: 'tempo:tap' } }, 'postCommand', [{ kind: 'tempo:tap' }]],
    ];
    for (const [action, method, args] of table) {
      const ctx = stubCtx();
      dispatchDeckAction(action, ctx);
      expect(ctx[method]).toHaveBeenCalledWith(...args);
    }
  });
});
