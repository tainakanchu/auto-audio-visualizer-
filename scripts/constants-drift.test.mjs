// vj-gen.mjs / vj-tweak.mjs は .ts を import できないので、src/synth/{derive,validate,
// schema}.ts の安全ルール定数を手で複製している。このテストは「複製が本家と食い違って
// いないか」だけを見る回帰テスト — 複製先のロジックが正しいかどうかは vj-gen.test.mjs
// / vj-tweak.test.mjs の仕事で、ここではやらない。
//
// 実際に今回見つかったバグ: vj-gen.mjs の AUDIO_SOURCES が audio:beatIntensity /
// audio:gridPulse / audio:barPulse を欠いていて、audio:beatIntensity を使う
// パッチ（今回の安全対応そのもの）がローカル検証で弾かれていた。
import { describe, expect, it } from 'vitest';
import * as derive from '../src/synth/derive.ts';
import * as schema from '../src/synth/schema.ts';
import * as validate from '../src/synth/validate.ts';
import * as vjGen from './vj-gen.mjs';
import * as vjTweak from './vj-tweak.mjs';

/** Set/配列を「順序に依存しない」形に正規化する。 */
function sortedArray(iterable) {
  return [...iterable].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('constants drift: vj-gen.mjs vs src/synth/*.ts', () => {
  it('AUDIO_SOURCES matches validate.ts (this is the headline regression: beatIntensity/gridPulse/barPulse were missing)', () => {
    expect(sortedArray(vjGen.AUDIO_SOURCES)).toEqual(sortedArray(validate.AUDIO_SOURCES));
  });

  it('ROUTE_SOURCES ids match derive.ts (no audio:beatPhase / audio:barPhase in the candidate pool)', () => {
    const deriveIds = derive.ROUTE_SOURCES.map((s) => s.id);
    expect(sortedArray(vjGen.ROUTE_SOURCES)).toEqual(sortedArray(deriveIds));
  });

  it('SAFE_TARGET_PARAMS matches derive.ts', () => {
    expect(sortedArray(vjGen.SAFE_TARGET_PARAMS)).toEqual(sortedArray(derive.SAFE_TARGET_PARAMS));
  });

  it('MOTION_TARGET_PARAMS and MOTION_RATIO_MAX match derive.ts', () => {
    expect(sortedArray(vjGen.MOTION_TARGET_PARAMS)).toEqual(
      sortedArray(derive.MOTION_TARGET_PARAMS),
    );
    expect(vjGen.MOTION_RATIO_MAX).toBe(derive.MOTION_RATIO_MAX);
  });

  it('CURRENT_SCHEMA_VERSION matches schema.ts', () => {
    expect(vjGen.CURRENT_SCHEMA_VERSION).toBe(schema.CURRENT_SCHEMA_VERSION);
  });

  it('CATEGORY_RANK matches validate.ts', () => {
    expect(vjGen.CATEGORY_RANK).toEqual(validate.CATEGORY_RANK);
  });

  it('COUNT_LIMITS matches validate.ts', () => {
    expect(vjGen.COUNT_LIMITS).toEqual(validate.COUNT_LIMITS);
  });

  it('PALETTE_MODES matches schema.ts paletteModeSchema.options', () => {
    expect(sortedArray(vjGen.PALETTE_MODES)).toEqual(sortedArray(schema.paletteModeSchema.options));
  });
});

describe('constants drift: vj-tweak.mjs vs src/synth/*.ts', () => {
  it('CATEGORY_RANK matches validate.ts', () => {
    expect(vjTweak.CATEGORY_RANK).toEqual(validate.CATEGORY_RANK);
  });

  it('COUNT_LIMITS matches validate.ts', () => {
    expect(vjTweak.COUNT_LIMITS).toEqual(validate.COUNT_LIMITS);
  });

  it('PALETTE_MODES matches schema.ts paletteModeSchema.options', () => {
    expect(sortedArray(vjTweak.PALETTE_MODES)).toEqual(
      sortedArray(schema.paletteModeSchema.options),
    );
  });

  it('QUALITY_TIERS matches schema.ts qualityTierSchema.options', () => {
    expect(sortedArray(vjTweak.QUALITY_TIERS)).toEqual(
      sortedArray(schema.qualityTierSchema.options),
    );
  });

  it('PALETTE_KEYS matches schema.ts paletteSpecSchema field names', () => {
    expect(sortedArray(vjTweak.PALETTE_KEYS)).toEqual(
      sortedArray(Object.keys(schema.paletteSpecSchema.entries)),
    );
  });

  it('COMPOSITION_KEYS matches schema.ts compositionSpecSchema field names', () => {
    expect(sortedArray(vjTweak.COMPOSITION_KEYS)).toEqual(
      sortedArray(Object.keys(schema.compositionSpecSchema.entries)),
    );
  });
});
