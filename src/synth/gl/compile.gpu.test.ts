/**
 * GPU compile/link smoke test for assemblePatch output.
 *
 * The exhaustive source×{field,modifier,material} cross product reached 1533
 * patches at 83 generators and grows quadratically, so the normal run is built
 * from two explicit guarantees instead:
 *
 * 1. coverage — every inline generator appears solo in at least one patch
 * 2. sampling — every source is additionally paired with a deterministically
 *    sampled 2 fields / 2 modifiers / 2 materials (rand(), fixed seed +
 *    namespace, so the patch set is identical on every machine and run)
 *
 * Set VJ_GPU_FULL=1 to compile the exhaustive cross product instead — slower,
 * meant for a pre-release sweep rather than the normal loop.
 *
 * Browser launch and the WebGL2 rig live in ./gpuHarness.ts, shared with the
 * render test and the coverage measurement script.
 *
 * Playwright + Chromium; skip with visible reason if browser unavailable.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FULLSCREEN_VERT } from '../../render/glutil';
import { assemblePatch } from './assemble';
import { ALL_REACTIONS } from './reactions';
import { inlineCatalog, type InlineGenerator } from '../generators';
import { rand } from '../rng';
import {
  basePatch as buildPatch,
  closeGpu,
  compileInBrowser,
  fullSweep,
  launchGpu,
  opFromDef,
  requireGen,
  roleOf,
  type NamedPatch,
} from './gpuHarness';
import type { VisualOperator } from '../types';

const COMPILE_SEED = 'gpu-compile-seed';

function basePatch(operators: VisualOperator[]) {
  return buildPatch(operators, COMPILE_SEED);
}

/** Minimal valid patch that includes the given generator. */
function soloPatchFor(genId: string): NamedPatch {
  const g = requireGen(genId);
  const role = roleOf(g.def);
  const grid = requireGen('grid');
  const neon = requireGen('neon');

  switch (role) {
    case 'source':
      return {
        label: `solo/source:${genId}`,
        patch: basePatch([opFromDef('src0', g.def), opFromDef('mat0', neon.def)]),
      };
    case 'field':
      return {
        label: `solo/field:${genId}`,
        patch: basePatch([
          opFromDef('src0', grid.def),
          opFromDef('fld0', g.def),
          opFromDef('mat0', neon.def),
        ]),
      };
    case 'mod_coord':
      return {
        label: `solo/mod_coord:${genId}`,
        patch: basePatch([
          opFromDef('mod0', g.def),
          opFromDef('src0', grid.def),
          opFromDef('mat0', neon.def),
        ]),
      };
    case 'mod_value':
      return {
        label: `solo/mod_value:${genId}`,
        patch: basePatch([
          opFromDef('src0', grid.def),
          opFromDef('mod0', g.def),
          opFromDef('mat0', neon.def),
        ]),
      };
    case 'material':
      return {
        label: `solo/material:${genId}`,
        patch: basePatch([opFromDef('src0', grid.def), opFromDef('mat0', g.def)]),
      };
  }
}

interface RolePools {
  sources: InlineGenerator[];
  fields: InlineGenerator[];
  mods: InlineGenerator[];
  materials: InlineGenerator[];
}

function rolePools(): RolePools {
  const all = inlineCatalog.all();
  return {
    sources: all.filter((g) => roleOf(g.def) === 'source'),
    fields: all.filter((g) => roleOf(g.def) === 'field'),
    mods: all.filter((g) => {
      const r = roleOf(g.def);
      return r === 'mod_coord' || r === 'mod_value';
    }),
    materials: all.filter((g) => roleOf(g.def) === 'material'),
  };
}

/** Fixed sampling key — the sampled patch set must not drift between runs. */
const SAMPLE_SEED = 'gpu-compile-sample';
const SAMPLE_NS = 'test:sample';
/** Sampled partners drawn per source, per pool. */
const PICKS_PER_POOL = 2;

/** Deterministically pick two distinct entries (or the whole pool if it is smaller). */
function pickTwo(pool: InlineGenerator[], salt: number): InlineGenerator[] {
  const n = pool.length;
  if (n <= PICKS_PER_POOL) return [...pool];
  const i0 = Math.min(n - 1, Math.floor(rand(SAMPLE_SEED, SAMPLE_NS, salt) * n));
  let i1 = Math.min(n - 2, Math.floor(rand(SAMPLE_SEED, SAMPLE_NS, salt + 1) * (n - 1)));
  // skip over i0 so the second pick is always a different generator
  if (i1 >= i0) i1 += 1;
  return [pool[i0]!, pool[i1]!];
}

/** Guarantee 2: each source × a deterministic sample of fields / modifiers / materials. */
function sampledCombinationPatches(): NamedPatch[] {
  const { sources, fields, mods, materials } = rolePools();
  const neon = requireGen('neon');
  const out: NamedPatch[] = [];

  sources.forEach((src, si) => {
    // a salt block per source: adding a source does not reshuffle the others
    const salt = si * 16;
    for (const fld of pickTwo(fields, salt)) {
      out.push({
        label: `sample/source:${src.def.id}+field:${fld.def.id}+material:neon`,
        patch: basePatch([
          opFromDef('src0', src.def),
          opFromDef('fld0', fld.def),
          opFromDef('mat0', neon.def),
        ]),
      });
    }
    for (const mod of pickTwo(mods, salt + 4)) {
      const r = roleOf(mod.def);
      out.push({
        label: `sample/source:${src.def.id}+${r}:${mod.def.id}+material:neon`,
        patch: basePatch([
          opFromDef('mod0', mod.def),
          opFromDef('src0', src.def),
          opFromDef('mat0', neon.def),
        ]),
      });
    }
    for (const mat of pickTwo(materials, salt + 8)) {
      out.push({
        label: `sample/source:${src.def.id}+material:${mat.def.id}`,
        patch: basePatch([opFromDef('src0', src.def), opFromDef('mat0', mat.def)]),
      });
    }
  });

  return out;
}

/** Exhaustive source × {field | modifier | material} product — VJ_GPU_FULL=1 only. */
function fullCombinationPatches(): NamedPatch[] {
  const { sources, fields, mods, materials } = rolePools();
  const neon = requireGen('neon');
  const out: NamedPatch[] = [];

  for (const src of sources) {
    for (const fld of fields) {
      out.push({
        label: `combo/source:${src.def.id}+field:${fld.def.id}+material:neon`,
        patch: basePatch([
          opFromDef('src0', src.def),
          opFromDef('fld0', fld.def),
          opFromDef('mat0', neon.def),
        ]),
      });
    }
    for (const mod of mods) {
      const r = roleOf(mod.def);
      out.push({
        label: `combo/source:${src.def.id}+${r}:${mod.def.id}+material:neon`,
        patch: basePatch([
          opFromDef('mod0', mod.def),
          opFromDef('src0', src.def),
          opFromDef('mat0', neon.def),
        ]),
      });
    }
    for (const mat of materials) {
      out.push({
        label: `combo/source:${src.def.id}+material:${mat.def.id}`,
        patch: basePatch([opFromDef('src0', src.def), opFromDef('mat0', mat.def)]),
      });
    }
  }

  return out;
}

function buildAllPatches(): NamedPatch[] {
  // guarantee 1: every generator solo, so nothing can be silently dropped
  const solos = inlineCatalog.all().map((g) => soloPatchFor(g.def.id));
  return [...solos, ...(fullSweep ? fullCombinationPatches() : sampledCombinationPatches())];
}

/** Every generator id referenced by the given patches. */
function generatorsCovered(patches: NamedPatch[]): Set<string> {
  const seen = new Set<string>();
  for (const { patch } of patches) {
    for (const op of patch.operators) seen.add(op.generatorId);
  }
  return seen;
}

function expectedPatchCount(): number {
  const { sources, fields, mods, materials } = rolePools();
  const solos = inlineCatalog.all().length;
  const perSource = fullSweep
    ? fields.length + mods.length + materials.length
    : Math.min(PICKS_PER_POOL, fields.length) +
      Math.min(PICKS_PER_POOL, mods.length) +
      Math.min(PICKS_PER_POOL, materials.length);
  return solos + sources.length * perSource;
}

const session = await launchGpu(
  '[compile.gpu.test] browser unavailable — GPU compile tests will be skipped:',
);

const ALL_PATCHES = buildAllPatches();
const PATCH_COUNT = ALL_PATCHES.length;
const EXPECTED_PATCH_COUNT = expectedPatchCount();

describe('synth/gl assemblePatch GPU compile', () => {
  // Plan checks need no GPU: they guard the sampling itself, so a browserless
  // machine still fails loudly if a generator drops out of the patch set.
  it(`patch set covers all 105 generators (${PATCH_COUNT} patches, full=${fullSweep})`, () => {
    const catalog = inlineCatalog.all();
    // catalog size sanity: 104 procedural generators (incl. 4 SDF raymarchers)
    // + stamp (image source)
    expect(catalog.length).toBe(105);
    // stamp must be in the plan as a solo source: an image generator that never
    // compiles on its own would only be caught live, mid-set.
    expect(ALL_PATCHES.some((p) => p.label === 'solo/source:stamp')).toBe(true);
    expect(PATCH_COUNT).toBe(EXPECTED_PATCH_COUNT);
    expect(PATCH_COUNT).toBeGreaterThan(0);

    const covered = generatorsCovered(ALL_PATCHES);
    const missing = catalog.map((g) => g.def.id).filter((id) => !covered.has(id));
    expect(missing, `generators absent from every patch: ${missing.join(', ')}`).toEqual([]);
    expect(covered.size).toBe(catalog.length);
  });

  const pg = session.page;
  if (!pg) {
    it.skip(`browser unavailable — GPU compile tests skipped${
      session.error instanceof Error ? `: ${session.error.message}` : ''
    }`, () => {});
    return;
  }

  afterAll(async () => {
    await closeGpu(session);
  });

  // Sampled runs land in the low hundreds of patches; VJ_GPU_FULL=1 is far
  // heavier, so keep the ceiling generous.
  const compileTimeoutMs = 180_000;

  it(
    `compiles ${PATCH_COUNT} patches covering all generators`,
    async () => {
      expect(PATCH_COUNT).toBe(EXPECTED_PATCH_COUNT);
      console.log(
        `[compile.gpu.test] verifying ${PATCH_COUNT} patches (mode=${
          fullSweep ? 'full' : 'sampled'
        }, ${inlineCatalog.all().length} generators)`,
      );

      const failures: string[] = [];

      for (const { label, patch } of ALL_PATCHES) {
        let fragSrc: string;
        try {
          fragSrc = assemblePatch(patch, inlineCatalog).fragSrc;
        } catch (e) {
          failures.push(
            `${label}: assemblePatch threw: ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
        const result = await compileInBrowser(pg, FULLSCREEN_VERT, fragSrc);
        if (!result.ok) {
          failures.push(`${label}:\n${result.log}`);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length}/${PATCH_COUNT} patch(es) failed GPU compile/link:\n\n` +
            failures.join('\n\n==========\n\n'),
        );
      }

      expect(failures.length).toBe(0);
      console.log(`[compile.gpu.test] all ${PATCH_COUNT} patches compiled and linked`);
    },
    compileTimeoutMs,
  );

  /**
   * リアクション層は topology から選ばれるので、上のパッチ集合が全種類を引く保証は
   * 無い。1 つ 1 つ名指しで組んで、どのスニペットも単体で通ることを確かめる
   * （GLSL の書き間違いが「その topology を引いた本番でだけリンクエラー」になる
   * のを防ぐ）。座標段と色段を総当たりで組み合わせ、変数名の衝突も一緒に見る。
   */
  it(
    `compiles every audio reaction (${ALL_REACTIONS.length} in catalog)`,
    async () => {
      const coord = ALL_REACTIONS.filter((r) => r.stage === 'coord');
      const color = ALL_REACTIONS.filter((r) => r.stage === 'color');
      expect(coord.length).toBeGreaterThan(0);
      expect(color.length).toBeGreaterThan(0);

      const grid = requireGen('grid');
      const neon = requireGen('neon');
      const patch = basePatch([opFromDef('src0', grid.def), opFromDef('mat0', neon.def)]);

      const failures: string[] = [];
      for (const c of coord) {
        for (const k of color) {
          const label = `reaction/${c.id}+${k.id}`;
          let fragSrc: string;
          try {
            fragSrc = assemblePatch(patch, inlineCatalog, {
              reactions: [c.id, k.id],
            }).fragSrc;
          } catch (e) {
            failures.push(
              `${label}: assemblePatch threw: ${e instanceof Error ? e.message : String(e)}`,
            );
            continue;
          }
          const result = await compileInBrowser(pg, FULLSCREEN_VERT, fragSrc);
          if (!result.ok) failures.push(`${label}:\n${result.log}`);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} reaction combination(s) failed GPU compile/link:\n\n` +
            failures.join('\n\n==========\n\n'),
        );
      }
      expect(failures.length).toBe(0);
      console.log(
        `[compile.gpu.test] ${coord.length}×${color.length} reaction combinations compiled`,
      );
    },
    compileTimeoutMs,
  );
});
