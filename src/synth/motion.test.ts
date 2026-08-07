import { describe, expect, it } from 'vitest';
import type { AudioFrame } from '../audio/types';
import {
  audioEnergy,
  createMotionClock,
  IDLE_MOTION_RATE,
  motionRate,
  REFERENCE_BPM,
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
    });
  });
});
