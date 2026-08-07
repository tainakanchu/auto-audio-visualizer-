/**
 * CPU 側の変調マトリクス。
 *
 * AudioFrame / time から ModulationRoute を解決し、各パラメータへの加算量を返す。
 * 描画は行わない。Operator 出力 (`operator:<opId>`) はこのフェーズでは未対応。
 *
 * 平滑化は README のアンビエント設計に合わせ、秒スケールの指数平滑を使う。
 * ビートで爆発させるのではなく、音楽にゆったり呑まれるように状態を持つ。
 */
import type { AudioFrame } from '../audio/types';
import type { InlineGeneratorCatalog } from './generators/types';
import type { ModulationRoute, ParameterDefinition, VisualPatch } from './types';

/**
 * Route を作るときの平滑化時定数の既定値（秒）。
 *
 * アンビエント設計では秒スケール（0.5〜2 秒）で状態を平滑化し、
 * 音をなめらかに吸収する。0.8 秒はその中間寄りの既定値。
 * `ModulationRoute.smoothing` が必須なのでエンジン内部のフォールバックではなく、
 * ルート構築側がこの定数を使う想定。
 */
export const DEFAULT_SMOOTHING = 0.8;

/** 指数平滑の tau 下限。`smoothK` と揃え、0 除算と極端な k を避ける。 */
const TAU_EPS = 0.0001;

export interface ResolvedModulation {
  /** "<opId>.<paramId>" → 変調による加算量。 */
  offsets: Map<string, number>;
}

export interface ModulationEngine {
  /** 1フレーム進めて、各 target への変調量を解決する。 */
  update(audio: AudioFrame, t: number, dt: number): ResolvedModulation;
  /** 平滑化の内部状態をリセットする。 */
  reset(): void;
}

/** 未対応・未知の変調ソース。黙って 0 を返さないための明示エラー。 */
export class UnknownModulationSourceError extends Error {
  readonly source: string;

  constructor(source: string) {
    super(
      source.startsWith('operator:')
        ? `modulation source "${source}" is not supported yet (operator outputs are a later phase)`
        : `unknown modulation source "${source}"`,
    );
    this.name = 'UnknownModulationSourceError';
    this.source = source;
  }
}

/**
 * 指数平滑のブレンド係数。シーン側 `smoothK` と同じ形:
 * `k = 1 - exp(-dt / max(eps, tau))`
 *
 * scenes/util.ts の `smoothK` と同型。synth 層から scenes 層への依存を
 * 避けるため、ここで重複定義している。
 */
export function smoothK(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / Math.max(TAU_EPS, tau));
}

function resolveSourceValue(source: string, audio: AudioFrame, t: number): number {
  switch (source) {
    case 'audio:bass':
      return audio.bass;
    case 'audio:mid':
      return audio.mid;
    case 'audio:treble':
      return audio.treble;
    case 'audio:level':
      return audio.level;
    case 'audio:beat':
    // validate が昔から受け付けているスペル。ビートの「エンベロープ」を意味する
    // ので beatIntensity と同義にしておく。ここが無いと、検証を通った Patch が
    // デッキ生成時に UnknownModulationSourceError で落ちる。
    // falls through
    case 'audio:beatIntensity':
      return audio.beatIntensity;
    case 'audio:gridPulse':
      return audio.gridPulse;
    case 'audio:barPulse':
      return audio.barPulse;
    case 'audio:beatPhase':
      return audio.beatPhase;
    case 'audio:barPhase':
      return audio.barPhase;
    case 'time':
      // 正規化しない生の経過秒。スケールは amount で調整する。
      return t;
    default:
      throw new UnknownModulationSourceError(source);
  }
}

function applyPolarity(smoothed: number, polarity: ModulationRoute['polarity']): number {
  return polarity === 'bipolar' ? smoothed * 2 - 1 : smoothed;
}

export function createModulationEngine(routes: ModulationRoute[]): ModulationEngine {
  // ソースは構築時に検証し、未知 / operator: を黙って通さない。
  for (const route of routes) {
    if (route.source.startsWith('operator:')) {
      throw new UnknownModulationSourceError(route.source);
    }
    // time / 既知 audio 以外は resolve で例外。構築時も同じ経路で検査する。
    resolveSourceValue(route.source, EMPTY_AUDIO_FOR_VALIDATE, 0);
  }

  /** route index → 平滑化済みソース値 */
  const smoothed = Array.from({ length: routes.length }, () => 0);

  return {
    update(audio: AudioFrame, t: number, dt: number): ResolvedModulation {
      const offsets = new Map<string, number>();

      for (let i = 0; i < routes.length; i++) {
        const route = routes[i]!;
        const raw = resolveSourceValue(route.source, audio, t);

        let s: number;
        if (route.smoothing === 0) {
          s = raw;
          smoothed[i] = s;
        } else {
          const k = smoothK(dt, route.smoothing);
          s = smoothed[i]! + k * (raw - smoothed[i]!);
          smoothed[i] = s;
        }

        const contribution = applyPolarity(s, route.polarity) * route.amount;
        const prev = offsets.get(route.target) ?? 0;
        offsets.set(route.target, prev + contribution);
      }

      return { offsets };
    },

    reset(): void {
      smoothed.fill(0);
    },
  };
}

/** 構築時ソース検証用のダミー。数値フィールドだけ見ればよい。 */
const EMPTY_AUDIO_FOR_VALIDATE: AudioFrame = {
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
  running: false,
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isNumericKind(kind: ParameterDefinition['kind']): boolean {
  return kind === 'number' || kind === 'int';
}

/**
 * 解決済みの変調量を Patch のパラメータに適用し、最終的な値を返す。
 * 各パラメータの min/max でクランプする。
 *
 * - 同じ target への加算は `ResolvedModulation` 側で済んでいる前提
 * - `modulatable: false` や enum/bool へのオフセットは無視する
 */
export function applyModulation(
  patch: VisualPatch,
  catalog: InlineGeneratorCatalog,
  mod: ResolvedModulation,
): Map<string, number | string | boolean> {
  const out = new Map<string, number | string | boolean>();

  for (const op of patch.operators) {
    const gen = catalog.get(op.generatorId);
    const paramDefs = gen?.def.parameters ?? [];
    const defById = new Map(paramDefs.map((p) => [p.id, p]));

    for (const [paramId, base] of Object.entries(op.parameters)) {
      const key = `${op.id}.${paramId}`;
      const paramDef = defById.get(paramId);
      const offset = mod.offsets.get(key);

      if (
        paramDef &&
        paramDef.modulatable &&
        isNumericKind(paramDef.kind) &&
        typeof base === 'number' &&
        offset !== undefined &&
        Number.isFinite(offset)
      ) {
        let value = base + offset;
        const min = paramDef.min;
        const max = paramDef.max;
        if (typeof min === 'number' && typeof max === 'number') {
          value = clamp(value, min, max);
        } else if (typeof min === 'number') {
          value = Math.max(min, value);
        } else if (typeof max === 'number') {
          value = Math.min(max, value);
        }
        out.set(key, value);
      } else {
        // 非数値・非モジュラブル・オフセットなしはベース値のまま
        out.set(key, base);
      }
    }
  }

  return out;
}
