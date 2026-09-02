/**
 * Scene Deck の操作をキー / ボタン / 将来の MIDI から同じ経路に乗せる。
 *
 * keyToAction は純関数。トグル系（hue / bg / lock / autoCycle）だけは
 * 現在の App 表示が要るので第 2 引数を見る。無い（旧 host）ときは null。
 */
import { randomSeed } from '../variation/generate';
import type { DeckCommand } from './protocol';

export type DeckAction =
  | { type: 'trigger'; slot: number; cut?: boolean }
  | { type: 'fireCursor' }
  | { type: 'cursor'; dir: 'left' | 'right' | 'up' | 'down' }
  | { type: 'cycleTransition' }
  | { type: 'auto.toggle' }
  | { type: 'auto.mode' }
  | { type: 'auto.interval'; dir: 1 | -1 }
  | { type: 'bank.rebuild' }
  | { type: 'bank.gacha' }
  | { type: 'command'; command: DeckCommand };

/** トグルと hue:fixed の基準。旧 host では渡さない。 */
export interface DeckKeyView {
  hueMode: 'cycle' | 'fixed';
  fixedHue: number;
  /** レンダラの base hue（offset 未適用）。fixed に入るとき固定値にする。 */
  hue: number;
  background: 'black' | 'transparent';
  autoCycle: boolean;
  locked: boolean;
}

export interface DeckActionContext {
  fireSlot(slot: number, cut?: boolean): void;
  fireCursor(): void;
  moveCursor(dir: 'left' | 'right' | 'up' | 'down'): void;
  cycleTransition(): void;
  toggleAuto(): void;
  cycleAutoMode(): void;
  bumpInterval(dir: 1 | -1): void;
  rebuildBank(): void;
  gachaBank(): void;
  postCommand(command: DeckCommand): void;
}

const CURSOR_BY_CODE = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
} as const;

export function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

export function keyToAction(e: KeyboardEvent, view?: DeckKeyView | null): DeckAction | null {
  if (e.code >= 'Digit1' && e.code <= 'Digit8') {
    const slot = Number(e.code.slice(5)) - 1;
    return e.shiftKey ? { type: 'trigger', slot, cut: true } : { type: 'trigger', slot };
  }

  if (
    e.code === 'ArrowLeft' ||
    e.code === 'ArrowRight' ||
    e.code === 'ArrowUp' ||
    e.code === 'ArrowDown'
  ) {
    // Shift+←→ はシーン送り。カーソルは動かさない。
    if (e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      return {
        type: 'command',
        command: { kind: 'scene:shift', delta: e.code === 'ArrowRight' ? 1 : -1 },
      };
    }
    return { type: 'cursor', dir: CURSOR_BY_CODE[e.code] };
  }

  switch (e.code) {
    case 'Enter':
    case 'Space':
      return { type: 'fireCursor' };
    case 'KeyT':
      if (e.repeat) return null;
      return { type: 'command', command: { kind: 'tempo:tap' } };
    case 'KeyX':
      return { type: 'cycleTransition' };
    case 'Comma':
      if (e.repeat) return null;
      return { type: 'command', command: { kind: 'tempo:multiply', factor: 0.5 } };
    case 'Period':
      if (e.repeat) return null;
      return { type: 'command', command: { kind: 'tempo:multiply', factor: 2 } };
    case 'Slash':
      if (e.repeat) return null;
      return { type: 'command', command: { kind: 'tempo:auto' } };
    case 'KeyQ':
      if (e.repeat) return null;
      return { type: 'command', command: { kind: 'seed:set', seed: randomSeed() } };
    case 'KeyW':
      if (e.repeat) return null;
      return { type: 'command', command: { kind: 'patch:rerollDetails', seed: randomSeed() } };
    case 'KeyB': {
      if (e.repeat || !view) return null;
      return {
        type: 'command',
        command: {
          kind: 'background:set',
          background: view.background === 'black' ? 'transparent' : 'black',
        },
      };
    }
    case 'KeyH': {
      if (e.repeat || !view) return null;
      if (view.hueMode === 'fixed') {
        return { type: 'command', command: { kind: 'hue:mode', mode: 'cycle' } };
      }
      return { type: 'command', command: { kind: 'hue:fixed', hue: wrapHue(view.hue) } };
    }
    case 'BracketLeft':
    case 'BracketRight': {
      if (!view) return null;
      const delta = e.code === 'BracketLeft' ? -15 : 15;
      const base = view.hueMode === 'fixed' ? view.fixedHue : view.hue;
      return { type: 'command', command: { kind: 'hue:fixed', hue: wrapHue(base + delta) } };
    }
    case 'KeyL': {
      if (e.repeat || !view) return null;
      return {
        type: 'command',
        command: { kind: 'timeline:lock', seconds: view.locked ? 0 : 30 },
      };
    }
    case 'KeyA':
      if (e.shiftKey) {
        if (e.repeat || !view) return null;
        return { type: 'command', command: { kind: 'autoCycle:set', on: !view.autoCycle } };
      }
      return { type: 'auto.toggle' };
    case 'KeyM':
      return { type: 'auto.mode' };
    case 'Minus':
    case 'NumpadSubtract':
      return { type: 'auto.interval', dir: -1 };
    case 'Equal':
    case 'NumpadAdd':
      return { type: 'auto.interval', dir: 1 };
    case 'KeyR':
      return { type: 'bank.rebuild' };
    case 'KeyG':
      return { type: 'bank.gacha' };
    default:
      return null;
  }
}

export function dispatchDeckAction(action: DeckAction, ctx: DeckActionContext): void {
  switch (action.type) {
    case 'trigger':
      ctx.fireSlot(action.slot, action.cut);
      break;
    case 'fireCursor':
      ctx.fireCursor();
      break;
    case 'cursor':
      ctx.moveCursor(action.dir);
      break;
    case 'cycleTransition':
      ctx.cycleTransition();
      break;
    case 'auto.toggle':
      ctx.toggleAuto();
      break;
    case 'auto.mode':
      ctx.cycleAutoMode();
      break;
    case 'auto.interval':
      ctx.bumpInterval(action.dir);
      break;
    case 'bank.rebuild':
      ctx.rebuildBank();
      break;
    case 'bank.gacha':
      ctx.gachaBank();
      break;
    case 'command':
      ctx.postCommand(action.command);
      break;
  }
}
