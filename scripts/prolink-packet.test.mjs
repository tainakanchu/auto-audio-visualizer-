// prolink-packet.mjs の純粋関数（パース・生成・デバイス選択）の単体テスト。
// UDP / WebSocket は立てない。ソケットを含む結合は `pnpm prolink` + `pnpm prolink:sim`
// を使った手動の統合検証で担保する（vj-bridge と同じ方針）。
import { describe, expect, it } from 'vitest';
import {
  BEAT_PACKET_LENGTH,
  DEVICE_STALE_MS,
  buildBeatPacket,
  initialSelection,
  parseBeatPacket,
  pitchPercentFromRaw,
  pitchRawFromPercent,
  selectBeat,
  toBeatMessage,
} from './prolink-packet.mjs';

/**
 * 資料（djl-analysis "Beat Packets"）の図をそのまま 16 バイトずつ書き起こした
 * フィクスチャ。buildBeatPacket を使わずに組むことで、生成とパースが同じ誤りを
 * 共有していても検出できるようにする。
 *   device 2 "CDJ-3000", track 128.00 BPM, pitch +2%（raw 0x1051ec）, bb=3
 */
const FIXTURE_HEX = [
  // 0x00: magic "Qspt1WmJOL" / type 0x28 / name 先頭 "CDJ-3"
  '51 73 70 74 31 57 6d 4a 4f 4c 28 43 44 4a 2d 33',
  // 0x10: name 続き "000" + NUL 埋め、0x1f = 01
  '30 30 30 00 00 00 00 00 00 00 00 00 00 00 00 01',
  // 0x20: subtype 00, D=02, len_r=003c, nextBeat=469 (0x1d5), 2ndBeat=938 (0x3aa), nextBar=938
  '00 02 00 3c 00 00 01 d5 00 00 03 aa 00 00 03 aa',
  // 0x30: 4thBeat=1875 (0x753), 2ndBar=2813 (0xafd), 8thBeat=3750 (0xea6), ff…
  '00 00 07 53 00 00 0a fd 00 00 0e a6 ff ff ff ff',
  // 0x40
  'ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff',
  // 0x50: ff ×4, pitch 00 10 51 ec, 00 00, BPM 0x3200 (12800), bb=3, 00 00, D=02
  'ff ff ff ff 00 10 51 ec 00 00 32 00 03 00 00 02',
].join(' ');

function fixture() {
  return Buffer.from(FIXTURE_HEX.replace(/\s+/g, ''), 'hex');
}

describe('parseBeatPacket', () => {
  it('reads a hand-written fixture of the documented layout', () => {
    const buf = fixture();
    expect(buf.length).toBe(BEAT_PACKET_LENGTH);
    const b = parseBeatPacket(buf);
    expect(b).not.toBeNull();
    expect(b.device).toBe(2);
    expect(b.name).toBe('CDJ-3000');
    expect(b.subtype).toBe(0);
    expect(b.nextBeatMs).toBe(469);
    expect(b.secondBeatMs).toBe(938);
    expect(b.nextBarMs).toBe(938);
    expect(b.fourthBeatMs).toBe(1875);
    expect(b.secondBarMs).toBe(2813);
    expect(b.eighthBeatMs).toBe(3750);
    expect(b.trackBpm).toBe(128);
    expect(b.pitch).toBeCloseTo(2, 3);
    expect(b.bpm).toBeCloseTo(128 * 1.02, 2);
    expect(b.beatInBar).toBe(3);
  });

  it('returns null for packets shorter than 0x60', () => {
    expect(parseBeatPacket(fixture().subarray(0, 0x5f))).toBeNull();
    expect(parseBeatPacket(Buffer.alloc(0))).toBeNull();
  });

  it('returns null when the magic does not match', () => {
    const buf = fixture();
    buf[0] = 0x52;
    expect(parseBeatPacket(buf)).toBeNull();
  });

  it('returns null for other packet types on port 50001', () => {
    const buf = fixture();
    buf[0x0a] = 0x0b; // CDJ-3000 の絶対位置パケットなど
    expect(parseBeatPacket(buf)).toBeNull();
  });

  it('returns null for non-Buffer input', () => {
    expect(parseBeatPacket(null)).toBeNull();
    expect(parseBeatPacket('Qspt1WmJOL')).toBeNull();
  });

  it('maps 0xffffffff timings to null and 0xffff BPM to null', () => {
    const buf = fixture();
    buf.writeUInt32BE(0xffffffff, 0x2c);
    buf.writeUInt16BE(0xffff, 0x5a);
    const b = parseBeatPacket(buf);
    expect(b.nextBarMs).toBeNull();
    expect(b.trackBpm).toBeNull();
    expect(b.bpm).toBeNull();
    expect(toBeatMessage(b)).toBeNull();
  });

  it('treats an out-of-range beat-in-bar as null', () => {
    const buf = fixture();
    buf[0x5c] = 0;
    expect(parseBeatPacket(buf).beatInBar).toBeNull();
  });
});

describe('pitch encoding', () => {
  it('0x100000 is ±0%, 0 is -100%, 0x200000 is +100%', () => {
    expect(pitchPercentFromRaw(0x100000)).toBe(0);
    expect(pitchPercentFromRaw(0)).toBe(-100);
    expect(pitchPercentFromRaw(0x200000)).toBe(100);
    expect(pitchPercentFromRaw(0x100000 - 0x100000 * 0.08)).toBeCloseTo(-8, 6);
  });

  it('round-trips through pitchRawFromPercent', () => {
    for (const p of [-16, -6, -0.5, 0, 0.02, 3.3, 10]) {
      expect(pitchPercentFromRaw(pitchRawFromPercent(p))).toBeCloseTo(p, 3);
    }
  });
});

describe('buildBeatPacket → parseBeatPacket round trip', () => {
  it('matches the hand-written fixture byte for byte for the same inputs', () => {
    // フィクスチャのタイミング欄は 60000/128 を丸めた値の倍数ではないので比較対象から外し、
    // それ以外（ヘッダ・pitch・BPM・bb・D）が一致することを見る。
    const built = buildBeatPacket({
      device: 2,
      name: 'CDJ-3000',
      bpm: 128,
      pitch: 2,
      beatInBar: 3,
    });
    const fx = fixture();
    expect(built.length).toBe(fx.length);
    expect(built.subarray(0, 0x24)).toEqual(fx.subarray(0, 0x24));
    expect(built.subarray(0x3c, 0x60)).toEqual(fx.subarray(0x3c, 0x60));
  });

  it('round-trips device / name / bpm / pitch / beatInBar', () => {
    for (const bb of [1, 2, 3, 4]) {
      const b = parseBeatPacket(
        buildBeatPacket({ device: 3, name: 'CDJ-SIM', bpm: 174.5, pitch: -4, beatInBar: bb }),
      );
      expect(b.device).toBe(3);
      expect(b.name).toBe('CDJ-SIM');
      expect(b.trackBpm).toBe(174.5);
      expect(b.pitch).toBeCloseTo(-4, 3);
      expect(b.bpm).toBeCloseTo(174.5 * 0.96, 2);
      expect(b.beatInBar).toBe(bb);
      // タイミング欄は pitch 0% 換算（実機と同じ）
      expect(b.nextBeatMs).toBe(Math.round(60000 / 174.5));
      expect(b.nextBarMs).toBe(Math.round(60000 / 174.5) * (5 - bb));
    }
  });

  it('truncates names longer than the 20-byte field', () => {
    const b = parseBeatPacket(buildBeatPacket({ name: 'X'.repeat(40) }));
    expect(b.name).toBe('X'.repeat(20));
  });
});

describe('toBeatMessage', () => {
  it('builds the browser JSON and scales nextBeatMs by pitch', () => {
    const msg = toBeatMessage(parseBeatPacket(fixture()));
    expect(msg).toEqual({
      type: 'beat',
      bpm: expect.closeTo(130.56, 2),
      trackBpm: 128,
      pitch: expect.closeTo(2, 3),
      beatInBar: 3,
      nextBeatMs: Math.round(469 / 1.02),
      device: 2,
      name: 'CDJ-3000',
    });
    // JSON 化できる（Buffer などが混ざっていない）
    expect(JSON.parse(JSON.stringify(msg)).type).toBe('beat');
  });
});

describe('selectBeat', () => {
  /** [device, t] の列を流して、採用されたビートの device 列を返す。 */
  function run(events, fixed = null) {
    let s = initialSelection();
    const accepted = [];
    for (const [device, t] of events) {
      const r = selectBeat(s, device, t, fixed);
      s = r.state;
      if (r.accept) accepted.push(device);
    }
    return accepted;
  }

  it('follows the first device that sends beats', () => {
    expect(
      run([
        [1, 0],
        [2, 100],
        [1, 470],
        [2, 570],
      ]),
    ).toEqual([1, 1]);
  });

  it('switches to the next sender once the followed device is silent for 2 s', () => {
    expect(
      run([
        [1, 0],
        [2, 100],
        [2, 1000],
        [2, DEVICE_STALE_MS - 1], // 1 はまだ生きている扱い
        [2, DEVICE_STALE_MS + 10], // 1 が 2 秒以上黙った → 2 へ
        [1, DEVICE_STALE_MS + 100], // 1 が戻っても 2 が生きている間は 2 のまま
        [2, DEVICE_STALE_MS + 500],
      ]),
    ).toEqual([1, 2, 2]);
  });

  it('prefers the mixer (device >= 0x21) while it is sending', () => {
    expect(
      run([
        [1, 0],
        [33, 10],
        [1, 470],
        [33, 480],
      ]),
    ).toEqual([1, 33, 33]);
  });

  it('falls back to a player when the mixer stops', () => {
    expect(
      run([
        [33, 0],
        [1, 10],
        [1, DEVICE_STALE_MS + 10],
      ]),
    ).toEqual([33, 1]);
  });

  it('only accepts the fixed device when --device is given', () => {
    expect(
      run(
        [
          [1, 0],
          [33, 10],
          [2, 20],
          [2, 5000],
          [1, 9000],
        ],
        2,
      ),
    ).toEqual([2, 2]);
  });

  it('does not mutate the previous state', () => {
    const s0 = initialSelection();
    selectBeat(s0, 1, 0);
    expect(s0).toEqual({ current: null, lastSeen: {} });
  });
});
