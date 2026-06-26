import type { PaletteMode, Variation } from './types';

/**
 * xmur3 string hash → returns a 32-bit seed generator function.
 * Standard public-domain hash by bryc; produces well-mixed seeds for mulberry32.
 */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG — fast, deterministic 0..1 generator from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE_MODES: PaletteMode[] = [
  'mono',
  'analogous',
  'complementary',
  'triadic',
  'rainbow',
];

/** Hue spread (degrees) each palette mode asks scenes to spread their elements across. */
function hueSpreadFor(mode: PaletteMode): number {
  switch (mode) {
    case 'mono':
      return 12;
    case 'analogous':
      return 40;
    case 'complementary':
      return 180;
    case 'triadic':
      return 120;
    case 'rainbow':
      return 360;
  }
}

/** Map a 0..1 float to an inclusive integer range [lo, hi]. */
function intRange(r: number, lo: number, hi: number): number {
  return lo + Math.floor(r * (hi - lo + 1 - 1e-9));
}

/**
 * Build a {@link Variation} deterministically from a seed string.
 *
 * IMPORTANT: every parameter is drawn from the PRNG in a FIXED order. The order
 * below is part of the contract — reordering or inserting a draw changes the
 * look of every existing seed. Append new draws at the end if you must extend.
 */
export function generateVariation(seed: string): Variation {
  const seedHash = xmur3(seed);
  const baseSeed = seedHash();
  const rng = mulberry32(baseSeed);

  // ---- Fixed draw order (do not reorder) ----
  const paletteMode = PALETTE_MODES[intRange(rng(), 0, PALETTE_MODES.length - 1)]!;
  const hueOffset = rng() * 360; //                                0..360
  const saturation = 55 + rng() * 45; //                           55..100
  const lightness = 45 + rng() * 27; //                            45..72
  const speed = 0.5 + rng() * 1.3; //                              0.5..1.8
  const density = 0.55 + rng() * 1.45; //                          0.55..2.0
  const scale = 0.7 + rng() * 0.7; //                              0.7..1.4
  const symmetry = intRange(rng(), 2, 8); //                       2..8
  const direction: 1 | -1 = rng() < 0.5 ? 1 : -1; //               +1 / -1
  const wobble = rng(); //                                         0..1
  const shape = rng(); //                                          0..1
  const variant = intRange(rng(), 0, 3); //                        0..3
  // ---- end fixed draw order ----

  const hueSpread = hueSpreadFor(paletteMode);

  /**
   * Per-index deterministic randomness: a fresh mulberry32 seeded by the seed
   * hash XOR a mixed index (golden-ratio constant), sampled once. Stable for a
   * given (seed, i) pair and independent of frame timing.
   */
  const rand = (i: number): number => {
    const mixed = (baseSeed ^ Math.imul(i, 0x9e3779b9)) >>> 0;
    return mulberry32(mixed)();
  };

  return {
    seed,
    paletteMode,
    hueOffset,
    hueSpread,
    saturation,
    lightness,
    speed,
    density,
    scale,
    symmetry,
    direction,
    wobble,
    shape,
    variant,
    rand,
  };
}

/** Fun, readable adjectives for generated seeds (≈24). */
const ADJECTIVES = [
  'neon',
  'acid',
  'velvet',
  'ghost',
  'cyber',
  'lunar',
  'solar',
  'hyper',
  'retro',
  'glass',
  'frost',
  'ember',
  'cosmic',
  'pixel',
  'vapor',
  'electric',
  'crystal',
  'midnight',
  'golden',
  'plasma',
  'mystic',
  'turbo',
  'quantum',
  'astro',
];

/** Fun, readable nouns for generated seeds (≈24). */
const NOUNS = [
  'tiger',
  'orchid',
  'prism',
  'nebula',
  'comet',
  'falcon',
  'lotus',
  'phoenix',
  'serpent',
  'raven',
  'wolf',
  'koi',
  'dragon',
  'panther',
  'mantis',
  'jaguar',
  'sphinx',
  'cobra',
  'mirage',
  'aurora',
  'glacier',
  'volcano',
  'tempest',
  'cipher',
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/**
 * Generate a fresh, fun, readable seed for the gacha button, e.g.
 * `neon-tiger-042`. Uses Math.random — this is UI-side only; the variation
 * derived from the resulting string stays fully deterministic.
 */
export function randomSeed(): string {
  const n = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${n}`;
}
