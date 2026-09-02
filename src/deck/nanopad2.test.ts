import { describe, expect, it } from 'vitest';
import { resolveMidiBinding } from './midi';
import {
  NANOPAD2_FAMILY_ID,
  NANOPAD2_NATIVE_CC_CH,
  NANOPAD2_NATIVE_MAPPING,
  NANOPAD2_NATIVE_NOTE_CH,
  NANOPAD2_PAD1_NOTE,
  SCENE_DUMP_PACKED_BYTES,
  SCENE_DUMP_UNPACKED_BYTES,
  buildSceneDumpUnpacked,
  ccSceneLed,
  mappingFromPads,
  nativeMapping,
  pack7bit,
  parseNanopadSysex,
  parseSceneDumpPads,
  sysexModeRequest,
  sysexNativeModeRequest,
  sysexSceneDumpRequest,
  sysexSearchDeviceRequest,
  unpack7bit,
  type NanopadPad,
} from './nanopad2';

function bytes(...data: number[]): Uint8Array {
  return new Uint8Array(data);
}

function dumpSysex(unpacked: Uint8Array, globalCh = 0): Uint8Array {
  const packed = pack7bit(unpacked);
  const len = packed.length + 1;
  return Uint8Array.from([
    0xf0,
    0x42,
    0x40 | globalCh,
    0x00,
    0x01,
    0x12,
    0x00,
    0x7f,
    0x7f,
    0x02,
    (len >> 7) & 0x7f,
    len & 0x7f,
    0x40,
    ...packed,
    0xf7,
  ]);
}

describe('sysex builders', () => {
  it('builds Native In/Out on the global channel', () => {
    expect(sysexNativeModeRequest(0, true)).toEqual(
      bytes(0xf0, 0x42, 0x40, 0x00, 0x01, 0x12, 0x00, 0x00, 0x00, 0x01, 0xf7),
    );
    expect(sysexNativeModeRequest(0, false)).toEqual(
      bytes(0xf0, 0x42, 0x40, 0x00, 0x01, 0x12, 0x00, 0x00, 0x00, 0x00, 0xf7),
    );
    expect(sysexNativeModeRequest(3, true)).toEqual(
      bytes(0xf0, 0x42, 0x43, 0x00, 0x01, 0x12, 0x00, 0x00, 0x00, 0x01, 0xf7),
    );
  });

  it('builds Mode Request and Search Device Request', () => {
    expect(sysexModeRequest(0)).toEqual(
      bytes(0xf0, 0x42, 0x40, 0x00, 0x01, 0x12, 0x00, 0x1f, 0x12, 0x00, 0xf7),
    );
    expect(sysexSearchDeviceRequest(0x2a)).toEqual(bytes(0xf0, 0x42, 0x50, 0x00, 0x2a, 0xf7));
  });

  it('builds Current Scene Data Dump Request (Func 10)', () => {
    expect(sysexSceneDumpRequest(1)).toEqual(
      bytes(0xf0, 0x42, 0x41, 0x00, 0x01, 0x12, 0x00, 0x1f, 0x10, 0x00, 0xf7),
    );
  });

  it('builds Scene LED CCs on ch 16', () => {
    expect(ccSceneLed(1, true)).toEqual(bytes(0xbf, 0x79, 0x7f));
    expect(ccSceneLed(2, false)).toEqual(bytes(0xbf, 0x7a, 0x00));
    expect(ccSceneLed(3, true)).toEqual(bytes(0xbf, 0x7b, 0x7f));
    expect(ccSceneLed(4, false)).toEqual(bytes(0xbf, 0x7c, 0x00));
    expect(0xbf).toBe(0xb0 | NANOPAD2_NATIVE_CC_CH);
  });
});

describe('parseNanopadSysex', () => {
  it('parses Native mode In/Out', () => {
    expect(
      parseNanopadSysex(bytes(0xf0, 0x42, 0x40, 0x00, 0x01, 0x12, 0x00, 0x40, 0x00, 0x03, 0xf7)),
    ).toEqual({ kind: 'nativeMode', on: true });
    expect(
      parseNanopadSysex(bytes(0xf0, 0x42, 0x40, 0x00, 0x01, 0x12, 0x00, 0x40, 0x00, 0x02, 0xf7)),
    ).toEqual({ kind: 'nativeMode', on: false });
  });

  it('parses Mode Data', () => {
    expect(
      parseNanopadSysex(bytes(0xf0, 0x42, 0x42, 0x00, 0x01, 0x12, 0x00, 0x5f, 0x42, 0x01, 0xf7)),
    ).toEqual({ kind: 'modeData', native: true });
    expect(
      parseNanopadSysex(bytes(0xf0, 0x42, 0x42, 0x00, 0x01, 0x12, 0x00, 0x5f, 0x42, 0x00, 0xf7)),
    ).toEqual({ kind: 'modeData', native: false });
  });

  it('parses Search Device Reply and Family ID 12 01', () => {
    expect(
      parseNanopadSysex(
        bytes(
          0xf0,
          0x42,
          0x50,
          0x01,
          0x00,
          0x11,
          NANOPAD2_FAMILY_ID[0],
          NANOPAD2_FAMILY_ID[1],
          0xf7,
        ),
      ),
    ).toEqual({ kind: 'searchReply', globalCh: 0, echoId: 0x11, isNanopad2: true });
    expect(parseNanopadSysex(bytes(0xf0, 0x42, 0x50, 0x01, 0x05, 0x03, 0x13, 0x01, 0xf7))).toEqual({
      kind: 'searchReply',
      globalCh: 5,
      echoId: 3,
      isNanopad2: false,
    });
  });

  it('returns null for unknown sysex', () => {
    expect(parseNanopadSysex(bytes(0xf0, 0x7e, 0xf7))).toBeNull();
    expect(parseNanopadSysex(bytes(0xf0, 0x42, 0x40, 0x00, 0x01, 0x13, 0x00, 0xf7))).toBeNull();
  });
});

describe('unpack7bit', () => {
  it('round-trips 97 unpacked bytes to 111 packed bytes', () => {
    const raw = Uint8Array.from({ length: SCENE_DUMP_UNPACKED_BYTES }, (_, i) => (i * 13) & 0xff);
    const packed = pack7bit(raw);
    expect(packed.length).toBe(SCENE_DUMP_PACKED_BYTES);
    expect(unpack7bit(packed)).toEqual(raw);
  });

  it('restores MSB from the leading byte of each 7-byte group', () => {
    const packed = bytes(0b0000_0101, 0x01, 0x02, 0x03);
    expect(unpack7bit(packed)).toEqual(bytes(0x81, 0x02, 0x83));
  });
});

describe('scene dump → mapping', () => {
  it('parses pad assign/note/ch from a packed dump', () => {
    const pads: NanopadPad[] = Array.from({ length: 16 }, (_, i) => ({
      assign: 'note',
      number: i < 8 ? 40 + i : 60 + (i - 8),
      ch: i === 0 ? 'global' : 0,
    }));
    const unpacked = buildSceneDumpUnpacked(pads);
    expect(unpacked.length).toBe(97);
    expect(parseSceneDumpPads(unpacked)).toEqual(pads);

    const parsed = parseNanopadSysex(dumpSysex(unpacked, 0));
    expect(parsed?.kind).toBe('sceneDump');
    if (parsed?.kind !== 'sceneDump') return;
    expect(parsed.pads).toEqual(pads);

    const mapping = mappingFromPads(parsed.pads);
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 0, note: 60, velocity: 40 }, mapping)?.action,
    ).toEqual({ type: 'trigger', slot: 0 });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 3, note: 40, velocity: 40 }, mapping)?.action,
    ).toEqual({ type: 'trigger', slot: 0, cut: true });
  });
});

describe('NANOPAD2_NATIVE_MAPPING', () => {
  it('maps lower pads to trigger and upper pads to cut on ch 2', () => {
    expect(NANOPAD2_PAD1_NOTE).toBe(64);
    expect(NANOPAD2_NATIVE_NOTE_CH).toBe(1);
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 1, note: 72, velocity: 40 }, NANOPAD2_NATIVE_MAPPING)
        ?.action,
    ).toEqual({ type: 'trigger', slot: 0 });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 1, note: 79, velocity: 40 }, NANOPAD2_NATIVE_MAPPING)
        ?.action,
    ).toEqual({ type: 'trigger', slot: 7 });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 1, note: 64, velocity: 40 }, NANOPAD2_NATIVE_MAPPING)
        ?.action,
    ).toEqual({ type: 'trigger', slot: 0, cut: true });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 1, note: 71, velocity: 40 }, NANOPAD2_NATIVE_MAPPING)
        ?.action,
    ).toEqual({ type: 'trigger', slot: 7, cut: true });
    expect(
      resolveMidiBinding(
        { kind: 'cc', ch: 15, controller: 0x39, value: 127 },
        NANOPAD2_NATIVE_MAPPING,
      )?.action,
    ).toEqual({ type: 'command', command: { kind: 'tempo:tap' } });
    expect(
      resolveMidiBinding(
        { kind: 'cc', ch: 15, controller: 0x0b, value: 127 },
        NANOPAD2_NATIVE_MAPPING,
      )?.action,
    ).toEqual({ type: 'fireCursor' });
    expect(
      resolveMidiBinding({ kind: 'cc', ch: 15, controller: 9, value: 64 }, NANOPAD2_NATIVE_MAPPING),
    ).toBeNull();
  });

  it('swapRows exchanges the physical rows', () => {
    const swapped = nativeMapping(true);
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 1, note: 64, velocity: 40 }, swapped)?.action,
    ).toEqual({ type: 'trigger', slot: 0 });
    expect(
      resolveMidiBinding({ kind: 'noteOn', ch: 1, note: 72, velocity: 40 }, swapped)?.action,
    ).toEqual({ type: 'trigger', slot: 0, cut: true });
  });
});
