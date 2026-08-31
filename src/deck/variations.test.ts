import { describe, expect, it } from 'vitest';
import { createCatalog } from '../synth/catalog';
import { DEFAULT_BUDGETS, estimateCost, fitsBudget } from '../synth/cost';
import { derivePatch } from '../synth/derive';
import { allGeneratorDefinitions, inlineCatalog } from '../synth/generators';
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
});
