// scripts/vj-set.mjs は src/synth/validate.ts の定数を手で複製している（CLI は .ts を
// import できないため）。このテストは vitest 側（TS 変換に対応している）から両方を
// 直接 import し、複製が本家からずれていないかを機械的に確かめる。
//
// 実際に AUDIO_SOURCES が `audio:beatIntensity` / `audio:gridPulse` / `audio:barPulse`
// の3つを欠いたまま古くなっていた（validate.ts は10種、vj-set.mjs は7種）というドリフト
// が見つかったことの再発防止。
//
// feat/vj-gen-safety ブランチの scripts/constants-drift.test.mjs（vj-gen.mjs 向けの同種
// ガード）と意図的に重複している。あちらがマージされたら、このファイルは統合して削除する。
import { describe, expect, it } from 'vitest';
import * as validate from '../src/synth/validate.ts';
import * as vjSet from './vj-set.mjs';

function sortedArray(iterable) {
  return [...iterable].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('constants drift: vj-set.mjs vs src/synth/validate.ts', () => {
  it('AUDIO_SOURCES matches validate.ts', () => {
    expect(sortedArray(vjSet.AUDIO_SOURCES)).toEqual(sortedArray(validate.AUDIO_SOURCES));
  });
});
