/**
 * 名前付き乱数ストリーム。
 *
 * 同じ (seed, namespace, index) から TypeScript (CPU) と GLSL (GPU) の両方で
 * bit-exact に一致する 0..1 の値を得るための決定的ハッシュ。
 *
 * アルゴリズム:
 * - 32bit 整数ハッシュ: lowbias32 (Chris Wellons)
 * - 文字列 → u32: FNV-1a 32bit
 * - 合成: hashCombine(a, b) = hashU32(a ^ hashU32(b))
 * - 0..1 変換: 上位 24bit のみ使用
 */

/** lowbias32 — 32bit 整数ハッシュ (Chris Wellons)。 */
function hashU32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** FNV-1a 32bit — 文字列を u32 に落とす。 */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** hashCombine(a, b) = hashU32(a ^ hashU32(b)) */
function hashCombine(a: number, b: number): number {
  return hashU32((a >>> 0) ^ hashU32(b >>> 0));
}

/**
 * ハッシュ値を [0, 1) に写す。
 *
 * 上位 24 ビットのみを使う。32bit 全体を float にすると、GLSL の float32 では
 * 2^32 個すべての値を正確に表現できず、JS の float64 との間に微小な差が生じる。
 * 24bit なら float32 でも float64 でも正確に表現できるため、CPU と GPU で
 * bit-exact に一致する。
 */
function rand01(h: number): number {
  return (h >>> 8) / 16777216;
}

const namespaceCache = new Map<string, number>();

/** 文字列 seed を u32 に落とす。 */
export function seedToU32(seed: string): number {
  return fnv1a32(seed);
}

/** 名前空間文字列を u32 に落とす（結果はキャッシュしてよい）。 */
export function namespaceToU32(namespace: string): number {
  let v = namespaceCache.get(namespace);
  if (v === undefined) {
    v = fnv1a32(namespace);
    namespaceCache.set(namespace, v);
  }
  return v;
}

/**
 * 決定的な 0..1。呼び出し順に依存せず、(seed, namespace, index) だけで決まる。
 * GLSL 側の synthRand(seedU32, nsU32, index) と bit-exact に一致する。
 */
export function rand(seed: string, namespace: string, index: number): number {
  const seedU = seedToU32(seed);
  const nsU = namespaceToU32(namespace);
  const h = hashCombine(hashCombine(seedU, nsU), index >>> 0);
  return rand01(h);
}

/**
 * 重み付きランデブー（highest-random-weight）選択。`weight` が大きい候補ほど
 * 勝ちやすい。
 *
 * `rand^(1/weight)` は分布が weight に比例する古典的な重み付けで、素の
 * ランデブーと同じ安定性を保つ: 候補が 1 つ増減しても、その候補が最大値を
 * 取る場合以外は既存 seed の結果が変わらない。カタログに要素を足したときに
 * 既存 seed の選択が全面シャッフルされないことが重要な場面で使う。
 */
export function pickWeightedByRendezvous<T>(
  seed: string,
  ns: string,
  candidates: readonly T[],
  keyOf: (c: T) => string,
  /** 省略時は全候補等確率（素のランデブーと同じ）。 */
  weightOf: (c: T) => number = () => 1,
): T {
  const first = candidates[0];
  if (first === undefined) {
    throw new Error(`pickWeightedByRendezvous: no candidates for "${ns}"`);
  }
  const score = (c: T) =>
    Math.pow(rand(seed, ns, namespaceToU32(keyOf(c))), 1 / Math.max(1e-6, weightOf(c)));
  return candidates.reduce((best, c) => (score(c) > score(best) ? c : best), first);
}

export interface RngStream {
  /** index を指定した決定的な 0..1。呼び出し順に依存しない。 */
  at(index: number): number;
  /** 内部カウンタを1つ進めて 0..1 を返す。spawn のように「毎回違う値」が要る用途向け。 */
  next(): number;
  /** 内部カウンタを 0 に戻す。 */
  reset(): void;
}

/** seed と名前空間を固定したストリームを作る。 */
export function createRngStream(seed: string, namespace: string): RngStream {
  const seedU = seedToU32(seed);
  const nsU = namespaceToU32(namespace);
  let counter = 0;

  return {
    at(index: number): number {
      const h = hashCombine(hashCombine(seedU, nsU), index >>> 0);
      return rand01(h);
    },
    next(): number {
      const i = counter;
      counter = (counter + 1) >>> 0;
      const h = hashCombine(hashCombine(seedU, nsU), i);
      return rand01(h);
    },
    reset(): void {
      counter = 0;
    },
  };
}
