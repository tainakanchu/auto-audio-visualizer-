/**
 * Scene Deck の決定的バリエーション生成。
 *
 * 同トポロジ・同 seed のままパラメータだけを動かす。ポン出しが in-place morph
 * （シェーダ再コンパイル無し）で済むようにするため。
 */
import { createCatalog } from '../synth/catalog';
import { MOTION_RATIO_MAX, MOTION_TARGET_PARAMS } from '../synth/derive';
import { allGeneratorDefinitions } from '../synth/generators';
import type { InlineGeneratorCatalog } from '../synth/generators/types';
import { rand } from '../synth/rng';
import type { ParameterDefinition, VisualOperator, VisualPatch } from '../synth/types';
import { validatePatch } from '../synth/validate';

export const SCENE_BANK_SIZE = 8;

export interface DeckScene {
  slot: number;
  label: string;
  detail: string;
  strength: number;
  patch: VisualPatch;
}

export function buildSceneBank(
  base: VisualPatch,
  bankSeed: string,
  catalog: InlineGeneratorCatalog,
): DeckScene[] {
  const metaCatalog = createCatalog(allGeneratorDefinitions());
  const scenes: DeckScene[] = [];
  for (let slot = 0; slot < SCENE_BANK_SIZE; slot++) {
    scenes.push(buildScene(base, bankSeed, catalog, metaCatalog, slot));
  }
  return scenes;
}

function buildScene(
  base: VisualPatch,
  bankSeed: string,
  catalog: InlineGeneratorCatalog,
  metaCatalog: ReturnType<typeof createCatalog>,
  slot: number,
): DeckScene {
  const label = slot === 0 ? 'BASE' : `V${slot}`;
  const strength = slot === 0 ? 0 : 0.15 + (0.7 * (slot - 1)) / 6;

  if (slot === 0) {
    return { slot, label, detail: 'base', strength, patch: structuredClone(base) };
  }

  const patch = structuredClone(base);
  varyOperators(patch, bankSeed, catalog, slot, strength);
  varyComposition(patch, bankSeed, slot, strength);
  varyRoutes(patch, bankSeed, catalog, slot, strength);
  varyPalette(patch, bankSeed, slot, strength);

  const detail = summarizeDetail(base, patch, catalog);
  if (validatePatch(patch, metaCatalog).length > 0) {
    return { slot, label, detail: 'base', strength, patch: structuredClone(base) };
  }
  return { slot, label, detail, strength, patch };
}

function varyOperators(
  patch: VisualPatch,
  bankSeed: string,
  catalog: InlineGeneratorCatalog,
  slot: number,
  strength: number,
): void {
  const adoptP = 0.35 + 0.4 * strength;
  for (const op of patch.operators) {
    const gen = catalog.get(op.generatorId);
    if (!gen) continue;
    for (const def of gen.def.parameters) {
      varyParam(op, def, bankSeed, slot, strength, adoptP);
    }
  }
}

function varyParam(
  op: VisualOperator,
  def: ParameterDefinition,
  bankSeed: string,
  slot: number,
  strength: number,
  adoptP: number,
): void {
  const current = op.parameters[def.id];
  if (current === undefined) return;
  const ns = `deck:v${slot}:${op.id}:${def.id}`;

  if (def.kind === 'bool' || def.kind === 'enum') {
    if (strength < 0.6) return;
    if (rand(bankSeed, ns, 0) >= 0.25) return;
    if (def.kind === 'bool') {
      op.parameters[def.id] = rand(bankSeed, ns, 1) < 0.5;
      return;
    }
    const options = def.options ?? [];
    if (options.length === 0) return;
    const idx = Math.min(options.length - 1, Math.floor(rand(bankSeed, ns, 1) * options.length));
    op.parameters[def.id] = options[idx]!;
    return;
  }

  if (rand(bankSeed, ns, 0) >= adoptP) return;
  if (typeof current !== 'number' || !Number.isFinite(current)) return;
  const min = def.min;
  const max = def.max;
  if (typeof min !== 'number' || typeof max !== 'number') return;
  const unit = rand(bankSeed, ns, 1) * 2 - 1;

  if (isHueParam(def)) {
    op.parameters[def.id] = wrapHue(current + strength * unit * 180);
    return;
  }

  const raw = current + unit * strength * (max - min);
  if (def.kind === 'int') {
    op.parameters[def.id] = clamp(Math.round(raw), min, max);
    return;
  }
  op.parameters[def.id] = clamp(raw, min, max);
}

function varyComposition(
  patch: VisualPatch,
  bankSeed: string,
  slot: number,
  strength: number,
): void {
  const unit = rand(bankSeed, `deck:v${slot}:composition:speed`, 1) * 2 - 1;
  // clamp 範囲は base 基準で広げる。定数 0.3..1 のままだと base がその外
  // （例: 2.5）のとき全バリエーションが端に潰れて BASE と別物になる。
  const base = patch.composition.speed;
  patch.composition.speed = clamp(
    base * (1 + unit * 0.5 * strength),
    Math.min(0.3, base),
    Math.max(1, base),
  );
}

function varyRoutes(
  patch: VisualPatch,
  bankSeed: string,
  catalog: InlineGeneratorCatalog,
  slot: number,
  strength: number,
): void {
  for (let i = 0; i < patch.routes.length; i++) {
    const route = patch.routes[i]!;
    const unit = rand(bankSeed, `deck:v${slot}:routes:${i}:amount`, 1) * 2 - 1;
    const scaled = route.amount * (1 + unit * 0.4 * strength);
    const cap = routeAmountCap(route.target, patch, catalog);
    // 符号は base のまま（動かすのは振り幅だけ）。負の amount を 0 に潰さない。
    const magnitude = Math.min(Math.abs(scaled), cap ?? Infinity);
    route.amount = route.amount < 0 ? -magnitude : magnitude;
  }
}

/**
 * derive.ts の `buildRoutes` が敷いている amount の上限を再現する。
 * 動き系 target は span * {@link MOTION_RATIO_MAX}、それ以外は span まで。
 * target のパラメータを解決できないときは undefined（上限なし）。
 */
function routeAmountCap(
  target: string,
  patch: VisualPatch,
  catalog: InlineGeneratorCatalog,
): number | undefined {
  const dot = target.indexOf('.');
  if (dot <= 0) return undefined;
  const opId = target.slice(0, dot);
  const paramId = target.slice(dot + 1);
  const op = patch.operators.find((o) => o.id === opId);
  if (!op) return undefined;
  const gen = catalog.get(op.generatorId);
  const def = gen?.def.parameters.find((p) => p.id === paramId);
  if (!def || typeof def.min !== 'number' || typeof def.max !== 'number') return undefined;
  const span = def.max - def.min;
  if (!(span > 0)) return undefined;
  return span * (MOTION_TARGET_PARAMS.has(paramId) ? MOTION_RATIO_MAX : 1);
}

function varyPalette(patch: VisualPatch, bankSeed: string, slot: number, strength: number): void {
  const pal = patch.palette;
  const hueUnit = rand(bankSeed, `deck:v${slot}:palette:hueOffset`, 1) * 2 - 1;
  pal.hueOffset = wrapHue(pal.hueOffset + strength * hueUnit * 180);

  const satUnit = rand(bankSeed, `deck:v${slot}:palette:saturation`, 1) * 2 - 1;
  pal.saturation = clamp(pal.saturation + satUnit * 15 * strength, 0, 100);

  const litUnit = rand(bankSeed, `deck:v${slot}:palette:lightness`, 1) * 2 - 1;
  pal.lightness = clamp(pal.lightness + litUnit * 15 * strength, 0, 100);
}

interface NamedDelta {
  text: string;
  score: number;
}

function summarizeDetail(
  base: VisualPatch,
  patch: VisualPatch,
  catalog: InlineGeneratorCatalog,
): string {
  const deltas: NamedDelta[] = [];

  for (let i = 0; i < patch.operators.length; i++) {
    const op = patch.operators[i]!;
    const baseOp = base.operators[i];
    if (!baseOp || baseOp.id !== op.id) continue;
    const gen = catalog.get(op.generatorId);
    if (!gen) continue;
    for (const def of gen.def.parameters) {
      const from = baseOp.parameters[def.id];
      const to = op.parameters[def.id];
      if (from === undefined || to === undefined || from === to) continue;
      const delta = paramDelta(def, from, to);
      if (delta) deltas.push(delta);
    }
  }

  pushNumericDelta(deltas, 'speed', base.composition.speed, patch.composition.speed, 0.7, 'mul');

  for (let i = 0; i < patch.routes.length; i++) {
    const from = base.routes[i];
    const to = patch.routes[i];
    if (!from || !to) continue;
    if (from.amount === to.amount) continue;
    const span = Math.max(Math.abs(from.amount), 1e-6);
    deltas.push({
      text: `amount×${fmtNum(to.amount / (from.amount === 0 ? 1 : from.amount), 2)}`,
      score: Math.abs(to.amount - from.amount) / span,
    });
  }

  const hueD = shortestHueDelta(base.palette.hueOffset, patch.palette.hueOffset);
  if (hueD !== 0) {
    deltas.push({ text: `hueOffset${fmtSigned(hueD, 0)}`, score: Math.abs(hueD) / 180 });
  }
  pushNumericDelta(deltas, 'sat', base.palette.saturation, patch.palette.saturation, 100, 'add');
  pushNumericDelta(deltas, 'lit', base.palette.lightness, patch.palette.lightness, 100, 'add');

  deltas.sort((a, b) => b.score - a.score);
  const top = deltas.filter((d) => d.score > 1e-9).slice(0, 2);
  if (top.length === 0) return 'vary';
  return top.map((d) => d.text).join(' · ');
}

function paramDelta(
  def: ParameterDefinition,
  from: number | string | boolean,
  to: number | string | boolean,
): NamedDelta | null {
  if (def.kind === 'bool' || def.kind === 'enum') {
    return { text: `${def.id}=${String(to)}`, score: 1 };
  }
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  if (isHueParam(def)) {
    const d = shortestHueDelta(from, to);
    if (d === 0) return null;
    return { text: `${def.id}${fmtSigned(d, 0)}`, score: Math.abs(d) / 180 };
  }
  const span =
    typeof def.min === 'number' && typeof def.max === 'number' && def.max !== def.min
      ? def.max - def.min
      : 1;
  return {
    text: `${def.id}${fmtSigned(to - from, 2)}`,
    score: Math.abs(to - from) / Math.abs(span),
  };
}

function pushNumericDelta(
  deltas: NamedDelta[],
  name: string,
  from: number,
  to: number,
  span: number,
  style: 'add' | 'mul',
): void {
  if (from === to) return;
  // 'mul' は倍率表示。絶対値を出すと「speed×0.6」が新しい値なのか倍率なのか
  // 読めなくなる（route の amount× と同じく to/from を出す）。
  const text =
    style === 'mul'
      ? `${name}×${fmtNum(to / (from === 0 ? 1 : from), 2)}`
      : `${name}${fmtSigned(to - from, 2)}`;
  deltas.push({ text, score: Math.abs(to - from) / span });
}

function isHueParam(def: ParameterDefinition): boolean {
  return def.kind === 'number' && def.min === 0 && def.max === 360;
}

/** hue は範囲 clamp だと 0/360 際で偏るので wrap する。 */
function wrapHue(x: number): number {
  return ((x % 360) + 360) % 360;
}

function shortestHueDelta(from: number, to: number): number {
  let d = wrapHue(to) - wrapHue(from);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function fmtNum(n: number, digits: number): string {
  return String(Number(n.toFixed(digits)));
}

function fmtSigned(n: number, digits: number): string {
  const v = Number(n.toFixed(digits));
  return `${v > 0 ? '+' : ''}${v}`;
}
