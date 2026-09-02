import { describe, expect, it } from 'vitest';
import type { VisualPatch } from '../synth/types';
import {
  DECK_CHANNEL,
  parseDeckMode,
  parseDeckRequest,
  parseDeckResponse,
  type DeckAppState,
  type DeckCommand,
  type DeckSharedState,
} from './protocol';

function samplePatch(overrides: Partial<VisualPatch> = {}): VisualPatch {
  return {
    schemaVersion: 1,
    seed: 'test-seed',
    operators: [
      {
        id: 'src1',
        generatorId: 'grid',
        generatorVersion: 1,
        parameters: { cells: 8, thickness: 0.08 },
      },
    ],
    routes: [],
    palette: {
      mode: 'mono',
      hueOffset: 120,
      saturation: 80,
      lightness: 50,
    },
    composition: {
      symmetry: 4,
      scale: 1,
      speed: 0.8,
    },
    qualityTier: 'medium',
    ...overrides,
  };
}

function sampleState(overrides: Partial<DeckSharedState> = {}): DeckSharedState {
  return {
    currentPatch: null,
    nowSec: 1.25,
    barCount: 3,
    tempoLocked: true,
    transitionActive: false,
    lockedUntilSec: 0,
    recordingActive: false,
    lastTriggerLabel: null,
    ...overrides,
  };
}

function sampleApp(overrides: Partial<DeckAppState> = {}): DeckAppState {
  return {
    sceneId: 'semantic-synth',
    hueMode: 'cycle',
    fixedHue: 200,
    baseHue: 180,
    background: 'black',
    seed: 'neon-prism-001',
    autoCycle: false,
    bpm: 128,
    tempoLocked: true,
    audioRunning: true,
    ...overrides,
  };
}

function commandMsg(command: DeckCommand, id = 'cmd-1'): unknown {
  return { kind: 'deck:command', id, command };
}

describe('DECK_CHANNEL', () => {
  it('is the v1 channel name', () => {
    expect(DECK_CHANNEL).toBe('vj-deck-v1');
  });
});

describe('parseDeckMode', () => {
  it('returns false when the parameter is absent', () => {
    expect(parseDeckMode('')).toBe(false);
    expect(parseDeckMode('?scene=semantic-synth&bridge=1')).toBe(false);
  });

  it('returns false for empty or non-enable values', () => {
    expect(parseDeckMode('?deck')).toBe(false);
    expect(parseDeckMode('?deck=')).toBe(false);
    expect(parseDeckMode('?deck=0')).toBe(false);
    expect(parseDeckMode('?deck=yes')).toBe(false);
    expect(parseDeckMode('?deck=false')).toBe(false);
  });

  it('maps the enable forms to true', () => {
    expect(parseDeckMode('?deck=1')).toBe(true);
    expect(parseDeckMode('?deck=true')).toBe(true);
    expect(parseDeckMode('?bridge=1&deck=1')).toBe(true);
    expect(parseDeckMode('?room=abcd1234&deck=true')).toBe(true);
  });
});

describe('parseDeckRequest', () => {
  it('accepts requestState', () => {
    expect(parseDeckRequest({ kind: 'deck:requestState' })).toEqual({
      kind: 'deck:requestState',
    });
  });

  it('accepts a valid trigger', () => {
    const patch = samplePatch();
    const msg = {
      kind: 'deck:trigger',
      patch,
      label: 'V3',
      preset: 'slow',
    };
    expect(parseDeckRequest(msg)).toEqual({
      kind: 'deck:trigger',
      patch,
      label: 'V3',
      preset: 'slow',
    });
  });

  it('rejects null / non-objects / wrong kind', () => {
    expect(parseDeckRequest(null)).toBeNull();
    expect(parseDeckRequest(undefined)).toBeNull();
    expect(parseDeckRequest(42)).toBeNull();
    expect(parseDeckRequest('deck:trigger')).toBeNull();
    expect(parseDeckRequest([])).toBeNull();
    expect(parseDeckRequest({})).toBeNull();
    expect(parseDeckRequest({ kind: 'deck:unknown' })).toBeNull();
    expect(parseDeckRequest({ kind: 'deck:state' })).toBeNull();
  });

  it('rejects trigger with missing or invalid fields', () => {
    const patch = samplePatch();
    expect(parseDeckRequest({ kind: 'deck:trigger' })).toBeNull();
    expect(parseDeckRequest({ kind: 'deck:trigger', patch, label: 'V1' })).toBeNull();
    expect(
      parseDeckRequest({ kind: 'deck:trigger', patch, label: 'V1', preset: 'fast' }),
    ).toBeNull();
    expect(parseDeckRequest({ kind: 'deck:trigger', patch, label: 1, preset: 'cut' })).toBeNull();
    expect(
      parseDeckRequest({
        kind: 'deck:trigger',
        patch: { seed: 'nope' },
        label: 'V1',
        preset: 'cut',
      }),
    ).toBeNull();
    expect(
      parseDeckRequest({ kind: 'deck:trigger', patch: null, label: 'V1', preset: 'cut' }),
    ).toBeNull();
  });

  it('accepts every command kind', () => {
    const goods: DeckCommand[] = [
      { kind: 'seed:gacha' },
      { kind: 'seed:set', seed: 'neon-tiger-042' },
      { kind: 'patch:rerollDetails', seed: 'neon-tiger-042' },
      { kind: 'scene:set', sceneId: 'bars' },
      { kind: 'scene:shift', delta: 1 },
      { kind: 'scene:shift', delta: -1 },
      { kind: 'hue:mode', mode: 'cycle' },
      { kind: 'hue:mode', mode: 'fixed' },
      { kind: 'hue:fixed', hue: 0 },
      { kind: 'hue:fixed', hue: 200 },
      { kind: 'hue:fixed', hue: 360 },
      { kind: 'background:set', background: 'black' },
      { kind: 'background:set', background: 'transparent' },
      { kind: 'tempo:tap' },
      { kind: 'tempo:multiply', factor: 2 },
      { kind: 'tempo:multiply', factor: 0.5 },
      { kind: 'tempo:auto' },
      { kind: 'timeline:lock', seconds: 0 },
      { kind: 'timeline:lock', seconds: 30 },
      { kind: 'autoCycle:set', on: true },
      { kind: 'autoCycle:set', on: false },
    ];
    for (const command of goods) {
      expect(parseDeckRequest(commandMsg(command))).toEqual({
        kind: 'deck:command',
        id: 'cmd-1',
        command,
      });
    }
  });

  it('rejects command with missing or invalid envelope', () => {
    expect(parseDeckRequest({ kind: 'deck:command' })).toBeNull();
    expect(
      parseDeckRequest({ kind: 'deck:command', id: 1, command: { kind: 'tempo:tap' } }),
    ).toBeNull();
    expect(parseDeckRequest({ kind: 'deck:command', id: 'x' })).toBeNull();
    expect(parseDeckRequest({ kind: 'deck:command', id: 'x', command: null })).toBeNull();
    expect(parseDeckRequest({ kind: 'deck:command', id: 'x', command: [] })).toBeNull();
    expect(
      parseDeckRequest({ kind: 'deck:command', id: 'x', command: { kind: 'nope' } }),
    ).toBeNull();
  });

  it('rejects each command kind with invalid fields', () => {
    const bads: unknown[] = [
      { kind: 'seed:set' },
      { kind: 'seed:set', seed: 12 },
      { kind: 'patch:rerollDetails' },
      { kind: 'patch:rerollDetails', seed: 12 },
      { kind: 'scene:set' },
      { kind: 'scene:set', sceneId: 0 },
      { kind: 'scene:shift', delta: 0 },
      { kind: 'scene:shift', delta: 2 },
      { kind: 'scene:shift', delta: '1' },
      { kind: 'hue:mode', mode: 'rainbow' },
      { kind: 'hue:mode' },
      { kind: 'hue:fixed', hue: Number.NaN },
      { kind: 'hue:fixed', hue: Number.POSITIVE_INFINITY },
      { kind: 'hue:fixed', hue: -1 },
      { kind: 'hue:fixed', hue: 361 },
      { kind: 'hue:fixed', hue: '200' },
      { kind: 'background:set', background: 'white' },
      { kind: 'tempo:multiply', factor: 1 },
      { kind: 'tempo:multiply', factor: 3 },
      { kind: 'tempo:multiply' },
      { kind: 'timeline:lock', seconds: Number.NaN },
      { kind: 'timeline:lock', seconds: Number.POSITIVE_INFINITY },
      { kind: 'timeline:lock', seconds: -1 },
      { kind: 'timeline:lock' },
      { kind: 'autoCycle:set', on: 1 },
      { kind: 'autoCycle:set', on: 'true' },
      { kind: 'autoCycle:set' },
    ];
    for (const command of bads) {
      expect(parseDeckRequest(commandMsg(command as DeckCommand))).toBeNull();
    }
  });
});

describe('parseDeckResponse', () => {
  it('accepts result', () => {
    const msg = { kind: 'deck:result', ok: true, label: 'V2', issues: [] };
    expect(parseDeckResponse(msg)).toEqual(msg);
    expect(
      parseDeckResponse({
        kind: 'deck:result',
        ok: false,
        label: 'V2',
        issues: ['timeline is locked for 4s'],
      }),
    ).toEqual({
      kind: 'deck:result',
      ok: false,
      label: 'V2',
      issues: ['timeline is locked for 4s'],
    });
  });

  it('accepts state with a null patch and with a valid patch', () => {
    const empty = sampleState();
    expect(parseDeckResponse({ kind: 'deck:state', state: empty })).toEqual({
      kind: 'deck:state',
      state: empty,
    });

    const withPatch = sampleState({
      currentPatch: samplePatch(),
      lastTriggerLabel: 'BASE',
      recordingActive: true,
    });
    expect(parseDeckResponse({ kind: 'deck:state', state: withPatch })).toEqual({
      kind: 'deck:state',
      state: withPatch,
    });
  });

  it('rejects null / non-objects / wrong kind', () => {
    expect(parseDeckResponse(null)).toBeNull();
    expect(parseDeckResponse(undefined)).toBeNull();
    expect(parseDeckResponse(0)).toBeNull();
    expect(parseDeckResponse([])).toBeNull();
    expect(parseDeckResponse({ kind: 'deck:trigger' })).toBeNull();
    expect(parseDeckResponse({ kind: 'deck:requestState' })).toBeNull();
  });

  it('rejects result / state with missing or invalid fields', () => {
    expect(parseDeckResponse({ kind: 'deck:result' })).toBeNull();
    expect(parseDeckResponse({ kind: 'deck:result', ok: true, label: 'V1' })).toBeNull();
    expect(
      parseDeckResponse({ kind: 'deck:result', ok: true, label: 'V1', issues: [1] }),
    ).toBeNull();
    expect(parseDeckResponse({ kind: 'deck:state' })).toBeNull();
    expect(parseDeckResponse({ kind: 'deck:state', state: null })).toBeNull();
    expect(
      parseDeckResponse({
        kind: 'deck:state',
        state: { ...sampleState(), nowSec: Number.NaN },
      }),
    ).toBeNull();
    expect(
      parseDeckResponse({
        kind: 'deck:state',
        state: { ...sampleState(), currentPatch: { seed: 'nope' } },
      }),
    ).toBeNull();
    expect(
      parseDeckResponse({
        kind: 'deck:state',
        state: { ...sampleState(), lastTriggerLabel: 3 },
      }),
    ).toBeNull();
  });

  it('accepts a finite hue and keeps it', () => {
    for (const hue of [0, 213, 359.5]) {
      const withHue = sampleState({ hue });
      expect(parseDeckResponse({ kind: 'deck:state', state: withHue })).toEqual({
        kind: 'deck:state',
        state: withHue,
      });
    }
  });

  it('keeps hue undefined when the field is missing (legacy host)', () => {
    const empty = sampleState();
    expect(empty.hue).toBeUndefined();
    expect('hue' in empty).toBe(false);
    const parsed = parseDeckResponse({ kind: 'deck:state', state: empty });
    expect(parsed).toEqual({ kind: 'deck:state', state: empty });
    if (parsed?.kind === 'deck:state') {
      expect(parsed.state.hue).toBeUndefined();
      expect('hue' in parsed.state).toBe(false);
    }
  });

  it('omits hue when the input has explicit hue: undefined', () => {
    const parsed = parseDeckResponse({
      kind: 'deck:state',
      state: { ...sampleState(), hue: undefined },
    });
    expect(parsed).not.toBeNull();
    if (parsed?.kind === 'deck:state') {
      expect(parsed.state.hue).toBeUndefined();
      expect('hue' in parsed.state).toBe(false);
    }
  });

  it('rejects NaN or non-number hue', () => {
    expect(
      parseDeckResponse({
        kind: 'deck:state',
        state: { ...sampleState(), hue: Number.NaN },
      }),
    ).toBeNull();
    expect(
      parseDeckResponse({
        kind: 'deck:state',
        state: { ...sampleState(), hue: Number.POSITIVE_INFINITY },
      }),
    ).toBeNull();
    expect(
      parseDeckResponse({
        kind: 'deck:state',
        state: { ...sampleState(), hue: '200' },
      }),
    ).toBeNull();
    expect(
      parseDeckResponse({
        kind: 'deck:state',
        state: { ...sampleState(), hue: null },
      }),
    ).toBeNull();
  });

  it('accepts commandResult', () => {
    const msg = { kind: 'deck:commandResult' as const, id: 'cmd-1', ok: true, issues: [] };
    expect(parseDeckResponse(msg)).toEqual(msg);
    expect(
      parseDeckResponse({
        kind: 'deck:commandResult',
        id: 'cmd-2',
        ok: false,
        issues: ['unknown scene: nope'],
      }),
    ).toEqual({
      kind: 'deck:commandResult',
      id: 'cmd-2',
      ok: false,
      issues: ['unknown scene: nope'],
    });
  });

  it('rejects commandResult with missing or invalid fields', () => {
    expect(parseDeckResponse({ kind: 'deck:commandResult' })).toBeNull();
    expect(parseDeckResponse({ kind: 'deck:commandResult', id: 'x', ok: true })).toBeNull();
    expect(
      parseDeckResponse({ kind: 'deck:commandResult', id: 1, ok: true, issues: [] }),
    ).toBeNull();
    expect(
      parseDeckResponse({ kind: 'deck:commandResult', id: 'x', ok: 'yes', issues: [] }),
    ).toBeNull();
    expect(
      parseDeckResponse({ kind: 'deck:commandResult', id: 'x', ok: true, issues: [1] }),
    ).toBeNull();
  });

  it('accepts a valid app block and keeps it', () => {
    const withApp = sampleState({ app: sampleApp({ bpm: 0, audioRunning: false }) });
    expect(parseDeckResponse({ kind: 'deck:state', state: withApp })).toEqual({
      kind: 'deck:state',
      state: withApp,
    });
  });

  it('rejects missing or non-finite baseHue', () => {
    const app = sampleApp();
    const withoutBase = {
      sceneId: app.sceneId,
      hueMode: app.hueMode,
      fixedHue: app.fixedHue,
      background: app.background,
      seed: app.seed,
      autoCycle: app.autoCycle,
      bpm: app.bpm,
      tempoLocked: app.tempoLocked,
      audioRunning: app.audioRunning,
    };
    expect(
      parseDeckResponse({
        kind: 'deck:state',
        state: { ...sampleState(), app: withoutBase },
      } as unknown),
    ).toBeNull();
    expect(
      parseDeckResponse({
        kind: 'deck:state',
        state: { ...sampleState(), app: { ...sampleApp(), baseHue: Number.NaN } },
      }),
    ).toBeNull();
  });

  it('keeps app undefined when the field is missing (legacy host)', () => {
    const empty = sampleState();
    expect(empty.app).toBeUndefined();
    const parsed = parseDeckResponse({ kind: 'deck:state', state: empty });
    expect(parsed).toEqual({ kind: 'deck:state', state: empty });
    if (parsed?.kind === 'deck:state') {
      expect(parsed.state.app).toBeUndefined();
    }
  });

  it('rejects app that is present but invalid', () => {
    const invalids: unknown[] = [
      null,
      [],
      { ...sampleApp(), sceneId: 1 },
      { ...sampleApp(), hueMode: 'spin' },
      { ...sampleApp(), fixedHue: Number.NaN },
      { ...sampleApp(), baseHue: Number.NaN },
      { ...sampleApp(), baseHue: '180' },
      { ...sampleApp(), background: 'white' },
      { ...sampleApp(), seed: 3 },
      { ...sampleApp(), autoCycle: 1 },
      { ...sampleApp(), bpm: Number.POSITIVE_INFINITY },
      { ...sampleApp(), tempoLocked: 'yes' },
      { ...sampleApp(), audioRunning: 'no' },
      { sceneId: 'bars' },
    ];
    for (const app of invalids) {
      expect(
        parseDeckResponse({
          kind: 'deck:state',
          state: { ...sampleState(), app },
        }),
      ).toBeNull();
    }
  });
});
