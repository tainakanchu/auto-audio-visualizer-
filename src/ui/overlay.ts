/**
 * `?overlay=<sceneId>` の解決ロジック。
 *
 * オーバーレイは**意図的に URL 専用**の機能で、localStorage には保存されません
 * （`useSettings` の `initialUiHidden` / `ui=hide` と同じ扱い）。もし永続化すると、
 * 一度 `?overlay=rings` を開いただけのユーザーがオーバーレイ付きの状態から
 * 抜け出せなくなり、「overlay 未指定時は現状と完全に同一の挙動」という前提が
 * 崩れてしまうためです。
 *
 * この関数自体は純粋関数で、URL の読み取りやシーン一覧の取得は呼び出し側
 * （`useSettings` / `App`）が担う。
 */

export interface OverlayResolution {
  /** The overlay scene id to activate, or null for "no overlay". */
  id: string | null;
  /** Human-readable reason the request was rejected, or null. */
  warning: string | null;
}

const DISABLE_VALUES = new Set(['none', 'off', '0']);

/**
 * `overlay` URL パラメータの生値を解決する。
 *
 * - 未指定（null / undefined / 空文字）: リクエストなし。警告なし。
 * - `none` / `off` / `0`（大小文字・前後空白を無視）: 明示的な無効化。警告なし。
 * - 未知のシーン id: 無効化した上で警告を返す。
 * - ベースシーンと同一の id: 無効化した上で警告を返す（オーバーレイはベースと
 *   異なるシーンでなければならない）。
 * - それ以外: トリム済みの id をそのまま採用。
 */
export function resolveOverlaySceneId(
  raw: string | null | undefined,
  baseSceneId: string,
  knownSceneIds: readonly string[],
): OverlayResolution {
  if (raw == null || raw === '') return { id: null, warning: null };

  const trimmed = raw.trim();
  if (trimmed === '') return { id: null, warning: null };

  if (DISABLE_VALUES.has(trimmed.toLowerCase())) return { id: null, warning: null };

  if (!knownSceneIds.includes(trimmed)) {
    return {
      id: null,
      warning: `\`overlay=${trimmed}\` は未知のシーン id です。オーバーレイを無効にします。`,
    };
  }

  if (trimmed === baseSceneId) {
    return {
      id: null,
      warning: `\`overlay=${trimmed}\` はベースシーンと同じです。オーバーレイにはベースと異なるシーンを指定してください。オーバーレイを無効にします。`,
    };
  }

  return { id: trimmed, warning: null };
}
