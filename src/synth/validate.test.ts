import { describe, expect, it } from 'vitest';
import { createCatalog } from './catalog';
import type { GeneratorDefinition, VisualPatch } from './types';
import { validatePatch } from './validate';

function def(
  partial: Partial<GeneratorDefinition> & Pick<GeneratorDefinition, 'id' | 'category'>,
): GeneratorDefinition {
  return {
    version: 1,
    costClass: 'light',
    impl: 'inline',
    output: partial.category === 'material' ? 'color' : 'field',
    tags: {},
    parameters: [
      {
        id: 'amount',
        label: 'Amount',
        kind: 'number',
        min: 0,
        max: 1,
        default: 0.5,
        modulatable: true,
      },
      {
        id: 'mode',
        label: 'Mode',
        kind: 'enum',
        options: ['a', 'b'],
        default: 'a',
        modulatable: false,
      },
      {
        id: 'count',
        label: 'Count',
        kind: 'int',
        min: 1,
        max: 8,
        default: 2,
        modulatable: true,
      },
      {
        id: 'enabled',
        label: 'Enabled',
        kind: 'bool',
        default: true,
        modulatable: false,
      },
    ],
    cost: { passes: 0, relativeFill: 1, stateful: false },
    ...partial,
  };
}

const sourceGen = def({ id: 'gen-source', category: 'source' });
const sourceGen2 = def({ id: 'gen-source-2', category: 'source' });
const fieldGen = def({ id: 'gen-field', category: 'field' });
const fieldGen2 = def({ id: 'gen-field-2', category: 'field' });
const modifierGen = def({ id: 'gen-modifier', category: 'modifier' });
const modifierGen2 = def({ id: 'gen-modifier-2', category: 'modifier' });
const modifierGen3 = def({ id: 'gen-modifier-3', category: 'modifier' });
const materialGen = def({ id: 'gen-material', category: 'material', output: 'color' });

/** Source with a texture input slot — the shape stamp has. */
const texturedGen = def({ id: 'gen-textured', category: 'source', textures: ['image'] });

const catalog = createCatalog([
  sourceGen,
  sourceGen2,
  fieldGen,
  fieldGen2,
  modifierGen,
  modifierGen2,
  modifierGen3,
  materialGen,
  texturedGen,
  def({ id: 'gen-v2', category: 'source', version: 2 }),
]);

function validPatch(overrides: Partial<VisualPatch> = {}): VisualPatch {
  return {
    schemaVersion: 1,
    seed: 'seed',
    operators: [
      {
        id: 'src',
        generatorId: 'gen-source',
        generatorVersion: 1,
        parameters: { amount: 0.5, mode: 'a', count: 2, enabled: true },
      },
      {
        id: 'mod',
        generatorId: 'gen-modifier',
        generatorVersion: 1,
        parameters: { amount: 0.3, mode: 'b', count: 1, enabled: false },
      },
      {
        id: 'mat',
        generatorId: 'gen-material',
        generatorVersion: 1,
        parameters: { amount: 1, mode: 'a', count: 4, enabled: true },
      },
    ],
    routes: [
      {
        source: 'audio:bass',
        target: 'mod.amount',
        amount: 0.5,
        polarity: 'unipolar',
        smoothing: 0.1,
      },
    ],
    palette: { mode: 'mono', hueOffset: 0, saturation: 50, lightness: 50 },
    composition: { symmetry: 1, scale: 1, speed: 1 },
    qualityTier: 'medium',
    ...overrides,
  };
}

function codes(patch: VisualPatch = validPatch()) {
  return validatePatch(patch, catalog).map((i) => i.code);
}

describe('synth/validate', () => {
  describe('rule1: operator ids unique', () => {
    it('pass: unique ids', () => {
      expect(codes()).not.toContain('duplicate_operator_id');
    });

    it('fail: duplicate operator id', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'same',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'same',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('duplicate_operator_id');
    });
  });

  describe('rule2: generatorId exists in catalog', () => {
    it('pass: known generators', () => {
      expect(codes()).not.toContain('unknown_generator');
    });

    it('fail: unknown generator', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'does-not-exist',
            generatorVersion: 1,
            parameters: {},
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('unknown_generator');
    });
  });

  describe('rule3: generatorVersion matches catalog', () => {
    it('pass: matching version', () => {
      expect(codes()).not.toContain('version_mismatch');
    });

    it('fail: version mismatch', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 99,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('version_mismatch');
    });
  });

  describe('rule4: stage order Source → Field → Modifier → Material', () => {
    it('pass: non-decreasing category order', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'fld',
            generatorId: 'gen-field',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).not.toContain('stage_order');
    });

    it('fail: material before modifier', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('stage_order');
    });
  });

  describe('rule5: count limits Source1–2 / Field0–2 / Modifier1–3 / Material1', () => {
    it('pass: within limits', () => {
      expect(codes()).not.toContain('count_limit');
    });

    it('fail: zero sources', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('count_limit');
    });

    it('fail: two materials', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat1',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat2',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('count_limit');
    });

    it('fail: four modifiers', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'm1',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'm2',
            generatorId: 'gen-modifier-2',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'm3',
            generatorId: 'gen-modifier-3',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'm4',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('count_limit');
    });
  });

  describe('rule6: parameters type/range', () => {
    it('pass: valid parameter values', () => {
      const issues = validatePatch(validPatch(), catalog);
      expect(
        issues.filter((i) => i.code.startsWith('param_') || i.code === 'unknown_parameter'),
      ).toEqual([]);
    });

    it('fail: unknown parameter', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { amount: 0.5, ghost: 1 },
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('unknown_parameter');
    });

    it('fail: number out of range', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { amount: 2 },
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('param_range');
    });

    it('fail: int type mismatch (float)', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { count: 1.5 },
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('param_type');
    });

    it('fail: bool type mismatch', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { enabled: 'yes' },
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('param_type');
    });

    it('fail: enum not in options', () => {
      const patch = validPatch({
        operators: [
          {
            id: 'src',
            generatorId: 'gen-source',
            generatorVersion: 1,
            parameters: { mode: 'z' },
          },
          {
            id: 'mod',
            generatorId: 'gen-modifier',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
          {
            id: 'mat',
            generatorId: 'gen-material',
            generatorVersion: 1,
            parameters: { amount: 0.5 },
          },
        ],
      });
      expect(codes(patch)).toContain('param_range');
    });
  });

  describe('rule7: route target op.param and modulatable', () => {
    it('pass: valid modulatable target', () => {
      expect(codes()).not.toContain('invalid_target');
      expect(codes()).not.toContain('target_not_modulatable');
    });

    it('fail: malformed target', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'time',
            target: 'noperiod',
            amount: 1,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).toContain('invalid_target');
    });

    it('fail: unknown operator in target', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'time',
            target: 'missing.amount',
            amount: 1,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).toContain('invalid_target');
    });

    it('fail: non-modulatable parameter', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'time',
            target: 'mod.mode',
            amount: 1,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).toContain('target_not_modulatable');
    });
  });

  describe('rule8: route source known form', () => {
    it('pass: audio / time / operator sources', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'audio:mid',
            target: 'mod.amount',
            amount: 1,
            polarity: 'bipolar',
            smoothing: 0,
          },
          {
            source: 'time',
            target: 'src.amount',
            amount: 0.2,
            polarity: 'unipolar',
            smoothing: 0.05,
          },
          {
            source: 'operator:src',
            target: 'mod.count',
            amount: 1,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).not.toContain('invalid_source');
    });

    it('pass: every swell layer', () => {
      const patch = validPatch({
        routes: (['swell:wave', 'swell:group', 'swell:set', 'swell:surge'] as const).map(
          (source, i) => ({
            source,
            target: ['mod.amount', 'mod.count', 'src.amount', 'src.count'][i]!,
            amount: 0.2,
            polarity: 'unipolar' as const,
            smoothing: 0.8,
          }),
        ),
      });
      expect(codes(patch)).not.toContain('invalid_source');
    });

    it('fail: a swell layer that modulation.ts cannot resolve', () => {
      // 網が prefix 一致になっていないことの確認。ここが緩いと「検証は通るのに
      // デッキ生成で UnknownModulationSourceError」が作れてしまう。
      const patch = validPatch({
        routes: [
          {
            source: 'swell:tide',
            target: 'mod.amount',
            amount: 1,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).toContain('invalid_source');
    });

    it('fail: unknown source string', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'midi:cc1',
            target: 'mod.amount',
            amount: 1,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).toContain('invalid_source');
    });

    it('fail: operator source that does not exist', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'operator:ghost',
            target: 'mod.amount',
            amount: 1,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).toContain('invalid_source');
    });
  });

  describe('rule9: same-frame self-reference reject', () => {
    it('pass: operator A modulates B', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'operator:src',
            target: 'mod.amount',
            amount: 1,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).not.toContain('self_modulation');
    });

    it('fail: operator X modulates X', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'operator:mod',
            target: 'mod.amount',
            amount: 1,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).toContain('self_modulation');
    });
  });

  describe('rule10: amount/smoothing finite; smoothing >= 0', () => {
    it('pass: finite amount and non-negative smoothing', () => {
      expect(codes()).not.toContain('invalid_amount');
      expect(codes()).not.toContain('invalid_smoothing');
    });

    it('fail: non-finite amount', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'time',
            target: 'mod.amount',
            amount: Number.NaN,
            polarity: 'unipolar',
            smoothing: 0,
          },
        ],
      });
      expect(codes(patch)).toContain('invalid_amount');
    });

    it('fail: negative smoothing', () => {
      const patch = validPatch({
        routes: [
          {
            source: 'time',
            target: 'mod.amount',
            amount: 1,
            polarity: 'unipolar',
            smoothing: -0.1,
          },
        ],
      });
      expect(codes(patch)).toContain('invalid_smoothing');
    });
  });

  describe('rule11: image references', () => {
    /** validPatch with its source swapped for the textured generator. */
    function texturedPatch(images?: VisualPatch['images']): VisualPatch {
      const base = validPatch();
      return {
        ...base,
        operators: [
          { ...base.operators[0]!, generatorId: 'gen-textured' },
          ...base.operators.slice(1),
        ],
        ...(images ? { images } : {}),
      };
    }

    it('pass: patch without images (every existing patch)', () => {
      expect(validatePatch(validPatch(), catalog)).toEqual([]);
    });

    it('pass: reference points at a declared slot', () => {
      const patch = texturedPatch({ 'src.image': { name: 'logo.png', hash: 'deadbeef' } });
      expect(validatePatch(patch, catalog)).toEqual([]);
    });

    it('pass: a declared slot may stay unassigned (renders empty, not invalid)', () => {
      expect(validatePatch(texturedPatch({}), catalog)).toEqual([]);
    });

    it('fail: key is not "<opId>.<slot>"', () => {
      const patch = texturedPatch({ src: { name: 'logo.png', hash: 'deadbeef' } });
      expect(codes(patch)).toContain('invalid_image_key');
    });

    it('fail: operator does not exist', () => {
      const patch = texturedPatch({ 'nope.image': { name: 'logo.png', hash: 'deadbeef' } });
      expect(codes(patch)).toContain('invalid_image_key');
    });

    it('fail: operator exists but declares no such slot', () => {
      const patch = texturedPatch({ 'src.background': { name: 'logo.png', hash: 'deadbeef' } });
      expect(codes(patch)).toContain('unknown_texture_slot');
    });

    it('fail: operator declares no textures at all', () => {
      const patch = validPatch({ images: { 'src.image': { name: 'l.png', hash: 'deadbeef' } } });
      const issues = validatePatch(patch, catalog);
      expect(issues.map((i) => i.code)).toContain('unknown_texture_slot');
      expect(issues.find((i) => i.code === 'unknown_texture_slot')?.path).toBe('images.src.image');
    });
  });

  describe('valid patch overall', () => {
    it('returns no issues for a fully valid patch', () => {
      expect(validatePatch(validPatch(), catalog)).toEqual([]);
    });
  });
});
