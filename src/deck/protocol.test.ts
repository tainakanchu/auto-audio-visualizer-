import { describe, expect, it } from 'vitest';
import type { VisualPatch } from '../synth/types';
import {
  DECK_CHANNEL,
  parseDeckMode,
  parseDeckRequest,
  parseDeckResponse,
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
});
