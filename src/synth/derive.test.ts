import { describe, expect, it } from 'vitest';
import { createCatalog } from './catalog';
import { DEFAULT_BUDGETS, estimateCost, fitsBudget } from './cost';
import { derivePatch, rerollPatch, SAFE_TARGET_PARAMS } from './derive';
import { createInlineCatalog, inlineCatalog } from './generators';
import type { InlineGenerator } from './generators/types';
import { CURRENT_SCHEMA_VERSION, serializePatch } from './schema';
import type { QualityTier, VisualOperator, VisualPatch } from './types';
import { validatePatch } from './validate';

const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high'];

/** Generators the tier filter is there for: heavy is banned outright at low. */
const HEAVY_SOURCE_IDS = inlineCatalog
  .all()
  .filter(
    (g) =>
      g.def.category === 'source' &&
      g.def.costClass === 'heavy' &&
      (g.def.textures?.length ?? 0) === 0,
  )
  .map((g) => g.def.id);

/**
 * Sources the seed gacha may pick. Generators with a texture input are excluded
 * on purpose: a picture is something the operator brings deliberately, so derive
 * must never make one appear (or vanish) on its own.
 */
const SOURCE_IDS = inlineCatalog
  .all()
  .filter((g) => g.def.category === 'source' && (g.def.textures?.length ?? 0) === 0)
  .map((g) => g.def.id);

/** Every generator that declares a texture slot — none of these may be derived. */
const TEXTURED_IDS = inlineCatalog
  .all()
  .filter((g) => (g.def.textures?.length ?? 0) > 0)
  .map((g) => g.def.id);

/**
 * Sources used by derive buildRoutes.
 *
 * `audio:beatPhase` / `audio:barPhase` は意図的に**含まない**: 無音でも回り
 * 続けるノコギリ波なので、変調に使っても音に反応したことにならない。
 * 拍系は無音で 0 に落ちる `audio:beatIntensity` のみ（`audio:gridPulse` は
 * ブレイク中もフリーホイールするので derive では使わない）。
 *
 * `swell:group` / `swell:set` は音から生やしたうねりで、無音では構造的に 0 に
 * 落ちるので同じ安全性を満たす。`swell:wave`（速すぎる）と `swell:surge`
 * （下限が高く変調として動かない）は候補プールに入れていない。
 */
const ROUTE_AUDIO_SOURCES = new Set([
  'audio:bass',
  'audio:mid',
  'audio:treble',
  'audio:level',
  'audio:beatIntensity',
  'swell:group',
  'swell:set',
]);

function defCatalogFrom(catalog = inlineCatalog) {
  return createCatalog(catalog.all().map((g) => g.def));
}

function primarySourceId(patch: VisualPatch): string | undefined {
  const sources = patch.operators.filter((op) => op.id.startsWith('src'));
  const first = sources[0] ?? patch.operators.find((op) => op.id === 'src0');
  return first?.generatorId;
}

function sourceOps(patch: VisualPatch): VisualOperator[] {
  return patch.operators.filter((op) => op.id.startsWith('src'));
}

/** The part of an operator that must survive a reroll unchanged: its "topology" identity. */
function topologyOf(
  patch: VisualPatch,
): Array<Pick<VisualOperator, 'id' | 'generatorId' | 'generatorVersion'>> {
  return patch.operators.map((op) => ({
    id: op.id,
    generatorId: op.generatorId,
    generatorVersion: op.generatorVersion,
  }));
}

describe('synth/derive', () => {
  describe('public API / defaults', () => {
    it('derivePatch works with default qualityTier (medium)', () => {
      const patch = derivePatch('default-tier-seed', { catalog: inlineCatalog });
      expect(patch.qualityTier).toBe('medium');
      expect(patch.schemaVersion).toBe(1);
      expect(patch.seed).toBe('default-tier-seed');
      expect(patch.routes.length).toBeGreaterThanOrEqual(1);
      expect(patch.routes.length).toBeLessThanOrEqual(4);
    });
  });

  describe('determinism', () => {
    it('same seed → same serializePatch string twice', () => {
      const seed = 'neon-tiger-042';
      const a = serializePatch(derivePatch(seed, { catalog: inlineCatalog }));
      const b = serializePatch(derivePatch(seed, { catalog: inlineCatalog }));
      expect(a).toBe(b);
    });
  });

  describe('modulation routes', () => {
    it('routes length is 0–4 and usually ≥1 with full catalog', () => {
      let withRoutes = 0;
      for (let i = 0; i < 200; i++) {
        const patch = derivePatch(`routes-len-${i}`, { catalog: inlineCatalog });
        expect(patch.routes.length).toBeGreaterThanOrEqual(0);
        expect(patch.routes.length).toBeLessThanOrEqual(4);
        if (patch.routes.length >= 1) withRoutes += 1;
      }
      expect(withRoutes).toBeGreaterThan(180);
    });

    it('grows swell routes for some seeds, and keeps them out of the pulse smoothing band', () => {
      let swellRoutes = 0;
      for (let i = 0; i < 200; i++) {
        for (const r of derivePatch(`swell-route-${i}`, { catalog: inlineCatalog }).routes) {
          if (!r.source.startsWith('swell:')) continue;
          swellRoutes += 1;
          // 候補プールに入れたのは group / set の 2 本だけ。
          expect(['swell:group', 'swell:set']).toContain(r.source);
          // pulse: false なので拍用の 0.05〜0.15 秒ではなく 0.4〜1.6 秒側が掛かる。
          expect(r.smoothing).toBeGreaterThanOrEqual(0.4);
          expect(r.smoothing).toBeLessThanOrEqual(1.6);
        }
      }
      // weight 3 / 合計 15 なので、200 seed 回せば必ず何本かは生える。
      expect(swellRoutes).toBeGreaterThan(10);
    });

    it('all routes use allowed audio sources, unique targets, finite amount, plausible smoothing', () => {
      for (let i = 0; i < 100; i++) {
        const patch = derivePatch(`routes-shape-${i}`, { catalog: inlineCatalog });
        const targets = new Set<string>();
        for (const route of patch.routes) {
          expect(ROUTE_AUDIO_SOURCES.has(route.source), `source ${route.source}`).toBe(true);
          expect(targets.has(route.target), `duplicate target ${route.target}`).toBe(false);
          targets.add(route.target);
          expect(Number.isFinite(route.amount)).toBe(true);
          expect(route.amount).not.toBe(0);
          // 拍系は 0.05–0.15、帯域系は 0.4–1.6。
          expect(route.smoothing).toBeGreaterThanOrEqual(0.05);
          expect(route.smoothing).toBeLessThanOrEqual(1.6);
        }
      }
    });

    /**
     * 「音に反応して画が消える」ことが起きない、という不変条件のテスト。
     * クラブの大音量下でずっと真っ暗、という事故を構造的に防ぐ。
     */
    it('audio can only ever add: every route is unipolar with a positive amount', () => {
      for (let i = 0; i < 200; i++) {
        const patch = derivePatch(`routes-additive-${i}`, { catalog: inlineCatalog });
        for (const route of patch.routes) {
          expect(route.polarity, `${route.source} → ${route.target}`).toBe('unipolar');
          expect(route.amount, `${route.source} → ${route.target}`).toBeGreaterThan(0);
        }
      }
    });

    it('never modulates a parameter that can blank the picture', () => {
      // 上げると絵が消える / 潰れる方向のパラメータ。許可リスト運用なので
      // ここに挙げたものは自動的に外れるはずだが、代表例を明示的に守る。
      const BLANKING = new Set([
        'threshold',
        'gate',
        'dropout',
        'fade',
        'invert',
        'breakup',
        'corruption',
        'escape',
        'duty',
        'litRatio',
        'openness',
        'mix',
        'level',
        'levels',
      ]);
      for (let i = 0; i < 200; i++) {
        const patch = derivePatch(`routes-safe-${i}`, { catalog: inlineCatalog });
        for (const route of patch.routes) {
          const paramId = route.target.slice(route.target.indexOf('.') + 1);
          expect(BLANKING.has(paramId), `route targets "${paramId}"`).toBe(false);
        }
      }
    });

    it('same seed yields identical routes', () => {
      const seed = 'route-det-seed';
      const a = derivePatch(seed, { catalog: inlineCatalog }).routes;
      const b = derivePatch(seed, { catalog: inlineCatalog }).routes;
      expect(a).toEqual(b);
    });
  });

  describe('diversity', () => {
    it('different seeds → different patches (100 seeds)', () => {
      const serials = new Set<string>();
      const sourceIds = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const patch = derivePatch(`diversity-${i}`, { catalog: inlineCatalog });
        serials.add(serializePatch(patch));
        for (const op of sourceOps(patch)) {
          sourceIds.add(op.generatorId);
        }
      }
      expect(serials.size).toBeGreaterThan(1);
      expect(sourceIds.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe('composition.speed (patch motion speed)', () => {
    it('never exceeds 1: no derived patch moves faster than the old flat rate', () => {
      for (let i = 0; i < 200; i++) {
        const { composition } = derivePatch(`comp-speed-${i}`, { catalog: inlineCatalog });
        expect(composition.speed).toBeGreaterThan(0);
        expect(composition.speed).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('always valid & in budget', () => {
    it('~200 seeds: validatePatch returns [] and fitsBudget returns []', () => {
      const catalog = defCatalogFrom();
      for (let i = 0; i < 200; i++) {
        const seed = `valid-budget-${i}`;
        const patch = derivePatch(seed, { catalog: inlineCatalog });
        const vIssues = validatePatch(patch, catalog);
        const bIssues = fitsBudget(
          estimateCost(patch, catalog),
          DEFAULT_BUDGETS[patch.qualityTier],
        );
        expect(vIssues, `validate failed for ${seed}: ${JSON.stringify(vIssues)}`).toEqual([]);
        expect(bIssues, `budget failed for ${seed}: ${JSON.stringify(bIssues)}`).toEqual([]);
      }
    });
  });

  describe('source coverage', () => {
    it('all catalog sources appear across many seeds', () => {
      const seen = new Set<string>();
      const maxSeeds = 8000;
      const target = new Set(SOURCE_IDS);
      for (let i = 0; i < maxSeeds && seen.size < target.size; i++) {
        const patch = derivePatch(`source-cover-${i}`, { catalog: inlineCatalog });
        for (const op of sourceOps(patch)) {
          if (target.has(op.generatorId)) seen.add(op.generatorId);
        }
      }
      for (const id of SOURCE_IDS) {
        expect(seen.has(id), `source "${id}" never selected in ${maxSeeds} seeds`).toBe(true);
      }
    });
  });

  describe('texture generators are never derived', () => {
    it('catalog actually has at least one (otherwise this test proves nothing)', () => {
      expect(TEXTURED_IDS).toContain('stamp');
    });

    it('2000 seeds never select a generator with a texture slot', () => {
      const textured = new Set(TEXTURED_IDS);
      const offenders: string[] = [];
      for (let i = 0; i < 2000; i++) {
        const seed = `no-texture-${i}`;
        const patch = derivePatch(seed, { catalog: inlineCatalog });
        for (const op of patch.operators) {
          if (textured.has(op.generatorId)) offenders.push(`${seed}: ${op.generatorId}`);
        }
        // A derived patch never carries image references either.
        expect(patch.images, `seed ${seed} produced images`).toBeUndefined();
      }
      expect(offenders, `derived patches contained texture generators: ${offenders[0]}`).toEqual(
        [],
      );
    });
  });

  describe('source distribution (report)', () => {
    it('logs counts per source id over 300 seeds', () => {
      const counts: Record<string, number> = Object.fromEntries(SOURCE_IDS.map((id) => [id, 0]));
      for (let i = 0; i < 300; i++) {
        const patch = derivePatch(`dist-${i}`, { catalog: inlineCatalog });
        for (const op of sourceOps(patch)) {
          counts[op.generatorId] = (counts[op.generatorId] ?? 0) + 1;
        }
      }
      const report = Object.entries(counts)
        .map(([id, n]) => `${id}=${n}`)
        .join(', ');
      console.log(`[derive] source distribution over 300 seeds (operator occurrences): ${report}`);
      // soft-check total mass and that catalog sources are tracked.
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(300); // at least 1 source each
      expect(Object.keys(counts).length).toBe(SOURCE_IDS.length);
    });
  });

  describe('rendezvous stability', () => {
    it('removing one source (cells): seeds that did not pick cells keep the same src0', () => {
      const full = inlineCatalog;
      const reduced = createInlineCatalog(full.all().filter((g) => g.def.id !== 'cells'));

      const n = 800;
      let compared = 0;
      let changedAmongNonCells = 0;
      let fullPickedCells = 0;
      let overallChanged = 0;

      for (let i = 0; i < n; i++) {
        const seed = `rendezvous-rm-cells-${i}`;
        const fullPatch = derivePatch(seed, { catalog: full });
        const reducedPatch = derivePatch(seed, { catalog: reduced });
        const fullSrc = primarySourceId(fullPatch);
        const reducedSrc = primarySourceId(reducedPatch);
        expect(fullSrc).toBeDefined();
        expect(reducedSrc).toBeDefined();

        if (fullSrc !== reducedSrc) overallChanged += 1;

        if (fullSrc === 'cells') {
          fullPickedCells += 1;
        } else {
          compared += 1;
          if (fullSrc !== reducedSrc) changedAmongNonCells += 1;
        }
      }

      const overallRate = overallChanged / n;
      const nonCellsChangeRate = compared > 0 ? changedAmongNonCells / compared : 0;
      const cellsPickRate = fullPickedCells / n;

      console.log(
        `[derive] rendezvous remove "cells" (n=${n}): ` +
          `overallChange=${(overallRate * 100).toFixed(2)}%, ` +
          `nonCellsSrc0Change=${(nonCellsChangeRate * 100).toFixed(2)}%, ` +
          `fullPickedCellsAsSrc0=${(cellsPickRate * 100).toFixed(2)}%`,
      );

      // Seeds that did not select the removed generator must stay put.
      expect(
        changedAmongNonCells,
        `expected 0 changes among non-cells winners, got ${changedAmongNonCells}/${compared}`,
      ).toBe(0);

      // Overall change should be well under naive reindex (~50%+); theoretically ~ fraction that picked cells.
      expect(overallRate).toBeLessThan(0.5);
      expect(overallRate).toBeGreaterThan(0); // some seeds did use cells
    });

    it('adding a fake extra source: change rate ≈ 1/(n+1) and low', () => {
      const fullSources = inlineCatalog.all().filter((g) => g.def.category === 'source');
      const nSources = fullSources.length;
      const fake: InlineGenerator = {
        def: {
          id: 'fake-source-zz',
          version: 1,
          category: 'source',
          costClass: 'micro',
          impl: 'inline',
          output: 'field',
          tags: {},
          parameters: [
            {
              id: 'amount',
              label: 'Amount',
              kind: 'number',
              min: 0,
              max: 1,
              default: 0.5,
              modulatable: true,
            },
          ],
          cost: { passes: 0, relativeFill: 0.1, stateful: false },
        },
        emit: () => 'float fake(vec2 p){return 0.0;}',
      };

      const withExtra = createInlineCatalog([...inlineCatalog.all(), fake]);
      const sample = 1000;
      let changed = 0;
      let pickedFake = 0;

      for (let i = 0; i < sample; i++) {
        const seed = `rendezvous-add-fake-${i}`;
        const basePatch = derivePatch(seed, { catalog: inlineCatalog });
        const extraPatch = derivePatch(seed, { catalog: withExtra });
        const baseSrc = primarySourceId(basePatch)!;
        const extraSrc = primarySourceId(extraPatch)!;
        if (baseSrc !== extraSrc) changed += 1;
        if (extraSrc === fake.def.id) pickedFake += 1;
      }

      const changeRate = changed / sample;
      const fakeRate = pickedFake / sample;
      const expected = 1 / (nSources + 1);

      console.log(
        `[derive] rendezvous add fake source (n=${sample}, baseSources=${nSources}): ` +
          `src0Change=${(changeRate * 100).toFixed(2)}%, ` +
          `pickedFakeAsSrc0=${(fakeRate * 100).toFixed(2)}%, ` +
          `theory≈${(expected * 100).toFixed(2)}%`,
      );

      // Should be clearly better than reindex chaos; near 1/(n+1).
      expect(changeRate).toBeLessThan(0.45);
      expect(changeRate).toBeGreaterThan(expected * 0.4);
      // Fake win rate as primary should also be in a plausible band around 1/(n+1).
      expect(fakeRate).toBeGreaterThan(expected * 0.4);
      expect(fakeRate).toBeLessThan(0.45);
    });
  });

  describe('tier-aware candidate filter', () => {
    it('the catalog really has heavy sources (otherwise these tests prove nothing)', () => {
      expect(HEAVY_SOURCE_IDS.length).toBeGreaterThan(0);
      expect(HEAVY_SOURCE_IDS).toContain('sdfTunnel');
      // …and low tier really bans them, so the filter has something to do.
      expect(DEFAULT_BUDGETS.low.maxHeavyGenerators).toBe(0);
    });

    it('every quality tier × 400 seeds: derivePatch never throws and stays in budget', () => {
      const catalog = defCatalogFrom();
      const failures: string[] = [];

      for (const tier of QUALITY_TIERS) {
        for (let i = 0; i < 400; i++) {
          const seed = `tier-sweep-${tier}-${i}`;
          try {
            const patch = derivePatch(seed, { catalog: inlineCatalog, qualityTier: tier });
            expect(patch.qualityTier).toBe(tier);
            const vIssues = validatePatch(patch, catalog);
            const bIssues = fitsBudget(estimateCost(patch, catalog), DEFAULT_BUDGETS[tier]);
            if (vIssues.length > 0 || bIssues.length > 0) {
              failures.push(
                `${seed}: validate=${JSON.stringify(vIssues)} budget=${JSON.stringify(bIssues)}`,
              );
            }
          } catch (e) {
            failures.push(`${seed}: threw ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      expect(
        failures.slice(0, 5),
        `${failures.length}/${QUALITY_TIERS.length * 400} tier×seed combinations failed`,
      ).toEqual([]);
    });

    it('heavy sources are absent at low tier and present at high tier', () => {
      const heavy = new Set(HEAVY_SOURCE_IDS);
      const lowOffenders: string[] = [];
      const seenAtHigh = new Set<string>();

      for (let i = 0; i < 1500; i++) {
        const seed = `heavy-tier-${i}`;
        for (const op of derivePatch(seed, { catalog: inlineCatalog, qualityTier: 'low' })
          .operators) {
          if (heavy.has(op.generatorId)) lowOffenders.push(`${seed}: ${op.generatorId}`);
        }
        for (const op of derivePatch(seed, { catalog: inlineCatalog, qualityTier: 'high' })
          .operators) {
          if (heavy.has(op.generatorId)) seenAtHigh.add(op.generatorId);
        }
      }

      expect(lowOffenders.slice(0, 3), 'heavy generator derived at low tier').toEqual([]);
      for (const id of HEAVY_SOURCE_IDS) {
        expect(seenAtHigh.has(id), `heavy source "${id}" never derived at high tier`).toBe(true);
      }
    });

    it('the rule is budget-general, not a costClass check (passes are filtered too)', () => {
      // light costClass, but 99 passes: over maxPasses at every tier.
      const passHog: InlineGenerator = {
        def: {
          id: 'pass-hog-zz',
          version: 1,
          category: 'source',
          costClass: 'light',
          impl: 'inline',
          output: 'field',
          tags: {},
          parameters: [],
          cost: { passes: 99, relativeFill: 0.1, stateful: false },
        },
        emit: (ctx) => `float ${ctx.fnName}(vec2 p) { return 0.0; }`,
      };
      const catalog = createInlineCatalog([...inlineCatalog.all(), passHog]);

      for (const tier of QUALITY_TIERS) {
        for (let i = 0; i < 300; i++) {
          const patch = derivePatch(`pass-hog-${tier}-${i}`, { catalog, qualityTier: tier });
          expect(
            patch.operators.some((op) => op.generatorId === 'pass-hog-zz'),
            `pass-hog-zz was derived at ${tier}`,
          ).toBe(false);
        }
      }
    });

    it('a catalog whose only sources are heavy has no low-tier pool at all', () => {
      const heavy = new Set(HEAVY_SOURCE_IDS);
      const heavyOnly = createInlineCatalog(
        inlineCatalog.all().filter((g) => g.def.category !== 'source' || heavy.has(g.def.id)),
      );
      // The filter empties the low-tier source pool, so derive fails with the
      // catalog-shaped error rather than the unstrippable-patch one.
      expect(() => derivePatch('heavy-only', { catalog: heavyOnly, qualityTier: 'low' })).toThrow(
        /need at least 1 source generator/,
      );
      expect(() =>
        derivePatch('heavy-only', { catalog: heavyOnly, qualityTier: 'high' }),
      ).not.toThrow();
    });
  });

  describe('structure', () => {
    it('operators are ordered Source → Field → Modifier → Material with expected id prefixes', () => {
      const catalog = defCatalogFrom();
      for (let i = 0; i < 50; i++) {
        const patch = derivePatch(`structure-${i}`, { catalog: inlineCatalog, qualityTier: 'low' });
        const ranks = patch.operators.map((op) => {
          const def = catalog.get(op.generatorId);
          expect(def).toBeDefined();
          return { source: 0, field: 1, modifier: 2, material: 3 }[def!.category];
        });
        for (let j = 1; j < ranks.length; j++) {
          expect(ranks[j]!).toBeGreaterThanOrEqual(ranks[j - 1]!);
        }
        expect(patch.operators.some((op) => op.id.startsWith('src'))).toBe(true);
        expect(patch.operators.some((op) => op.id.startsWith('mod'))).toBe(true);
        expect(patch.operators.some((op) => op.id.startsWith('mat'))).toBe(true);
      }
    });
  });

  describe('reroll', () => {
    const BASE_SEEDS = [
      'reroll-base-alpha',
      'reroll-base-bravo',
      'reroll-base-charlie',
      'reroll-base-delta',
      'reroll-base-echo',
      'reroll-base-foxtrot',
    ];

    it('preserves topology (id/generatorId/generatorVersion/order) across many starting seeds', () => {
      for (const baseSeed of BASE_SEEDS) {
        const original = derivePatch(baseSeed, { catalog: inlineCatalog });
        for (let i = 0; i < 10; i++) {
          const rerolled = rerollPatch(original, `${baseSeed}-reroll-${i}`, {
            catalog: inlineCatalog,
          });
          expect(topologyOf(rerolled), `base=${baseSeed} reroll=${i}`).toEqual(
            topologyOf(original),
          );
        }
      }
    });

    it('a full reroll usually changes palette, composition, and at least one operator parameter', () => {
      const n = 30;
      let paletteChanged = 0;
      let compositionChanged = 0;
      let anyParamChanged = 0;

      for (let i = 0; i < n; i++) {
        const baseSeed = `reroll-content-base-${i}`;
        const original = derivePatch(baseSeed, { catalog: inlineCatalog });
        const rerolled = rerollPatch(original, `reroll-content-next-${i}`, {
          catalog: inlineCatalog,
        });

        if (!deepEqual(rerolled.palette, original.palette)) paletteChanged++;
        if (!deepEqual(rerolled.composition, original.composition)) compositionChanged++;
        const paramsChanged = rerolled.operators.some((op, idx) => {
          const before = original.operators[idx]!;
          return !deepEqual(op.parameters, before.parameters);
        });
        if (paramsChanged) anyParamChanged++;
      }

      // "Usually" — not every draw has to move (a coordinate could coincidentally
      // repeat), but the overwhelming majority must, or the reroll isn't doing
      // its job. Mirrors the statistical style already used in this file
      // (e.g. "routes length is 0-4 and usually >=1").
      expect(paletteChanged, 'palette').toBeGreaterThan(n * 0.8);
      expect(compositionChanged, 'composition').toBeGreaterThan(n * 0.8);
      expect(anyParamChanged, 'parameters').toBeGreaterThan(n * 0.8);
    });

    describe('partial flags reroll only the selected category', () => {
      const n = 25;

      it('parameters: true (routes/palette/composition: false) — only parameters usually change', () => {
        let paramsChanged = 0;
        for (let i = 0; i < n; i++) {
          const baseSeed = `reroll-only-params-base-${i}`;
          const original = derivePatch(baseSeed, { catalog: inlineCatalog });
          const rerolled = rerollPatch(original, `reroll-only-params-next-${i}`, {
            catalog: inlineCatalog,
            parameters: true,
            routes: false,
            palette: false,
            composition: false,
          });

          expect(rerolled.routes, `seed ${i}`).toEqual(original.routes);
          expect(rerolled.palette, `seed ${i}`).toEqual(original.palette);
          expect(rerolled.composition, `seed ${i}`).toEqual(original.composition);
          expect(topologyOf(rerolled), `seed ${i}`).toEqual(topologyOf(original));

          const changed = rerolled.operators.some((op, idx) => {
            const before = original.operators[idx]!;
            return !deepEqual(op.parameters, before.parameters);
          });
          if (changed) paramsChanged++;
        }
        expect(paramsChanged, 'parameters actually changed').toBeGreaterThan(n * 0.8);
      });

      it('routes: true (parameters/palette/composition: false) — only routes usually change', () => {
        let routesChanged = 0;
        for (let i = 0; i < n; i++) {
          const baseSeed = `reroll-only-routes-base-${i}`;
          const original = derivePatch(baseSeed, { catalog: inlineCatalog });
          const rerolled = rerollPatch(original, `reroll-only-routes-next-${i}`, {
            catalog: inlineCatalog,
            parameters: false,
            routes: true,
            palette: false,
            composition: false,
          });

          expect(rerolled.palette, `seed ${i}`).toEqual(original.palette);
          expect(rerolled.composition, `seed ${i}`).toEqual(original.composition);
          expect(rerolled.operators, `seed ${i}`).toEqual(original.operators);

          if (!deepEqual(rerolled.routes, original.routes)) routesChanged++;
        }
        expect(routesChanged, 'routes actually changed').toBeGreaterThan(n * 0.8);
      });

      it('palette: true (parameters/routes/composition: false) — only palette usually changes', () => {
        let paletteChanged = 0;
        for (let i = 0; i < n; i++) {
          const baseSeed = `reroll-only-palette-base-${i}`;
          const original = derivePatch(baseSeed, { catalog: inlineCatalog });
          const rerolled = rerollPatch(original, `reroll-only-palette-next-${i}`, {
            catalog: inlineCatalog,
            parameters: false,
            routes: false,
            palette: true,
            composition: false,
          });

          expect(rerolled.routes, `seed ${i}`).toEqual(original.routes);
          expect(rerolled.composition, `seed ${i}`).toEqual(original.composition);
          expect(rerolled.operators, `seed ${i}`).toEqual(original.operators);

          if (!deepEqual(rerolled.palette, original.palette)) paletteChanged++;
        }
        expect(paletteChanged, 'palette actually changed').toBeGreaterThan(n * 0.8);
      });

      it('composition: true (parameters/routes/palette: false) — only composition usually changes', () => {
        let compositionChanged = 0;
        for (let i = 0; i < n; i++) {
          const baseSeed = `reroll-only-composition-base-${i}`;
          const original = derivePatch(baseSeed, { catalog: inlineCatalog });
          const rerolled = rerollPatch(original, `reroll-only-composition-next-${i}`, {
            catalog: inlineCatalog,
            parameters: false,
            routes: false,
            palette: false,
            composition: true,
          });

          expect(rerolled.routes, `seed ${i}`).toEqual(original.routes);
          expect(rerolled.palette, `seed ${i}`).toEqual(original.palette);
          expect(rerolled.operators, `seed ${i}`).toEqual(original.operators);

          if (!deepEqual(rerolled.composition, original.composition)) compositionChanged++;
        }
        expect(compositionChanged, 'composition actually changed').toBeGreaterThan(n * 0.8);
      });
    });

    it('is deterministic: same (patch, seed, opts) → identical serializePatch output', () => {
      const original = derivePatch('reroll-determinism-base', { catalog: inlineCatalog });
      const a = serializePatch(
        rerollPatch(original, 'reroll-determinism-next', { catalog: inlineCatalog }),
      );
      const b = serializePatch(
        rerollPatch(original, 'reroll-determinism-next', { catalog: inlineCatalog }),
      );
      expect(a).toBe(b);
    });

    it('safety invariants hold across many (base seed × reroll seed) combinations', () => {
      let combos = 0;
      for (const baseSeed of BASE_SEEDS) {
        const original = derivePatch(baseSeed, { catalog: inlineCatalog });
        for (let i = 0; i < 12; i++) {
          const rerolled = rerollPatch(original, `${baseSeed}-safety-${i}`, {
            catalog: inlineCatalog,
          });
          combos++;
          for (const route of rerolled.routes) {
            const paramId = route.target.slice(route.target.indexOf('.') + 1);
            expect(SAFE_TARGET_PARAMS.has(paramId), `${baseSeed}#${i}: ${route.target}`).toBe(true);
            expect(route.polarity, `${baseSeed}#${i}: ${route.target}`).toBe('unipolar');
            expect(route.amount, `${baseSeed}#${i}: ${route.target}`).toBeGreaterThan(0);
            expect(route.source, `${baseSeed}#${i}: ${route.target}`).not.toBe('audio:beatPhase');
            expect(route.source, `${baseSeed}#${i}: ${route.target}`).not.toBe('audio:barPhase');
          }
        }
      }
      // >=50 seeds requirement (BASE_SEEDS.length * 12 = 72).
      expect(combos).toBeGreaterThanOrEqual(50);
    });

    it('validatePatch passes across many reroll seeds, from several starting topologies', () => {
      const catalog = defCatalogFrom();
      let combos = 0;
      for (const baseSeed of BASE_SEEDS) {
        const original = derivePatch(baseSeed, { catalog: inlineCatalog });
        for (let i = 0; i < 12; i++) {
          const seed = `${baseSeed}-validate-${i}`;
          const rerolled = rerollPatch(original, seed, { catalog: inlineCatalog });
          combos++;
          const issues = validatePatch(rerolled, catalog);
          expect(issues, `base=${baseSeed} reroll=${seed}: ${JSON.stringify(issues)}`).toEqual([]);
        }
      }
      expect(combos).toBeGreaterThanOrEqual(50);
    });

    it('preserves qualityTier and images untouched', () => {
      const stampGen = inlineCatalog.get('stamp')!;
      const modGen = inlineCatalog.get('repeat')!;
      const matGen = inlineCatalog.get('neon')!;
      const mkOp = (id: string, gen: InlineGenerator): VisualOperator => ({
        id,
        generatorId: gen.def.id,
        generatorVersion: gen.def.version,
        parameters: Object.fromEntries(gen.def.parameters.map((p) => [p.id, p.default])),
      });
      const original: VisualPatch = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        seed: 'reroll-images-base',
        operators: [mkOp('src0', stampGen), mkOp('mod0', modGen), mkOp('mat0', matGen)],
        routes: [],
        palette: { mode: 'mono', hueOffset: 10, saturation: 40, lightness: 55 },
        composition: { symmetry: 2, scale: 1.1, speed: 0.4 },
        qualityTier: 'high', // deliberately non-default (derivePatch's own default is 'medium')
        images: { 'src0.image': { name: 'my-logo.png', hash: 'deadbeef' } },
      };

      const rerolled = rerollPatch(original, 'reroll-images-next', { catalog: inlineCatalog });

      expect(rerolled.qualityTier).toBe('high');
      expect(rerolled.images).toEqual({ 'src0.image': { name: 'my-logo.png', hash: 'deadbeef' } });
    });

    it('throws a clear error when an operator references a generator missing from the catalog', () => {
      const original = derivePatch('reroll-missing-gen-base', { catalog: inlineCatalog });
      const missingId = original.operators[0]!.generatorId;
      const reduced = createInlineCatalog(
        inlineCatalog.all().filter((g) => g.def.id !== missingId),
      );
      expect(() => rerollPatch(original, 'reroll-missing-gen-next', { catalog: reduced })).toThrow(
        /not found in catalog/,
      );
      expect(() => rerollPatch(original, 'reroll-missing-gen-next', { catalog: reduced })).toThrow(
        new RegExp(missingId),
      );
    });
  });
});

/** Structural equality without relying on object identity (mirrors `toEqual` semantics). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
