import type { BlendMode } from '../ui/blend';
import { resolveBlendMode } from '../ui/blend';
import type { PerformanceTimeline, TimelineOp } from './timeline';
import type { VisualPatch } from './types';

/**
 * External Control Interface — the first implementation of the RFC's control
 * surface.
 *
 * A scene is a module singleton driven by the renderer; the UI is React. Wiring
 * them to each other directly would tie every panel to one scene's internals
 * and make the scene impossible to drive from anywhere else. This module is the
 * seam between them: the active scene registers a backend, callers talk to a
 * stable facade, and neither side holds a reference to the other.
 *
 * The UI is only the first caller. An AI Director, a PRO DJ LINK bridge and a
 * MIDI adapter all connect here later and drive the same ops — the surface is
 * deliberately transport-agnostic.
 *
 * The registry owns no synth state of its own: it is a backend slot plus a
 * listener set, plus a few facade-owned fields (e.g. blendMode) that are not
 * scene-specific. With no scene registered every backend call is a safe no-op,
 * so callers never have to check whether a synth scene happens to be on screen.
 */

export interface SynthControlState {
  currentPatch: VisualPatch | null;
  /** 読み取り専用として扱うこと（呼び出し側は変更しない）。 */
  timeline: PerformanceTimeline;
  transitionActive: boolean;
  qualityScale: number;
  recordingActive: boolean;
  /** getState() を呼んだ瞬間のシーン時計（秒）。UI が相対 anchor を絶対値に直すのに使う。 */
  nowSec: number;
  /** 直近フレームの barCount。bar anchor の計算用。 */
  barCount: number;
  /** テンポグリッドがロックされているか（false だと bar anchor は発火しない）。 */
  tempoLocked: boolean;
  /** 発火済みイベント id（UI 表示用）。 */
  firedIds: readonly string[];
  /**
   * 今の Patch に載っているオーディオ・リアクションの id（座標段 → 色段）。
   *
   * Patch には持たず topology から決まるので、`currentPatch` を見ても分からない。
   * 「今どのグリッチが鳴っているか」は演出を組み立てる側が知りたい情報なので
   * state で出す。シーンが居ないときは空。
   */
  reactions: readonly string[];
  /**
   * オーバーレイ合成のブレンドモード（常に存在する。既定 `'normal'`）。
   *
   * シーン backend ではなく facade が所有する。CLI / Bridge から切り替え可能で、
   * オーバーレイが無いときは描画側が無視する。
   */
  blendMode: BlendMode;
  /**
   * レンダラの現在 hue（0..360、variation.hueOffset 込み）。
   * シーン非アクティブ時は 0。
   */
  hue: number;
}

/** setBlendMode の結果。不正値でも ok:true（normal へフォールバック + warning）。 */
export interface SetBlendModeResult {
  ok: true;
  mode: BlendMode;
  warning?: string;
}

/** setImage の結果。ok のとき hash は Patch の images 参照にそのまま使える。 */
export interface SetImageResult {
  ok: boolean;
  issues: string[];
  /** SHA-256 hex（成功時のみ）。 */
  hash?: string;
  /** 実際に登録された名前（成功時のみ）。 */
  name?: string;
}

export interface SynthControl {
  getState(): SynthControlState;
  /** gatePatchProposal を通してから適用する。issues が空なら遷移が始まる。 */
  proposePatch(input: unknown): { ok: boolean; issues: string[] };
  /** seed から派生した Patch へ遷移する（ガチャの Timeline 版）。 */
  proposeSeed(seed: string): void;
  /**
   * 画像を登録する（Bridge 経由の `vj-ctl image` の受け口）。
   *
   * 登録するだけで、どの Operator に割り当てるかは決めない。返った hash を
   * Patch の `images["<opId>.<slot>"]` に入れて proposePatch する、という順で使う。
   * ハッシュ計算と decode が非同期なので、control のなかでここだけ Promise を返す。
   */
  setImage(name: string, bytesBase64: string, mime: string): Promise<SetImageResult>;
  applyTimelineOp(op: TimelineOp): { ok: boolean; issue?: string };
  fireExternal(id: string): void;
  startRecording(): void;
  /** serializeRecording の JSON（未開始なら null）。 */
  stopRecording(): string | null;
  /** replay 用に Timeline を再構成して適用する。 */
  loadRecording(json: string): { ok: boolean; issues: string[] };
  /**
   * オーバーレイ合成のブレンドモードを設定する（facade 専用。backend は持たない）。
   *
   * 不正値は `normal` にフォールバックし warning を返す。常に ok:true。
   */
  setBlendMode(mode: string): SetBlendModeResult;
  /** 状態変化の購読（UI 再描画用）。unsubscribe を返す。 */
  subscribe(listener: () => void): () => void;
}

/**
 * シーンが登録する実体。subscribe と setBlendMode はレジストリ（facade）側が持つ。
 * getState は blendMode を省略してよい（facade が上書きする）。
 */
export type SynthControlBackend = Omit<SynthControl, 'subscribe' | 'setBlendMode' | 'getState'> & {
  getState(): Omit<SynthControlState, 'blendMode'>;
};

const NO_SCENE = 'no synth scene is active';

let active: SynthControlBackend | null = null;
const listeners = new Set<() => void>();

/** Facade-owned blend mode (not scene-specific). */
let blendMode: BlendMode = 'normal';

/** What the facade reports while nothing is registered (blendMode merged on read). */
function idleState(): Omit<SynthControlState, 'blendMode'> {
  return {
    currentPatch: null,
    timeline: { lockedUntilSec: 0, events: [] },
    transitionActive: false,
    qualityScale: 1,
    recordingActive: false,
    nowSec: 0,
    barCount: 0,
    tempoLocked: false,
    firedIds: [],
    reactions: [],
    hue: 0,
  };
}

/** シーンから呼ぶ。unregister 関数を返す。登録/解除時に listener へ通知する。 */
export function registerSynthControl(backend: SynthControlBackend): () => void {
  active = backend;
  notifySynthControlChanged();
  return () => {
    // Registration is last-wins, so a scene that was already superseded must not
    // tear down its successor — only clear the slot if it is still ours.
    if (active !== backend) return;
    active = null;
    notifySynthControlChanged();
  };
}

/** シーン側の状態が変わったときに呼ぶ。購読者へ通知する。 */
export function notifySynthControlChanged(): void {
  // Iterate a copy: a listener may unsubscribe (or subscribe) from inside its
  // own callback, and one that throws must not stop the rest.
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (e) {
      console.error('[synth-control] listener threw:', e);
    }
  }
}

/**
 * Stable facade. Every method resolves the backend at call time, so the object
 * stays valid across scene switches and can be captured once by the UI.
 */
const facade: SynthControl = {
  getState(): SynthControlState {
    // blendMode is facade-owned; always overwrite whatever a backend might put.
    const base = active ? active.getState() : idleState();
    return { ...base, blendMode };
  },

  proposePatch(input: unknown): { ok: boolean; issues: string[] } {
    return active ? active.proposePatch(input) : { ok: false, issues: [NO_SCENE] };
  },

  proposeSeed(seed: string): void {
    active?.proposeSeed(seed);
  },

  setImage(name: string, bytesBase64: string, mime: string): Promise<SetImageResult> {
    return active
      ? active.setImage(name, bytesBase64, mime)
      : Promise.resolve({ ok: false, issues: [NO_SCENE] });
  },

  applyTimelineOp(op: TimelineOp): { ok: boolean; issue?: string } {
    return active ? active.applyTimelineOp(op) : { ok: false, issue: NO_SCENE };
  },

  fireExternal(id: string): void {
    active?.fireExternal(id);
  },

  startRecording(): void {
    active?.startRecording();
  },

  stopRecording(): string | null {
    return active ? active.stopRecording() : null;
  },

  loadRecording(json: string): { ok: boolean; issues: string[] } {
    return active ? active.loadRecording(json) : { ok: false, issues: [NO_SCENE] };
  },

  setBlendMode(mode: string): SetBlendModeResult {
    const { mode: resolved, warning } = resolveBlendMode(mode);
    blendMode = resolved;
    notifySynthControlChanged();
    return warning != null ? { ok: true, mode: resolved, warning } : { ok: true, mode: resolved };
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** UI から使う窓口。返り値は登録状態に関わらず安定した同一オブジェクトでよい。 */
export function getSynthControl(): SynthControl {
  return facade;
}
