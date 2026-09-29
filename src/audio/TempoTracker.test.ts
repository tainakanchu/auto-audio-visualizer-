// TempoTracker の外部ビート入力（Pro DJ Link → 'link' モード）の単体テスト。
// 音声は流さず（onset 0 / level 0）、update() を 60 fps 相当で回して grid の
// 出力だけを見る。auto 検出そのもののテストはここではやらない。
import { describe, expect, it } from 'vitest';
import { LINK_TIMEOUT_MS, TempoTracker, type TempoState } from './TempoTracker';

const FRAME_MS = 1000 / 60;

function blankState(): TempoState {
  return {
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
  };
}

interface Fired {
  t: number;
  beatInBar: number;
  barCount: number;
  bar: boolean;
}

/**
 * [from, to) を 60 fps で回し、各フレームの state を観測する。
 * `beats` は外部ビートの受信時刻と bb（1..4）。受信はフレームの合間に届く扱い。
 */
function drive(
  tracker: TempoTracker,
  from: number,
  to: number,
  beats: { t: number; bpm: number; bb: number | null }[] = [],
): { fired: Fired[]; states: TempoState[] } {
  const fired: Fired[] = [];
  const states: TempoState[] = [];
  const queue = [...beats].sort((a, b) => a.t - b.t);
  for (let t = from; t < to; t += FRAME_MS) {
    while (queue.length > 0 && queue[0]!.t <= t) {
      const b = queue.shift()!;
      tracker.externalBeat(b.bpm, b.bb, b.t);
    }
    tracker.update(0, 0, t);
    const s = blankState();
    tracker.writeState(s);
    states.push(s);
    if (s.gridBeat) fired.push({ t, beatInBar: s.beatInBar, barCount: s.barCount, bar: s.gridBar });
  }
  return { fired, states };
}

/** bpm で bb 1→4 を循環させた外部ビート列（t0 から n 拍）。 */
function beatTrain(t0: number, bpm: number, n: number, firstBb = 1) {
  const period = 60000 / bpm;
  return Array.from({ length: n }, (_, i) => ({
    t: t0 + i * period,
    bpm,
    bb: ((firstBb - 1 + i) % 4) + 1,
  }));
}

function expectMonotonic(states: TempoState[]): void {
  for (let i = 1; i < states.length; i++) {
    expect(states[i]!.barCount).toBeGreaterThanOrEqual(states[i - 1]!.barCount);
  }
}

describe('TempoTracker external beats (link mode)', () => {
  it('enters link mode on the first beat: locked, confidence 1, bpm from the packet', () => {
    const tr = new TempoTracker();
    drive(tr, 0, 500);
    tr.externalBeat(128, 1, 500);
    tr.update(0, 0, 510);
    const s = blankState();
    tr.writeState(s);
    expect(s.tempoMode).toBe('link');
    expect(s.tempoLocked).toBe(true);
    expect(s.tempoConfidence).toBe(1);
    expect(s.bpm).toBe(128);
    expect(tr.linkMode).toBe(true);
  });

  it('fires one grid beat per packet, on the packet, with beatInBar matching bb', () => {
    const tr = new TempoTracker();
    const beats = beatTrain(1000, 128, 16, 3);
    const { fired, states } = drive(tr, 0, beats[15]!.t + 100, beats);
    // 1 パケット = 1 grid beat（二重発火しない・取りこぼさない）
    expect(fired).toHaveLength(16);
    for (let i = 0; i < 16; i++) {
      // パケット受信直後のフレームで発火する
      expect(fired[i]!.t - beats[i]!.t).toBeGreaterThanOrEqual(0);
      expect(fired[i]!.t - beats[i]!.t).toBeLessThan(FRAME_MS + 1e-6);
      expect(fired[i]!.beatInBar).toBe(beats[i]!.bb - 1);
      expect(fired[i]!.bar).toBe(beats[i]!.bb === 1);
    }
    expectMonotonic(states);
  });

  it('keeps freewheeling between packets (e.g. a dropped packet)', () => {
    const tr = new TempoTracker();
    const all = beatTrain(1000, 120, 8);
    const withGap = all.filter((_, i) => i !== 4); // 5 拍目のパケットが落ちた
    const { fired } = drive(tr, 0, all[7]!.t + 100, withGap);
    expect(fired).toHaveLength(8);
    // 落ちた拍も grid が自走で打ち、bb も続いている
    expect(fired[4]!.beatInBar).toBe(0);
    expect(Math.abs(fired[4]!.t - all[4]!.t)).toBeLessThan(FRAME_MS + 1);
  });

  it('does not double-fire when a packet arrives just after the grid already fired', () => {
    const tr = new TempoTracker();
    const period = 60000 / 120;
    // まず 4 拍ぶん同期させる
    const first = beatTrain(1000, 120, 4);
    drive(tr, 0, first[3]!.t + 50, first);
    // 以降のパケットは grid の拍より 30ms 遅れて届く（ネットワーク遅延）
    const late = beatTrain(1000 + 4 * period + 30, 120, 8, 1);
    const { fired, states } = drive(tr, first[3]!.t + 50, late[7]!.t + 100, late);
    expect(fired).toHaveLength(8);
    for (let i = 1; i < fired.length; i++) {
      expect(fired[i]!.t - fired[i - 1]!.t).toBeGreaterThan(period * 0.5);
    }
    expectMonotonic(states);
  });

  it('realigns the bar from an existing grid without stepping barCount backwards', () => {
    const tr = new TempoTracker();
    // 先に tap で 100 BPM の grid を走らせておく
    for (let t = 0; t <= 1800; t += 600) tr.tap(t);
    const pre = drive(tr, 0, 5000);
    const barBefore = pre.states.at(-1)!.barCount;
    // 位相も bb もずれた 128 BPM のビートが来る
    const beats = beatTrain(5123, 128, 12, 2);
    const { fired, states } = drive(tr, 5000, beats[11]!.t + 100, beats);
    expect(states[0]!.barCount).toBeGreaterThanOrEqual(barBefore);
    expectMonotonic([...pre.states, ...states]);
    expect(fired).toHaveLength(12);
    fired.forEach((f, i) => expect(f.beatInBar).toBe(beats[i]!.bb - 1));
  });

  it('leaves link 3 s after the last packet and returns to the previous mode (auto)', () => {
    const tr = new TempoTracker();
    const beats = beatTrain(1000, 128, 4);
    const last = beats[3]!.t;
    const { states } = drive(tr, 0, last + LINK_TIMEOUT_MS + 200, beats);
    // drive() は t=0 から FRAME_MS 刻みなので、index i のフレーム時刻は i * FRAME_MS。
    const during = states.filter((_, i) => i * FRAME_MS <= last + LINK_TIMEOUT_MS - 50).at(-1)!;
    expect(during.tempoMode).toBe('link');
    const after = states.at(-1)!;
    expect(after.tempoMode).toBe('auto');
    // auto はまだ何も検出していないので bpm 0（grid は休む）
    expect(after.bpm).toBe(0);
    expect(after.tempoLocked).toBe(false);
    expectMonotonic(states);
  });

  it('returns to manual (tap) mode, continuing from link phase, when link was entered from manual', () => {
    const tr = new TempoTracker();
    for (let t = 0; t <= 1500; t += 500) tr.tap(t); // 120 BPM
    drive(tr, 0, 2000);
    const beats = beatTrain(2000, 128, 4);
    const { states } = drive(tr, 2000, beats[3]!.t + LINK_TIMEOUT_MS + 200, beats);
    const after = states.at(-1)!;
    expect(after.tempoMode).toBe('manual');
    expect(after.bpm).toBeCloseTo(120, 6);
    expect(after.tempoLocked).toBe(true);
  });

  it('link has priority over tap / multiply / setAuto; they apply after link ends', () => {
    const tr = new TempoTracker();
    const beats = beatTrain(1000, 128, 20);
    const { states } = drive(tr, 0, beats[4]!.t + 10, beats.slice(0, 5));
    // link 中に 100 BPM で tap、×2
    for (let t = 0; t < 4; t++) tr.tap(beats[4]!.t + 20 + t * 600);
    tr.multiply(2);
    const rest = drive(tr, beats[4]!.t + 10, beats[19]!.t + 100, beats.slice(5));
    // link 中は tap も multiplier も grid に効かない
    for (const s of rest.states) {
      expect(s.tempoMode).toBe('link');
      expect(s.bpm).toBe(128);
    }
    expect(rest.fired).toHaveLength(15);
    rest.fired.forEach((f, i) => {
      expect(f.beatInBar).toBe(beats[i + 5]!.bb - 1);
      // tap が grid を掴み直していない（発火はパケット直後のフレームのまま）
      expect(f.t - beats[i + 5]!.t).toBeGreaterThanOrEqual(0);
      expect(f.t - beats[i + 5]!.t).toBeLessThan(FRAME_MS + 1e-6);
    });
    // link が切れると tap の 100 BPM × 2 に戻る
    const after = drive(tr, beats[19]!.t + 100, beats[19]!.t + LINK_TIMEOUT_MS + 300);
    const last = after.states.at(-1)!;
    expect(last.tempoMode).toBe('manual');
    expect(last.bpm).toBeCloseTo(200, 6);
    expectMonotonic([...states, ...rest.states, ...after.states]);
  });

  it('a tap during link does not re-anchor the freewheeling grid', () => {
    const tr = new TempoTracker();
    const beats = beatTrain(1000, 128, 8);
    // 5 拍目まで受けたあと 2 拍ぶんパケットが落ちる（link は継続）
    drive(tr, 0, beats[4]!.t + 50, beats.slice(0, 5));
    tr.tap(beats[4]!.t + 100);
    tr.tap(beats[4]!.t + 200);
    const { fired } = drive(tr, beats[4]!.t + 50, beats[6]!.t + 100);
    // 自走した拍は tap 時刻ではなく、パケット由来の位相のまま
    expect(fired).toHaveLength(2);
    fired.forEach((f, i) => expect(Math.abs(f.t - beats[i + 5]!.t)).toBeLessThan(FRAME_MS + 1));
  });

  it('setAuto during link only changes the fallback mode', () => {
    const tr = new TempoTracker();
    for (let t = 0; t <= 1500; t += 500) tr.tap(t);
    const beats = beatTrain(2000, 128, 3);
    drive(tr, 0, beats[2]!.t + 10, beats);
    tr.setAuto();
    const s = blankState();
    tr.writeState(s);
    expect(s.tempoMode).toBe('link');
    const after = drive(tr, beats[2]!.t + 10, beats[2]!.t + LINK_TIMEOUT_MS + 200);
    expect(after.states.at(-1)!.tempoMode).toBe('auto');
  });

  it('follows a tempo change from the packets', () => {
    const tr = new TempoTracker();
    const a = beatTrain(1000, 120, 4);
    const b = beatTrain(a[3]!.t + 500, 130, 4, 1);
    const { fired, states } = drive(tr, 0, b[3]!.t + 100, [...a, ...b]);
    expect(fired).toHaveLength(8);
    expect(states.at(-1)!.bpm).toBe(130);
  });

  it('ignores invalid BPMs and bar-aligns only on a valid beatInBar', () => {
    const tr = new TempoTracker();
    tr.externalBeat(Number.NaN, 1, 100);
    tr.externalBeat(0, 1, 100);
    tr.externalBeat(1000, 1, 100);
    expect(tr.linkMode).toBe(false);
    // bb 不明でも位相は合わせる
    const beats = beatTrain(1000, 128, 4).map((x) => ({ ...x, bb: null }));
    const { fired } = drive(tr, 0, beats[3]!.t + 100, beats);
    expect(fired).toHaveLength(4);
  });
});
