import { describe, expect, it } from 'vitest';
import { createCatalog } from '../synth/catalog';
import { allGeneratorDefinitions } from '../synth/generators';
import { parsePatch, serializePatch } from '../synth/schema';
import type { VisualPatch } from '../synth/types';
import { validatePatch } from '../synth/validate';
import {
  BANK_STORAGE_KEY,
  emptyBankStore,
  isBankSnapshotStale,
  loadBankStore,
  makeBankSnapshot,
  mergeBankStore,
  nextEmptySlot,
  parseBankSnapshot,
  parseBankStore,
  sameBankSnapshotContent,
  saveBankStore,
  type DeckBankSnapshot,
  type DeckBankStore,
} from './bankStore';

const metaCatalog = createCatalog(allGeneratorDefinitions());

function samplePatch(overrides: Partial<VisualPatch> = {}): VisualPatch {
  return {
    schemaVersion: 1,
    seed: 'bank-test-seed',
    operators: [
      {
        id: 'src0',
        generatorId: 'grid',
        generatorVersion: 1,
        parameters: { cells: 8, thickness: 0.08 },
      },
      {
        id: 'mod0',
        generatorId: 'kaleido',
        generatorVersion: 1,
        parameters: { segments: 6 },
      },
      {
        id: 'mat0',
        generatorId: 'neon',
        generatorVersion: 1,
        parameters: { hue: 200, intensity: 1.2 },
      },
    ],
    routes: [
      {
        source: 'audio:bass',
        target: 'mat0.intensity',
        amount: 0.5,
        polarity: 'unipolar',
        smoothing: 0.4,
      },
    ],
    palette: { mode: 'analogous', hueOffset: 10, saturation: 80, lightness: 50 },
    composition: { symmetry: 2, scale: 1.1, speed: 0.8 },
    qualityTier: 'medium',
    ...overrides,
  };
}

function sampleSnapshot(overrides: Partial<DeckBankSnapshot> = {}): DeckBankSnapshot {
  return {
    ...makeBankSnapshot({
      name: 'tonight',
      savedAt: '2026-09-02T12:00:00.000Z',
      base: samplePatch(),
      bankSeed: 'calm-harbor-042',
      preset: 'slow',
      auto: { on: true, kind: 'bars', order: 'random', seconds: 30, bars: 8 },
      cursor: 3,
      mainSeed: 'neon-prism-001',
    }),
    ...overrides,
  };
}

function mapStorage(
  initial?: Record<string, string>,
  overrides?: Partial<Pick<Storage, 'getItem' | 'setItem'>>,
): Storage {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    ...overrides,
  } as Storage;
}

describe('parseBankSnapshot', () => {
  it('roundtrips a snapshot (base via parsePatch)', () => {
    const snap = sampleSnapshot();
    const parsed = parseBankSnapshot(JSON.parse(JSON.stringify(snap)) as unknown);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('tonight');
    expect(parsed?.bankSeed).toBe('calm-harbor-042');
    expect(parsed?.preset).toBe('slow');
    expect(parsed?.auto).toEqual(snap.auto);
    expect(parsed?.cursor).toBe(3);
    expect(parsed?.mainSeed).toBe('neon-prism-001');
    expect(serializePatch(parsed!.base)).toBe(serializePatch(snap.base));
  });

  it('rejects old version, bad patch, empty bankSeed, and malformed fields', () => {
    const raw = JSON.parse(JSON.stringify(sampleSnapshot())) as Record<string, unknown>;
    expect(parseBankSnapshot({ ...raw, version: 2 })).toBeNull();
    expect(parseBankSnapshot({ ...raw, version: 0 })).toBeNull();
    expect(parseBankSnapshot({ ...raw, base: { schemaVersion: 1 } })).toBeNull();
    expect(parseBankSnapshot({ ...raw, preset: 'wipe' })).toBeNull();
    expect(parseBankSnapshot({ ...raw, auto: { on: true } })).toBeNull();
    expect(parseBankSnapshot({ ...raw, bankSeed: 12 })).toBeNull();
    expect(parseBankSnapshot({ ...raw, bankSeed: '' })).toBeNull();
    expect(parseBankSnapshot({ ...raw, name: 1 })).toBeNull();
    expect(parseBankSnapshot({ ...raw, cursor: '3' })).toBeNull();
    expect(parseBankSnapshot({ ...raw, cursor: Number.NaN })).toBeNull();
    expect(parseBankSnapshot('nope')).toBeNull();
  });

  it('omits empty mainSeed and rejects a non-string one', () => {
    const raw = JSON.parse(JSON.stringify(sampleSnapshot())) as Record<string, unknown>;
    delete raw.mainSeed;
    expect(parseBankSnapshot(raw)?.mainSeed).toBeUndefined();
    expect(parseBankSnapshot({ ...raw, mainSeed: '' })?.mainSeed).toBeUndefined();
    expect(parseBankSnapshot({ ...raw, mainSeed: 1 })).toBeNull();
  });
});

describe('parseBankStore', () => {
  it('returns an empty store for corrupt input / old version', () => {
    expect(parseBankStore(null)).toEqual(emptyBankStore());
    expect(parseBankStore('nope')).toEqual(emptyBankStore());
    expect(parseBankStore({ version: 2, current: sampleSnapshot(), slots: {} })).toEqual(
      emptyBankStore(),
    );
    expect(parseBankStore({ version: 0 })).toEqual(emptyBankStore());
  });

  it('drops a bad current / slot but keeps valid neighbors', () => {
    const good = sampleSnapshot({ name: 'A' });
    const parsed = parseBankStore({
      version: 1,
      current: { version: 1, name: 'bad' },
      slots: {
        A: good,
        B: { version: 2, name: 'old' },
        Z: good,
      },
    });
    expect(parsed.current).toBeNull();
    expect(parsed.slots.A?.name).toBe('A');
    expect(parsed.slots.B).toBeUndefined();
    expect((parsed.slots as Record<string, unknown>).Z).toBeUndefined();
  });

  it('drops current when bankSeed is empty', () => {
    const parsed = parseBankStore({
      version: 1,
      current: { ...sampleSnapshot(), bankSeed: '' },
      slots: { A: sampleSnapshot({ name: 'A' }) },
    });
    expect(parsed.current).toBeNull();
    expect(parsed.slots.A?.name).toBe('A');
  });
});

describe('stale detection', () => {
  it('is false for a catalog-valid base and true when generatorVersion is bumped', () => {
    const fresh = sampleSnapshot();
    expect(parsePatch(fresh.base).ok).toBe(true);
    expect(validatePatch(fresh.base, metaCatalog)).toEqual([]);
    expect(isBankSnapshotStale(fresh, metaCatalog)).toBe(false);

    const staleBase = samplePatch();
    staleBase.operators[0] = { ...staleBase.operators[0]!, generatorVersion: 2 };
    const stale = sampleSnapshot({ base: staleBase });
    expect(parseBankSnapshot(JSON.parse(JSON.stringify(stale)) as unknown)).not.toBeNull();
    expect(isBankSnapshotStale(stale, metaCatalog)).toBe(true);
    expect(validatePatch(stale.base, metaCatalog).some((i) => i.code === 'version_mismatch')).toBe(
      true,
    );
  });
});

describe('loadBankStore / saveBankStore', () => {
  it('saves and loads through a Map-based Storage', () => {
    const storage = mapStorage();
    const store: DeckBankStore = {
      version: 1,
      current: sampleSnapshot({ name: '' }),
      slots: { A: sampleSnapshot({ name: 'set A' }), C: sampleSnapshot({ name: 'set C' }) },
    };
    expect(saveBankStore(storage, store).warning).toBeNull();
    expect(storage.getItem(BANK_STORAGE_KEY)).toEqual(expect.any(String));

    const loaded = loadBankStore(storage);
    expect(loaded.current?.bankSeed).toBe(store.current?.bankSeed);
    expect(loaded.slots.A?.name).toBe('set A');
    expect(loaded.slots.C?.name).toBe('set C');
    expect(loaded.slots.B).toBeUndefined();
    expect(serializePatch(loaded.current!.base)).toBe(serializePatch(store.current!.base));
  });

  it('returns an empty store for missing, bad JSON, or a thrown getItem', () => {
    expect(loadBankStore(mapStorage())).toEqual(emptyBankStore());
    expect(loadBankStore(mapStorage({ [BANK_STORAGE_KEY]: '{not json' }))).toEqual(
      emptyBankStore(),
    );
    expect(
      loadBankStore(
        mapStorage(undefined, {
          getItem() {
            throw new Error('blocked');
          },
        }),
      ),
    ).toEqual(emptyBankStore());
  });

  it('writes only version, current, and slots', () => {
    const storage = mapStorage();
    expect(BANK_STORAGE_KEY).toBe('vj-deck-banks-v1');
    saveBankStore(storage, {
      version: 1,
      current: sampleSnapshot(),
      slots: { A: sampleSnapshot({ name: 'set A' }) },
    });
    const parsed = JSON.parse(storage.getItem(BANK_STORAGE_KEY)!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['current', 'slots', 'version']);
  });

  it('swallows setItem throws and returns a warning', () => {
    const storage = mapStorage(undefined, {
      setItem() {
        throw new Error('quota');
      },
    });
    const result = saveBankStore(storage, {
      version: 1,
      current: sampleSnapshot(),
      slots: {},
    });
    expect(result.warning).toEqual(expect.any(String));
    expect(result.warning).not.toBeNull();
  });
});

describe('sameBankSnapshotContent', () => {
  it('ignores savedAt and compares the rest', () => {
    const a = sampleSnapshot({ savedAt: '2026-09-01T00:00:00.000Z' });
    const b = sampleSnapshot({ savedAt: '2026-09-02T00:00:00.000Z' });
    expect(sameBankSnapshotContent(a, b)).toBe(true);
    expect(sameBankSnapshotContent(a, sampleSnapshot({ cursor: 4 }))).toBe(false);
    expect(sameBankSnapshotContent(a, sampleSnapshot({ name: 'other' }))).toBe(false);
  });
});

describe('mergeBankStore', () => {
  it('overlays one slot and optional current without dropping neighbors', () => {
    const latest: DeckBankStore = {
      version: 1,
      current: sampleSnapshot({ name: 'live' }),
      slots: { A: sampleSnapshot({ name: 'A' }), C: sampleSnapshot({ name: 'C' }) },
    };
    const slotted = mergeBankStore(latest, {
      slot: { id: 'B', snap: sampleSnapshot({ name: 'B' }) },
    });
    expect(slotted.current?.name).toBe('live');
    expect(slotted.slots.A?.name).toBe('A');
    expect(slotted.slots.B?.name).toBe('B');
    expect(slotted.slots.C?.name).toBe('C');

    const cleared = mergeBankStore(latest, { current: null });
    expect(cleared.current).toBeNull();
    expect(cleared.slots.A?.name).toBe('A');
  });
});

describe('nextEmptySlot', () => {
  it('returns the first hole, then A when full', () => {
    const store = emptyBankStore();
    expect(nextEmptySlot(store)).toBe('A');
    store.slots.A = sampleSnapshot();
    store.slots.B = sampleSnapshot();
    expect(nextEmptySlot(store)).toBe('C');
    for (const id of ['C', 'D', 'E', 'F', 'G', 'H'] as const) {
      store.slots[id] = sampleSnapshot();
    }
    expect(nextEmptySlot(store)).toBe('A');
  });
});
