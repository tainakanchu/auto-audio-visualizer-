// vj-ctl.mjs の buildEventAdd（`event add` の anchor 組み立て）の単体テスト。
// 偽の WebSocket サーバは立てない — buildEventAdd は conn.request(method, params) だけを
// 呼ぶ純粋寄りの async 関数なので、trivial なスタブ conn を渡して直接 import テストする。
import { describe, expect, it } from 'vitest';
import { buildEventAdd } from './vj-ctl.mjs';

/** conn.request('getState') が返す最小限の state。nowSec / barCount だけ使われる。 */
function stubConn(state = { nowSec: 10, barCount: 2 }) {
  return { request: async () => state };
}

function flagsOf(entries) {
  return new Map(entries);
}

describe('buildEventAdd', () => {
  it('--cue だけでは intent が空でエラーになる（--label/--seed/--patch のいずれかが必須のまま）', async () => {
    await expect(buildEventAdd(stubConn(), flagsOf([['cue', 'foo']]))).rejects.toThrow(
      /intent が空です/,
    );
  });

  it('--cue <id> --label <s> は external anchor になる', async () => {
    const event = await buildEventAdd(
      stubConn(),
      flagsOf([
        ['cue', 'foo'],
        ['label', 'bar'],
      ]),
    );
    expect(event.start).toEqual({ kind: 'external', id: 'foo' });
    expect(event.intent).toEqual({ label: 'bar' });
  });

  it('--bar が --cue より優先される（既存の bar > in の優先順位と同じ扱い）', async () => {
    const event = await buildEventAdd(
      stubConn({ nowSec: 10, barCount: 2 }),
      flagsOf([
        ['bar', '4'],
        ['cue', 'foo'],
        ['label', 'x'],
      ]),
    );
    expect(event.start).toEqual({ kind: 'bar', bar: 6 });
  });

  it('--in が --cue より優先される（--cue は最後に評価される）', async () => {
    const event = await buildEventAdd(
      stubConn({ nowSec: 10, barCount: 2 }),
      flagsOf([
        ['in', '5'],
        ['cue', 'foo'],
        ['label', 'x'],
      ]),
    );
    expect(event.start).toEqual({ kind: 'seconds', atSec: 15 });
  });

  it('--cue 使用時も transition preset の解決と id 生成（ctl- 接頭辞）は従来どおり動く', async () => {
    const event = await buildEventAdd(
      stubConn(),
      flagsOf([
        ['cue', 'foo'],
        ['label', 'x'],
        ['transition', 'slow'],
      ]),
    );
    expect(event.id).toMatch(/^ctl-\d+$/);
    expect(event.transition).toEqual({
      paletteMs: 2400,
      parameterMs: 1600,
      modulationMs: 2000,
      topologyMs: 4000,
      easing: 'easeInOut',
    });
    expect(event.duration).toEqual({ kind: 'untilNext' });
    expect(event.confidence).toBe(1);
    expect(event.locked).toBe(false);
  });

  it('--cue 使用時に不正な --transition はエラーになる', async () => {
    await expect(
      buildEventAdd(
        stubConn(),
        flagsOf([
          ['cue', 'foo'],
          ['label', 'x'],
          ['transition', 'nope'],
        ]),
      ),
    ).rejects.toThrow(/--transition/);
  });
});
