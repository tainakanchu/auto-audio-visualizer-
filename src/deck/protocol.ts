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

/** デッキ窓 → メイン窓 */
export type DeckRequest =
  | { kind: 'deck:trigger'; patch: VisualPatch; label: string; preset: TransitionPresetId }
  | { kind: 'deck:requestState' };

/** メイン窓 → デッキ窓 */
export type DeckResponse =
  | { kind: 'deck:state'; state: DeckSharedState }
  | { kind: 'deck:result'; ok: boolean; label: string; issues: string[] };

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
  if (msg.kind !== 'deck:state') return null;
  const state = parseSharedState(msg.state);
  if (state === null) return null;
  return { kind: 'deck:state', state };
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
