import { describe, expect, it } from 'vitest';
import { rand } from './rng';
import {
  createSwellClock,
  FP_MAX,
  FP_MIN,
  jonswapShape,
  MAX_DT,
  peakFrequency,
  SPECTRUM_BINS,
  SPECTRUM_RATIO_MAX,
  SPECTRUM_RATIO_MIN,
  spectrumAmplitudes,
  spectrumRatios,
  type SwellClock,
  type SwellState,
} from './swell';

const DT = 1 / 60;
const KEYS = ['wave', 'group', 'set', 'surge'] as const;

/** energy は定数でも、フレーム番号の関数でもよい。 */
type Energy = number | ((frame: number) => number);

/** clock を `seconds` 秒ぶん回して、毎フレームの state を返す。 */
function run(clock: SwellClock, energy: Energy, seconds: number, dt = DT): SwellState[] {
  const frames = Math.round(seconds / dt);
  const out: SwellState[] = [];
  for (let i = 0; i < frames; i++) {
    out.push(clock.advance(typeof energy === 'number' ? energy : energy(i), dt));
  }
  return out;
}

function field(states: readonly SwellState[], key: keyof SwellState): number[] {
  return states.map((s) => s[key]);
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 信号の「平均周期」。自身の平均値を上向きに横切った回数で長さを割る。
 *
 * ピーク検出より頑健なので階層の測定に使う。半波整流された `wave` / `set` でも、
 * 1 周期につき上向き交差はちょうど 1 回なので同じ尺度で比べられる。
 */
function meanPeriod(values: readonly number[], dt = DT): number {
  const avg = mean(values);
  let crossings = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1]! <= avg && values[i]! > avg) crossings++;
  }
  return (values.length * dt) / Math.max(1, crossings);
}

/** 決定性テスト用の、それらしく暴れる energy 列。 */
function wobble(frame: number): number {
  return rand('swell-test', 'energy', frame % 4096);
}

describe('synth/swell', () => {
  describe('jonswapShape', () => {
    it('peaks at fp', () => {
      const fp = 0.1;
      const peak = jonswapShape(fp, fp);
      expect(peak).toBeGreaterThan(jonswapShape(fp * 0.8, fp));
      expect(peak).toBeGreaterThan(jonswapShape(fp * 1.2, fp));
    });

    it('is positive and finite across the sampled band', () => {
      for (let i = 0; i <= 20; i++) {
        const r = SPECTRUM_RATIO_MIN + ((SPECTRUM_RATIO_MAX - SPECTRUM_RATIO_MIN) * i) / 20;
        const v = jonswapShape(r, 1);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    });
  });

  describe('spectrumRatios', () => {
    it('places every component inside the band', () => {
      const ratios = spectrumRatios('alpha');
      expect(ratios).toHaveLength(SPECTRUM_BINS);
      for (const r of ratios) {
        expect(r).toBeGreaterThan(SPECTRUM_RATIO_MIN);
        expect(r).toBeLessThan(SPECTRUM_RATIO_MAX);
      }
    });

    it('is deterministic per seed and differs between seeds', () => {
      expect(spectrumRatios('alpha')).toEqual(spectrumRatios('alpha'));
      expect(spectrumRatios('alpha')).not.toEqual(spectrumRatios('bravo'));
    });

    it('is jittered, not perfectly even', () => {
      // 完全な等間隔だと合成が短い周期で再帰し、うねりが規則的に見えてしまう。
      const ratios = spectrumRatios('alpha');
      const gaps: number[] = [];
      for (let i = 1; i < ratios.length; i++) gaps.push(ratios[i]! - ratios[i - 1]!);
      const spread = Math.max(...gaps) - Math.min(...gaps);
      expect(spread).toBeGreaterThan(0);
    });
  });

  describe('spectrumAmplitudes', () => {
    it('is normalised so the energy sums to 1', () => {
      const amps = spectrumAmplitudes(spectrumRatios('alpha'));
      const energy = amps.reduce((a, v) => a + v * v, 0);
      expect(energy).toBeCloseTo(1, 12);
    });

    it('puts the most energy near the spectral peak', () => {
      const ratios = spectrumRatios('alpha');
      const amps = spectrumAmplitudes(ratios);
      let best = 0;
      for (let i = 1; i < amps.length; i++) if (amps[i]! > amps[best]!) best = i;
      expect(Math.abs(ratios[best]! - 1)).toBeLessThan(0.1);
    });
  });

  describe('peakFrequency', () => {
    it('runs from the calm short chop to the grown long swell', () => {
      expect(peakFrequency(0)).toBeCloseTo(FP_MAX, 12);
      expect(peakFrequency(1)).toBeCloseTo(FP_MIN, 12);
    });

    it('drops monotonically as the sea grows', () => {
      let prev = peakFrequency(0);
      for (let i = 1; i <= 10; i++) {
        const f = peakFrequency(i / 10);
        expect(f).toBeLessThan(prev);
        prev = f;
      }
    });
  });

  describe('createSwellClock', () => {
    it('is deterministic — same seed and same input give the same output', () => {
      const a = run(createSwellClock('tide'), wobble, 90);
      const b = run(createSwellClock('tide'), wobble, 90);
      expect(a).toEqual(b);
    });

    it('reset() replays the exact same sequence', () => {
      const clock = createSwellClock('tide');
      const first = run(clock, wobble, 60);
      clock.reset();
      expect(clock.state).toEqual({ wave: 0, group: 0, set: 0, surge: 0 });
      expect(run(clock, wobble, 60)).toEqual(first);
    });

    it('a different seed gives a different sequence', () => {
      const a = run(createSwellClock('tide'), 1, 60);
      const b = run(createSwellClock('reef'), 1, 60);
      expect(a).not.toEqual(b);
      // 統計は似ていてよいが、波形そのものは別物であってほしい。
      expect(field(a, 'wave')).not.toEqual(field(b, 'wave'));
    });

    it('state mirrors the last advance()', () => {
      const clock = createSwellClock('tide');
      const states = run(clock, 1, 30);
      expect(clock.state).toEqual(states[states.length - 1]);
    });

    it('every output stays finite and inside 0..1 under wild input', () => {
      const clock = createSwellClock('tide');
      // 無音 / 全開 / 中間をランダムに行き来させる。範囲外の入力も混ぜる。
      const states = run(
        clock,
        (i) => {
          const r = rand('swell-test', 'wild', i % 8192);
          return r < 0.1 ? -0.5 : r < 0.2 ? 1.7 : r;
        },
        900,
      );
      // 54000 フレーム × 4 出力あるので、フレームごとに expect せず集計してから判定する。
      let outOfRange = 0;
      let lowest = Number.POSITIVE_INFINITY;
      let highest = Number.NEGATIVE_INFINITY;
      for (const s of states) {
        for (const k of KEYS) {
          const v = s[k];
          if (!Number.isFinite(v) || v < 0 || v > 1) outOfRange++;
          if (v < lowest) lowest = v;
          if (v > highest) highest = v;
        }
      }
      expect(outOfRange).toBe(0);
      expect(lowest).toBeGreaterThanOrEqual(0);
      expect(highest).toBeLessThanOrEqual(1);
    });

    it('silence settles everything back to 0', () => {
      // 一度きちんと海を立ててから止める。「そもそも動いていない」では証明にならない。
      const clock = createSwellClock('tide');
      run(clock, 1, 120);
      expect(clock.state.group).toBeGreaterThan(0.05);

      run(clock, 0, 600);
      for (const k of KEYS) expect(clock.state[k]).toBeLessThan(1e-5);
    });

    it('sustained energy grows the sea', () => {
      const states = run(createSwellClock('tide'), 1, 120);
      const frames = states.length;
      const early = mean(field(states.slice(0, Math.round(10 / DT)), 'group'));
      const late = mean(field(states.slice(frames - Math.round(10 / DT)), 'group'));
      expect(late).toBeGreaterThan(early * 3);
      expect(late).toBeGreaterThan(0.2);
    });

    describe('the memory of the sea', () => {
      it('does not reach full size the instant the sound starts', () => {
        const clock = createSwellClock('tide');
        const onset = run(clock, 1, 3);
        // 定常の平均に対して、立ち上がり 3 秒はまだ半分にも届かない。
        const steady = mean(field(run(createSwellClock('tide'), 1, 300).slice(-3600), 'group'));
        expect(Math.max(...field(onset, 'group'))).toBeLessThan(steady * 0.5);
      });

      it('still has a swell running seconds after the sound stops', () => {
        const clock = createSwellClock('tide');
        run(clock, 1, 60);
        const beforeCut = clock.state.group;

        const afterCut = run(clock, 0, 5);
        // 音が切れて 5 秒経ってもうねりは残る（DECAY_TAU が GROWTH_TAU より長い）。
        expect(mean(field(afterCut, 'group'))).toBeGreaterThan(0.15);
        expect(Math.max(...field(afterCut, 'group'))).toBeGreaterThan(beforeCut * 0.5);
      });
    });

    /**
     * この機能の本質。「10 波に 1 回」「100 波に 1 回」という数字はモジュールの
     * どこにも書いていないのに、干渉と 2 次振動子から 3 段の時間スケールが立ち上がる。
     *
     * 実測（energy=1 で 1200 秒、頭 300 秒は過渡なので捨てる。5 seed の範囲）:
     *   wave 1.20〜1.22 秒 / group 6.5〜7.3 秒 / set 47〜75 秒
     *   → group/wave 5.4〜6.0、set/group 6.7〜10.4、set/wave 39〜62
     * seed で set が ±30% 動くので、判定はオーダーだけ見る緩い範囲にしてある。
     */
    it('grows a three-level hierarchy of timescales on its own', () => {
      const states = run(createSwellClock('tide'), 1, 1200);
      const settled = states.slice(Math.round(300 / DT));

      const wave = meanPeriod(field(settled, 'wave'));
      const group = meanPeriod(field(settled, 'group'));
      const set = meanPeriod(field(settled, 'set'));

      // 順序は絶対。個々の波 < 波群 < set。
      expect(wave).toBeLessThan(group);
      expect(group).toBeLessThan(set);

      // 隣の層とは 1 桁のオーダーで離れている。
      expect(group / wave).toBeGreaterThan(4);
      expect(group / wave).toBeLessThan(30);
      expect(set / group).toBeGreaterThan(4);
      expect(set / group).toBeLessThan(30);

      // 2 段上がると 2 桁のオーダーになる。
      expect(set / wave).toBeGreaterThan(20);
      expect(set / wave).toBeLessThan(400);
    });

    it('keeps the hierarchy across seeds', () => {
      for (const seed of ['tide', 'reef', 'shorebreak']) {
        const settled = run(createSwellClock(seed), 1, 1200).slice(Math.round(300 / DT));
        const wave = meanPeriod(field(settled, 'wave'));
        const group = meanPeriod(field(settled, 'group'));
        const set = meanPeriod(field(settled, 'set'));
        expect(group / wave, seed).toBeGreaterThan(4);
        expect(set / group, seed).toBeGreaterThan(3);
      }
    });

    it('uses the whole 0..1 range at full energy without pinning', () => {
      // 較正が効いていることの確認。0.1 までしか振れない / 天井に張り付く、のどちらも避ける。
      const settled = run(createSwellClock('tide'), 1, 900).slice(Math.round(300 / DT));
      for (const k of KEYS) {
        const values = field(settled, k);
        expect(Math.max(...values)).toBeGreaterThan(0.6);
        expect(mean(values)).toBeLessThan(0.8);
        expect(values.filter((v) => v >= 1).length / values.length).toBeLessThan(0.02);
      }
    });

    describe('numerical safety', () => {
      it('a huge dt neither diverges nor produces NaN', () => {
        // タブ非アクティブから復帰した直後の巨大な dt。2 次振動子が飛ぶ条件。
        const clock = createSwellClock('tide');
        for (let i = 0; i < 400; i++) {
          const s = clock.advance(1, 5);
          for (const k of KEYS) {
            expect(Number.isFinite(s[k])).toBe(true);
            expect(s[k]).toBeGreaterThanOrEqual(0);
            expect(s[k]).toBeLessThanOrEqual(1);
          }
        }
      });

      it('clamps dt to MAX_DT', () => {
        const huge = createSwellClock('tide');
        const capped = createSwellClock('tide');
        for (let i = 0; i < 50; i++) {
          expect(huge.advance(1, 5)).toEqual(capped.advance(1, MAX_DT));
        }
      });

      it('shrugs off a non-finite dt or energy', () => {
        const clock = createSwellClock('tide');
        run(clock, 1, 30);
        // energy が NaN でも状態は汚れない（無音として扱われるだけ）。
        expect(clock.advance(Number.NaN, DT).wave).not.toBeNaN();
        // dt が NaN のフレームは丸ごと捨てる = 状態は 1 mm も進まない。
        const before = clock.state;
        expect(clock.advance(1, Number.NaN)).toEqual(before);
      });
    });
  });
});
