/** 円環上の最短距離（度）。359→1 は 2。 */
export function circularHueDelta(from: number, to: number): number {
  const d = Math.abs(to - from) % 360;
  return d > 180 ? 360 - d : d;
}
