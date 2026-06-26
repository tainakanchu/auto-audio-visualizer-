/** Small shared math/color helpers for scenes. */

import type { Variation } from '../variation/types';
import type { AudioFrame } from '../audio/types';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Frame-rate-independent exponential smoothing toward `target`. */
export function lerp(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

/** Wrap a hue into 0..360. */
export function wrapHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** Build an hsla color string. */
export function hsla(h: number, s: number, l: number, a: number): string {
  return `hsla(${wrapHue(h).toFixed(1)}, ${s}%, ${l}%, ${a})`;
}

/** Internal: one HSL channel given the precomputed p, q and a temp position. */
function hue2rgb(p: number, q: number, tInput: number): number {
  let tc = tInput;
  if (tc < 0) tc += 1;
  if (tc > 1) tc -= 1;
  if (tc < 1 / 6) return p + (q - p) * 6 * tc;
  if (tc < 1 / 2) return q;
  if (tc < 2 / 3) return p + (q - p) * (2 / 3 - tc) * 6;
  return p;
}

/**
 * Convert HSL to 0..1 RGB for shader uniforms.
 *
 * @param h   Hue in degrees (any range; wrapped internally).
 * @param s   Saturation, 0..100 (percent, matching the variation fields).
 * @param l   Lightness, 0..100 (percent).
 * @param out Optional 3-tuple to write into (avoids per-frame allocation in
 *            draw paths). Defaults to a fresh tuple.
 * @returns `[r, g, b]` each 0..1 (the same reference as `out` when provided).
 */
export function hslToRgb(
  h: number,
  s: number,
  l: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = clamp01(s / 100);
  const ll = clamp01(l / 100);
  if (ss === 0) {
    out[0] = ll;
    out[1] = ll;
    out[2] = ll;
    return out;
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  out[0] = hue2rgb(p, q, hh + 1 / 3);
  out[1] = hue2rgb(p, q, hh);
  out[2] = hue2rgb(p, q, hh - 1 / 3);
  return out;
}

/**
 * Idle ambient amount, 0..1: when audio is silent this fades a gentle
 * oscillation in so scenes are never a static black void.
 */
export function idlePulse(t: number, speed = 1, phase = 0): number {
  return (Math.sin(t * speed + phase) * 0.5 + 0.5);
}

/**
 * Pulse envelope for scene reactions. When the tempo grid is locked, follow the
 * steady grid pulse (with a floor blend of raw detection so transients still
 * read); otherwise fall back to the raw beat-detection envelope.
 */
export function beatPulse(audio: AudioFrame): number {
  return audio.tempoLocked
    ? Math.max(audio.gridPulse, audio.beatIntensity * 0.4)
    : audio.beatIntensity;
}

/**
 * Discrete trigger for scene events. Grid beats when the tempo is locked, raw
 * detected beats otherwise.
 */
export function beatTrigger(audio: AudioFrame): boolean {
  return audio.tempoLocked ? audio.gridBeat : audio.beat;
}

/**
 * Spread a hue across an element according to the variation's palette.
 *
 * @param va       Active variation (uses paletteMode + hueSpread).
 * @param baseHue  The base hue to offset from.
 * @param frac01   This element's position 0..1 across the spread.
 * @param altIndex Optional integer index used by 'complementary' to alternate
 *                 +0 / +180 instead of a smooth spread.
 */
export function spreadHue(
  va: Variation,
  baseHue: number,
  frac01: number,
  altIndex?: number,
): number {
  if (va.paletteMode === 'complementary' && altIndex != null) {
    return baseHue + (altIndex % 2 === 0 ? 0 : 180);
  }
  return baseHue + frac01 * va.hueSpread;
}
