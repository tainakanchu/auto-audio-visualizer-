/**
 * Scene Deck の自動送り。次スロット選択と小節跨ぎは純関数、タイマーと
 * tempoLocked 待ちはフック。発火そのものは DeckApp が trigger 経路に乗せる。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type AutoMode = 'off' | 'seconds' | 'bars';
export type AutoOrder = 'sequential' | 'random';
export type AutoKind = Exclude<AutoMode, 'off'>;

export const AUTO_SECONDS_DEFAULT = 30;
export const AUTO_SECONDS_MIN = 2;
export const AUTO_SECONDS_MAX = 600;
export const AUTO_SECONDS_STEP = 5;
export const AUTO_BARS_DEFAULT = 8;
export const AUTO_BARS_MIN = 1;
export const AUTO_BARS_MAX = 256;

export function clampAutoSeconds(value: number): number {
  if (!Number.isFinite(value)) return AUTO_SECONDS_DEFAULT;
  return Math.min(AUTO_SECONDS_MAX, Math.max(AUTO_SECONDS_MIN, value));
}

export function clampAutoBars(value: number): number {
  if (!Number.isFinite(value)) return AUTO_BARS_DEFAULT;
  return Math.min(AUTO_BARS_MAX, Math.max(AUTO_BARS_MIN, Math.round(value)));
}

/**
 * 次に出すスロット。sequential は 0..size-1 でラップ。random は size>1 のとき
 * 現在スロットを除外し、rand01 を残りのスロットへ写す。
 */
export function nextSlot(current: number, order: AutoOrder, size: number, rand01: number): number {
  if (!Number.isFinite(size) || size <= 1) return 0;
  const n = size | 0;
  const cur = ((Math.trunc(current) % n) + n) % n;
  if (order === 'sequential') return (cur + 1) % n;

  const others = n - 1;
  const unit = Number.isFinite(rand01) ? rand01 : 0;
  const t = unit <= 0 ? 0 : unit >= 1 ? 0.999999999999 : unit;
  let idx = Math.floor(t * others);
  if (idx >= others) idx = others - 1;
  if (idx < 0) idx = 0;
  return idx >= cur ? idx + 1 : idx;
}

/** App.tsx の bars オートサイクルと同じ「N 小節進んだら」判定。 */
export function shouldAdvanceBars(barCount: number, lastFiredBar: number, n: number): boolean {
  return Math.floor(barCount) - lastFiredBar >= n;
}

export interface AutoAdvanceOptions {
  mode: AutoMode;
  order: AutoOrder;
  seconds: number;
  bars: number;
  connected: boolean;
  tempoLocked: boolean;
  barCount: number;
  currentSlot: number;
  size: number;
  onAdvance: (slot: number) => void;
}

export interface AutoAdvanceHandle {
  /** 手動ポン出し後に秒タイマーをリセットし、小節カウントの原点を今にする。 */
  noteManualTrigger: () => void;
  waitingForTempo: boolean;
}

export function useAutoAdvance(opts: AutoAdvanceOptions): AutoAdvanceHandle {
  const {
    mode,
    order,
    seconds,
    bars,
    connected,
    tempoLocked,
    barCount,
    currentSlot,
    size,
    onAdvance,
  } = opts;

  const currentSlotRef = useRef(currentSlot);
  const orderRef = useRef(order);
  const sizeRef = useRef(size);
  const onAdvanceRef = useRef(onAdvance);
  const barCountRef = useRef(barCount);
  const lastFiredBarRef = useRef(Math.floor(barCount));
  const [epoch, setEpoch] = useState(0);

  currentSlotRef.current = currentSlot;
  orderRef.current = order;
  sizeRef.current = size;
  onAdvanceRef.current = onAdvance;
  barCountRef.current = barCount;

  const fireNext = useCallback((): void => {
    if (!connected) return;
    const n = sizeRef.current;
    if (n <= 0) return;
    const next = nextSlot(currentSlotRef.current, orderRef.current, n, Math.random());
    onAdvanceRef.current(next);
  }, [connected]);

  const noteManualTrigger = useCallback((): void => {
    lastFiredBarRef.current = Math.floor(barCountRef.current);
    setEpoch((n) => n + 1);
  }, []);

  // 秒モードは interval を張り直すことで手動トリガー／間隔変更をリセットする。
  useEffect(() => {
    if (mode !== 'seconds' || !connected || size <= 0) return;
    const ms = clampAutoSeconds(seconds) * 1000;
    const id = window.setInterval(fireNext, ms);
    return () => window.clearInterval(id);
  }, [mode, connected, seconds, size, fireNext, epoch]);

  // 小節カウントの原点を「今」に揃える。mode/bars だけでなく、未接続や
  // size=0 のままアームしたあとに host/bank が揃ったときもリセットしないと
  // shouldAdvanceBars(liveBarCount, 0, n) が即 true になり初回で発火する。
  useEffect(() => {
    lastFiredBarRef.current = Math.floor(barCountRef.current);
  }, [mode, bars, connected, size]);

  useEffect(() => {
    if (mode !== 'bars' || !connected || size <= 0) return;
    if (!tempoLocked) {
      // テンポが外れている間に溜まった差分で復帰直後に連打しない。
      lastFiredBarRef.current = Math.floor(barCount);
      return;
    }
    const n = clampAutoBars(bars);
    if (!shouldAdvanceBars(barCount, lastFiredBarRef.current, n)) return;
    lastFiredBarRef.current = Math.floor(barCount);
    fireNext();
  }, [mode, connected, tempoLocked, barCount, bars, size, fireNext]);

  return {
    noteManualTrigger,
    waitingForTempo: mode === 'bars' && connected && !tempoLocked,
  };
}
