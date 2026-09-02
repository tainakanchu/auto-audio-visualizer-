/**
 * Scene Deck のメッセージ型とガード。
 *
 * BroadcastChannel 等の transport 語彙は持ち込まない。受信側は必ず
 * parseDeckRequest / parseDeckResponse を通す（別タブの古いバージョンが
 * 流す壊れたメッセージに耐えるため）。
 */
import { parsePatch } from '../synth/schema';
import type { TransitionPresetId, VisualPatch } from '../synth/types';

export type { TransitionPresetId };

export const DECK_CHANNEL = 'vj-deck-v1';

/** Deck → メイン窓の App レベル操作。Settings / AudioEngine / Timeline に触る。 */
export type DeckCommand =
  | { kind: 'seed:gacha' }
  | { kind: 'seed:set'; seed: string }
  | { kind: 'patch:rerollDetails'; seed?: string }
  | { kind: 'scene:set'; sceneId: string }
  | { kind: 'scene:shift'; delta: 1 | -1 }
  | { kind: 'hue:mode'; mode: 'cycle' | 'fixed' }
  | { kind: 'hue:fixed'; hue: number }
  | { kind: 'background:set'; background: 'black' | 'transparent' }
  | { kind: 'tempo:tap' }
  | { kind: 'tempo:multiply'; factor: 2 | 0.5 }
  | { kind: 'tempo:auto' }
  | { kind: 'timeline:lock'; seconds: number }
  | { kind: 'autoCycle:set'; on: boolean };

/** デッキ窓 → メイン窓 */
export type DeckRequest =
  | { kind: 'deck:trigger'; patch: VisualPatch; label: string; preset: TransitionPresetId }
  | { kind: 'deck:requestState' }
  | { kind: 'deck:command'; id: string; command: DeckCommand };

/** メイン窓 → デッキ窓 */
export type DeckResponse =
  | { kind: 'deck:state'; state: DeckSharedState }
  | { kind: 'deck:result'; ok: boolean; label: string; issues: string[] }
  | { kind: 'deck:commandResult'; id: string; ok: boolean; issues: string[] };

export interface DeckAppState {
  sceneId: string;
  hueMode: 'cycle' | 'fixed';
  fixedHue: number;
  /**
   * Renderer base hue (offset 未適用). H / [ ] / hue トグルの基準。
   * `shared.hue` は offset 込みの表示用。
   */
  baseHue: number;
  background: 'black' | 'transparent';
  seed: string;
  autoCycle: boolean;
  /** 0 = 未検出 */
  bpm: number;
  tempoLocked: boolean;
  /** 入力が動いているか（止まっていたら Deck に赤で出す） */
  audioRunning: boolean;
}

export interface DeckSharedState {
  currentPatch: VisualPatch | null;
  nowSec: number;
  barCount: number;
  tempoLocked: boolean;
  transitionActive: boolean;
  lockedUntilSec: number;
  recordingActive: boolean;
  /** host が最後に受理した trigger の label（デッキのアクティブ表示確定用） */
  lastTriggerLabel: string | null;
  /** レンダラの現在 hue（0..360、variation.hueOffset 込み）。旧 host は送らないので optional。 */
  hue?: number;
  /** App レベルの状態。旧 host は送らないので optional。 */
  app?: DeckAppState;
}

/**
 * URL の query からデッキ窓モードかどうかを決める。
 *
 * `deck=1` / `deck=true` だけを true にする。`?deck`（値なし）や不正値は false。
 * autocycle / mirror と同じ作法。
 */
export function parseDeckMode(search: string): boolean {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('deck');
  } catch {
    return false;
  }
  if (raw === null) return false;
  return raw === '1' || raw === 'true';
}

export function parseDeckRequest(msg: unknown): DeckRequest | null {
  if (!isRecord(msg)) return null;
  if (msg.kind === 'deck:requestState') {
    return { kind: 'deck:requestState' };
  }
  if (msg.kind === 'deck:command') {
    if (typeof msg.id !== 'string') return null;
    const command = parseDeckCommand(msg.command);
    if (command === null) return null;
    return { kind: 'deck:command', id: msg.id, command };
  }
  if (msg.kind !== 'deck:trigger') return null;
  if (typeof msg.label !== 'string') return null;
  const preset = parsePreset(msg.preset);
  if (preset === null) return null;
  const parsed = parsePatch(msg.patch);
  if (!parsed.ok) return null;
  return { kind: 'deck:trigger', patch: parsed.patch, label: msg.label, preset };
}

export function parseDeckResponse(msg: unknown): DeckResponse | null {
  if (!isRecord(msg)) return null;
  if (msg.kind === 'deck:result') {
    if (typeof msg.ok !== 'boolean') return null;
    if (typeof msg.label !== 'string') return null;
    const issues = parseStringArray(msg.issues);
    if (issues === null) return null;
    return { kind: 'deck:result', ok: msg.ok, label: msg.label, issues };
  }
  if (msg.kind === 'deck:commandResult') {
    if (typeof msg.id !== 'string') return null;
    if (typeof msg.ok !== 'boolean') return null;
    const issues = parseStringArray(msg.issues);
    if (issues === null) return null;
    return { kind: 'deck:commandResult', id: msg.id, ok: msg.ok, issues };
  }
  if (msg.kind !== 'deck:state') return null;
  const state = parseSharedState(msg.state);
  if (state === null) return null;
  return { kind: 'deck:state', state };
}

export function parseDeckCommand(input: unknown): DeckCommand | null {
  if (!isRecord(input)) return null;
  switch (input.kind) {
    case 'seed:gacha':
      return { kind: 'seed:gacha' };
    case 'seed:set':
      if (typeof input.seed !== 'string') return null;
      return { kind: 'seed:set', seed: input.seed };
    case 'patch:rerollDetails': {
      if (input.seed === undefined) return { kind: 'patch:rerollDetails' };
      if (typeof input.seed !== 'string') return null;
      return { kind: 'patch:rerollDetails', seed: input.seed };
    }
    case 'scene:set':
      if (typeof input.sceneId !== 'string') return null;
      return { kind: 'scene:set', sceneId: input.sceneId };
    case 'scene:shift':
      if (input.delta !== 1 && input.delta !== -1) return null;
      return { kind: 'scene:shift', delta: input.delta };
    case 'hue:mode':
      if (input.mode !== 'cycle' && input.mode !== 'fixed') return null;
      return { kind: 'hue:mode', mode: input.mode };
    case 'hue:fixed': {
      if (!isFiniteNumber(input.hue)) return null;
      if (input.hue < 0 || input.hue > 360) return null;
      return { kind: 'hue:fixed', hue: input.hue };
    }
    case 'background:set':
      if (input.background !== 'black' && input.background !== 'transparent') return null;
      return { kind: 'background:set', background: input.background };
    case 'tempo:tap':
      return { kind: 'tempo:tap' };
    case 'tempo:multiply':
      if (input.factor !== 2 && input.factor !== 0.5) return null;
      return { kind: 'tempo:multiply', factor: input.factor };
    case 'tempo:auto':
      return { kind: 'tempo:auto' };
    case 'timeline:lock':
      if (!isFiniteNumber(input.seconds) || input.seconds < 0) return null;
      return { kind: 'timeline:lock', seconds: input.seconds };
    case 'autoCycle:set':
      if (typeof input.on !== 'boolean') return null;
      return { kind: 'autoCycle:set', on: input.on };
    default:
      return null;
  }
}

function parseSharedState(input: unknown): DeckSharedState | null {
  if (!isRecord(input)) return null;
  if (!isFiniteNumber(input.nowSec)) return null;
  if (!isFiniteNumber(input.barCount)) return null;
  if (typeof input.tempoLocked !== 'boolean') return null;
  if (typeof input.transitionActive !== 'boolean') return null;
  if (!isFiniteNumber(input.lockedUntilSec)) return null;
  if (typeof input.recordingActive !== 'boolean') return null;
  if (typeof input.lastTriggerLabel !== 'string' && input.lastTriggerLabel !== null) return null;

  // 欠損は undefined のまま通す。値が来て非数なら state ごと落とす。
  let hue: number | undefined;
  if (input.hue !== undefined) {
    if (!isFiniteNumber(input.hue)) return null;
    hue = input.hue;
  }

  let app: DeckAppState | undefined;
  if (input.app !== undefined) {
    const parsedApp = parseAppState(input.app);
    if (parsedApp === null) return null;
    app = parsedApp;
  }

  let currentPatch: VisualPatch | null = null;
  if (input.currentPatch !== null) {
    const parsed = parsePatch(input.currentPatch);
    if (!parsed.ok) return null;
    currentPatch = parsed.patch;
  }

  return {
    currentPatch,
    nowSec: input.nowSec,
    barCount: input.barCount,
    tempoLocked: input.tempoLocked,
    transitionActive: input.transitionActive,
    lockedUntilSec: input.lockedUntilSec,
    recordingActive: input.recordingActive,
    lastTriggerLabel: input.lastTriggerLabel,
    ...(hue !== undefined ? { hue } : {}),
    ...(app !== undefined ? { app } : {}),
  };
}

function parseAppState(input: unknown): DeckAppState | null {
  if (!isRecord(input)) return null;
  if (typeof input.sceneId !== 'string') return null;
  if (input.hueMode !== 'cycle' && input.hueMode !== 'fixed') return null;
  if (!isFiniteNumber(input.fixedHue)) return null;
  // 旧 host は baseHue を送らない。無いときは fixedHue に倒す。
  let baseHue: number;
  if (input.baseHue === undefined) {
    baseHue = input.fixedHue;
  } else if (!isFiniteNumber(input.baseHue)) {
    return null;
  } else {
    baseHue = input.baseHue;
  }
  if (input.background !== 'black' && input.background !== 'transparent') return null;
  if (typeof input.seed !== 'string') return null;
  if (typeof input.autoCycle !== 'boolean') return null;
  if (!isFiniteNumber(input.bpm)) return null;
  if (typeof input.tempoLocked !== 'boolean') return null;
  if (typeof input.audioRunning !== 'boolean') return null;
  return {
    sceneId: input.sceneId,
    hueMode: input.hueMode,
    fixedHue: input.fixedHue,
    baseHue,
    background: input.background,
    seed: input.seed,
    autoCycle: input.autoCycle,
    bpm: input.bpm,
    tempoLocked: input.tempoLocked,
    audioRunning: input.audioRunning,
  };
}

function parsePreset(value: unknown): TransitionPresetId | null {
  if (value === 'default' || value === 'slow' || value === 'cut') return value;
  return null;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
