import { describe, expect, it, vi } from 'vitest';
import type { SynthControl, SynthControlState } from '../synth/control';
import { derivePatch } from '../synth/derive';
import { inlineCatalog } from '../synth/generators';
import type { TimelineOp, VisualEvent } from '../synth/timeline';
import { TRANSITION_PRESETS } from '../synth/types';
import type { TransitionPresetId, VisualPatch } from '../synth/types';
import { handleDeckRequest, initDeckHost } from './host';
import type { DeckResponse } from './protocol';
import { DECK_CHANNEL } from './protocol';

const livePatch = derivePatch('deck-host-test', { catalog: inlineCatalog });

function schemaOnlyPatch(): VisualPatch {
  return {
    schemaVersion: 1,
    seed: 'schema-only',
    operators: [
      {
        id: 'src1',
        generatorId: 'grid',
        generatorVersion: 1,
        parameters: { cells: 8, thickness: 0.08 },
      },
    ],
    routes: [],
    palette: { mode: 'mono', hueOffset: 120, saturation: 80, lightness: 50 },
    composition: { symmetry: 4, scale: 1, speed: 0.8 },
    qualityTier: 'medium',
  };
}

function fakeEvent(id: string): VisualEvent {
  return {
    id,
    start: { kind: 'seconds', atSec: 1 },
    duration: { kind: 'untilNext' },
    intent: { label: id },
    transition: TRANSITION_PRESETS.default,
    confidence: 1,
    locked: false,
  };
}

function stubControl(
  init: {
    nowSec?: number;
    barCount?: number;
    tempoLocked?: boolean;
    transitionActive?: boolean;
    recordingActive?: boolean;
    lockedUntilSec?: number;
    currentPatch?: VisualPatch | null;
    firedIds?: string[];
    events?: VisualEvent[];
  } = {},
): { control: SynthControl; applyTimelineOp: ReturnType<typeof vi.fn> } {
  const applyTimelineOp = vi.fn(() => ({ ok: true as const }));
  const state: SynthControlState = {
    currentPatch: init.currentPatch === undefined ? livePatch : init.currentPatch,
    timeline: {
      lockedUntilSec: init.lockedUntilSec ?? 0,
      events: init.events ?? [],
    },
    transitionActive: init.transitionActive ?? false,
    qualityScale: 1,
    recordingActive: init.recordingActive ?? false,
    nowSec: init.nowSec ?? 10,
    barCount: init.barCount ?? 3,
    tempoLocked: init.tempoLocked ?? false,
    firedIds: init.firedIds ?? [],
    reactions: [],
    blendMode: 'normal',
  };
  const control: SynthControl = {
    getState: () => state,
    proposePatch: () => ({ ok: true, issues: [] }),
    proposeSeed: () => {},
    setImage: async () => ({ ok: true, issues: [] }),
    applyTimelineOp,
    fireExternal: () => {},
    startRecording: () => {},
    stopRecording: () => null,
    loadRecording: () => ({ ok: true, issues: [] }),
    setBlendMode: () => ({ ok: true, mode: 'normal' }),
    subscribe: () => () => {},
  };
  return { control, applyTimelineOp };
}

function triggerMsg(patch: VisualPatch, label: string, preset: TransitionPresetId): unknown {
  return { kind: 'deck:trigger', patch, label, preset };
}

function collect(control: SynthControl, msg: unknown): DeckResponse[] {
  const posted: DeckResponse[] = [];
  handleDeckRequest(msg, control, (res) => posted.push(res));
  return posted;
}

describe('handleDeckRequest', () => {
  it('ignores messages that fail the request guard', () => {
    const { control, applyTimelineOp } = stubControl();
    expect(collect(control, null)).toEqual([]);
    expect(collect(control, { kind: 'deck:unknown' })).toEqual([]);
    expect(applyTimelineOp).not.toHaveBeenCalled();
  });

  it('adds a timeline event at nowSec with the chosen transition preset', () => {
    const nowSec = 12.5;
    const { control, applyTimelineOp } = stubControl({ nowSec });
    const posted = collect(control, triggerMsg(livePatch, 'V3', 'slow'));

    const addOps = applyTimelineOp.mock.calls
      .map((call) => call[0] as TimelineOp)
      .filter((op): op is Extract<TimelineOp, { op: 'add' }> => op.op === 'add');
    expect(addOps).toHaveLength(1);
    const event = addOps[0]!.event;
    expect(event.start).toEqual({ kind: 'seconds', atSec: nowSec });
    expect(event.duration).toEqual({ kind: 'untilNext' });
    expect(event.intent.label).toBe('V3');
    expect(event.intent.patch).toEqual(livePatch);
    expect(event.transition).toEqual(TRANSITION_PRESETS.slow);
    expect(event.confidence).toBe(1);
    expect(event.locked).toBe(false);
    expect(event.id).toMatch(/^deck-[0-9a-z]+-\d+$/);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      kind: 'deck:state',
      state: { lastTriggerLabel: 'V3' },
    });
  });

  it('uses the cut preset when requested', () => {
    const { control, applyTimelineOp } = stubControl({ nowSec: 4 });
    collect(control, triggerMsg(livePatch, 'BASE', 'cut'));
    const add = applyTimelineOp.mock.calls
      .map((call) => call[0] as TimelineOp)
      .find((op): op is Extract<TimelineOp, { op: 'add' }> => op.op === 'add');
    expect(add?.event.transition).toEqual(TRANSITION_PRESETS.cut);
  });

  it('returns gate issues and never calls applyTimelineOp', () => {
    const { control, applyTimelineOp } = stubControl();
    const posted = collect(control, triggerMsg(schemaOnlyPatch(), 'V1', 'default'));
    expect(applyTimelineOp).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    const res = posted[0]!;
    expect(res.kind).toBe('deck:result');
    if (res.kind !== 'deck:result') return;
    expect(res.ok).toBe(false);
    expect(res.label).toBe('V1');
    expect(res.issues.length).toBeGreaterThan(0);
    expect(res.issues.every((issue) => typeof issue === 'string')).toBe(true);
  });

  it('refuses while the timeline is locked', () => {
    const { control, applyTimelineOp } = stubControl({
      nowSec: 10,
      lockedUntilSec: 14,
    });
    const posted = collect(control, triggerMsg(livePatch, 'V2', 'cut'));
    expect(applyTimelineOp).not.toHaveBeenCalled();
    expect(posted).toEqual([
      {
        kind: 'deck:result',
        ok: false,
        label: 'V2',
        issues: ['timeline is locked for 4s'],
      },
    ]);
  });

  it('removes fired deck-* events and swallows a failed remove', () => {
    const { control, applyTimelineOp } = stubControl({
      nowSec: 8,
      firedIds: ['deck-old', 'keep-fired'],
      events: [fakeEvent('deck-old'), fakeEvent('deck-pending'), fakeEvent('keep-fired')],
    });
    applyTimelineOp.mockImplementation((op: TimelineOp) => {
      if (op.op === 'remove' && op.id === 'deck-old') {
        return { ok: false, issue: 'protected' };
      }
      return { ok: true };
    });

    const posted = collect(control, triggerMsg(livePatch, 'BASE', 'default'));
    const ops = applyTimelineOp.mock.calls.map((call) => call[0] as TimelineOp);
    expect(ops.filter((op) => op.op === 'remove')).toEqual([{ op: 'remove', id: 'deck-old' }]);
    expect(ops.filter((op) => op.op === 'add')).toHaveLength(1);
    expect(posted[0]?.kind).toBe('deck:state');
  });

  it('requestState returns every DeckSharedState field', () => {
    const patch = livePatch;
    const { control } = stubControl({
      currentPatch: patch,
      nowSec: 12.5,
      barCount: 4,
      tempoLocked: true,
      transitionActive: true,
      lockedUntilSec: 20,
      recordingActive: true,
    });
    const posted = collect(control, { kind: 'deck:requestState' });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.kind).toBe('deck:state');
    if (posted[0]!.kind !== 'deck:state') return;
    const state = posted[0].state;
    expect(state.currentPatch).toEqual(patch);
    expect(state.nowSec).toBe(12.5);
    expect(state.barCount).toBe(4);
    expect(state.tempoLocked).toBe(true);
    expect(state.transitionActive).toBe(true);
    expect(state.lockedUntilSec).toBe(20);
    expect(state.recordingActive).toBe(true);
    expect(state.lastTriggerLabel === null || typeof state.lastTriggerLabel === 'string').toBe(
      true,
    );
  });

  it('requestState reports a null currentPatch when the synth scene is inactive', () => {
    const { control } = stubControl({ currentPatch: null, nowSec: 0, barCount: 0 });
    const posted = collect(control, { kind: 'deck:requestState' });
    expect(posted[0]).toMatchObject({
      kind: 'deck:state',
      state: { currentPatch: null, nowSec: 0, barCount: 0 },
    });
  });
});

describe('initDeckHost', () => {
  it('returns null when BroadcastChannel is unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    try {
      expect(initDeckHost()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the deck channel', () => {
    if (typeof BroadcastChannel !== 'function') return;
    const handle = initDeckHost();
    expect(handle).not.toBeNull();
    handle?.close();
    expect(DECK_CHANNEL).toBe('vj-deck-v1');
  });
});
