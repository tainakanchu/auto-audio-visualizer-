/**
 * 音に駆動される「動きの時計」。
 *
 * Semantic Synth の Generator の大半（106 個中 60 個）は `uTime` を直接読んで
 * 動く。`uTime` に実時間をそのまま流すと、**無音でもフル速度で動き続ける**ので
 * 「音と関係なくギュインギュイン動く」ことになる。ここではその `uTime` を実時間
 * から切り離し、音のエネルギーで進む速さが変わる時計にする。
 *
 * - 無音: {@link IDLE_MOTION_RATE}（通常の数 %）まで落ちる = ほぼ止まる
 * - 音が鳴っている: ほぼ等速。ビートで少しだけ前に押される
 * - テンポがロックしていれば BPM で全体の速さがスケールする
 *
 * 時計は**累積**なので、速さが変わっても位相は飛ばない（`t * rate` にすると
 * rate が変わった瞬間に画が飛ぶ）。トランジション / Timeline は実時間のままで、
 * この時計は描画の見た目だけに効く。
 */
import type { AudioFrame } from '../audio/types';
import { smoothK } from './modulation';

/** 無音時に残す時間の進み（1 = 通常速度）。0 にしないのは完全静止が死んで見えるから。 */
export const IDLE_MOTION_RATE = 0.05;

/**
 * これ以下のエネルギーは「無音」として捨てるノイズゲート。
 * マイク入力は環境ノイズで常に 0 より上に浮くので、これが無いと無音判定が効かない。
 */
export const NOISE_FLOOR = 0.05;

/**
 * エネルギー → 速さ のカーブ指数。1 より大きいほど、小さい音での動きが大人しくなる。
 * 「音が小さいときは本当に少ししか動かない」を線形より強く出すため 1 超に置く。
 */
export const MOTION_CURVE = 1.5;

/** ビートパルスが速さを押し上げる最大割合（0.3 = 拍の頭で +30%）。 */
export const BEAT_PUSH = 0.3;

/** テンポスケールの基準 BPM。この BPM のとき等倍。 */
export const REFERENCE_BPM = 120;
/** テンポスケールの下限 / 上限。速い曲でも青天井にはしない。 */
export const TEMPO_SCALE_MIN = 0.7;
export const TEMPO_SCALE_MAX = 1.25;

/** エネルギー平滑の時定数（秒）。立ち上がりは速く、立ち下がりはゆっくり。 */
export const ATTACK_TAU = 0.15;
/**
 * 立ち下がりを長めに取るのは、拍ごとに速さが上下すると動きがカクつくため。
 * ブレイクに入ってから静止するまでが 1 秒弱、という体感になる。
 */
export const RELEASE_TAU = 0.8;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * AudioFrame から 0..1 のエネルギーを取り出す。
 *
 * `level` は RMS なので帯域平均（bass/mid/treble）より一桁小さい。同じ土俵に
 * 載せるため係数で持ち上げてから max を取る。エンジンは停止中に全帯域を 0 に
 * するので、マイク未許可でも自然に無音側へ落ちる。
 */
export function audioEnergy(audio: AudioFrame): number {
  const raw = Math.max(audio.level * 2.5, audio.bass, audio.mid * 0.9, audio.treble * 0.75);
  return clamp01((raw - NOISE_FLOOR) / (1 - NOISE_FLOOR));
}

/** テンポがロックしていれば BPM 比、していなければ 1。 */
export function tempoScale(audio: AudioFrame): number {
  if (!audio.tempoLocked || !(audio.bpm > 0)) return 1;
  const ratio = audio.bpm / REFERENCE_BPM;
  return Math.min(TEMPO_SCALE_MAX, Math.max(TEMPO_SCALE_MIN, ratio));
}

/**
 * 平滑済みエネルギーから、この瞬間の時間の進む速さを決める。
 *
 * `patchSpeed` は Patch の `composition.speed`（Patch ごとの動きの速さ）。
 * ビート押し上げは `shaped` を掛けてあるので、無音のときはビートグリッドが
 * フリーホイールしていても速さは動かない。
 */
export function motionRate(energy: number, audio: AudioFrame, patchSpeed = 1): number {
  const shaped = Math.pow(clamp01(energy), MOTION_CURVE);
  const gate = IDLE_MOTION_RATE + (1 - IDLE_MOTION_RATE) * shaped;
  const pulse = audio.tempoLocked ? audio.gridPulse : audio.beatIntensity;
  const push = 1 + BEAT_PUSH * clamp01(pulse) * shaped;
  return gate * push * tempoScale(audio) * Math.max(0, patchSpeed);
}

export interface MotionClock {
  /** 1 フレーム進めて、シェーダに渡す時刻（秒）を返す。 */
  advance(audio: AudioFrame, dt: number, patchSpeed?: number): number;
  /** 現在の時刻（秒）。 */
  readonly time: number;
  /** 直近フレームの進む速さ（1 = 通常速度）。 */
  readonly rate: number;
  /** 直近フレームの平滑済みエネルギー 0..1。ビート表現のゲートにも使う。 */
  readonly energy: number;
  /** 時刻とエネルギーを初期状態に戻す。 */
  reset(): void;
}

/** {@link MotionClock} を作る。状態は呼び出し側が持つ（シーンごとに 1 本）。 */
export function createMotionClock(): MotionClock {
  let time = 0;
  let energy = 0;
  let rate = IDLE_MOTION_RATE;

  return {
    advance(audio: AudioFrame, dt: number, patchSpeed = 1): number {
      const target = audioEnergy(audio);
      // 非対称平滑: 音が入った瞬間は素早く動き出し、止んだあとはゆっくり止まる。
      const tau = target > energy ? ATTACK_TAU : RELEASE_TAU;
      energy += smoothK(dt, tau) * (target - energy);
      rate = motionRate(energy, audio, patchSpeed);
      time += dt * rate;
      return time;
    },
    get time() {
      return time;
    },
    get rate() {
      return rate;
    },
    get energy() {
      return energy;
    },
    reset(): void {
      time = 0;
      energy = 0;
      rate = IDLE_MOTION_RATE;
    },
  };
}
