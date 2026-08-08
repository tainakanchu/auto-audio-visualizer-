/**
 * 海岸の波の「階層」を作る時計。
 *
 * `motion.ts` が音のエネルギーで**時間の進む速さ**を決めるのに対し、こちらは
 * 音のエネルギーを**風速**とみなして、海面のうねりを丸ごと 1 つ生やす。出るのは
 * 4 本の 0..1 で、いずれも時間軸の変調源として使う想定:
 *
 * - {@link SwellState.wave}  個々の波の峰      … 数秒オーダー
 * - {@link SwellState.group} 波群（セットの塊）… 数十秒オーダー
 * - {@link SwellState.set}   infragravity      … 数十〜百秒オーダー
 * - {@link SwellState.surge} 岸に溜まった水    … 満ち引きのようにゆっくり
 *
 * 肝は、この階層を**定数で書いていない**こと。「10 波に 1 回大きいのが来る」を
 * `if (n % 10 === 0)` で書くと 10 波周期がそのまま画に出て、すぐ読まれてしまう。
 * ここでは JONSWAP スペクトルを 16 本の正弦波でサンプリングし、その解析信号を
 * 取るだけで、近接周波数の干渉から波群が自動的に**創発**する。さらにその波群が
 * 減衰 2 次振動子（infragravity）を叩き、その振動子がまた岸の水位を上下させる。
 * どの層の周期も「上の層の物理」から落ちてくるので、数字を書かずに階層になる。
 *
 * `motion.ts` と共通する思想が 2 つある:
 *
 * 1. **時計は累積**。ピーク周波数 fp は海が育つと下がる（波が長くなる）ので、
 *    位相を `2*PI*f*t` で作ると fp が動いた瞬間に位相が飛んで画がジャンプする。
 *    各成分の位相は必ず加算で進める。
 * 2. **非対称平滑**。`motion.ts` の `ATTACK_TAU`/`RELEASE_TAU` と同じことを、
 *    2 階層上の時定数（秒→十秒）でやっているだけ。海は育つより凪ぐ方が遅いので、
 *    ドロップの後に遅れてうねりが来て、ブレイク後も余韻が残る。
 *
 * 出力は全て unipolar 0..1 で、**無音では必ず 0 に落ちる**。このリポジトリは
 * 「音で画が消えることはない」を `derive.ts` の polarity 固定と `validate.ts` の
 * 許可リストで構造的に守っているので、無音時に定数オフセットが乗る出力は作らない。
 */
import { smoothK } from './modulation';
import { rand } from './rng';

const TWO_PI = Math.PI * 2;

/** スペクトルをサンプリングする成分数。増やすほど滑らかだが 1 フレームの三角関数も増える。 */
export const SPECTRUM_BINS = 16;

/**
 * 成分を置く周波数レンジ（ピーク周波数 fp に対する倍率）。
 *
 * ここが波群の周期を決める唯一のつまみ。帯域が広いほど遠く離れた成分どうしが
 * 速く唸るので包絡線がガタつき、「群」に見えなくなる。うねり（swell）は遠方の
 * 低気圧から分散しながら届く過程で狭帯域化した波なので、風波そのままの広い帯域
 * （0.6〜2.2 fp あたり）ではなく、この狭さが正しい。
 *
 * 実測: 0.6〜2.2（教科書どおりの風波帯域）だと 1 群あたり約 3 波にしかならず、
 * 階層に見えない。この帯域なら 1 群あたり約 6 波、つまり「10 波に 1 回」のオーダーになる。
 */
export const SPECTRUM_RATIO_MIN = 0.85;
export const SPECTRUM_RATIO_MAX = 1.35;

/**
 * 等間隔配置に載せるジッタ量（成分間隔に対する比）。
 *
 * 完全な等間隔だと 16 成分の合成が短い周期で厳密に再帰し、うねりが規則的に
 * 見えてしまう。seed 決定的にずらして、再帰周期を実用上無限に飛ばす。
 */
export const SPECTRUM_JITTER = 0.4;

/** JONSWAP のピーク増幅係数。1 で Pierson-Moskowitz（純粋な風波）。 */
export const JONSWAP_GAMMA = 3.3;
/** ピーク増幅の幅。慣例どおり低周波側と高周波側で非対称。 */
export const JONSWAP_SIGMA_LOW = 0.07;
export const JONSWAP_SIGMA_HIGH = 0.09;

/**
 * 風速 → 有義波高の指数。風波の成長は線形ではないので 1 より大きく取る。
 * 小さい音のときに海が立たない（= 画が静かなまま）のはこの指数のおかげ。
 */
export const WIND_TO_HEIGHT_EXP = 1.5;

/**
 * 海の記憶の時定数（秒）。**減衰の方を長くするのが肝**。
 *
 * `motion.ts` の `ATTACK_TAU = 0.15` / `RELEASE_TAU = 0.8` と全く同じ非対称平滑を、
 * 2 階層上の時定数でやっている。音が入っても海はすぐには立たず（= ドロップの
 * 後から遅れてうねりが来る）、音が止んでもすぐには凪がない（= ブレイクに入っても
 * 余韻が残る）。
 */
export const GROWTH_TAU = 18;
export const DECAY_TAU = 40;

/**
 * ピーク周波数のレンジ（Hz）。海が育つほど波は長くなる。
 * `FP_MAX` = 周期 4.5 秒の凪の短い波、`FP_MIN` = 周期 12 秒の育ったうねり。
 */
export const FP_MAX = 0.22;
export const FP_MIN = 0.085;

/**
 * 波（と波群）だけを早送りする倍率。
 *
 * fp は実海面の値なので個々の波は 5〜12 秒周期になる。VJ の変調源としては遅すぎる
 * うえ、infragravity（{@link T_IG}）が実時間の秒で回るため、等倍のままだと波群
 * (約 70 秒) と set (約 75 秒) の周期が重なって階層が潰れる。ここで搬送波側だけ
 * 縮めると「波 ≒ 1.2 秒 / 群 ≒ 7 秒 / set ≒ 50〜75 秒」になり、音楽の小節〜
 * セクションにちょうど乗る。うねり全体の速さを変えたいときはここを触る。
 */
export const TIME_SCALE = 10;

/** infragravity（surf beat）の固有周期（秒）。実海岸のこの帯は概ね 25〜250 秒。 */
export const T_IG = 75;
/** infragravity 振動子の固有角周波数。 */
export const OMEGA_IG = TWO_PI / T_IG;
/**
 * 駆動ゲイン。`OMEGA_IG^2` に置くと静的ゲインがちょうど 1 になり、`igX` が
 * 駆動（波高の 2 乗）と同じスケールに乗るのでデバッグしやすい。
 */
export const IG_DRIVE = OMEGA_IG * OMEGA_IG;
/** 減衰比。1 未満なので波群が止んだあともしばらく鳴り続ける（= 余韻）。 */
export const IG_ZETA = 0.25;
/**
 * 振動子から DC を抜くための超低速平均の時定数（秒）。
 *
 * 駆動が `envH^2 >= 0` で常に正なので、そのままだと `igX` が大きな定数オフセットに
 * 乗ったまま振動する。固有周期よりずっと長い時定数で平均を引き、変動成分だけ取る。
 * `T_IG` の 1.6 倍あるので、狙いの帯（75 秒）はほぼ素通りする。
 */
export const IG_DC_TAU = 120;

/**
 * 岸に溜まる水の時定数（秒）。溜まるのは速く、引くのは遅い。
 * これも `motion.ts` と同じ非対称平滑で、砕けた波が汀に水を積み上げてから
 * ゆっくり戻っていく振る舞いをそのまま書いている。
 */
export const SURGE_FILL_TAU = 6;
export const SURGE_DRAIN_TAU = 20;

/**
 * 溜まった水の戻り流れが次の波を立たせる量。
 *
 * これがあるおかげで、次の波高が「入射波だけの関数」ではなく
 * 「入射波と岸の状態の関数」になる。前の波が次の波に効く、という状態フィードバック。
 *
 * 掛ける相手は**正規化済みの `surge`（0..1）**であって、内部の生値ではない。
 * こうしてあると、この定数がそのまま「うねりが最大で何倍まで立つか」（1.35 倍）を
 * 意味する読める数になる。生値に掛けると実効倍率が {@link SURGE_NORM} の較正に
 * 従属してしまい、較正をいじるたびにフィードバック強度まで一緒に動いてしまう。
 */
export const SWELL_FEEDBACK = 0.35;

/**
 * 出力の較正係数。`energy = 1` の定常状態で 0..1 をきちんと使い切るよう、
 * 実測した分位点から決めてある（6 seed × 各 2400 秒、頭 400 秒は過渡なので捨てて集計）:
 *
 * | 出力  | 生値 p99 | 生値 p99.9 | 採用 NORM | 適用後 p99 | クリップ率 |
 * |-------|----------|------------|-----------|------------|------------|
 * | wave  | 1.96     | 2.59       | 0.39      | 0.76       | 0.09%      |
 * | group | 2.07     | 2.46       | 0.40      | 0.83       | 0.08%      |
 * | set   | 0.61     | 0.72       | 1.40      | 0.85       | 0.11%      |
 * | surge | 2.44     | 2.86       | 0.35      | 0.85       | 0.10%      |
 *
 * 「たまに天井を叩く」程度に留め、0.1 までしか振れない／張り付きっぱなし、の
 * どちらにもならないところを狙っている。
 *
 * `wave` の行だけ他より小さいのは、{@link SWELL_FEEDBACK} を生値ではなく正規化済み
 * `surge` に掛けるよう直したときに実効フィードバックが 1.85 倍 → 1.35 倍に下がり、
 * `wave` の生値レンジがそのぶん縮んだため（同じ手順で測り直した値）。
 */
export const WAVE_NORM = 0.39;
export const GROUP_NORM = 0.4;
export const SET_NORM = 1.4;
export const SURGE_NORM = 0.35;

/**
 * 1 フレームで進める上限（秒）。
 *
 * タブが非アクティブから復帰した直後は数秒〜数十秒の dt が 1 回だけ来る。
 * infragravity は陽的積分の 2 次振動子なので、その 1 回で `omega*dt` が大きく
 * なると発散して二度と戻らない。ここで頭を押さえておけば、復帰時は「少し進みが
 * 遅れる」だけで済む。
 */
export const MAX_DT = 0.1;

/**
 * 0..1 に丸める。半波整流も兼ねる。
 *
 * `v <= 0` をまとめて `+0` に潰しているのは `-0` 対策。`eta * hs` は hs が 0 の
 * とき eta の符号を引き継いで `-0` になり、`Object.is(-0, 0)` が false なので
 * 「無音なら厳密に 0」を確かめる側から見ると別物に見えてしまう。
 * NaN はここを素通りする（呼び出し側の非有限ガードで落とす方が原因が分かる）。
 */
function clamp01(v: number): number {
  if (v <= 0) return 0;
  return v > 1 ? 1 : v;
}

/**
 * JONSWAP スペクトルの**形状**。絶対スケールは後で正規化するので係数は要らない。
 *
 * `S(f) = f^-5 * exp(-1.25*(fp/f)^4) * GAMMA^r(f)`、
 * `r(f) = exp(-(f-fp)^2 / (2*sigma^2*fp^2))`
 */
export function jonswapShape(f: number, fp: number): number {
  const sigma = f <= fp ? JONSWAP_SIGMA_LOW : JONSWAP_SIGMA_HIGH;
  const d = f - fp;
  const r = Math.exp(-(d * d) / (2 * sigma * sigma * fp * fp));
  const q = fp / f;
  return Math.pow(f, -5) * Math.exp(-1.25 * q * q * q * q) * Math.pow(JONSWAP_GAMMA, r);
}

/**
 * 各成分の周波数を fp 比で返す。等間隔 + seed 決定的ジッタ。
 *
 * 周波数そのものではなく**比**で持つのが要点。fp は海の育ち具合で毎フレーム動くが、
 * スペクトルの形（fp に対する相対配置）は動かないので、比なら構築時に 1 回決めれば済む。
 */
export function spectrumRatios(seed: string): number[] {
  const span = (SPECTRUM_RATIO_MAX - SPECTRUM_RATIO_MIN) / SPECTRUM_BINS;
  const ratios: number[] = [];
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const jitter = (rand(seed, 'swell:jitter', i) * 2 - 1) * SPECTRUM_JITTER * span;
    ratios.push(SPECTRUM_RATIO_MIN + span * (i + 0.5) + jitter);
  }
  return ratios;
}

/**
 * `A_i = sqrt(2 * S(f_i) * df)` を `sum(A_i^2) = 1` に正規化して返す。
 *
 * fp に依存しないので構築時に 1 回でよい。`f = fp*r`、`df = fp*dr` を入れると
 * `A_i^2 = 2 * fp^-4 * dr * (r だけの項)` となり、共通因子 `fp^-4*dr` は
 * `sum(A_i^2)=1` の正規化で丸ごと落ちるため。ここでは `fp = 1` を代入して評価する。
 *
 * 正規化しておくと、包絡線 `sqrt(c^2+s^2)` の 2 乗平均がちょうど 1 になり、
 * 下流（infragravity / surge）の較正が波高 `Hs` だけの話に閉じる。
 */
export function spectrumAmplitudes(ratios: readonly number[]): number[] {
  const df = (SPECTRUM_RATIO_MAX - SPECTRUM_RATIO_MIN) / SPECTRUM_BINS;
  const raw = ratios.map((r) => Math.sqrt(2 * jonswapShape(r, 1) * df));
  const norm = Math.sqrt(raw.reduce((acc, a) => acc + a * a, 0));
  return raw.map((a) => a / norm);
}

/** 各成分の初期位相。seed 決定的に散らさないと、起動直後に全成分が揃って巨大な 1 波が立つ。 */
export function initialPhases(seed: string): number[] {
  const phases: number[] = [];
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    phases.push(rand(seed, 'swell:phase', i) * TWO_PI);
  }
  return phases;
}

/** 有義波高 0..1 に対するピーク周波数（Hz）。海が育つほど波が長くなる。 */
export function peakFrequency(hs: number): number {
  return FP_MAX - (FP_MAX - FP_MIN) * clamp01(hs);
}

export interface SwellState {
  /** 個々の波の峰。0..1 */
  wave: number;
  /** 波群の包絡線。0..1 */
  group: number;
  /** infragravity（長周期のセット）。0..1 */
  set: number;
  /** 岸に溜まった水 / 戻り流れ。0..1 */
  surge: number;
}

export interface SwellClock {
  /** 1フレーム進める。energy は 0..1 の平滑済み音エネルギー（= 風速）。 */
  advance(energy: number, dt: number): SwellState;
  readonly state: SwellState;
  /**
   * 海の**状態**（波高・溜まった水・IG 振動子・位相）はそのままに、成分の配置だけ
   * 新しい seed のものへ差し替える。Patch が変われば波の性格も変わるべきだが、
   * 切り替えのたびに凪へ戻ってしまうと「音は鳴っているのに画が止まる」が起きる。
   *
   * 位相を引き継げるのは、このモジュールが位相を累積で持っているから。周波数が
   * 変わっても位相は連続なので、差し替えの瞬間に画がジャンプしない。
   */
  reseed(seed: string): void;
  reset(): void;
}

/**
 * 無音（= まだ 1 フレームも進んでいない）状態。
 *
 * `state` getter 経由で外に漏れる共有オブジェクトなので凍結してある。
 * 変調エンジンの既定値としても使うので、書き換えられると全シーンに波及する。
 */
export const ZERO_SWELL_STATE: SwellState = Object.freeze({
  wave: 0,
  group: 0,
  set: 0,
  surge: 0,
});

/**
 * {@link SwellClock} を作る。状態は呼び出し側が持つ（シーンごとに 1 本）。
 *
 * `seed` は成分の周波数ジッタと初期位相にだけ効く。同じ seed・同じ入力列なら
 * 出力列は完全に同一になる。
 */
export function createSwellClock(seed: string): SwellClock {
  let ratios = spectrumRatios(seed);
  let amplitudes = spectrumAmplitudes(ratios);
  let basePhases = initialPhases(seed);
  const phases = basePhases.slice();

  /** 有義波高 0..1。海の記憶そのもの。 */
  let hs = 0;
  /** infragravity 振動子の変位と速度。 */
  let igX = 0;
  let igV = 0;
  /** `igX` から抜く超低速平均（DC）。 */
  let igMean = 0;
  /** 岸に溜まった水（生値。正規化前）。 */
  let pooled = 0;
  let state: SwellState = ZERO_SWELL_STATE;

  return {
    advance(energy: number, dt: number): SwellState {
      // dt を押さえるのは 2 次振動子を守るため（MAX_DT のコメント参照）。
      // NaN が 1 度でも入ると状態が永久に汚れるので、非有限はここで捨てる。
      const step = Number.isFinite(dt) ? Math.min(MAX_DT, Math.max(0, dt)) : 0;
      const wind = Number.isFinite(energy) ? clamp01(energy) : 0;

      // --- 海の記憶: 風 → 有義波高。育つより凪ぐ方が遅い。
      const hsTarget = Math.pow(wind, WIND_TO_HEIGHT_EXP);
      hs += smoothK(step, hsTarget > hs ? GROWTH_TAU : DECAY_TAU) * (hsTarget - hs);

      // --- 搬送波: 位相は必ず累積する。fp が動いても位相が飛ばないのはこれのおかげ。
      const fp = peakFrequency(hs);
      let cos = 0;
      let sin = 0;
      for (let i = 0; i < SPECTRUM_BINS; i++) {
        let phase = phases[i]! + TWO_PI * fp * ratios[i]! * step * TIME_SCALE;
        // 長時間走らせても float の刻みが粗くならないよう 1 周ごとに畳む。
        if (phase >= TWO_PI) phase %= TWO_PI;
        phases[i] = phase;
        cos += amplitudes[i]! * Math.cos(phase);
        sin += amplitudes[i]! * Math.sin(phase);
      }

      // --- 解析信号。同じ 1 組の成分から、波そのものと包絡線が同時に出る。
      // 「10 波に 1 回大きい」を定数で書かずに波群が創発するのはここ。近接した
      // 周波数どうしが唸って、包絡線が勝手に数波〜十数波の塊を作る。
      const eta = cos;
      const env = Math.sqrt(cos * cos + sin * sin);
      // 実際の波高。`hs` を掛けて初めて物理量になる（`env` は無音でも 1 前後で
      // 振れ続けるので、ここを掛け忘れると無音で 0 に落ちなくなる）。
      const envH = env * hs;
      // radiation stress は波高の 2 乗に比例する。下の 2 層は両方これで駆動される。
      const forcing = envH * envH;

      // --- infragravity: 波群が岸へ運ぶ水が叩く減衰 2 次振動子。
      // semi-implicit Euler（v を先に更新して x に使う）。陽的 Euler より安定。
      const acc = IG_DRIVE * forcing - 2 * IG_ZETA * OMEGA_IG * igV - OMEGA_IG * OMEGA_IG * igX;
      igV += acc * step;
      igX += igV * step;
      igMean += smoothK(step, IG_DC_TAU) * (igX - igMean);
      const igAc = igX - igMean;

      // --- surge: 汀に溜まった水。速く溜まり、ゆっくり引く。
      pooled +=
        smoothK(step, forcing > pooled ? SURGE_FILL_TAU : SURGE_DRAIN_TAU) * (forcing - pooled);

      // --- 状態フィードバック: 戻り流れとぶつかると波が立つ。
      // 次の波高が「入射波だけの関数」ではなく「入射波と岸の状態の関数」になる。
      // 掛けるのは出力と同じ正規化済みの値。こうしておくと SWELL_FEEDBACK が
      // 「最大 1.35 倍」をそのまま意味し、SURGE_NORM の較正から独立する。
      const surge = clamp01(pooled * SURGE_NORM);
      const etaFed = eta * (1 + SWELL_FEEDBACK * surge);

      // --- 出力。すべて unipolar 0..1、無音（hs → 0）で必ず 0 に落ちる。
      // wave / set は clamp01 が半波整流を兼ねる。谷が 0 なので「波の峰が来た瞬間」だけ立つ。
      state = {
        wave: clamp01(etaFed * hs * WAVE_NORM),
        group: clamp01(envH * GROUP_NORM),
        set: clamp01(igAc * hs * SET_NORM),
        surge,
      };
      return state;
    },
    get state() {
      return state;
    },
    reseed(next: string): void {
      // 差し替えるのはスペクトルの「形」だけ。hs / igX / igV / igMean / pooled と
      // 現在の位相はそのまま残すので、海は凪に戻らず、画も飛ばない。
      ratios = spectrumRatios(next);
      amplitudes = spectrumAmplitudes(ratios);
      basePhases = initialPhases(next);
    },
    reset(): void {
      for (let i = 0; i < SPECTRUM_BINS; i++) phases[i] = basePhases[i]!;
      hs = 0;
      igX = 0;
      igV = 0;
      igMean = 0;
      pooled = 0;
      state = ZERO_SWELL_STATE;
    },
  };
}
