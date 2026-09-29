/**
 * prolink-packet — Pro DJ Link のビートパケット（port 50001 / type 0x28）の
 * パース・生成と、追従デバイスの選択ロジック。
 *
 * ソケットを一切触らない純粋関数だけを置く。prolink-bridge.mjs（受信）と
 * prolink-sim.mjs（送信シミュレータ）の両方がここを使い、テストは実ネットワーク
 * 無しで scripts/prolink-packet.test.mjs から叩く。
 *
 * レイアウトの一次資料: Deep Symmetry "DJ Link Ecosystem Analysis" の Beat Packets 節
 * https://djl-analysis.deepsymmetry.org/djl-analysis/beats.html
 * （2026-09-29 に取得して照合済み。オフセットは下の定数を参照）
 */

/** ビートパケットが流れる UDP ポート。 */
export const PROLINK_BEAT_PORT = 50001;

/**
 * ブラウザ向け WebSocket の既定ポート。src/audio/linkClient.ts の
 * DEFAULT_LINK_PORT と揃えること（scripts/constants-drift.test.mjs が検査する）。
 * vj-bridge の 7877 とは別ポートにして、両方を同時に起動できるようにしている。
 */
export const DEFAULT_LINK_WS_PORT = 7878;

/** 全 Pro DJ Link パケット共通の先頭 10 バイト（"Qspt1WmJOL"）。 */
export const MAGIC = Buffer.from('Qspt1WmJOL', 'ascii');

export const BEAT_PACKET_TYPE = 0x28;
/** 0x24 から len_r（= 0x3c）バイトが続くので全長は 0x60 = 96 バイト。 */
export const BEAT_PACKET_LENGTH = 0x60;

/** ミキサー（DJM）の device number。資料上は 0x21 固定。 */
export const MIXER_DEVICE_NUMBER = 0x21;

/** pitch フィールドで ±0% を表す値。0 = -100%、0x200000 = +100%。 */
export const PITCH_NORMAL = 0x100000;

/** タイミング欄で「曲がその拍より前に終わる」ことを示す値。 */
const NO_BEAT = 0xffffffff;

// ---- オフセット（資料の表記どおり hex） ----
const OFF_TYPE = 0x0a;
const OFF_NAME = 0x0b;
const NAME_LENGTH = 0x14; // 0x0b..0x1e。0x1f は常に 0x01
const OFF_SUBTYPE = 0x20;
const OFF_DEVICE = 0x21;
const OFF_LEN_R = 0x22;
const OFF_NEXT_BEAT = 0x24; // 以降 2ndBeat / nextBar / 4thBeat / 2ndBar / 8thBeat が u32 BE で続く
const OFF_PITCH = 0x54; // u32 BE。上位バイトは常に 0 なので実質 0x55-0x57 の u24
const OFF_BPM = 0x5a; // u16 BE、track BPM × 100
const OFF_BEAT_IN_BAR = 0x5c; // 1..4
const OFF_DEVICE_COPY = 0x5f; // D の冗長コピー

/** raw pitch 値 → パーセント（0x100000 = 0%）。 */
export function pitchPercentFromRaw(raw) {
  return ((raw - PITCH_NORMAL) / PITCH_NORMAL) * 100;
}

/** パーセント → raw pitch 値（シミュレータ用。0..0x200000 に丸める）。 */
export function pitchRawFromPercent(percent) {
  const raw = Math.round(PITCH_NORMAL + (percent / 100) * PITCH_NORMAL);
  return Math.max(0, Math.min(PITCH_NORMAL * 2, raw));
}

function readTiming(buf, offset) {
  const v = buf.readUInt32BE(offset);
  return v === NO_BEAT ? null : v;
}

/**
 * UDP ペイロード 1 件をビートパケットとして読む。ビートパケットでなければ null。
 *
 * port 50001 には 0x28 以外（on-air 通知の短いパケット、CDJ-3000 の絶対位置
 * パケットなど）も流れるので、長さ・magic・type のどれかが違えば黙って null。
 *
 * タイミング欄（nextBeatMs など）は資料どおり「pitch 0% 換算の値」をそのまま返す。
 * 実時間に直すのは呼び出し側（{@link toBeatMessage}）の仕事。
 * track BPM が 0xffff（不明）のときは trackBpm / bpm を null にする。
 */
export function parseBeatPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < BEAT_PACKET_LENGTH) return null;
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  if (buf[OFF_TYPE] !== BEAT_PACKET_TYPE) return null;

  const nameRaw = buf.subarray(OFF_NAME, OFF_NAME + NAME_LENGTH);
  const nul = nameRaw.indexOf(0);
  const name = nameRaw
    .subarray(0, nul < 0 ? nameRaw.length : nul)
    .toString('ascii')
    .trim();

  const pitchRaw = buf.readUInt32BE(OFF_PITCH);
  const pitch = pitchPercentFromRaw(pitchRaw);
  const bpmRaw = buf.readUInt16BE(OFF_BPM);
  const trackBpm = bpmRaw === 0xffff ? null : bpmRaw / 100;
  const bb = buf[OFF_BEAT_IN_BAR];

  return {
    device: buf[OFF_DEVICE],
    name,
    subtype: buf[OFF_SUBTYPE],
    nextBeatMs: readTiming(buf, OFF_NEXT_BEAT),
    secondBeatMs: readTiming(buf, OFF_NEXT_BEAT + 4),
    nextBarMs: readTiming(buf, OFF_NEXT_BEAT + 8),
    fourthBeatMs: readTiming(buf, OFF_NEXT_BEAT + 12),
    secondBarMs: readTiming(buf, OFF_NEXT_BEAT + 16),
    eighthBeatMs: readTiming(buf, OFF_NEXT_BEAT + 20),
    pitch,
    trackBpm,
    // effective BPM = track BPM × (1 + pitch/100)。ミキサーは pitch 常に 0% で、
    // master の BPM をそのまま流す（資料の脚注）ので同じ式で問題ない。
    bpm: trackBpm === null ? null : trackBpm * (1 + pitch / 100),
    beatInBar: bb >= 1 && bb <= 4 ? bb : null,
  };
}

/**
 * ビートパケットを組み立てる（シミュレータとテストの往復用）。
 * nextBeatMs 以降のタイミング欄は pitch 0% 換算で書く（実機と同じ）。
 */
export function buildBeatPacket({
  device = 1,
  name = 'CDJ-SIM',
  bpm = 128,
  pitch = 0,
  beatInBar = 1,
} = {}) {
  const buf = Buffer.alloc(BEAT_PACKET_LENGTH, 0);
  MAGIC.copy(buf, 0);
  buf[OFF_TYPE] = BEAT_PACKET_TYPE;
  buf.write(String(name).slice(0, NAME_LENGTH), OFF_NAME, 'ascii');
  buf[0x1f] = 0x01;
  buf[OFF_SUBTYPE] = 0x00;
  buf[OFF_DEVICE] = device;
  buf.writeUInt16BE(BEAT_PACKET_LENGTH - OFF_NEXT_BEAT, OFF_LEN_R);

  // タイミングは track BPM（pitch 0%）基準の拍長で書く。
  const beatMs = Math.round(60000 / bpm);
  const beatsToNextBar = 5 - beatInBar; // bb=1 なら次の小節頭まで 4 拍
  const timings = [
    beatMs,
    beatMs * 2,
    beatMs * beatsToNextBar,
    beatMs * 4,
    beatMs * (beatsToNextBar + 4),
    beatMs * 8,
  ];
  timings.forEach((ms, i) => buf.writeUInt32BE(ms, OFF_NEXT_BEAT + i * 4));
  // 0x3c..0x53 は実機では 0xff 埋め。
  buf.fill(0xff, 0x3c, OFF_PITCH);

  buf.writeUInt32BE(pitchRawFromPercent(pitch), OFF_PITCH);
  buf.writeUInt16BE(Math.round(bpm * 100), OFF_BPM);
  buf[OFF_BEAT_IN_BAR] = beatInBar;
  buf[OFF_DEVICE_COPY] = device;
  return buf;
}

/**
 * パース結果 → ブラウザへ送る JSON（オブジェクト）。送る価値が無ければ null。
 *
 * nextBeatMs はパケット上は pitch 0% 換算なので、ここで実時間に直して送る。
 * 時刻そのものは送らない（Node とブラウザの時計は揃っていない前提で、ブラウザ
 * 側は受信時刻を拍の時刻として使う）。
 */
export function toBeatMessage(beat) {
  if (!beat || beat.bpm === null || !(beat.bpm > 0) || !Number.isFinite(beat.bpm)) return null;
  const speed = 1 + beat.pitch / 100;
  return {
    type: 'beat',
    bpm: beat.bpm,
    trackBpm: beat.trackBpm,
    pitch: beat.pitch,
    beatInBar: beat.beatInBar,
    nextBeatMs:
      beat.nextBeatMs === null || !(speed > 0) ? null : Math.round(beat.nextBeatMs / speed),
    device: beat.device,
    name: beat.name,
  };
}

// ---------------------------------------------------------------------------
// どのデバイスに追従するか
// ---------------------------------------------------------------------------

/** 追従中のデバイスからこれだけ来なければ「止まった」とみなして乗り換える。 */
export const DEVICE_STALE_MS = 2000;

/** 選択状態の初期値。state は呼び出し側が持ち回す（関数は state を壊さない）。 */
export function initialSelection() {
  return { current: null, lastSeen: {} };
}

/**
 * ビート 1 件ごとに「このビートを採用するか」と次の state を決める。
 *
 * 規則:
 * 1. `fixedDevice` 指定があれば、そのデバイスのビートだけを採用する。
 * 2. ミキサー（device >= 0x21）のビートが直近 {@link DEVICE_STALE_MS} 以内に来ていれば
 *    ミキサーを優先する。資料によるとミキサーは master プレーヤーの BPM を
 *    pitch 0% で中継し、何も再生していなくても「予備のメトロノーム」として常に
 *    流す。master 追従に一番近いのでこれを優先する。ただし DJM がどの機種・設定で
 *    ビートを流すかは実機で確認していない（未確認）。
 * 3. それ以外は、いま追従しているデバイスが生きていればそれを続け、
 *    {@link DEVICE_STALE_MS} 以上来なくなったら、次にビートを送ってきたデバイスへ
 *    乗り換える（CDJ は再生中にしかビートを送らないため、止めたプレーヤーから
 *    再生中のプレーヤーへ自然に移る）。
 *
 * rekordbox（PC）の device number も 0x21 以上になりうるが、区別する手段が
 * ビートパケットには無いので同じくミキサー扱いになる（これも実機未確認）。
 */
export function selectBeat(state, device, nowMs, fixedDevice = null) {
  const lastSeen = { ...state.lastSeen, [device]: nowMs };

  if (fixedDevice !== null) {
    const accept = device === fixedDevice;
    return { accept, state: { current: fixedDevice, lastSeen } };
  }

  const alive = (d) =>
    d !== null && lastSeen[d] !== undefined && nowMs - lastSeen[d] < DEVICE_STALE_MS;
  const isMixer = (d) => d >= MIXER_DEVICE_NUMBER;

  let current = state.current;
  if (isMixer(device)) {
    // ミキサーは来た時点で最優先。
    current = device;
  } else if (!alive(current)) {
    // 追従先が未定 / 止まった（ミキサーが止まった場合も含む）ときだけ乗り換える。
    // alive(current) は current !== device なら前回の受信時刻で判定される。
    current = device;
  }

  return { accept: device === current, state: { current, lastSeen } };
}
