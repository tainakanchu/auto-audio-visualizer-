/**
 * Scene Deck のバンク永続化。8 面は保存せず base + bankSeed で再生成する。
 * Storage は注入する（このモジュールは localStorage を直接触らない）。
 */
import type { GeneratorCatalog } from '../synth/catalog';
import { parsePatch } from '../synth/schema';
import type { TransitionPresetId, VisualPatch } from '../synth/types';
import { validatePatch } from '../synth/validate';
import type { AutoKind, AutoOrder } from './autoAdvance';

export const BANK_STORAGE_KEY = 'vj-deck-banks-v1';

export type BankSlotId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export const BANK_SLOT_IDS: readonly BankSlotId[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export interface DeckBankSnapshot {
  version: 1;
  name: string;
  savedAt: string;
  base: VisualPatch;
  bankSeed: string;
  preset: TransitionPresetId;
  auto: { on: boolean; kind: AutoKind; order: AutoOrder; seconds: number; bars: number };
  cursor: number;
  /** 保存時の main 側 seed（Settings.seed）。復元時に seed:set で戻す。旧データは無い */
  mainSeed?: string;
}

export interface DeckBankStore {
  version: 1;
  current: DeckBankSnapshot | null;
  slots: Partial<Record<BankSlotId, DeckBankSnapshot>>;
}

export interface SaveBankStoreResult {
  warning: string | null;
}

export function emptyBankStore(): DeckBankStore {
  return { version: 1, current: null, slots: {} };
}

export function isBankSlotId(value: unknown): value is BankSlotId {
  return typeof value === 'string' && (BANK_SLOT_IDS as readonly string[]).includes(value);
}

/** 次の空きスロット。全部埋まっていれば A（上書き先）。 */
export function nextEmptySlot(store: DeckBankStore): BankSlotId {
  for (const id of BANK_SLOT_IDS) {
    if (store.slots[id] === undefined) return id;
  }
  return 'A';
}

export function makeBankSnapshot(input: {
  name?: string;
  savedAt?: string;
  base: VisualPatch;
  bankSeed: string;
  preset: TransitionPresetId;
  auto: DeckBankSnapshot['auto'];
  cursor: number;
  mainSeed?: string;
}): DeckBankSnapshot {
  const snap: DeckBankSnapshot = {
    version: 1,
    name: input.name ?? '',
    savedAt: input.savedAt ?? new Date().toISOString(),
    base: input.base,
    bankSeed: input.bankSeed,
    preset: input.preset,
    auto: input.auto,
    cursor: input.cursor,
  };
  if (input.mainSeed !== undefined && input.mainSeed !== '') {
    snap.mainSeed = input.mainSeed;
  }
  return snap;
}

export function parseBankSnapshot(input: unknown): DeckBankSnapshot | null {
  if (!isRecord(input)) return null;
  if (input.version !== 1) return null;
  if (typeof input.name !== 'string') return null;
  if (typeof input.savedAt !== 'string') return null;
  if (typeof input.bankSeed !== 'string') return null;
  const preset = parsePreset(input.preset);
  if (preset === null) return null;
  const auto = parseAuto(input.auto);
  if (auto === null) return null;
  if (!isFiniteNumber(input.cursor)) return null;
  const parsed = parsePatch(input.base);
  if (!parsed.ok) return null;

  const snap: DeckBankSnapshot = {
    version: 1,
    name: input.name,
    savedAt: input.savedAt,
    base: parsed.patch,
    bankSeed: input.bankSeed,
    preset,
    auto,
    cursor: input.cursor,
  };
  if (input.mainSeed !== undefined) {
    if (typeof input.mainSeed !== 'string') return null;
    if (input.mainSeed !== '') snap.mainSeed = input.mainSeed;
  }
  return snap;
}

/** 壊れていれば空 store。個別スロットの不正は落とすだけで全体は残す。 */
export function parseBankStore(input: unknown): DeckBankStore {
  if (!isRecord(input) || input.version !== 1) return emptyBankStore();

  let current: DeckBankSnapshot | null = null;
  if (input.current !== undefined && input.current !== null) {
    current = parseBankSnapshot(input.current);
  }

  const slots: Partial<Record<BankSlotId, DeckBankSnapshot>> = {};
  if (isRecord(input.slots)) {
    for (const id of BANK_SLOT_IDS) {
      const raw = input.slots[id];
      if (raw === undefined) continue;
      const snap = parseBankSnapshot(raw);
      if (snap !== null) slots[id] = snap;
    }
  }

  return { version: 1, current, slots };
}

export function loadBankStore(storage: Storage): DeckBankStore {
  try {
    const raw = storage.getItem(BANK_STORAGE_KEY);
    if (raw === null || raw === '') return emptyBankStore();
    return parseBankStore(JSON.parse(raw) as unknown);
  } catch {
    return emptyBankStore();
  }
}

/** 容量超などで setItem が throw しても握る。呼び出し側が warning を出す。 */
export function saveBankStore(storage: Storage, store: DeckBankStore): SaveBankStoreResult {
  const payload: DeckBankStore = {
    version: 1,
    current: store.current,
    slots: store.slots,
  };
  try {
    storage.setItem(BANK_STORAGE_KEY, JSON.stringify(payload));
    return { warning: null };
  } catch {
    return { warning: 'バンクを保存できませんでした（容量不足？）' };
  }
}

/**
 * parsePatch は通るが catalog 現行版と合わない。
 * ロードは通し、UI が STALE を出す（黙って全部 BASE 相当になるのを防ぐ）。
 */
export function isBankSnapshotStale(
  snapshot: DeckBankSnapshot,
  catalog: GeneratorCatalog,
): boolean {
  return validatePatch(snapshot.base, catalog).length > 0;
}

function parseAuto(input: unknown): DeckBankSnapshot['auto'] | null {
  if (!isRecord(input)) return null;
  if (typeof input.on !== 'boolean') return null;
  if (input.kind !== 'seconds' && input.kind !== 'bars') return null;
  if (input.order !== 'sequential' && input.order !== 'random') return null;
  if (!isFiniteNumber(input.seconds) || !isFiniteNumber(input.bars)) return null;
  return {
    on: input.on,
    kind: input.kind,
    order: input.order,
    seconds: input.seconds,
    bars: input.bars,
  };
}

function parsePreset(value: unknown): TransitionPresetId | null {
  if (value === 'default' || value === 'slow' || value === 'cut') return value;
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
