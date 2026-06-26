/** Colour-relationship mode that decides how scenes spread hue across elements. */
export type PaletteMode =
  | 'mono'
  | 'analogous'
  | 'complementary'
  | 'triadic'
  | 'rainbow';

/**
 * A deterministic bundle of "look" parameters derived from a seed string.
 *
 * Every field is drawn from a seeded PRNG so the same seed always yields the
 * same visual identity. Scenes read these to vary colour, motion, density,
 * size, symmetry and — most importantly — {@link Variation.variant}, a discrete
 * per-scene layout switch that makes a reroll feel like a different scene.
 */
export interface Variation {
  /** The source seed string this variation was generated from. */
  seed: string;
  /** Colour-relationship mode; drives {@link Variation.hueSpread}. */
  paletteMode: PaletteMode;
  /** 0..360 added to the base hue by the renderer before scenes see it. */
  hueOffset: number;
  /**
   * Degrees of hue range a scene spreads across its elements.
   * Derived from {@link Variation.paletteMode} (mono ~12, analogous ~40,
   * complementary alternation ~180, triadic ~120, rainbow ~360).
   */
  hueSpread: number;
  /** Base saturation, 55..100. */
  saturation: number;
  /** Base lightness, 45..72. */
  lightness: number;
  /** Motion / time multiplier, 0.5..1.8. */
  speed: number;
  /** Element-count multiplier, 0.55..2.0. */
  density: number;
  /** Size multiplier, 0.7..1.4. */
  scale: number;
  /** Symmetry / repeat count, integer 2..8. */
  symmetry: number;
  /** Rotation / drift direction, +1 or -1. */
  direction: 1 | -1;
  /** Organic per-element noise amount, 0..1. */
  wobble: number;
  /** Free-form personality knob, 0..1 (spiky vs round, polygon sides, etc.). */
  shape: number;
  /** Discrete per-scene layout switch, integer 0..3 — the big gacha lever. */
  variant: number;
  /**
   * Deterministic 0..1 per integer index, stable for a given seed. Use for
   * per-element randomness that must not flicker across frames (never
   * Math.random in a draw path).
   */
  rand: (i: number) => number;
}
