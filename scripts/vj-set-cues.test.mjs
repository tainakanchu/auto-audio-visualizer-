// scripts/vj-set.mjs の deriveNextCue / deriveCurrentCue（next / status が使う
// カーソル導出ロジック）の単体テスト。どちらも state.timeline.events / state.firedIds
// だけから毎回導出する純粋関数なので、vj-ctl.mjs はおろか vj-set.mjs 自体の
// サブプロセス起動も不要 — 直接 import して呼ぶだけでよい。
import { describe, expect, it } from 'vitest';
import { deriveCurrentCue, deriveNextCue } from './vj-set.mjs';

function externalEvent(id, cueId, label) {
  return {
    id,
    start: { kind: 'external', id: cueId },
    duration: { kind: 'untilNext' },
    intent: label !== undefined ? { label } : {},
    transition: { paletteMs: 0, parameterMs: 0, modulationMs: 0, topologyMs: 0, easing: 'linear' },
    confidence: 1,
    locked: false,
  };
}

function secondsEvent(id, atSec) {
  return {
    id,
    start: { kind: 'seconds', atSec },
    duration: { kind: 'untilNext' },
    intent: {},
    transition: { paletteMs: 0, parameterMs: 0, modulationMs: 0, topologyMs: 0, easing: 'linear' },
    confidence: 1,
    locked: false,
  };
}

function barEvent(id, bar) {
  return {
    id,
    start: { kind: 'bar', bar },
    duration: { kind: 'untilNext' },
    intent: {},
    transition: { paletteMs: 0, parameterMs: 0, modulationMs: 0, topologyMs: 0, easing: 'linear' },
    confidence: 1,
    locked: false,
  };
}

describe('deriveNextCue', () => {
  it('events / firedIds が空なら null', () => {
    expect(deriveNextCue([], [])).toBeNull();
  });

  it('external イベントが1つだけ未発火なら、それを返す', () => {
    const events = [externalEvent('ctl-1', 's1', 'intro')];
    expect(deriveNextCue(events, [])).toEqual({ cue: 's1', id: 'ctl-1', label: 'intro' });
  });

  it('firedIds に同じ id が入っていればスキップし、次の external イベントへ進む', () => {
    const events = [externalEvent('ctl-1', 's1'), externalEvent('ctl-2', 's2', 'drop')];
    expect(deriveNextCue(events, ['ctl-1'])).toEqual({ cue: 's2', id: 'ctl-2', label: 'drop' });
  });

  it('全部発火済みなら null', () => {
    const events = [externalEvent('ctl-1', 's1'), externalEvent('ctl-2', 's2')];
    expect(deriveNextCue(events, ['ctl-1', 'ctl-2'])).toBeNull();
  });

  it('seconds / bar anchor は external の合間に混ざっていても無視する（発火済み・未発火どちらでも）', () => {
    const events = [
      secondsEvent('ctl-sec', 100),
      externalEvent('ctl-1', 's1'),
      barEvent('ctl-bar', 8),
      externalEvent('ctl-2', 's2'),
    ];
    // seconds/bar は firedIds に入っていなくても external として扱わない。
    expect(deriveNextCue(events, [])).toEqual({ cue: 's1', id: 'ctl-1', label: undefined });
    // firedIds に seconds/bar の id が(万一)紛れ込んでいても external の判定には影響しない。
    expect(deriveNextCue(events, ['ctl-sec', 'ctl-bar'])).toEqual({
      cue: 's1',
      id: 'ctl-1',
      label: undefined,
    });
  });

  it('同じ cue (start.id) を持つ external イベントが複数あっても、配列順で最初の1つを返す', () => {
    // vj-set.mjs load 自身はセット内の cue 重複をロード前に弾くが、手で
    // `vj-ctl.mjs event add --cue` を複数回叩けばこの状況は起こり得る。
    // 起きたときに deriveNextCue が「最初の1つ」を安定して返せば十分で、
    // その後 fire したときに両方まとめて発火する(fireExternal の既存の仕様)のを
    // ここで防ぐ責務はない — 防ぐのは vj-set.mjs load 側の一意性検証の仕事。
    const events = [externalEvent('ctl-1', 'dup'), externalEvent('ctl-2', 'dup')];
    expect(deriveNextCue(events, [])).toEqual({ cue: 'dup', id: 'ctl-1', label: undefined });
  });
});

describe('deriveCurrentCue', () => {
  it('firedIds が空なら null', () => {
    const events = [externalEvent('ctl-1', 's1')];
    expect(deriveCurrentCue(events, [])).toBeNull();
  });

  it('挿入順ではなく実際に発火した順（firedIds の末尾）を返す — out-of-order fire でも最後に発火したものが current', () => {
    // Timeline 挿入順は s1, s2, s3 だが、手動で s3 → s1 の順に fire したとする。
    const events = [
      externalEvent('ctl-1', 's1'),
      externalEvent('ctl-2', 's2'),
      externalEvent('ctl-3', 's3'),
    ];
    // 最後に発火したのは ctl-1 (s1) — 挿入順で最後の s3 ではないことを確認する。
    expect(deriveCurrentCue(events, ['ctl-3', 'ctl-1'])).toEqual({
      cue: 's1',
      id: 'ctl-1',
      label: undefined,
    });
  });

  it('external 以外(seconds/bar)は firedIds に含まれていても current とは見なさない', () => {
    const events = [externalEvent('ctl-1', 's1'), secondsEvent('ctl-sec', 100)];
    expect(deriveCurrentCue(events, ['ctl-1', 'ctl-sec'])).toEqual({
      cue: 's1',
      id: 'ctl-1',
      label: undefined,
    });
  });
});
