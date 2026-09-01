import { describe, expect, it } from 'vitest';
import { createCatalog } from '../synth/catalog';
import { DEFAULT_BUDGETS, estimateCost, fitsBudget } from '../synth/cost';
import { derivePatch, MOTION_RATIO_MAX, MOTION_TARGET_PARAMS } from '../synth/derive';
import { allGeneratorDefinitions, inlineCatalog } from '../synth/generators';
import { serializePatch } from '../synth/schema';
import type { ParameterDefinition, VisualPatch } from '../synth/types';
import { validatePatch } from '../synth/validate';
import { buildSceneBank, SCENE_BANK_SIZE } from './variations';

const metaCatalog = createCatalog(allGeneratorDefinitions());

function kindsPatch(): VisualPatch {
  return {
    schemaVersion: 1,
    seed: 'kinds-seed',
    operators: [
      {
        id: 'src0',
        generatorId: 'stamp',
        generatorVersion: 1,
        parameters: { fit: 'contain', scale: 1, invert: false },
      },
      {
        id: 'mod0',
        generatorId: 'kaleido',
        generatorVersion: 1,
        parameters: { segments: 6 },
      },
      {
        id: 'mod1',
        generatorId: 'mirror',
        generatorVersion: 1,
        parameters: { axis: 'x' },
      },
      {
        id: 'mat0',
        generatorId: 'neon',
        generatorVersion: 1,
        parameters: { hue: 10, intensity: 1.2 },
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
    images: { 'src0.image': { name: 'logo', hash: 'abc123' } },
  };
}

function topologyOf(patch: VisualPatch) {
  return patch.operators.map((op) => ({
    id: op.id,
    generatorId: op.generatorId,
    generatorVersion: op.generatorVersion,
  }));
}

function assertParamKinds(patch: VisualPatch): void {
  for (const op of patch.operators) {
    const gen = inlineCatalog.get(op.generatorId);
    if (!gen) continue;
    const byId = new Map(gen.def.parameters.map((p) => [p.id, p]));
    for (const [paramId, value] of Object.entries(op.parameters)) {
      const def = byId.get(paramId);
      if (!def) continue;
      assertValueRespects(def, value);
    }
  }
}

function assertValueRespects(def: ParameterDefinition, value: number | string | boolean): void {
  switch (def.kind) {
    case 'number': {
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
      if (def.min === 0 && def.max === 360) {
        expect(value as number).toBeGreaterThanOrEqual(0);
        expect(value as number).toBeLessThan(360);
        break;
      }
      if (def.min !== undefined) expect(value as number).toBeGreaterThanOrEqual(def.min);
      if (def.max !== undefined) expect(value as number).toBeLessThanOrEqual(def.max);
      break;
    }
    case 'int': {
      expect(typeof value).toBe('number');
      expect(Number.isInteger(value)).toBe(true);
      if (def.min !== undefined) expect(value as number).toBeGreaterThanOrEqual(def.min);
      if (def.max !== undefined) expect(value as number).toBeLessThanOrEqual(def.max);
      break;
    }
    case 'bool':
      expect(typeof value).toBe('boolean');
      break;
    case 'enum':
      expect(typeof value).toBe('string');
      expect(def.options ?? []).toContain(value);
      break;
  }
}

function assertInvariants(base: VisualPatch, scenePatch: VisualPatch): void {
  expect(topologyOf(scenePatch)).toEqual(topologyOf(base));
  expect(scenePatch.seed).toBe(base.seed);
  expect(scenePatch.qualityTier).toBe(base.qualityTier);
  expect(scenePatch.images).toEqual(base.images);
  expect(scenePatch.palette.mode).toBe(base.palette.mode);
  expect(scenePatch.composition.symmetry).toBe(base.composition.symmetry);
  expect(scenePatch.composition.scale).toBe(base.composition.scale);

  expect(scenePatch.palette.hueOffset).toBeGreaterThanOrEqual(0);
  expect(scenePatch.palette.hueOffset).toBeLessThan(360);
  expect(scenePatch.palette.saturation).toBeGreaterThanOrEqual(0);
  expect(scenePatch.palette.saturation).toBeLessThanOrEqual(100);
  expect(scenePatch.palette.lightness).toBeGreaterThanOrEqual(0);
  expect(scenePatch.palette.lightness).toBeLessThanOrEqual(100);
  expect(Number.isFinite(scenePatch.composition.symmetry)).toBe(true);
  expect(Number.isFinite(scenePatch.composition.scale)).toBe(true);
  expect(scenePatch.composition.speed).toBeGreaterThanOrEqual(0.3);
  expect(scenePatch.composition.speed).toBeLessThanOrEqual(1);

  expect(scenePatch.routes.length).toBe(base.routes.length);
  for (let i = 0; i < base.routes.length; i++) {
    const from = base.routes[i]!;
    const to = scenePatch.routes[i]!;
    expect(to.source).toBe(from.source);
    expect(to.target).toBe(from.target);
    expect(to.polarity).toBe(from.polarity);
    expect(to.smoothing).toBe(from.smoothing);
    expect(to.amount).toBeGreaterThanOrEqual(0);
  }

  assertParamKinds(scenePatch);
}

/** route の amount 上限（derive.ts の buildRoutes と同じ規則）。 */
function routeAmountCapOf(patch: VisualPatch, target: string): number | undefined {
  const dot = target.indexOf('.');
  if (dot <= 0) return undefined;
  const op = patch.operators.find((o) => o.id === target.slice(0, dot));
  if (!op) return undefined;
  const paramId = target.slice(dot + 1);
  const def = inlineCatalog.get(op.generatorId)?.def.parameters.find((prm) => prm.id === paramId);
  if (!def || typeof def.min !== 'number' || typeof def.max !== 'number') return undefined;
  const span = def.max - def.min;
  return span * (MOTION_TARGET_PARAMS.has(paramId) ? MOTION_RATIO_MAX : 1);
}

describe('deck/variations', () => {
  it('same (base, bankSeed) → deep equal (determinism)', () => {
    const base = derivePatch('neon-tiger-042', { catalog: inlineCatalog });
    const a = buildSceneBank(base, 'bank-alpha', inlineCatalog);
    const b = buildSceneBank(base, 'bank-alpha', inlineCatalog);
    expect(a).toEqual(b);
  });

  it('emits 8 slots with BASE/V1..V7 labels and a cloned slot 0', () => {
    const base = kindsPatch();
    const bank = buildSceneBank(base, 'bank-labels', inlineCatalog);
    expect(bank).toHaveLength(SCENE_BANK_SIZE);
    expect(bank.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(bank.map((s) => s.label)).toEqual(['BASE', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7']);
    expect(bank[0]!.strength).toBe(0);
    expect(bank[0]!.patch).toEqual(base);
    expect(bank[0]!.patch).not.toBe(base);
    expect(bank[0]!.detail.length).toBeGreaterThan(0);
    bank[0]!.patch.seed = 'mutated';
    expect(base.seed).toBe('kinds-seed');
  });

  it('keeps topology, seed, qualityTier, images; respects param kinds and schema ranges', () => {
    const bases = [
      kindsPatch(),
      derivePatch('deck-kind-1', { catalog: inlineCatalog }),
      derivePatch('deck-kind-2', { catalog: inlineCatalog }),
    ];
    for (const base of bases) {
      const bank = buildSceneBank(base, 'bank-kinds', inlineCatalog);
      for (const scene of bank) {
        assertInvariants(base, scene.patch);
        expect(scene.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it('derivePatch 20 seeds × 8 slots all pass validatePatch + fitsBudget', () => {
    for (let i = 0; i < 20; i++) {
      const base = derivePatch(`deck-var-${i}`, { catalog: inlineCatalog });
      const bank = buildSceneBank(base, `bank-${i}`, inlineCatalog);
      expect(bank).toHaveLength(SCENE_BANK_SIZE);
      for (const scene of bank) {
        expect(validatePatch(scene.patch, metaCatalog)).toEqual([]);
        expect(
          fitsBudget(
            estimateCost(scene.patch, metaCatalog),
            DEFAULT_BUDGETS[scene.patch.qualityTier],
          ),
        ).toEqual([]);
        assertInvariants(base, scene.patch);
      }
      expect(bank[0]!.patch).toEqual(base);
      expect(bank[0]!.detail.length).toBeGreaterThan(0);
    }
  });

  it('V1..V7 actually differ from BASE (vary が効いている)', () => {
    for (const seed of ['deck-diff-a', 'deck-diff-b', 'deck-diff-c', 'deck-diff-d']) {
      const base = derivePatch(seed, { catalog: inlineCatalog });
      const bank = buildSceneBank(base, `bank-${seed}`, inlineCatalog);
      const baseText = serializePatch(base);
      expect(serializePatch(bank[0]!.patch)).toBe(baseText);
      for (const scene of bank.slice(1)) {
        expect(serializePatch(scene.patch)).not.toBe(baseText);
        expect(scene.detail).not.toBe('base');
      }
    }
  });

  it('V1..V7 are pairwise distinct', () => {
    for (const seed of ['deck-pair-a', 'deck-pair-b', 'deck-pair-c']) {
      const base = derivePatch(seed, { catalog: inlineCatalog });
      const bank = buildSceneBank(base, `bank-${seed}`, inlineCatalog);
      const texts = bank.slice(1).map((s) => serializePatch(s.patch));
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it('route amount stays under the derive.ts safety cap', () => {
    const eps = 1e-9;
    for (let i = 0; i < 60; i++) {
      const base = derivePatch(`deck-cap-${i}`, { catalog: inlineCatalog });
      const bank = buildSceneBank(base, `bank-cap-${i}`, inlineCatalog);
      for (const scene of bank) {
        for (const route of scene.patch.routes) {
          const cap = routeAmountCapOf(scene.patch, route.target);
          expect(cap).toBeDefined();
          expect(Math.abs(route.amount)).toBeLessThanOrEqual(cap! + eps);
        }
      }
    }
  });

  it('keeps a base speed outside 0.3..1 instead of collapsing it to 1', () => {
    const base = kindsPatch();
    base.composition.speed = 2.5;
    const bank = buildSceneBank(base, 'bank-fast', inlineCatalog);
    const speeds = bank.slice(1).map((s) => s.patch.composition.speed);
    for (const speed of speeds) {
      expect(speed).toBeGreaterThanOrEqual(0.3);
      expect(speed).toBeLessThanOrEqual(2.5);
    }
    expect(speeds.every((v) => v === 1)).toBe(false);
    expect(new Set(speeds).size).toBeGreaterThan(1);
  });

  it('renders the speed delta as a ratio, not the absolute value', () => {
    const base = kindsPatch();
    base.composition.speed = 2.5;
    const bank = buildSceneBank(base, 'bank-fast', inlineCatalog);
    const ratios = bank
      .map((scene) => /speed×([\d.]+)/.exec(scene.detail)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    expect(ratios.length).toBeGreaterThan(0);
    // 倍率は 1 ± 0.5*strength(<=0.85) の範囲。絶対値（2.5 前後）が出たら壊れている。
    for (const ratio of ratios) expect(ratio).toBeLessThanOrEqual(1.5);
  });

  it('falls back to a base clone when the base patch itself is invalid', () => {
    const base = kindsPatch();
    base.operators[0]!.generatorVersion = 999; // カタログと不一致 = validate 落ち
    expect(validatePatch(base, metaCatalog).length).toBeGreaterThan(0);

    const bank = buildSceneBank(base, 'bank-invalid', inlineCatalog);
    expect(bank).toHaveLength(SCENE_BANK_SIZE);
    for (const scene of bank) {
      expect(scene.detail).toBe('base');
      expect(scene.patch).toEqual(base);
      expect(scene.patch).not.toBe(base);
    }
  });
});
