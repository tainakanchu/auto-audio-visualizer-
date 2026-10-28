/**
 * GPU render smoke test for assemblePatch output.
 *
 * Verifies that assembled fullscreen shaders actually draw non-empty,
 * non-uniform pixels (not merely that GLSL compiles).
 *
 * SCOPE: Only Source×Material combinations are covered.
 * Field and Modifier generators are intentionally OUT OF SCOPE because
 * operators like `threshold` can legitimately render fully black / empty
 * depending on settings; requiring non-empty alpha or non-uniform pixels
 * would be inappropriate for them.
 *
 * Browser launch, WebGL2 setup and readPixels live in ./gpuHarness.ts, shared
 * with the coverage measurement script. The harness reduces each frame inside
 * the browser and hands back scalars only — serialising a 256² RGBA frame into
 * a 262,144-element JSON array costs far more than drawing it, and this suite
 * only ever asked aggregate questions of the pixels anyway.
 *
 * Playwright + Chromium; skip with visible reason if browser unavailable.
 */
import type { Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { inlineCatalog } from '../generators';
import {
  basePatch,
  closeGpu,
  launchGpu,
  opFromDef,
  renderPatchFrame,
  requireGen,
  type NamedPatch,
  type TextureSpec,
} from './gpuHarness';

// 64 undersamples default grid lines (cells=8, thickness=0.08) — pixel centers
// miss thin strokes and read fully transparent; 256 leaves a safe sampling margin.
const SIZE = 256;
// ~1/10 of 1080p after a half-res degradation step; thin lines without fwidth AA vanish here.
const SIZE_LOW = 96;
const SEED = 'gpu-render-seed';

/**
 * Source×Material only. Field/Modifier patches are out of scope (see file header).
 */
function sourceNeonPatches(): NamedPatch[] {
  const sources = inlineCatalog.all().filter((g) => g.def.category === 'source');
  const neon = requireGen('neon');
  return sources.map((src) => ({
    label: `source:${src.def.id}+material:neon`,
    patch: basePatch([opFromDef('src0', src.def), opFromDef('mat0', neon.def)], SEED),
  }));
}

/**
 * grid×each Material. Field/Modifier patches are out of scope (see file header).
 */
function gridMaterialPatches(): NamedPatch[] {
  const materials = inlineCatalog.all().filter((g) => g.def.category === 'material');
  const grid = requireGen('grid');
  return materials.map((mat) => ({
    label: `source:grid+material:${mat.def.id}`,
    patch: basePatch([opFromDef('src0', grid.def), opFromDef('mat0', mat.def)], SEED),
  }));
}

/**
 * The raymarched (SDF) sources. They are singled out because a 3D source is the
 * one kind that can silently degrade into a flat-shaded blob: a cube face has a
 * constant normal, so a plain NdotL quantises the whole object to a handful of
 * levels and the material downstream receives almost no information.
 */
const RAYMARCHED_SOURCE_IDS = [
  'sdfTunnel',
  'sdfLattice',
  'sdfBlob',
  'sdfCube',
  'sdfMandelbox',
  'sdfMagicEye',
  'sdfPlanet',
] as const;

/** Unique patches from the source and material sets (dedupe by label). */
function allRenderPatches(): NamedPatch[] {
  const byLabel = new Map<string, NamedPatch>();
  for (const p of [...sourceNeonPatches(), ...gridMaterialPatches()]) {
    byLabel.set(p.label, p);
  }
  return [...byLabel.values()];
}

function renderPatch(
  page: Page,
  { patch }: NamedPatch,
  size: number = SIZE,
  textureKind: TextureSpec['kind'] = 'pattern',
) {
  return renderPatchFrame(page, patch, size, textureKind);
}

const session = await launchGpu(
  '[render.gpu.test] browser unavailable — GPU render tests will be skipped:',
);

const SOURCE_NEON = sourceNeonPatches();
const GRID_MATERIALS = gridMaterialPatches();
const ALL_RENDER = allRenderPatches();

describe('synth/gl assemblePatch GPU render', () => {
  const pg = session.page;
  if (!pg) {
    it.skip(`browser unavailable — GPU render tests skipped${
      session.error instanceof Error ? `: ${session.error.message}` : ''
    }`, () => {});
    return;
  }

  afterAll(async () => {
    await closeGpu(session);
  });

  // SIZE=256 + many source×material patches makes multi-patch WebGL/readPixels slow.
  // 100 generators → unique source/material patches; 60s is too tight.
  const renderTimeoutMs = 180_000;

  it(
    `all Sources draw something (${SOURCE_NEON.length} patches)`,
    async () => {
      expect(SOURCE_NEON.length).toBeGreaterThan(0);
      console.log(
        `[render.gpu.test] verifying ${SOURCE_NEON.length} source×neon patches for non-zero alpha`,
      );

      const failures: string[] = [];

      for (const named of SOURCE_NEON) {
        const result = await renderPatch(pg, named);
        if (!result.ok) {
          failures.push(`${named.label}: ${result.log}`);
          continue;
        }
        if (result.frame.alphaCount === 0) {
          failures.push(`${named.label}: empty alpha (all pixels alpha=0)`);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length}/${SOURCE_NEON.length} source patch(es) failed non-empty alpha:\n\n` +
            failures.join('\n'),
        );
      }

      console.log(
        `[render.gpu.test] all ${SOURCE_NEON.length} source×neon patches have non-zero alpha`,
      );
    },
    renderTimeoutMs,
  );

  it(
    `all Materials draw something (${GRID_MATERIALS.length} patches)`,
    async () => {
      expect(GRID_MATERIALS.length).toBeGreaterThan(0);
      console.log(
        `[render.gpu.test] verifying ${GRID_MATERIALS.length} grid×material patches for non-zero alpha`,
      );

      const failures: string[] = [];

      for (const named of GRID_MATERIALS) {
        const result = await renderPatch(pg, named);
        if (!result.ok) {
          failures.push(`${named.label}: ${result.log}`);
          continue;
        }
        if (result.frame.alphaCount === 0) {
          failures.push(`${named.label}: empty alpha (all pixels alpha=0)`);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length}/${GRID_MATERIALS.length} material patch(es) failed non-empty alpha:\n\n` +
            failures.join('\n'),
        );
      }

      console.log(
        `[render.gpu.test] all ${GRID_MATERIALS.length} grid×material patches have non-zero alpha`,
      );
    },
    renderTimeoutMs,
  );

  it(
    `output is non-uniform (${ALL_RENDER.length} unique patches)`,
    async () => {
      expect(ALL_RENDER.length).toBeGreaterThan(0);
      console.log(
        `[render.gpu.test] verifying ${ALL_RENDER.length} unique patches for non-uniform pixels`,
      );

      const failures: string[] = [];

      for (const named of ALL_RENDER) {
        const result = await renderPatch(pg, named);
        if (!result.ok) {
          failures.push(`${named.label}: ${result.log}`);
          continue;
        }
        if (result.frame.uniform) {
          failures.push(`${named.label}: uniform output (all pixels identical RGBA)`);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length}/${ALL_RENDER.length} patch(es) failed non-uniform check:\n\n` +
            failures.join('\n'),
        );
      }

      console.log(`[render.gpu.test] all ${ALL_RENDER.length} unique patches are non-uniform`);
    },
    renderTimeoutMs,
  );

  it(
    'stamp draws the bound image, and nothing at all without one',
    async () => {
      const stamp = requireGen('stamp');
      const neon = requireGen('neon');
      const named: NamedPatch = {
        label: 'source:stamp+material:neon',
        patch: {
          ...basePatch([opFromDef('src0', stamp.def), opFromDef('mat0', neon.def)], SEED),
          images: { 'src0.image': { name: 'procedural.png', hash: 'test-pattern' } },
        },
      };

      // 1. a real (procedurally generated) image → visible, structured output
      const withImage = await renderPatch(pg, named);
      if (!withImage.ok) throw new Error(`stamp with image failed: ${withImage.log}`);
      expect(withImage.frame.alphaCount > 0, 'stamp×neon drew nothing').toBe(true);
      expect(withImage.frame.uniform, 'stamp×neon output is a flat fill').toBe(false);

      // 2. the scene's fallback (1×1 transparent) → v = 0, an empty frame
      const withoutImage = await renderPatch(pg, named, SIZE, 'transparent');
      if (!withoutImage.ok) throw new Error(`stamp without image failed: ${withoutImage.log}`);
      expect(
        withoutImage.frame.alphaCount > 0,
        'a missing image must render empty, not opaque',
      ).toBe(false);

      // 3. orientation. The image store hands over bottom-row-first pixels, so
      //    the rows uploaded first (t≈0) must land at the bottom of the frame.
      //    readPixels also starts at the bottom row, so the lit rows come first.
      //    Quarters, not halves: LINEAR filtering bleeds a row or two across the
      //    seam and that is not an orientation bug.
      const oriented = await renderPatch(pg, named, SIZE, 'firstRows');
      if (!oriented.ok) throw new Error(`stamp orientation probe failed: ${oriented.log}`);
      const quarterPixels = (SIZE * SIZE) / 4;
      const quarters = oriented.frame.quarterAlphaCounts;
      const bottom = quarters[0]!;
      const top = quarters[quarters.length - 1]!;
      expect(bottom, 'first-uploaded rows must appear at the bottom of the frame').toBeGreaterThan(
        quarterPixels / 2,
      );
      expect(top, 'the transparent rows must appear at the top of the frame').toBe(0);
    },
    renderTimeoutMs,
  );

  it(
    `raymarched sources render continuous tone (${RAYMARCHED_SOURCE_IDS.length} patches)`,
    async () => {
      const neon = requireGen('neon');
      const failures: string[] = [];

      for (const id of RAYMARCHED_SOURCE_IDS) {
        const src = requireGen(id);
        const named: NamedPatch = {
          label: `source:${id}+material:neon`,
          patch: basePatch([opFromDef('src0', src.def), opFromDef('mat0', neon.def)], SEED),
        };
        const result = await renderPatch(pg, named);
        if (!result.ok) {
          failures.push(`${named.label}: ${result.log}`);
          continue;
        }
        const levels = result.frame.distinctAlphaLevels;
        console.log(`[render.gpu.test] ${id}: ${levels} distinct alpha levels`);
        // Measured 144–192 for the four SDF sources; a flat-shaded solid would
        // land in the single digits. 40 leaves room for driver differences while
        // still failing loudly if the shading collapses into steps.
        if (levels < 40) {
          failures.push(
            `${named.label}: only ${levels} distinct alpha levels — shading looks quantised`,
          );
        }
      }

      if (failures.length > 0) {
        throw new Error(`raymarched source tone check failed:\n\n${failures.join('\n')}`);
      }
    },
    renderTimeoutMs,
  );

  it(
    `low-res (${SIZE_LOW}): all Sources keep non-zero alpha (${SOURCE_NEON.length} patches)`,
    async () => {
      expect(SOURCE_NEON.length).toBeGreaterThan(0);
      console.log(
        `[render.gpu.test] verifying ${SOURCE_NEON.length} source×neon patches at ${SIZE_LOW}px for non-zero alpha`,
      );

      const failures: string[] = [];

      for (const named of SOURCE_NEON) {
        const result = await renderPatch(pg, named, SIZE_LOW);
        if (!result.ok) {
          failures.push(`${named.label}: ${result.log}`);
          continue;
        }
        if (result.frame.alphaCount === 0) {
          failures.push(`${named.label}: empty alpha (all pixels alpha=0) at ${SIZE_LOW}px`);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length}/${SOURCE_NEON.length} source patch(es) failed low-res non-empty alpha:\n\n` +
            failures.join('\n'),
        );
      }

      console.log(
        `[render.gpu.test] all ${SOURCE_NEON.length} source×neon patches have non-zero alpha at ${SIZE_LOW}px`,
      );
    },
    renderTimeoutMs,
  );
});
