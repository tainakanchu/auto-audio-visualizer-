import { describe, expect, it } from 'vitest';
import type { AudioFrame } from '../audio/types';
import {
  audioEnergy,
  createMotionClock,
  IDLE_MOTION_RATE,
  motionRate,
  REFERENCE_BPM,
  SWELL_PUSH,
  tempoScale,
  TEMPO_SCALE_MAX,
  TEMPO_SCALE_MIN,
} from './motion';

/** テスト用 AudioFrame。指定フィールドだけ上書きする。 */
function makeAudio(partial: Partial<AudioFrame> = {}): AudioFrame {
  return {
    freq: new Uint8Array(0),
    wave: new Uint8Array(0),
    level: 0,
    levelRaw: 0,
    peak: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    beat: false,
    beatIntensity: 0,
    running: true,
    bpm: 0,
    beatPhase: 0,
    barPhase: 0,
    beatInBar: 0,
    barCount: 0,
    gridBeat: false,
    gridBar: false,
    gridPulse: 0,
    barPulse: 0,
    tempoConfidence: 0,
    tempoLocked: false,
    tempoMode: 'auto',
    ...partial,
  };
}

const SILENT = makeAudio();
const LOUD = makeAudio({ level: 0.35, bass: 0.8, mid: 0.6, treble: 0.4 });

/** clock を `seconds` 秒ぶん 60fps で回す。 */
function run(
  clock: ReturnType<typeof createMotionClock>,
  audio: AudioFrame,
  seconds: number,
  patchSpeed = 1,
): void {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) clock.advance(audio, dt, patchSpeed);
}

/** `seconds` 秒ぶん進めながら、毎フレームの `swell.group` を集める。 */
function collect(
  clock: ReturnType<typeof createMotionClock>,
  audio: AudioFrame,
  seconds: number,
): number[] {
  const dt = 1 / 60;
  const out: number[] = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    clock.advance(audio, dt);
    out.push(clock.swell.group);
  }
  return out;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

describe('synth/motion', () => {
  describe('audioEnergy', () => {
    it('silence is 0', () => {
      expect(audioEnergy(SILENT)).toBe(0);
    });

    it('mic noise floor still reads as silence', () => {
      expect(audioEnergy(makeAudio({ level: 0.01, bass: 0.03, mid: 0.02 }))).toBe(0);
    });

    it('loud music approaches 1', () => {
      expect(audioEnergy(LOUD)).toBeGreaterThan(0.7);
    });

    it('is bounded to 0..1', () => {
      const hot = makeAudio({ level: 1, bass: 1, mid: 1, treble: 1 });
      expect(audioEnergy(hot)).toBeLessThanOrEqual(1);
    });
  });

  describe('motionRate', () => {
    it('silence falls back to the idle rate', () => {
      expect(motionRate(0, SILENT)).toBeCloseTo(IDLE_MOTION_RATE, 6);
    });

    it('full energy runs at roughly normal speed', () => {
      expect(motionRate(1, LOUD)).toBeGreaterThanOrEqual(1);
    });

    it('a freewheeling beat grid cannot speed up a silent frame', () => {
      // ブレイク中もグリッドは回るが、無音なら動きは増えない。
      const freewheel = makeAudio({ tempoLocked: true, bpm: 128, gridPulse: 1 });
      expect(motionRate(0, freewheel)).toBeCloseTo(
        motionRate(0, SILENT) * tempoScale(freewheel),
        6,
      );
    });

    it('patch speed scales the result', () => {
      expect(motionRate(1, LOUD, 0.5)).toBeCloseTo(motionRate(1, LOUD, 1) * 0.5, 6);
    });

    it('never returns a negative rate', () => {
      expect(motionRate(0, SILENT, -5)).toBe(0);
    });
  });

  describe('tempoScale', () => {
    it('is 1 without a tempo lock', () => {
      expect(tempoScale(makeAudio({ bpm: 174 }))).toBe(1);
    });

    it('is 1 at the reference BPM', () => {
      expect(tempoScale(makeAudio({ tempoLocked: true, bpm: REFERENCE_BPM }))).toBe(1);
    });

    it('clamps both ends', () => {
      expect(tempoScale(makeAudio({ tempoLocked: true, bpm: 20 }))).toBe(TEMPO_SCALE_MIN);
      expect(tempoScale(makeAudio({ tempoLocked: true, bpm: 400 }))).toBe(TEMPO_SCALE_MAX);
    });
  });

  describe('createMotionClock', () => {
    it('silence advances the clock by only a few percent of real time', () => {
      const clock = createMotionClock();
      run(clock, SILENT, 10);
      // 10 秒経っても 1 秒未満しか進まない = ほとんど動かない。
      expect(clock.time).toBeLessThan(1);
      expect(clock.rate).toBeCloseTo(IDLE_MOTION_RATE, 6);
    });

    it('loud music advances it at roughly real time', () => {
      const clock = createMotionClock();
      run(clock, LOUD, 10);
      expect(clock.time).toBeGreaterThan(7);
    });

    it('is monotonic — the time never jumps backwards', () => {
      const clock = createMotionClock();
      let prev = clock.time;
      for (let i = 0; i < 600; i++) {
        // 音が付いたり消えたりしても位相は飛ばない。
        clock.advance(i % 120 < 60 ? LOUD : SILENT, 1 / 60);
        expect(clock.time).toBeGreaterThanOrEqual(prev);
        prev = clock.time;
      }
    });

    it('ramps up quickly when sound starts and coasts down after it stops', () => {
      const clock = createMotionClock();
      run(clock, LOUD, 3);
      const loudRate = clock.rate;

      clock.advance(SILENT, 0.25);
      // 0.25 秒ではまだ止まりきらない（急停止はカクつくので意図的に遅い）。
      expect(clock.rate).toBeGreaterThan(IDLE_MOTION_RATE * 2);

      run(clock, SILENT, 5);
      expect(clock.rate).toBeLessThan(loudRate * 0.1);
    });

    it('reset() returns it to the initial state', () => {
      const clock = createMotionClock();
      run(clock, LOUD, 5);
      clock.reset();
      expect(clock.time).toBe(0);
      expect(clock.energy).toBe(0);
      expect(clock.swell).toEqual({ wave: 0, group: 0, set: 0, surge: 0 });
    });
  });

  describe('the swell it owns', () => {
    const SWELL_KEYS = ['wave', 'group', 'set', 'surge'] as const;

    it('starts calm', () => {
      expect(createMotionClock().swell).toEqual({ wave: 0, group: 0, set: 0, surge: 0 });
    });

    it('advances the sea as the clock advances', () => {
      const clock = createMotionClock('tide');
      run(clock, LOUD, 120);
      // 2 分も鳴らせば海は育っている。
      expect(clock.swell.group).toBeGreaterThan(0.05);
      expect(clock.swell.surge).toBeGreaterThan(0.05);
    });

    it('leaves the sea flat in silence — every layer stays exactly 0', () => {
      const clock = createMotionClock('tide');
      for (let i = 0; i < 60 * 60; i++) {
        clock.advance(SILENT, 1 / 60);
        for (const k of SWELL_KEYS) expect(clock.swell[k]).toBe(0);
      }
    });

    it('is deterministic per seed and differs between seeds', () => {
      const sample = (seed?: string) => {
        const clock = seed === undefined ? createMotionClock() : createMotionClock(seed);
        run(clock, LOUD, 120);
        return { ...clock.swell };
      };
      expect(sample('tide')).toEqual(sample('tide'));
      expect(sample('tide')).not.toEqual(sample('reef'));
      // seed 省略でも動く（既存の呼び出しを壊さない）。
      expect(sample()).not.toEqual({ wave: 0, group: 0, set: 0, surge: 0 });
    });

    it('reseed() swaps the character without draining the sea', () => {
      const clock = createMotionClock('tide');
      run(clock, LOUD, 180);

      // 単発フレームは半波整流や Rayleigh 分布で大きくばらつくので、窓の平均で見る。
      const beforeMean = mean(collect(clock, LOUD, 30));
      const beforeSurge = clock.swell.surge;
      clock.reseed('reef');
      const afterMean = mean(collect(clock, LOUD, 30));

      // 海はそのまま。凪に戻って変調が 0 から立ち上がり直す、が起きない。
      expect(afterMean).toBeGreaterThan(beforeMean * 0.7);
      expect(afterMean).toBeLessThan(beforeMean * 1.4);
      // 溜まった水は時定数 6〜20 秒なので、差し替えの前後で連続している。
      expect(clock.swell.surge).toBeCloseTo(beforeSurge, 1);

      // それでいて波形は別物になる: 同じ seed のまま回した場合と列が食い違う。
      const kept = createMotionClock('tide');
      run(kept, LOUD, 240);
      expect(collect(clock, LOUD, 5)).not.toEqual(collect(kept, LOUD, 5));
    });

    it('pushes the clock forward but never below the idle floor', () => {
      // うねりは押す方向にしか効かない。無音で swell は 0 なので idle 相当のまま。
      const calm = { wave: 0, group: 0, set: 0, surge: 0 };
      const peak = { wave: 1, group: 1, set: 1, surge: 1 };
      expect(motionRate(0, SILENT, 1, peak)).toBeGreaterThanOrEqual(motionRate(0, SILENT, 1, calm));
      expect(motionRate(0, SILENT, 1, calm)).toBeCloseTo(IDLE_MOTION_RATE, 6);
      expect(motionRate(1, LOUD, 1, peak)).toBeGreaterThan(motionRate(1, LOUD, 1, calm));
      expect(motionRate(1, LOUD, 1, peak)).toBeCloseTo(
        motionRate(1, LOUD, 1, calm) * (1 + SWELL_PUSH),
        6,
      );
    });

    it('is driven by group/set only — the fast carrier must not jitter uTime', () => {
      const base = { wave: 0, group: 0, set: 0, surge: 0 };
      // wave / surge をどれだけ振っても速さは変わらない。
      expect(motionRate(1, LOUD, 1, { ...base, wave: 1, surge: 1 })).toBeCloseTo(
        motionRate(1, LOUD, 1, base),
        10,
      );
      // group と set は max なので、どちらか一方が立てば同じだけ押す。
      expect(motionRate(1, LOUD, 1, { ...base, group: 0.8 })).toBeCloseTo(
        motionRate(1, LOUD, 1, { ...base, set: 0.8 }),
        10,
      );
      expect(motionRate(1, LOUD, 1, { ...base, group: 0.8, set: 0.2 })).toBeCloseTo(
        motionRate(1, LOUD, 1, { ...base, group: 0.8 }),
        10,
      );
    });

    it('a swell peak cannot rescue a silent frame from the idle rate', () => {
      // gridPulse と違ってフリーホイールしないので構造的に起こり得ないが、
      // 仮に非ゼロが来ても idle の何倍にもならないことを固定しておく。
      const peak = { wave: 1, group: 1, set: 1, surge: 1 };
      expect(motionRate(0, SILENT, 1, peak)).toBeLessThan(
        IDLE_MOTION_RATE * (1 + SWELL_PUSH) * 1.01,
      );
    });
  });
});
