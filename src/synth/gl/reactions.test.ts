import { describe, expect, it } from 'vitest';
import {
  ALL_REACTIONS,
  allowsMultiTap,
  MULTITAP_MAX_FILL,
  rawFillCost,
  reactionNamespace,
  reactionsByIds,
  REACTION_NS_CONST,
  selectReactions,
  topologyKey,
  type Reaction,
} from './reactions';
import { allGeneratorDefinitions, inlineCatalog } from '../generators';
import { derivePatch } from '../derive';
import { pickWeightedByRendezvous } from '../rng';
import type { GeneratorDefinition } from '../types';

const KEY = 'src0:grid@1|mat0:neon@1';
const DEFS = allGeneratorDefinitions();

function defOf(id: string): GeneratorDefinition {
  const def = DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`no such generator: ${id}`);
  return def;
}

describe('synth/gl/reactions catalog', () => {
  it('ids are unique and both stages are populated', () => {
    const ids = ALL_REACTIONS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ALL_REACTIONS.filter((r) => r.stage === 'coord').length).toBeGreaterThanOrEqual(4);
    expect(ALL_REACTIONS.filter((r) => r.stage === 'color').length).toBeGreaterThanOrEqual(4);
  });

  it('every reaction has a positive weight and a label', () => {
    for (const r of ALL_REACTIONS) {
      expect(r.weight, r.id).toBeGreaterThan(0);
      expect(r.label.length, r.id).toBeGreaterThan(0);
    }
  });

  /**
   * 無音での恒等性は目視では守れないので、形の上で担保する。ゲートに使ってよい
   * のは無音で 0 になる値（rPunch / rEnergy と、それらを掛けた帯域）だけ。
   * `uBeat` はテンポグリッドのフリーホイールで無音でも脈打つので直接は読ませない。
   */
  it('no reaction reads a raw audio uniform — only the silence-gated drives', () => {
    for (const r of ALL_REACTIONS) {
      for (const raw of ['uBeat', 'uLevel', 'uPunch', 'uEnergy']) {
        expect(r.glsl.includes(raw), `${r.id} reads ${raw} directly`).toBe(false);
      }
      // 帯域は必ず rBass/rMid/rTreble 経由（= uEnergy でゲート済み）で読む。
      expect(/\buBass\b|\buMid\b|\buTreble\b/.test(r.glsl), `${r.id} reads a raw band`).toBe(false);
    }
  });

  it('every reaction is driven by the beat or the level, never by bare time alone', () => {
    for (const r of ALL_REACTIONS) {
      expect(/\brPunch\b|\brEnergy\b|\brBass\b|\brMid\b|\brTreble\b/.test(r.glsl), r.id).toBe(true);
    }
  });

  it('multi-tap reactions gate their extra pipeline evaluations behind the beat', () => {
    for (const r of ALL_REACTIONS.filter((x) => x.multiTap)) {
      expect(r.glsl, r.id).toContain('synthPipeline(');
      expect(r.glsl, r.id).toMatch(/if \(rPunch > /);
    }
    // ...and nothing else calls the pipeline again.
    for (const r of ALL_REACTIONS.filter((x) => !x.multiTap)) {
      expect(r.glsl.includes('synthPipeline('), r.id).toBe(false);
    }
  });

  it('randomised reactions use the seeded namespace constant, not a bare hash', () => {
    for (const r of ALL_REACTIONS) {
      if (!r.glsl.includes('synthRand')) continue;
      expect(r.glsl, r.id).toContain(`synthRand(uSeed, ${REACTION_NS_CONST}`);
    }
  });

  it('coord snippets touch p, color snippets touch col', () => {
    for (const r of ALL_REACTIONS) {
      if (r.stage === 'coord') {
        expect(/\bp(\.[xy])?\s*(\*|\+)?=/.test(r.glsl), r.id).toBe(true);
      } else {
        expect(/\bcol(\.\w+)?\s*(\*|\+)?=/.test(r.glsl), r.id).toBe(true);
      }
    }
  });
});

describe('synth/gl/reactions selection', () => {
  it('always yields exactly one color reaction and 1–2 coord reactions', () => {
    for (let i = 0; i < 300; i++) {
      const sel = selectReactions(`key-${i}`, { allowMultiTap: true });
      expect(sel.color.length).toBe(1);
      expect(sel.color[0]!.stage).toBe('color');
      expect(sel.coord.length).toBeGreaterThanOrEqual(1);
      expect(sel.coord.length).toBeLessThanOrEqual(2);
      expect(sel.coord.every((r) => r.stage === 'coord')).toBe(true);
      if (sel.coord.length === 2) expect(sel.coord[0]!.id).not.toBe(sel.coord[1]!.id);
    }
  });

  it('is deterministic for a given key', () => {
    const a = selectReactions(KEY, { allowMultiTap: true });
    const b = selectReactions(KEY, { allowMultiTap: true });
    expect(a.coord.map((r) => r.id)).toEqual(b.coord.map((r) => r.id));
    expect(a.color.map((r) => r.id)).toEqual(b.color.map((r) => r.id));
  });

  it('allowMultiTap: false removes the extra-pass reactions from the pool', () => {
    for (let i = 0; i < 300; i++) {
      const sel = selectReactions(`key-${i}`, { allowMultiTap: false });
      expect(sel.color.every((r) => !r.multiTap)).toBe(true);
    }
  });

  /** 単調さの再発防止: どのリアクションも「まず出ない」状態にならないこと。 */
  it('spreads across the whole catalog over many topologies', () => {
    const seen = new Map<string, number>();
    const N = 600;
    for (let i = 0; i < N; i++) {
      const sel = selectReactions(`key-${i}`, { allowMultiTap: true });
      for (const r of [...sel.coord, ...sel.color]) {
        seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
      }
    }
    for (const r of ALL_REACTIONS) {
      expect(seen.get(r.id) ?? 0, `${r.id} never selected in ${N} draws`).toBeGreaterThan(0.02 * N);
    }
  });

  /**
   * ランデブー選択の性質: カタログに 1 個足しても、その新顔が勝つ場合以外は
   * 既存の選択が変わらない。リアクションを 1 つ追加するたびに全 Patch の演出が
   * 総入れ替えになると、seed とルックの結び付きが毎リリース壊れてしまう。
   */
  it('adding a reaction to the pool leaves most existing picks alone', () => {
    const colorPool = ALL_REACTIONS.filter((r) => r.stage === 'color');
    const extra: Reaction = {
      id: 'testOnlyExtra',
      stage: 'color',
      weight: 2,
      label: 'test',
      glsl: '  col.rgb *= 1.0 + rPunch;',
    };
    const pick = (key: string, pool: readonly Reaction[]) =>
      pickWeightedByRendezvous(
        key,
        'react:color:0',
        pool,
        (r) => r.id,
        (r) => r.weight,
      ).id;

    let changed = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const key = `key-${i}`;
      // The live selection must agree with the same draw run standalone.
      expect(pick(key, colorPool)).toBe(selectReactions(key, { allowMultiTap: true }).color[0]!.id);
      if (pick(key, colorPool) !== pick(key, [...colorPool, extra])) changed += 1;
    }
    // 1/(n+1) 前後に収まっていればよい。上限は余裕を持たせてある。
    expect(changed / N).toBeLessThan(2 / (colorPool.length + 1));
  });
});

describe('synth/gl/reactions budget', () => {
  it('rawFillCost adds up costClass weight × relativeFill', () => {
    const weight = { micro: 1, light: 3, medium: 10, heavy: 30 } as const;
    const defs = [defOf('grid'), defOf('neon')];
    const expected = defs.reduce((sum, d) => sum + weight[d.costClass] * d.cost.relativeFill, 0);
    expect(rawFillCost(defs)).toBeCloseTo(expected, 6);
  });

  it('a heavy generator disqualifies multi-tap however cheap the rest is', () => {
    const heavy = DEFS.find((d) => d.costClass === 'heavy');
    expect(
      heavy,
      'catalog must have a heavy generator for this test to prove anything',
    ).toBeTruthy();
    expect(allowsMultiTap([heavy!])).toBe(false);
  });

  it('a light stack under the fill ceiling qualifies', () => {
    const defs = [defOf('grid'), defOf('neon')];
    expect(rawFillCost(defs)).toBeLessThanOrEqual(MULTITAP_MAX_FILL);
    expect(allowsMultiTap(defs)).toBe(true);
  });

  it('derived patches land on both sides of the ceiling (the gate is not vacuous)', () => {
    let allowed = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const patch = derivePatch(`fill-${i}`, { catalog: inlineCatalog });
      const defs = patch.operators.map((op) => defOf(op.generatorId));
      if (allowsMultiTap(defs)) allowed += 1;
    }
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(N);
  });
});

describe('synth/gl/reactions keys', () => {
  it('topologyKey ignores parameters and depends on the operator graph', () => {
    const a = topologyKey([
      { id: 'src0', generatorId: 'grid', generatorVersion: 1 },
      { id: 'mat0', generatorId: 'neon', generatorVersion: 1 },
    ]);
    expect(a).toBe(KEY);
    expect(
      topologyKey([
        { id: 'src0', generatorId: 'stripes', generatorVersion: 1 },
        { id: 'mat0', generatorId: 'neon', generatorVersion: 1 },
      ]),
    ).not.toBe(a);
  });

  it('reactionNamespace is a stable u32', () => {
    const ns = reactionNamespace(KEY);
    expect(Number.isInteger(ns)).toBe(true);
    expect(ns).toBeGreaterThanOrEqual(0);
    expect(ns).toBeLessThanOrEqual(0xffffffff);
    expect(reactionNamespace(KEY)).toBe(ns);
    expect(reactionNamespace(`${KEY}|x`)).not.toBe(ns);
  });

  it('reactionsByIds splits by stage and rejects unknown ids', () => {
    const sel = reactionsByIds(['sliceShift', 'hueSlam']);
    expect(sel.coord.map((r) => r.id)).toEqual(['sliceShift']);
    expect(sel.color.map((r) => r.id)).toEqual(['hueSlam']);
    expect(() => reactionsByIds(['sliceShift', 'nope'])).toThrow(/unknown audio reaction/);
  });
});
