/**
 * GPU behaviour test for the audio reaction layer.
 *
 * Two properties the whole design rests on, neither of which a compile test can
 * see:
 *
 * 1. **無音では完全な no-op**。リアクションを載せた Patch は、無音のフレームで
 *    リアクション無しの Patch と 1 ピクセルも変わらないこと。ゲートし忘れた項が
 *    1 つでもあると「音が鳴っていないのに勝手に動く」に戻る。
 * 2. **拍では実際に絵が変わる**。ゲートは効いているが振れ幅が実質 0、という
 *    「載っているのに見えない」リアクションを弾く。
 *
 * ハーネスは 1 フレームをブラウザ内で数値に畳んで返す（FrameStats）ので、比較は
 * その集計値で行う。alpha を動かさない色リアクション（色相回転・階調潰し・
 * ネガ反転・チャンネル入れ替え）は 2 の対象外 — alpha は定義上変わらない。
 *
 * Playwright + Chromium; skip with visible reason if browser unavailable.
 */
import type { Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { FULLSCREEN_VERT } from '../../render/glutil';
import { inlineCatalog } from '../generators';
import { assemblePatch } from './assemble';
import {
  basePatch,
  buildUniformSpecs,
  closeGpu,
  launchGpu,
  opFromDef,
  renderInBrowser,
  requireGen,
  type FrameStats,
  type UniformSpec,
} from './gpuHarness';
import { ALL_REACTIONS } from './reactions';
import type { VisualPatch } from '../types';

const SIZE = 256;
const SEED = 'gpu-reaction-seed';

/** 無音。ノイズゲート後の値なので帯域まで含めて 0。 */
const SILENT: Record<string, number> = {
  uBass: 0,
  uMid: 0,
  uTreble: 0,
  uLevel: 0,
  uBeat: 0,
  uEnergy: 0,
  uPunch: 0,
};

/** 強い拍。リアクションが最大まで振れる側。 */
const BEAT: Record<string, number> = {
  uBass: 0.7,
  uMid: 0.6,
  uTreble: 0.6,
  uLevel: 0.6,
  uBeat: 1,
  uEnergy: 0.9,
  uPunch: 0.9,
};

function withAudio(specs: UniformSpec[], audio: Record<string, number>): UniformSpec[] {
  return specs.map((s) =>
    s.kind === '1f' && s.name in audio ? { ...s, value: audio[s.name]! } : s,
  );
}

/**
 * 比較に使う Patch。
 *
 * 鏡像・回転系のリアクションは、対称な絵に掛けても集計値が動かない（`grid` を
 * x 反転しても被覆率は同じ）。対称性の違う 2 枚を用意して「どちらかで動けば
 * よい」とすることで、テストが Generator の対称性に引きずられないようにする。
 */
function testPatches(): { label: string; patch: VisualPatch }[] {
  const neon = requireGen('neon');
  return ['grid', 'spiral'].map((srcId) => {
    const src = requireGen(srcId);
    return {
      label: `${srcId}+neon`,
      patch: basePatch([opFromDef('src0', src.def), opFromDef('mat0', neon.def)], SEED),
    };
  });
}

async function frameOf(
  page: Page,
  patch: VisualPatch,
  reactions: 'off' | string[],
  audio: Record<string, number>,
): Promise<FrameStats> {
  const assembled = assemblePatch(patch, inlineCatalog, { reactions });
  const uniforms = withAudio(buildUniformSpecs(patch, assembled, SIZE), audio);
  const res = await renderInBrowser(page, FULLSCREEN_VERT, assembled.fragSrc, uniforms, SIZE);
  if (!res.ok) throw new Error(`render failed: ${res.log}`);
  return res.frame;
}

/** FrameStats が完全に一致するか。 */
function sameFrame(a: FrameStats, b: FrameStats): boolean {
  return (
    a.meanAlpha === b.meanAlpha &&
    a.solidFraction === b.solidFraction &&
    a.alphaCount === b.alphaCount &&
    a.uniform === b.uniform &&
    a.distinctAlphaLevels === b.distinctAlphaLevels &&
    a.quarterAlphaCounts.length === b.quarterAlphaCounts.length &&
    a.quarterAlphaCounts.every((q, i) => q === b.quarterAlphaCounts[i])
  );
}

const session = await launchGpu('[reactions.gpu.test] browser launch failed:');

describe('synth/gl audio reactions on GPU', () => {
  const pg = session.page;
  if (!pg) {
    it.skip(`browser unavailable — GPU reaction tests skipped${
      session.error instanceof Error ? `: ${session.error.message}` : ''
    }`, () => {});
    return;
  }

  afterAll(async () => {
    await closeGpu(session);
  });

  const timeoutMs = 180_000;
  const PATCHES = testPatches();

  it(
    'every reaction is a no-op in silence',
    async () => {
      const failures: string[] = [];
      for (const { label, patch } of PATCHES) {
        const off = await frameOf(pg, patch, 'off', SILENT);
        for (const r of ALL_REACTIONS) {
          const on = await frameOf(pg, patch, [r.id], SILENT);
          if (!sameFrame(off, on)) {
            failures.push(
              `${label}/${r.id}: silent frame differs from the reaction-free frame\n` +
                `  off=${JSON.stringify(off)}\n  on =${JSON.stringify(on)}`,
            );
          }
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} reaction(s) are not silence-gated:\n\n${failures.join('\n\n')}`,
        );
      }
      expect(failures.length).toBe(0);
    },
    timeoutMs,
  );

  it(
    'every alpha-affecting reaction visibly changes the frame on a beat',
    async () => {
      // `col.rgb` だけを書き換えるリアクションは alpha を動かさないので、この
      // 観測系（FrameStats は alpha の集計）には映らない。`col` ごと書き換える
      // ものだけを対象にする。
      const touchesAlpha = (glsl: string) => /\bcol\s*[+*]?=/.test(glsl);
      const observable = ALL_REACTIONS.filter((r) => r.stage === 'coord' || touchesAlpha(r.glsl));
      expect(observable.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const r of observable) {
        let movedSomewhere = false;
        for (const { patch } of PATCHES) {
          const off = await frameOf(pg, patch, 'off', BEAT);
          const on = await frameOf(pg, patch, [r.id], BEAT);
          if (!sameFrame(off, on)) {
            movedSomewhere = true;
            break;
          }
        }
        if (!movedSomewhere) {
          failures.push(`${r.id}: beat frame is identical to the reaction-free frame`);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} reaction(s) do nothing on a beat:\n\n${failures.join('\n')}`,
        );
      }
      expect(failures.length).toBe(0);
    },
    timeoutMs,
  );
});
