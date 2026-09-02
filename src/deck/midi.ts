/**
 * Scene Deck の MIDI 純関数。デバイス生死は useMidi、ここはバイト列と
 * マッピングだけ。Note On v=0 は noteOff。短い / 未知ステータスは null。
 */
import type { DeckAction } from './actions';
import { parseDeckCommand } from './protocol';

export const MIDI_STORAGE_KEY = 'vj-deck-midi-v1';

export type MidiMessage =
  | { kind: 'noteOn'; ch: number; note: number; velocity: number }
  | { kind: 'noteOff'; ch: number; note: number }
  | { kind: 'cc'; ch: number; controller: number; value: number }
  | { kind: 'sysex'; data: Uint8Array };

export type MidiTrigger =
  | { kind: 'note'; ch: number | 'any'; note: number }
  | { kind: 'cc'; ch: number | 'any'; controller: number; edge: 'press' | 'value' };

export interface MidiBinding {
  trigger: MidiTrigger;
  action: DeckAction;
  /** trigger 系のみ。velocity >= threshold なら cut:true */
  velocityCutThreshold?: number;
}

export interface MidiMapping {
  version: 1;
  name: string;
  bindings: MidiBinding[];
}

export interface MidiStorage {
  activeMapping: MidiMapping | null;
  autoApplyPreset: boolean;
}

export interface MidiLearnItem {
  id: string;
  label: string;
  action: DeckAction;
  /** CC を学ぶとき press（ボタン）か value（ノブ）か */
  ccEdge: 'press' | 'value';
}

export function emptyMidiMapping(name = 'custom'): MidiMapping {
  return { version: 1, name, bindings: [] };
}

export function parseMidiMessage(data: Uint8Array): MidiMessage | null {
  if (data.length < 1) return null;
  const status = data[0]!;
  if (status === 0xf0) {
    if (data.length < 2 || data[data.length - 1] !== 0xf7) return null;
    return { kind: 'sysex', data: data.slice() };
  }
  const type = status & 0xf0;
  const ch = status & 0x0f;
  if (type !== 0x80 && type !== 0x90 && type !== 0xb0) return null;
  if (data.length < 3) return null;
  const a = data[1]!;
  const b = data[2]!;
  if (a > 127 || b > 127) return null;
  if (type === 0x90) {
    if (b === 0) return { kind: 'noteOff', ch, note: a };
    return { kind: 'noteOn', ch, note: a, velocity: b };
  }
  if (type === 0x80) return { kind: 'noteOff', ch, note: a };
  return { kind: 'cc', ch, controller: a, value: b };
}

export function ccValueTo01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / 127));
}

export function ccValueToHue(value: number): number {
  return ccValueTo01(value) * 360;
}

/**
 * 先頭一致。ch 'any' は全チャンネル。CC press は value>=64 で発火
 * （ヒステリシスは純関数側では持たない）。edge value は 0..127 を
 * auto.intervalAbs / hue:fixed へ写す。
 */
export function resolveMidiBinding(msg: MidiMessage, mapping: MidiMapping): DeckAction | null {
  for (const binding of mapping.bindings) {
    if (!triggerMatches(binding.trigger, msg)) continue;
    if (msg.kind === 'noteOn') return applyVelocityCut(binding, msg.velocity);
    if (msg.kind === 'cc' && binding.trigger.kind === 'cc') {
      if (binding.trigger.edge === 'press') {
        return msg.value >= 64 ? binding.action : null;
      }
      return applyCcValue(binding.action, msg.value);
    }
    return null;
  }
  return null;
}

export function parseMidiMapping(input: unknown): MidiMapping | null {
  if (!isRecord(input)) return null;
  if (input.version !== 1) return null;
  if (typeof input.name !== 'string') return null;
  if (!Array.isArray(input.bindings)) return null;
  const bindings: MidiBinding[] = [];
  for (const item of input.bindings) {
    const binding = parseMidiBinding(item);
    if (binding === null) return null;
    bindings.push(binding);
  }
  return { version: 1, name: input.name, bindings };
}

export function parseMidiStorage(input: unknown): MidiStorage | null {
  if (!isRecord(input)) return null;
  const autoApplyPreset = input.autoApplyPreset === true;
  if (input.activeMapping === undefined || input.activeMapping === null) {
    return { activeMapping: null, autoApplyPreset };
  }
  const mapping = parseMidiMapping(input.activeMapping);
  if (mapping === null) return { activeMapping: null, autoApplyPreset };
  return { activeMapping: mapping, autoApplyPreset };
}

export function triggersOverlap(a: MidiTrigger, b: MidiTrigger): boolean {
  if (a.kind !== b.kind) return false;
  const chOk = a.ch === 'any' || b.ch === 'any' || a.ch === b.ch;
  if (!chOk) return false;
  if (a.kind === 'note' && b.kind === 'note') return a.note === b.note;
  if (a.kind === 'cc' && b.kind === 'cc') return a.controller === b.controller;
  return false;
}

export function triggerFromMessage(
  msg: MidiMessage,
  ccEdge: 'press' | 'value',
): MidiTrigger | null {
  if (msg.kind === 'noteOn') return { kind: 'note', ch: msg.ch, note: msg.note };
  if (msg.kind === 'cc') {
    return { kind: 'cc', ch: msg.ch, controller: msg.controller, edge: ccEdge };
  }
  return null;
}

export function isMidiRelease(msg: MidiMessage): boolean {
  return msg.kind === 'noteOff' || (msg.kind === 'cc' && msg.value < 64);
}

/** note/cc の同一性。edge は見ない（press の押下と離しを同一 trigger にする）。 */
export function triggerIdentity(msg: MidiMessage): MidiTrigger | null {
  if (msg.kind === 'noteOn' || msg.kind === 'noteOff') {
    return { kind: 'note', ch: msg.ch, note: msg.note };
  }
  if (msg.kind === 'cc') {
    return { kind: 'cc', ch: msg.ch, controller: msg.controller, edge: 'press' };
  }
  return null;
}

export type LearnAccept =
  | { bind: MidiTrigger; lastBound: MidiTrigger }
  | { bind: null; lastBound: MidiTrigger | null };

/**
 * learn 1 メッセージ。press の CC value<64 は無視。直前と同じ trigger は
 * 別 trigger か release まで無視（ボタン離し / ノブ連打で次の action を食わない）。
 */
export function acceptLearnMessage(
  msg: MidiMessage,
  ccEdge: 'press' | 'value',
  lastBound: MidiTrigger | null,
): LearnAccept {
  const identity = triggerIdentity(msg);
  if (lastBound && identity && triggersOverlap(lastBound, identity)) {
    return { bind: null, lastBound: isMidiRelease(msg) ? null : lastBound };
  }
  if (msg.kind === 'noteOff' || msg.kind === 'sysex') {
    return { bind: null, lastBound };
  }
  if (msg.kind === 'cc' && ccEdge === 'press' && msg.value < 64) {
    return { bind: null, lastBound };
  }
  const trigger = triggerFromMessage(msg, ccEdge);
  if (trigger === null) return { bind: null, lastBound };
  return { bind: trigger, lastBound: trigger };
}

export function upsertMidiBinding(
  mapping: MidiMapping,
  trigger: MidiTrigger,
  action: DeckAction,
): { mapping: MidiMapping; overwritten: boolean } {
  const overwritten = mapping.bindings.some((b) => triggersOverlap(b.trigger, trigger));
  const bindings = mapping.bindings.filter((b) => !triggersOverlap(b.trigger, trigger));
  bindings.push({ trigger, action });
  return { mapping: { version: 1, name: mapping.name, bindings }, overwritten };
}

export function formatMidiTrigger(trigger: MidiTrigger): string {
  const ch = trigger.ch === 'any' ? 'any' : String(trigger.ch + 1);
  if (trigger.kind === 'note') return `ch${ch} n${trigger.note}`;
  return `ch${ch} cc${trigger.controller}`;
}

function padItems(): MidiLearnItem[] {
  const pads: MidiLearnItem[] = [];
  for (let slot = 0; slot < 8; slot++) {
    pads.push({
      id: `pad-${slot + 1}`,
      label: `pad ${slot + 1}`,
      action: { type: 'trigger', slot },
      ccEdge: 'press',
    });
  }
  for (let slot = 0; slot < 8; slot++) {
    pads.push({
      id: `pad-${slot + 1}-cut`,
      label: `pad ${slot + 1} cut`,
      action: { type: 'trigger', slot, cut: true },
      ccEdge: 'press',
    });
  }
  return pads;
}

export const MIDI_LEARN_ITEMS: MidiLearnItem[] = [
  ...padItems(),
  { id: 'fireCursor', label: 'cursor fire', action: { type: 'fireCursor' }, ccEdge: 'press' },
  {
    id: 'cycleTransition',
    label: 'transition',
    action: { type: 'cycleTransition' },
    ccEdge: 'press',
  },
  { id: 'auto.toggle', label: 'auto', action: { type: 'auto.toggle' }, ccEdge: 'press' },
  { id: 'auto.mode', label: 'auto mode', action: { type: 'auto.mode' }, ccEdge: 'press' },
  {
    id: 'auto.interval.up',
    label: 'interval +',
    action: { type: 'auto.interval', dir: 1 },
    ccEdge: 'press',
  },
  {
    id: 'auto.interval.down',
    label: 'interval -',
    action: { type: 'auto.interval', dir: -1 },
    ccEdge: 'press',
  },
  {
    id: 'auto.intervalAbs',
    label: 'interval abs',
    action: { type: 'auto.intervalAbs', value01: 0 },
    ccEdge: 'value',
  },
  { id: 'bank.rebuild', label: 'rebuild', action: { type: 'bank.rebuild' }, ccEdge: 'press' },
  { id: 'bank.gacha', label: 'gacha bank', action: { type: 'bank.gacha' }, ccEdge: 'press' },
  {
    id: 'tempo.tap',
    label: 'tap',
    action: { type: 'command', command: { kind: 'tempo:tap' } },
    ccEdge: 'press',
  },
  {
    id: 'seed.gacha',
    label: 'seed gacha',
    action: { type: 'command', command: { kind: 'seed:gacha' } },
    ccEdge: 'press',
  },
  {
    id: 'patch.reroll',
    label: 'details',
    action: { type: 'command', command: { kind: 'patch:rerollDetails' } },
    ccEdge: 'press',
  },
  {
    id: 'hue.fixed',
    label: 'hue',
    action: { type: 'command', command: { kind: 'hue:fixed', hue: 0 } },
    ccEdge: 'value',
  },
  {
    id: 'scene.prev',
    label: 'scene ‹',
    action: { type: 'command', command: { kind: 'scene:shift', delta: -1 } },
    ccEdge: 'press',
  },
  {
    id: 'scene.next',
    label: 'scene ›',
    action: { type: 'command', command: { kind: 'scene:shift', delta: 1 } },
    ccEdge: 'press',
  },
];

function triggerMatches(trigger: MidiTrigger, msg: MidiMessage): boolean {
  if (msg.kind === 'sysex') return false;
  const chOk = trigger.ch === 'any' || trigger.ch === msg.ch;
  if (!chOk) return false;
  if (trigger.kind === 'note' && msg.kind === 'noteOn') return trigger.note === msg.note;
  if (trigger.kind === 'cc' && msg.kind === 'cc') return trigger.controller === msg.controller;
  return false;
}

function applyVelocityCut(binding: MidiBinding, velocity: number): DeckAction {
  const action = binding.action;
  if (action.type !== 'trigger') return action;
  const th = binding.velocityCutThreshold;
  if (typeof th === 'number' && velocity >= th) {
    return { type: 'trigger', slot: action.slot, cut: true };
  }
  return action;
}

function applyCcValue(action: DeckAction, value: number): DeckAction {
  if (action.type === 'auto.intervalAbs') {
    return { type: 'auto.intervalAbs', value01: ccValueTo01(value) };
  }
  if (action.type === 'command' && action.command.kind === 'hue:fixed') {
    return { type: 'command', command: { kind: 'hue:fixed', hue: ccValueToHue(value) } };
  }
  return action;
}

function parseMidiBinding(input: unknown): MidiBinding | null {
  if (!isRecord(input)) return null;
  const trigger = parseMidiTrigger(input.trigger);
  const action = parseDeckAction(input.action);
  if (trigger === null || action === null) return null;
  const binding: MidiBinding = { trigger, action };
  if (input.velocityCutThreshold !== undefined) {
    if (!isMidiData(input.velocityCutThreshold)) return null;
    binding.velocityCutThreshold = input.velocityCutThreshold;
  }
  return binding;
}

function parseMidiTrigger(input: unknown): MidiTrigger | null {
  if (!isRecord(input)) return null;
  const ch = parseCh(input.ch);
  if (ch === undefined) return null;
  if (input.kind === 'note') {
    if (!isMidiData(input.note)) return null;
    return { kind: 'note', ch, note: input.note };
  }
  if (input.kind === 'cc') {
    if (!isMidiData(input.controller)) return null;
    if (input.edge !== 'press' && input.edge !== 'value') return null;
    return { kind: 'cc', ch, controller: input.controller, edge: input.edge };
  }
  return null;
}

function parseDeckAction(input: unknown): DeckAction | null {
  if (!isRecord(input) || typeof input.type !== 'string') return null;
  switch (input.type) {
    case 'trigger': {
      if (!isIntIn(input.slot, 0, 7)) return null;
      if (input.cut !== undefined && typeof input.cut !== 'boolean') return null;
      return input.cut === true
        ? { type: 'trigger', slot: input.slot, cut: true }
        : { type: 'trigger', slot: input.slot };
    }
    case 'fireCursor':
      return { type: 'fireCursor' };
    case 'cursor':
      if (
        input.dir !== 'left' &&
        input.dir !== 'right' &&
        input.dir !== 'up' &&
        input.dir !== 'down'
      ) {
        return null;
      }
      return { type: 'cursor', dir: input.dir };
    case 'cycleTransition':
      return { type: 'cycleTransition' };
    case 'auto.toggle':
      return { type: 'auto.toggle' };
    case 'auto.mode':
      return { type: 'auto.mode' };
    case 'auto.interval':
      if (input.dir !== 1 && input.dir !== -1) return null;
      return { type: 'auto.interval', dir: input.dir };
    case 'auto.intervalAbs':
      if (!isFiniteNumber(input.value01)) return null;
      return { type: 'auto.intervalAbs', value01: input.value01 };
    case 'bank.rebuild':
      return { type: 'bank.rebuild' };
    case 'bank.gacha':
      return { type: 'bank.gacha' };
    case 'command': {
      const command = parseDeckCommand(input.command);
      if (command === null) return null;
      return { type: 'command', command };
    }
    default:
      return null;
  }
}

function parseCh(value: unknown): number | 'any' | undefined {
  if (value === 'any') return 'any';
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15) {
    return value;
  }
  return undefined;
}

function isMidiData(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 127;
}

function isIntIn(value: unknown, lo: number, hi: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
