/**
 * KORG nanoPAD2 Native KORG Mode ドライバ（純関数）。
 *
 * MIDI Implementation Rev 1.01（2011.10.19）:
 *   Native In/Out N3, Mode Request N8, Search Device N9,
 *   Scene Data Dump N2/NOTE 3, LED N7, pad 出力 N4–N6.
 *
 * 資料に pad 1..16 と物理上下段の対応は無い。既定は
 * notes 64–71（pads 1–8）を上段 cut、72–79（pads 9–16）を下段 trigger。
 * ズレたら swapRows。
 */
import type { MidiBinding, MidiMapping } from './midi';

export const NANOPAD2_FAMILY_ID = [0x12, 0x01] as const;
export const NANOPAD2_PRODUCT = [0x00, 0x01, 0x12] as const;
/** Native mode のパッド Note On は ch 2（index 1）。 */
export const NANOPAD2_NATIVE_NOTE_CH = 1;
/** Native mode の CC（X-Y / Scene / LED）は ch 16（index 15）。 */
export const NANOPAD2_NATIVE_CC_CH = 15;
/** Touch Scale 由来の 92/82/B2。Native では無視する。 */
export const NANOPAD2_TOUCH_SCALE_CH = 2;
/** Native pad 1 = Note 64。 */
export const NANOPAD2_PAD1_NOTE = 64;
export const SCENE_DUMP_UNPACKED_BYTES = 97;
export const SCENE_DUMP_PACKED_BYTES = 111;

export type NanopadAssign = 'none' | 'cc' | 'note' | 'pc';

export interface NanopadPad {
  assign: NanopadAssign;
  number: number;
  ch: number | 'global';
}

export type NanopadSysex =
  | { kind: 'nativeMode'; on: boolean }
  | { kind: 'modeData'; native: boolean }
  | { kind: 'searchReply'; globalCh: number; echoId: number; isNanopad2: boolean }
  | { kind: 'sceneDump'; pads: NanopadPad[] };

const ASSIGN: NanopadAssign[] = ['none', 'cc', 'note', 'pc'];

export function isNanopad2Name(name: string): boolean {
  return name.toLowerCase().includes('nanopad2');
}

export function sysexNativeModeRequest(globalCh: number, on: boolean): Uint8Array {
  return exclusive(globalCh, [0x00, 0x00, 0x00, on ? 0x01 : 0x00]);
}

export function sysexModeRequest(globalCh: number): Uint8Array {
  return exclusive(globalCh, [0x00, 0x1f, 0x12, 0x00]);
}

export function sysexSearchDeviceRequest(echoId: number): Uint8Array {
  return Uint8Array.from([0xf0, 0x42, 0x50, 0x00, clampData(echoId), 0xf7]);
}

/** Current Scene Data Dump Request（Func 10）。応答の dump 本体は Func 40。 */
export function sysexSceneDumpRequest(globalCh: number): Uint8Array {
  return exclusive(globalCh, [0x00, 0x1f, 0x10, 0x00]);
}

/** Scene LED 1–4: BF 79..7C 7F/00（Native mode のみ）。 */
export function ccSceneLed(index: 1 | 2 | 3 | 4, on: boolean): Uint8Array {
  return Uint8Array.from([0xb0 | NANOPAD2_NATIVE_CC_CH, 0x78 + index, on ? 0x7f : 0x00]);
}

/**
 * NOTE 3: 7 バイトの 8bit データを 8 バイトの 7bit MIDI にパック。
 * 先頭バイトに続く最大 7 バイトの MSB を詰める。97 → 111。
 */
export function pack7bit(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 7) {
    const n = Math.min(7, bytes.length - i);
    let msb = 0;
    const rest: number[] = [];
    for (let b = 0; b < n; b++) {
      const v = bytes[i + b]!;
      msb |= ((v >> 7) & 1) << b;
      rest.push(v & 0x7f);
    }
    out.push(msb, ...rest);
  }
  return Uint8Array.from(out);
}

export function unpack7bit(payload: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < payload.length) {
    const msb = payload[i]!;
    i += 1;
    for (let b = 0; b < 7 && i < payload.length; b++, i++) {
      out.push((payload[i]! & 0x7f) | (((msb >> b) & 1) << 7));
    }
  }
  return Uint8Array.from(out);
}

export function parseNanopadSysex(data: Uint8Array): NanopadSysex | null {
  if (data.length < 2 || data[0] !== 0xf0 || data[data.length - 1] !== 0xf7) return null;
  const search = parseSearchReply(data);
  if (search) return search;
  if (!isNanopadExclusive(data)) return null;
  const native = parseNativeMode(data);
  if (native) return native;
  const mode = parseModeData(data);
  if (mode) return mode;
  const dump = parseSceneDump(data);
  if (dump) return dump;
  return null;
}

/**
 * Unpacked Current Scene Dump（97 bytes）。
 * byte 0 は予約。pad 1..16 は offset 1 から 6 バイトずつ
 * [ch, assign, number, n2, n3, n4]。
 * ch 0–15 = MIDI ch、16 以上 = Global。
 * assign 0 none / 1 cc / 2 note / 3 pc。
 */
export function parseSceneDumpPads(unpacked: Uint8Array): NanopadPad[] {
  const pads: NanopadPad[] = [];
  for (let i = 0; i < 16; i++) {
    const o = 1 + i * 6;
    const chByte = unpacked[o] ?? 0;
    const assignByte = unpacked[o + 1] ?? 0;
    const number = unpacked[o + 2] ?? 0;
    pads.push({
      assign: ASSIGN[assignByte] ?? 'none',
      number: number & 0x7f,
      ch: chByte >= 16 ? 'global' : chByte & 0x0f,
    });
  }
  return pads;
}

export function buildSceneDumpUnpacked(pads: readonly NanopadPad[]): Uint8Array {
  const out = new Uint8Array(SCENE_DUMP_UNPACKED_BYTES);
  for (let i = 0; i < 16; i++) {
    const pad = pads[i] ?? { assign: 'none', number: 0, ch: 'global' };
    const o = 1 + i * 6;
    out[o] = pad.ch === 'global' ? 16 : pad.ch & 0x0f;
    const assign = ASSIGN.indexOf(pad.assign);
    out[o + 1] = assign < 0 ? 0 : assign;
    out[o + 2] = pad.number & 0x7f;
  }
  return out;
}

export function nativeMapping(swapRows = false): MidiMapping {
  const bindings: MidiBinding[] = [];
  for (let slot = 0; slot < 8; slot++) {
    const upper = 64 + slot;
    const lower = 72 + slot;
    const triggerNote = swapRows ? upper : lower;
    const cutNote = swapRows ? lower : upper;
    bindings.push({
      trigger: { kind: 'note', ch: NANOPAD2_NATIVE_NOTE_CH, note: triggerNote },
      action: { type: 'trigger', slot },
    });
    bindings.push({
      trigger: { kind: 'note', ch: NANOPAD2_NATIVE_NOTE_CH, note: cutNote },
      action: { type: 'trigger', slot, cut: true },
    });
  }
  bindings.push({
    trigger: { kind: 'cc', ch: NANOPAD2_NATIVE_CC_CH, controller: 0x39, edge: 'press' },
    action: { type: 'command', command: { kind: 'tempo:tap' } },
  });
  bindings.push({
    trigger: { kind: 'cc', ch: NANOPAD2_NATIVE_CC_CH, controller: 0x0b, edge: 'press' },
    action: { type: 'fireCursor' },
  });
  return {
    version: 1,
    name: swapRows ? 'nanoPAD2 Native (swap)' : 'nanoPAD2 Native',
    bindings,
  };
}

export const NANOPAD2_NATIVE_MAPPING: MidiMapping = nativeMapping(false);

export function mappingFromPads(pads: readonly NanopadPad[], swapRows = false): MidiMapping {
  const bindings: MidiBinding[] = [];
  for (let slot = 0; slot < 8; slot++) {
    const upper = pads[slot];
    const lower = pads[slot + 8];
    const triggerPad = swapRows ? upper : lower;
    const cutPad = swapRows ? lower : upper;
    const trigger = padToNoteBinding(triggerPad, slot, false);
    const cut = padToNoteBinding(cutPad, slot, true);
    if (trigger) bindings.push(trigger);
    if (cut) bindings.push(cut);
  }
  return { version: 1, name: 'nanoPAD2 Scene Dump', bindings };
}

export function isNanopadMappingName(name: string): boolean {
  return name.startsWith('nanoPAD2');
}

function padToNoteBinding(
  pad: NanopadPad | undefined,
  slot: number,
  cut: boolean,
): MidiBinding | null {
  if (!pad || pad.assign !== 'note') return null;
  return {
    trigger: { kind: 'note', ch: pad.ch === 'global' ? 'any' : pad.ch, note: pad.number },
    action: cut ? { type: 'trigger', slot, cut: true } : { type: 'trigger', slot },
  };
}

function exclusive(globalCh: number, payload: number[]): Uint8Array {
  return Uint8Array.from([
    0xf0,
    0x42,
    0x40 | clampCh(globalCh),
    ...NANOPAD2_PRODUCT,
    ...payload,
    0xf7,
  ]);
}

function isNanopadExclusive(data: Uint8Array): boolean {
  return (
    data.length >= 7 &&
    data[1] === 0x42 &&
    (data[2]! & 0xf0) === 0x40 &&
    data[3] === NANOPAD2_PRODUCT[0] &&
    data[4] === NANOPAD2_PRODUCT[1] &&
    data[5] === NANOPAD2_PRODUCT[2]
  );
}

function parseSearchReply(data: Uint8Array): NanopadSysex | null {
  if (data.length < 6 || data[1] !== 0x42 || data[2] !== 0x50 || data[3] !== 0x01) return null;
  return {
    kind: 'searchReply',
    globalCh: data[4]! & 0x0f,
    echoId: data[5]!,
    isNanopad2:
      data.length >= 8 && data[6] === NANOPAD2_FAMILY_ID[0] && data[7] === NANOPAD2_FAMILY_ID[1],
  };
}

function parseNativeMode(data: Uint8Array): NanopadSysex | null {
  // F0 42 4g 00 01 12 00 40 00 rr F7
  if (data.length < 11 || data[6] !== 0x00 || data[7] !== 0x40 || data[8] !== 0x00) return null;
  const rr = data[9]!;
  if (rr !== 0x03 && rr !== 0x02) return null;
  return { kind: 'nativeMode', on: rr === 0x03 };
}

function parseModeData(data: Uint8Array): NanopadSysex | null {
  // F0 42 4g 00 01 12 00 5F 42 mm F7
  if (data.length < 11 || data[6] !== 0x00 || data[7] !== 0x5f || data[8] !== 0x42) return null;
  return { kind: 'modeData', native: data[9] === 0x01 };
}

function parseSceneDump(data: Uint8Array): NanopadSysex | null {
  // F0 42 4g 00 01 12 00 7F … 40 [packed] F7
  if (data.length < 10 || data[6] !== 0x00 || data[7] !== 0x7f) return null;
  let i = 8;
  if (data[i] === 0x7f && data[i + 1] === 0x02 && data.length > i + 4) {
    i += 4;
  }
  if (data[i] !== 0x40) return null;
  const packed = data.slice(i + 1, data.length - 1);
  const unpacked = unpack7bit(packed);
  return { kind: 'sceneDump', pads: parseSceneDumpPads(unpacked) };
}

function clampCh(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 15) return 0;
  return value;
}

function clampData(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 127) return 0;
  return value;
}
