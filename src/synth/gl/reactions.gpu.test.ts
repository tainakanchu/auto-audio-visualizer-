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

/** 無音。ノイズゲート後の値なので帯域まで含めて 0。海も凪。 */
const SILENT: Record<string, number> = {
  uBass: 0,
  uMid: 0,
  uTreble: 0,
  uLevel: 0,
  uBeat: 0,
  uEnergy: 0,
  uPunch: 0,
  uSwellWave: 0,
  uSwellGroup: 0,
  uSwellSet: 0,
  uSwellSurge: 0,
};

/** 強い拍 + 育った海。リアクションが最大まで振れる側。 */
const BEAT: Record<string, number> = {
  uBass: 0.7,
  uMid: 0.6,
  uTreble: 0.6,
  uLevel: 0.6,
  uBeat: 1,
  uEnergy: 0.9,
  uPunch: 0.9,
  uSwellWave: 0.8,
  uSwellGroup: 0.8,
  uSwellSet: 0.7,
  uSwellSurge: 0.8,
};

/**
 * 音は大音量なのに海だけが凪いでいるフレーム。
 *
 * 実際には Hs の時定数（GROWTH_TAU = 18 秒）のせいで音が鳴り始めた直後がこれに
 * なる。うねり駆動のリアクションが拍から漏れて動いていないかを見るのに使う。
 */
const LOUD_BUT_CALM_SEA: Record<string, number> = {
  ...BEAT,
  uSwellWave: 0,
  uSwellGroup: 0,
  uSwellSet: 0,
  uSwellSurge: 0,
};

/**
 * 海だけが走っていて、拍も音量も 0 のフレーム。
 *
 * ブレイクに入ってうねりだけが残っている状態。実運用では `uEnergy` が 0 に
 * 落ちきる前に Hs も落ち始めるので厳密にはこの通りにはならないが、
 * 「うねりが単独で絵を動かせる」ことを分離して確かめるための人工的な断面。
 */
const CALM_BUT_SWELL: Record<string, number> = {
  uBass: 0,
  uMid: 0,
  uTreble: 0,
  uLevel: 0,
  uBeat: 0,
  uEnergy: 0,
  uPunch: 0,
  uSwellWave: 0.8,
  uSwellGroup: 0.8,
  uSwellSet: 0.7,
  uSwellSurge: 0.8,
};

/** うねりを駆動値に持つリアクション。 */
const SWELL_DRIVEN = ALL_REACTIONS.filter((r) => /\brSwell\b|\brSet\b/.test(r.glsl));

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

  /**
   * うねり駆動のリアクションについて、「駆動値が 0 なら完全な恒等変換」を
   * 音とは独立に確かめる。
   *
   * 上の無音テストは全 uniform が 0 なので、拍から漏れて動いているリアクションも
   * 一緒に静かになってしまい区別が付かない。ここは**音を最大にしたまま海だけを
   * 凪がせる**ので、うねり項が本当にうねりだけで駆動されているかが分離できる。
   */
  it(
    'swell reactions are pixel-identical to no reaction when the sea is calm, however loud the room',
    async () => {
      expect(SWELL_DRIVEN.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const { label, patch } of PATCHES) {
        const off = await frameOf(pg, patch, 'off', LOUD_BUT_CALM_SEA);
        for (const r of SWELL_DRIVEN) {
          const on = await frameOf(pg, patch, [r.id], LOUD_BUT_CALM_SEA);
          if (!sameFrame(off, on)) {
            failures.push(
              `${label}/${r.id}: a calm sea still changed the frame — the snippet is picking up ` +
                `something other than rSwell/rSet\n  off=${JSON.stringify(off)}\n  on =${JSON.stringify(
                  on,
                )}`,
            );
          }
        }
      }
      if (failures.length > 0) {
        throw new Error(`${failures.length} swell reaction(s) leak:\n\n${failures.join('\n\n')}`);
      }
      expect(failures.length).toBe(0);
    },
    timeoutMs,
  );

  /**
   * 逆向きの確認。うねりだけで絵が動くこと = 配線が本当に届いていること。
   * これが無いと「駆動値 0 で恒等」は「常に恒等」でも通ってしまう。
   */
  it(
    'swell reactions move the frame on the swell alone, with no beat and no level',
    async () => {
      const failures: string[] = [];
      for (const r of SWELL_DRIVEN) {
        let movedSomewhere = false;
        for (const { patch } of PATCHES) {
          const off = await frameOf(pg, patch, 'off', CALM_BUT_SWELL);
          const on = await frameOf(pg, patch, [r.id], CALM_BUT_SWELL);
          if (!sameFrame(off, on)) {
            movedSomewhere = true;
            break;
          }
        }
        if (!movedSomewhere) {
          failures.push(`${r.id}: the swell alone does not move the frame`);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} swell reaction(s) are inert:\n\n${failures.join('\n')}`,
        );
      }
      expect(failures.length).toBe(0);
    },
    timeoutMs,
  );
});
