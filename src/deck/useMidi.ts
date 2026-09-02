/**
 * Deck 窓の Web MIDI。クリックから requestMIDIAccess({ sysex: false })。
 * フォーカス無しでも受信する。メイン窓には載せない。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeckAction } from './actions';
import {
  acceptLearnMessage,
  emptyMidiMapping,
  MIDI_LEARN_ITEMS,
  MIDI_STORAGE_KEY,
  parseMidiMapping,
  parseMidiMessage,
  parseMidiStorage,
  resolveMidiBinding,
  upsertMidiBinding,
  type MidiLearnItem,
  type MidiMapping,
  type MidiTrigger,
} from './midi';
import { NANOPAD2_FACTORY_SCENE1, NANOPAD2_PAD1_NOTE } from './midiPresets';

/** DOM lib に MIDIAccess が無い環境向けの最小型。 */
interface MidiInputLike {
  id: string;
  name: string | null;
  onmidimessage: ((ev: { data?: Uint8Array | null }) => void) | null;
}

interface MidiAccessLike {
  inputs: { forEach(cb: (input: MidiInputLike) => void): void };
  onstatechange: ((ev: unknown) => void) | null;
}

type MidiNavigator = Navigator & {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MidiAccessLike>;
};

export type MidiStatus = 'off' | 'on' | 'denied' | 'unsupported';

export interface MidiDeviceInfo {
  id: string;
  name: string;
}

export interface UseMidi {
  status: MidiStatus;
  devices: MidiDeviceInfo[];
  mapping: MidiMapping;
  learning: boolean;
  learnIndex: number;
  learnItems: readonly MidiLearnItem[];
  learnWarning: string | null;
  importError: string | null;
  exportOk: boolean;
  nanopadOffer: boolean;
  pad1Confirm: boolean;
  mismatch: boolean;
  enable: () => Promise<void>;
  toggleLearn: () => void;
  endLearn: () => void;
  setLearnIndex: (index: number) => void;
  setMappingName: (name: string) => void;
  applyNanopadPreset: () => void;
  startLearnFromMismatch: () => void;
  exportToClipboard: () => Promise<void>;
  importFromText: (text: string) => boolean;
}

function midiSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as MidiNavigator).requestMIDIAccess === 'function'
  );
}

function readStored(): { mapping: MidiMapping; saved: boolean; autoApplyPreset: boolean } {
  try {
    const raw = localStorage.getItem(MIDI_STORAGE_KEY);
    if (!raw) return { mapping: emptyMidiMapping(), saved: false, autoApplyPreset: false };
    const parsed = parseMidiStorage(JSON.parse(raw) as unknown);
    if (!parsed) return { mapping: emptyMidiMapping(), saved: false, autoApplyPreset: false };
    if (parsed.activeMapping) {
      return {
        mapping: parsed.activeMapping,
        saved: true,
        autoApplyPreset: parsed.autoApplyPreset,
      };
    }
    return { mapping: emptyMidiMapping(), saved: false, autoApplyPreset: parsed.autoApplyPreset };
  } catch {
    return { mapping: emptyMidiMapping(), saved: false, autoApplyPreset: false };
  }
}

function persist(mapping: MidiMapping, autoApplyPreset: boolean): void {
  try {
    localStorage.setItem(
      MIDI_STORAGE_KEY,
      JSON.stringify({ activeMapping: mapping, autoApplyPreset }),
    );
  } catch {
    // quota / private mode
  }
}

function isNanopadName(name: string): boolean {
  return name.toLowerCase().includes('nanopad2');
}

export function useMidi(opts: { dispatch: (action: DeckAction) => void }): UseMidi {
  const [stored] = useState(() => readStored());
  const [status, setStatus] = useState<MidiStatus>(() => (midiSupported() ? 'off' : 'unsupported'));
  const [devices, setDevices] = useState<MidiDeviceInfo[]>([]);
  const [mapping, setMapping] = useState<MidiMapping>(stored.mapping);
  const [hasStoredMapping, setHasStoredMapping] = useState(stored.saved);
  const [learning, setLearning] = useState(false);
  const [learnIndex, setLearnIndexState] = useState(0);
  const [learnWarning, setLearnWarning] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [exportOk, setExportOk] = useState(false);
  const [pad1Confirm, setPad1Confirm] = useState(false);
  const [mismatch, setMismatch] = useState(false);

  const dispatchRef = useRef(opts.dispatch);
  dispatchRef.current = opts.dispatch;
  const mappingRef = useRef(mapping);
  mappingRef.current = mapping;
  const learningRef = useRef(learning);
  learningRef.current = learning;
  const learnIndexRef = useRef(learnIndex);
  learnIndexRef.current = learnIndex;
  const pad1ConfirmRef = useRef(pad1Confirm);
  pad1ConfirmRef.current = pad1Confirm;
  const autoApplyRef = useRef(stored.autoApplyPreset);
  const mountedRef = useRef(true);
  const accessRef = useRef<MidiAccessLike | null>(null);
  const inputsRef = useRef<MidiInputLike[]>([]);
  const ccHeldRef = useRef(new Set<string>());
  const learnLatchRef = useRef<MidiTrigger | null>(null);
  const onMessageRef = useRef<(ev: { data?: Uint8Array | null }) => void>(() => {});

  const commitMapping = useCallback((next: MidiMapping): void => {
    mappingRef.current = next;
    setMapping(next);
    setHasStoredMapping(true);
    persist(next, autoApplyRef.current);
  }, []);

  const endLearn = useCallback((): void => {
    setLearning(false);
    learningRef.current = false;
    learnLatchRef.current = null;
  }, []);

  onMessageRef.current = (ev: { data?: Uint8Array | null }): void => {
    const raw = ev.data;
    if (!raw || raw.length === 0) return;
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const msg = parseMidiMessage(data);
    if (msg === null) return;

    if (learningRef.current) {
      const item = MIDI_LEARN_ITEMS[learnIndexRef.current];
      if (!item) return;
      const accepted = acceptLearnMessage(msg, item.ccEdge, learnLatchRef.current);
      learnLatchRef.current = accepted.lastBound;
      if (accepted.bind === null) return;
      const { mapping: next, overwritten } = upsertMidiBinding(
        mappingRef.current,
        accepted.bind,
        item.action,
      );
      commitMapping(next);
      setLearnWarning(overwritten ? '上書きしました（既存のトリガー）' : null);
      const nextIndex = Math.min(learnIndexRef.current + 1, MIDI_LEARN_ITEMS.length - 1);
      learnIndexRef.current = nextIndex;
      setLearnIndexState(nextIndex);
      return;
    }

    if (msg.kind === 'noteOff' || msg.kind === 'sysex') return;

    if (pad1ConfirmRef.current && msg.kind === 'noteOn') {
      pad1ConfirmRef.current = false;
      setPad1Confirm(false);
      if (msg.note !== NANOPAD2_PAD1_NOTE) {
        setMismatch(true);
        return;
      }
      setMismatch(false);
    }

    const action = resolveMidiBinding(msg, mappingRef.current);
    if (msg.kind === 'cc') {
      const key = `${msg.ch}:${msg.controller}`;
      const continuous =
        action !== null &&
        (action.type === 'auto.intervalAbs' ||
          (action.type === 'command' && action.command.kind === 'hue:fixed'));
      if (!continuous) {
        if (msg.value < 64) {
          ccHeldRef.current.delete(key);
          return;
        }
        if (ccHeldRef.current.has(key)) return;
        ccHeldRef.current.add(key);
      }
    }
    if (action) dispatchRef.current(action);
  };

  const syncInputs = useCallback((access: MidiAccessLike): void => {
    const next: MidiInputLike[] = [];
    const seen = new Set<string>();
    const handler = (ev: { data?: Uint8Array | null }): void => {
      onMessageRef.current(ev);
    };
    access.inputs.forEach((input) => {
      seen.add(input.id);
      input.onmidimessage = handler;
      next.push(input);
    });
    for (const prev of inputsRef.current) {
      if (!seen.has(prev.id)) prev.onmidimessage = null;
    }
    inputsRef.current = next;
    setDevices(next.map((input) => ({ id: input.id, name: input.name ?? input.id })));
  }, []);

  const detach = useCallback((): void => {
    const access = accessRef.current;
    if (access) access.onstatechange = null;
    for (const input of inputsRef.current) input.onmidimessage = null;
    inputsRef.current = [];
    accessRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detach();
    };
  }, [detach]);

  const enable = useCallback(async (): Promise<void> => {
    const request = (navigator as MidiNavigator).requestMIDIAccess;
    if (typeof request !== 'function') {
      setStatus('unsupported');
      return;
    }
    try {
      const access = await request.call(navigator, { sysex: false });
      if (!mountedRef.current) return;
      accessRef.current = access;
      access.onstatechange = () => {
        if (accessRef.current) syncInputs(accessRef.current);
      };
      syncInputs(access);
      setStatus('on');
    } catch {
      if (mountedRef.current) setStatus('denied');
    }
  }, [syncInputs]);

  const toggleLearn = useCallback((): void => {
    setLearning((on) => {
      const next = !on;
      learningRef.current = next;
      return next;
    });
    learnLatchRef.current = null;
    setLearnWarning(null);
    setMismatch(false);
    pad1ConfirmRef.current = false;
    setPad1Confirm(false);
  }, []);

  const setLearnIndex = useCallback((index: number): void => {
    const i = Math.min(MIDI_LEARN_ITEMS.length - 1, Math.max(0, index));
    learnIndexRef.current = i;
    setLearnIndexState(i);
  }, []);

  const setMappingName = useCallback(
    (name: string): void => {
      commitMapping({ ...mappingRef.current, name });
    },
    [commitMapping],
  );

  const applyNanopadPreset = useCallback((): void => {
    const next = structuredClone(NANOPAD2_FACTORY_SCENE1);
    commitMapping(next);
    setMismatch(false);
    pad1ConfirmRef.current = true;
    setPad1Confirm(true);
    setLearning(false);
    learningRef.current = false;
    learnLatchRef.current = null;
  }, [commitMapping]);

  const startLearnFromMismatch = useCallback((): void => {
    setMismatch(false);
    setLearning(true);
    learningRef.current = true;
    pad1ConfirmRef.current = false;
    setPad1Confirm(false);
    learnLatchRef.current = null;
  }, []);

  const exportToClipboard = useCallback(async (): Promise<void> => {
    setExportOk(false);
    const json = JSON.stringify(mappingRef.current, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setExportOk(true);
    } catch {
      setImportError('clipboard に書けませんでした');
    }
  }, []);

  const importFromText = useCallback(
    (text: string): boolean => {
      setExportOk(false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        setImportError('JSON が読めません');
        return false;
      }
      const mappingNext = parseMidiMapping(parsed);
      if (mappingNext === null) {
        setImportError('マッピングが不正です');
        return false;
      }
      setImportError(null);
      commitMapping(mappingNext);
      return true;
    },
    [commitMapping],
  );

  const nanopadOffer =
    status === 'on' &&
    !hasStoredMapping &&
    mapping.bindings.length === 0 &&
    devices.some((d) => isNanopadName(d.name));

  return {
    status,
    devices,
    mapping,
    learning,
    learnIndex,
    learnItems: MIDI_LEARN_ITEMS,
    learnWarning,
    importError,
    exportOk,
    nanopadOffer,
    pad1Confirm,
    mismatch,
    enable,
    toggleLearn,
    endLearn,
    setLearnIndex,
    setMappingName,
    applyNanopadPreset,
    startLearnFromMismatch,
    exportToClipboard,
    importFromText,
  };
}
