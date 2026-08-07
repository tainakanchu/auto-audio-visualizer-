/**
 * `?blend=<mode>` の解決ロジックと、ベース/オーバーレイの描画経路ごとの適用方法。
 *
 * ブレンドは**意図的に URL 専用**の機能で、localStorage には保存されません
 * （`useSettings` の `overlay` / `ui=hide` と同じ扱い）。オーバーレイ未指定時や
 * `blend` 未指定時は現状と完全に同一の挙動を保つ前提のため、永続化はしません。
 *
 * 不正値は throw せず `normal` にフォールバックし、呼び出し側が警告を出せるよう
 * `warning` を返す。VJ 本番で画面が真っ黒になる事故を避けるため。
 */

export const BLEND_MODES = [
  'normal',
  'screen',
  'multiply',
  'overlay',
  'difference',
  'exclusion',
  'color-dodge',
  'hard-light',
  'lighten',
  'darken',
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

export interface BlendResolution {
  /** Canonical lowercase mode (always a member of {@link BLEND_MODES}). */
  mode: BlendMode;
  /** Human-readable reason the request was rejected, or null. */
  warning: string | null;
}

const BLEND_MODE_SET = new Set<string>(BLEND_MODES);

/**
 * `blend` URL パラメータ / 外部制御の生値を解決する。
 *
 * - 未指定（null / undefined / 空文字 / 空白のみ）: `normal`。警告なし。
 * - 既知モード（前後空白無視・大小文字不問）: 正規化した小文字名。
 * - 未知: `normal` に倒し、元の値を含む警告を返す（決して throw しない）。
 */
export function resolveBlendMode(raw: string | null | undefined): BlendResolution {
  if (raw == null || raw === '') return { mode: 'normal', warning: null };

  const trimmed = raw.trim();
  if (trimmed === '') return { mode: 'normal', warning: null };

  const lower = trimmed.toLowerCase();
  if (BLEND_MODE_SET.has(lower)) {
    return { mode: lower as BlendMode, warning: null };
  }

  return {
    mode: 'normal',
    warning: `\`blend=${trimmed}\` は未知のブレンドモードです。\`normal\` にフォールバックします。`,
  };
}

/**
 * How to apply a non-`normal` blend for a base/overlay pairing.
 *
 * - `none` — no effective overlay (or no base): do not set mix-blend-mode / GCO
 * - `css-gl` / `css-2d` — dual-canvas pairings; CSS on the top layer canvas
 * - `gco` — shared 2D canvas; Canvas2D `globalCompositeOperation` on overlay pass
 * - `unsupported-gl` — shared GL context; keep existing GL blend, warn once
 */
export type BlendApplication = 'none' | 'css-gl' | 'css-2d' | 'gco' | 'unsupported-gl';

/**
 * ベース/オーバーレイの kind から、ブレンドをどう適用するかを決める純粋関数。
 * オーバーレイが無い（またはベースが無い）ときは CSS も GCO も触らない。
 */
export function resolveBlendApplication(
  baseKind: '2d' | 'gl' | null,
  overlayKind: '2d' | 'gl' | null,
): BlendApplication {
  if (baseKind == null || overlayKind == null) return 'none';
  if (baseKind === '2d' && overlayKind === 'gl') return 'css-gl';
  if (baseKind === 'gl' && overlayKind === '2d') return 'css-2d';
  if (baseKind === '2d' && overlayKind === '2d') return 'gco';
  return 'unsupported-gl';
}

/**
 * Canvas2D の overlay パス用 GCO。`normal` は既定の `source-over`。
 * それ以外は CSS `mix-blend-mode` と同名（Canvas2D がそのまま受け付ける）。
 */
export function blendModeToGlobalCompositeOperation(mode: BlendMode): GlobalCompositeOperation {
  return mode === 'normal' ? 'source-over' : mode;
}
