import { describe, expect, it } from 'vitest';
import {
  acceptLearnMessage,
  parseMidiMapping,
  parseMidiMessage,
  parseMidiStorage,
  resolveMidiBinding,
  type MidiMapping,
  type MidiTrigger,
} from './midi';
import { NANOPAD2_NATIVE_MAPPING, NANOPAD2_PAD1_NOTE } from './nanopad2';

function bytes(...data: number[]): Uint8Array {
  return new Uint8Array(data);
}

const tapMapping = (over: Partial<MidiMapping> = {}): MidiMapping => ({
  version: 1,
  name: 'test',
  bindings: [],
  ...over,
});

describe('parseMidiMessage', () => {
  it('parses noteOn with channel and velocity', () => {
    expect(parseMidiMessage(bytes(0x90, 60, 100))).toEqual({
      kind: 'noteOn',
      ch: 0,
      note: 60,
      velocity: 100,
    });
    expect(parseMidiMessage(bytes(0x93, 36, 1))).toEqual({
      kind: 'noteOn',
      ch: 3,
      note: 36,
      velocity: 1,
    });
  });

  it('treats noteOn velocity 0 as noteOff', () => {
    expect(parseMidiMessage(bytes(0x90, 60, 0))).toEqual({
      kind: 'noteOff',
      ch: 0,
      note: 60,
    });
  });

  it('parses noteOff and cc', () => {
    expect(parseMidiMessage(bytes(0x80, 60, 64))).toEqual({
      kind: 'noteOff',
      ch: 0,
      note: 60,
    });
    expect(parseMidiMessage(bytes(0xb2, 9, 64))).toEqual({
      kind: 'cc',
      ch: 2,
      controller: 9,
      value: 64,
    });
  });

  it('returns null for short or invalid messages', () => {
    expect(parseMidiMessage(bytes())).toBeNull();
    expect(parseMidiMessage(bytes(0x90))).toBeNull();
    expect(parseMidiMessage(bytes(0x90, 60))).toBeNull();
    expect(parseMidiMessage(bytes(0xb0, 1))).toBeNull();
    expect(parseMidiMessage(bytes(0xc0, 1))).toBeNull();
    expect(parseMidiMessage(bytes(0x20, 60, 100))).toBeNull();
  });
});

describe('resolveMidiBinding', () => {
  it('matches ch any and returns the first binding', () => {
    const mapping = tapMapping({
      bindings: [
        {
          trigger: { kind: 'note', ch: 'any', note: 60 },
          action: { type: 'trigger', slot: 0 },
        },
        {
          trigger: { kind: 'note', ch: 3, note: 60 },
          action: { type: 'trigger', slot: 7 },
        },
      ],
    });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 3, note: 60, velocity: 40 }, mapping)?.action,
    ).toEqual({
      type: 'trigger',
      slot: 0,
    });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 0, note: 61, velocity: 40 }, mapping),
    ).toBeNull();
  });

  it('sets cut when velocity meets the threshold', () => {
    const mapping = tapMapping({
      bindings: [
        {
          trigger: { kind: 'note', ch: 0, note: 36 },
          action: { type: 'trigger', slot: 2 },
          velocityCutThreshold: 100,
        },
      ],
    });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 0, note: 36, velocity: 99 }, mapping)?.action,
    ).toEqual({
      type: 'trigger',
      slot: 2,
    });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 0, note: 36, velocity: 100 }, mapping)?.action,
    ).toEqual({
      type: 'trigger',
      slot: 2,
      cut: true,
    });
  });

  it('returns null when nothing matches', () => {
    const mapping = tapMapping({
      bindings: [
        {
          trigger: { kind: 'note', ch: 0, note: 10 },
          action: { type: 'trigger', slot: 0 },
        },
      ],
    });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 0, note: 11, velocity: 64 }, mapping),
    ).toBeNull();
    expect(resolveMidiBinding({ kind: 'noteOff', ch: 0, note: 10 }, mapping)).toBeNull();
    expect(
      resolveMidiBinding({ kind: 'sysex', data: new Uint8Array([0xf0, 0xf7]) }, mapping),
    ).toBeNull();
  });

  it('fires CC press at value >= 64 and ignores below', () => {
    const mapping = tapMapping({
      bindings: [
        {
          trigger: { kind: 'cc', ch: 'any', controller: 16, edge: 'press' },
          action: { type: 'command', command: { kind: 'tempo:tap' } },
        },
      ],
    });
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 0, controller: 16, value: 63 }, mapping),
    ).toBeNull();
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 5, controller: 16, value: 64 }, mapping)?.action,
    ).toEqual({
      type: 'command',
      command: { kind: 'tempo:tap' },
    });
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 5, controller: 16, value: 127 }, mapping)?.action,
    ).toEqual({
      type: 'command',
      command: { kind: 'tempo:tap' },
    });
  });

  it('maps CC value 0..127 onto intervalAbs and hue:fixed', () => {
    const interval = tapMapping({
      bindings: [
        {
          trigger: { kind: 'cc', ch: 0, controller: 10, edge: 'value' },
          action: { type: 'auto.intervalAbs', value01: 0 },
        },
      ],
    });
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 0, controller: 10, value: 0 }, interval)?.action,
    ).toEqual({
      type: 'auto.intervalAbs',
      value01: 0,
    });
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 0, controller: 10, value: 64 }, interval)?.action,
    ).toEqual({
      type: 'auto.intervalAbs',
      value01: 64 / 127,
    });
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 0, controller: 10, value: 127 }, interval)?.action,
    ).toEqual({
      type: 'auto.intervalAbs',
      value01: 1,
    });

    const hue = tapMapping({
      bindings: [
        {
          trigger: { kind: 'cc', ch: 0, controller: 9, edge: 'value' },
          action: { type: 'command', command: { kind: 'hue:fixed', hue: 0 } },
        },
      ],
    });
    expect(resolveMidiBinding({ kind: 'cc', ch: 0, controller: 9, value: 0 }, hue)?.action).toEqual(
      {
        type: 'command',
        command: { kind: 'hue:fixed', hue: 0 },
      },
    );
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 0, controller: 9, value: 127 }, hue)?.action,
    ).toEqual({
      type: 'command',
      command: { kind: 'hue:fixed', hue: 360 },
    });
  });

  it('uses trigger.edge for continuous vs press, not the action type', () => {
    const mapping = tapMapping({
      bindings: [
        {
          trigger: { kind: 'cc', ch: 0, controller: 1, edge: 'value' },
          action: { type: 'trigger', slot: 0 },
        },
      ],
    });
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 0, controller: 1, value: 10 }, mapping)?.action,
    ).toEqual({ type: 'trigger', slot: 0 });
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 0, controller: 1, value: 10 }, mapping)?.binding.trigger,
    ).toEqual({
      kind: 'cc',
      ch: 0,
      controller: 1,
      edge: 'value',
    });
  });

  it('continues past a non-firing press to a later binding', () => {
    const mapping = tapMapping({
      bindings: [
        {
          trigger: { kind: 'cc', ch: 0, controller: 16, edge: 'press' },
          action: { type: 'bank.rebuild' },
        },
        {
          trigger: { kind: 'cc', ch: 0, controller: 16, edge: 'value' },
          action: { type: 'auto.intervalAbs', value01: 0 },
        },
      ],
    });
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 0, controller: 16, value: 10 }, mapping)?.action,
    ).toEqual({
      type: 'auto.intervalAbs',
      value01: 10 / 127,
    });
  });
});

describe('parseMidiMapping', () => {
  it('rejects garbage', () => {
    expect(parseMidiMapping(null)).toBeNull();
    expect(parseMidiMapping(undefined)).toBeNull();
    expect(parseMidiMapping('nope')).toBeNull();
    expect(parseMidiMapping(1)).toBeNull();
    expect(parseMidiMapping([])).toBeNull();
    expect(parseMidiMapping({})).toBeNull();
    expect(parseMidiMapping({ version: 2, name: 'x', bindings: [] })).toBeNull();
    expect(parseMidiMapping({ version: 1, name: 3, bindings: [] })).toBeNull();
    expect(parseMidiMapping({ version: 1, name: 'x', bindings: null })).toBeNull();
    expect(
      parseMidiMapping({
        version: 1,
        name: 'x',
        bindings: [{ trigger: { kind: 'note', ch: 0, note: 60 }, action: { type: 'nope' } }],
      }),
    ).toBeNull();
  });

  it('accepts a valid mapping and the nanoPAD2 native map', () => {
    const parsed = parseMidiMapping({
      version: 1,
      name: 'ok',
      bindings: [
        {
          trigger: { kind: 'note', ch: 'any', note: 42 },
          action: { type: 'trigger', slot: 3, cut: true },
          velocityCutThreshold: 90,
        },
      ],
    });
    expect(parsed).toEqual({
      version: 1,
      name: 'ok',
      bindings: [
        {
          trigger: { kind: 'note', ch: 'any', note: 42 },
          action: { type: 'trigger', slot: 3, cut: true },
          velocityCutThreshold: 90,
        },
      ],
    });
    expect(parseMidiMapping(NANOPAD2_NATIVE_MAPPING)).toEqual(NANOPAD2_NATIVE_MAPPING);
    expect(NANOPAD2_PAD1_NOTE).toBe(64);
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 1, note: 72, velocity: 40 }, NANOPAD2_NATIVE_MAPPING)
        ?.action,
    ).toEqual({ type: 'trigger', slot: 0 });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 1, note: 64, velocity: 40 }, NANOPAD2_NATIVE_MAPPING)
        ?.action,
    ).toEqual({ type: 'trigger', slot: 0, cut: true });
  });
});

describe('acceptLearnMessage', () => {
  const pressCc = (
    value: number,
  ): { kind: 'cc'; ch: number; controller: number; value: number } => ({
    kind: 'cc',
    ch: 0,
    controller: 16,
    value,
  });
  const boundPress: MidiTrigger = { kind: 'cc', ch: 0, controller: 16, edge: 'press' };

  it('ignores CC value<64 when the current item is press', () => {
    expect(acceptLearnMessage(pressCc(0), 'press', null)).toEqual({
      bind: null,
      lastBound: null,
    });
    expect(acceptLearnMessage(pressCc(63), 'press', null)).toEqual({
      bind: null,
      lastBound: null,
    });
    expect(acceptLearnMessage(pressCc(64), 'press', null)).toEqual({
      bind: boundPress,
      lastBound: boundPress,
    });
  });

  it('does not rebind an overlapping press release onto the next action', () => {
    const afterPress = acceptLearnMessage(pressCc(127), 'press', null);
    expect(afterPress.bind).toEqual(boundPress);
    const release = acceptLearnMessage(pressCc(0), 'press', afterPress.lastBound);
    expect(release).toEqual({ bind: null, lastBound: null });
  });

  it('latches a value-edge knob until a different controller/note arrives', () => {
    const first = acceptLearnMessage(pressCc(80), 'value', null);
    expect(first.bind).toEqual({ kind: 'cc', ch: 0, controller: 16, edge: 'value' });
    expect(acceptLearnMessage(pressCc(90), 'value', first.lastBound)).toEqual({
      bind: null,
      lastBound: first.lastBound,
    });
    expect(acceptLearnMessage(pressCc(10), 'value', first.lastBound)).toEqual({
      bind: null,
      lastBound: first.lastBound,
    });
    const other = acceptLearnMessage(
      { kind: 'cc', ch: 0, controller: 17, value: 40 },
      'value',
      first.lastBound,
    );
    expect(other.bind).toEqual({ kind: 'cc', ch: 0, controller: 17, edge: 'value' });
  });

  it('does not rebind a value-edge knob onto the next press-edge item', () => {
    const first = acceptLearnMessage(pressCc(80), 'value', null);
    expect(first.bind).toEqual({ kind: 'cc', ch: 0, controller: 16, edge: 'value' });
    expect(acceptLearnMessage(pressCc(10), 'press', first.lastBound)).toEqual({
      bind: null,
      lastBound: first.lastBound,
    });
    expect(acceptLearnMessage(pressCc(90), 'press', first.lastBound)).toEqual({
      bind: null,
      lastBound: first.lastBound,
    });
  });
});

describe('parseMidiStorage', () => {
  it('reads activeMapping and nanopad prefs', () => {
    expect(
      parseMidiStorage({ activeMapping: null, nanopad: { preferNative: false, swapRows: true } }),
    ).toEqual({
      activeMapping: null,
      nanopad: { preferNative: false, swapRows: true },
    });
    expect(parseMidiStorage({ activeMapping: null })).toEqual({
      activeMapping: null,
      nanopad: { preferNative: true, swapRows: false },
    });
    expect(parseMidiStorage({ autoApplyPreset: true, activeMapping: null })).toEqual({
      activeMapping: null,
      nanopad: { preferNative: true, swapRows: false },
    });
    expect(parseMidiStorage('nope')).toBeNull();
  });
});
