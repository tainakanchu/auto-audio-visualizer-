/**
 * Deck 窓の Web MIDI。クリックから requestMIDIAccess({ sysex: true })。
 * nanoPAD2 は Search Device → Native In → LED。unload で Native Out。
 * フォーカス無しでも受信する。メイン窓には載せない。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeckAction } from './actions';
import {
  acceptLearnMessage,
  DEFAULT_NANOPAD_PREFS,
  emptyMidiMapping,
  mappingVelocityCutThreshold,
  MIDI_LEARN_ITEMS,
  MIDI_STORAGE_KEY,
  parseMidiMapping,
  parseMidiMessage,
  parseMidiStorage,
  resolveMidiBinding,
  triggersOverlap,
  upsertMidiBinding,
  withVelocityCutThreshold,
  type MidiLearnItem,
  type MidiMapping,
  type MidiNanopadPrefs,
  type MidiTrigger,
} from './midi';
import {
  ccSceneLed,
  isNanopad2Name,
  isNanopadMappingName,
  mappingFromPads,
  NANOPAD2_PAD1_NOTE,
  NANOPAD2_TOUCH_SCALE_CH,
  nativeMapping,
  parseNanopadSysex,
  sysexNativeModeRequest,
  sysexSceneDumpRequest,
  sysexSearchDeviceRequest,
  type NanopadPad,
} from './nanopad2';

interface MidiInputLike {
  id: string;
  name: string | null;
  onmidimessage: ((ev: { data?: Uint8Array | null }) => void) | null;
}

interface MidiOutputLike {
  id: string;
  name: string | null;
  send(data: Uint8Array): void;
}

interface MidiAccessLike {
  inputs: { forEach(cb: (input: MidiInputLike) => void): void };
  outputs: { forEach(cb: (output: MidiOutputLike) => void): void };
  sysexEnabled?: boolean;
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

export interface MidiLeds {
  conn: boolean;
  auto: boolean;
  tempoLock: boolean;
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
  exportError: string | null;
  exportOk: boolean;
  native: boolean;
  dumpMapped: boolean;
  swapRows: boolean;
  preferNative: boolean;
  velocityCutThreshold: number | null;
  sysex: boolean;
  pad1Confirm: boolean;
  mismatch: boolean;
  enable: () => Promise<void>;
  toggleLearn: () => void;
  endLearn: () => void;
  setLearnIndex: (index: number) => void;
  setMappingName: (name: string) => void;
  setSwapRows: (on: boolean) => void;
  setPreferNative: (on: boolean) => void;
  setVelocityCutThreshold: (threshold: number | null) => void;
  applyNanopadPreset: () => void;
  startLearnFromMismatch: () => void;
  exportToClipboard: () => Promise<void>;
  importFromText: (text: string) => boolean;
}

interface NanopadLink {
  inputId: string;
  output: MidiOutputLike;
  globalCh: number;
  native: boolean;
  nativeRequested: boolean;
}

const SEARCH_MS = 400;
const NATIVE_MS = 1000;
const DUMP_MS = 1000;
const LED_BLINK_MS = 500;

function midiSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as MidiNavigator).requestMIDIAccess === 'function'
  );
}

function readStored(): {
  mapping: MidiMapping;
  saved: boolean;
  nanopad: MidiNanopadPrefs;
} {
  try {
    const raw = localStorage.getItem(MIDI_STORAGE_KEY);
    if (!raw)
      return { mapping: emptyMidiMapping(), saved: false, nanopad: { ...DEFAULT_NANOPAD_PREFS } };
    const parsed = parseMidiStorage(JSON.parse(raw) as unknown);
    if (!parsed)
      return { mapping: emptyMidiMapping(), saved: false, nanopad: { ...DEFAULT_NANOPAD_PREFS } };
    if (parsed.activeMapping) {
      return { mapping: parsed.activeMapping, saved: true, nanopad: parsed.nanopad };
    }
    return { mapping: emptyMidiMapping(), saved: false, nanopad: parsed.nanopad };
  } catch {
    return { mapping: emptyMidiMapping(), saved: false, nanopad: { ...DEFAULT_NANOPAD_PREFS } };
  }
}

function persist(mapping: MidiMapping, nanopad: MidiNanopadPrefs): void {
  try {
    localStorage.setItem(MIDI_STORAGE_KEY, JSON.stringify({ activeMapping: mapping, nanopad }));
  } catch {
    // quota / private mode
  }
}

function collect<T>(forEachable: { forEach(cb: (item: T) => void): void }): T[] {
  const out: T[] = [];
  forEachable.forEach((item) => out.push(item));
  return out;
}

function mergeGenerated(current: MidiMapping, generated: MidiMapping): MidiMapping {
  const extras = current.bindings.filter(
    (binding) => !generated.bindings.some((g) => triggersOverlap(g.trigger, binding.trigger)),
  );
  return { ...generated, bindings: [...generated.bindings, ...extras] };
}

function shouldAutoApply(mapping: MidiMapping, saved: boolean): boolean {
  if (!saved && mapping.bindings.length === 0) return true;
  return isNanopadMappingName(mapping.name);
}

export function useMidi(opts: {
  dispatch: (action: DeckAction) => void;
  leds?: MidiLeds;
}): UseMidi {
  const [stored] = useState(() => readStored());
  const [status, setStatus] = useState<MidiStatus>(() => (midiSupported() ? 'off' : 'unsupported'));
  const [devices, setDevices] = useState<MidiDeviceInfo[]>([]);
  const [mapping, setMapping] = useState<MidiMapping>(stored.mapping);
  const [learning, setLearning] = useState(false);
  const [learnIndex, setLearnIndexState] = useState(0);
  const [learnWarning, setLearnWarning] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportOk, setExportOk] = useState(false);
  const [pad1Confirm, setPad1Confirm] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [native, setNative] = useState(false);
  const [dumpMapped, setDumpMapped] = useState(false);
  const [swapRows, setSwapRowsState] = useState(stored.nanopad.swapRows);
  const [preferNative, setPreferNativeState] = useState(stored.nanopad.preferNative);
  const [sysex, setSysex] = useState(false);
  const [handshakeError, setHandshakeError] = useState(false);
  const sysexRef = useRef(false);

  const dispatchRef = useRef(opts.dispatch);
  dispatchRef.current = opts.dispatch;
  const ledsRef = useRef<MidiLeds>(opts.leds ?? { conn: false, auto: false, tempoLock: false });
  ledsRef.current = opts.leds ?? { conn: false, auto: false, tempoLock: false };
  const mappingRef = useRef(mapping);
  mappingRef.current = mapping;
  const learningRef = useRef(learning);
  learningRef.current = learning;
  const learnIndexRef = useRef(learnIndex);
  learnIndexRef.current = learnIndex;
  const pad1ConfirmRef = useRef(pad1Confirm);
  pad1ConfirmRef.current = pad1Confirm;
  const nanopadRef = useRef<MidiNanopadPrefs>(stored.nanopad);
  const savedRef = useRef(stored.saved);
  const mountedRef = useRef(true);
  const accessRef = useRef<MidiAccessLike | null>(null);
  const inputsRef = useRef<MidiInputLike[]>([]);
  const outputsRef = useRef<MidiOutputLike[]>([]);
  const linkRef = useRef<NanopadLink | null>(null);
  const ccHeldRef = useRef(new Set<string>());
  const learnLatchRef = useRef<MidiTrigger | null>(null);
  const pendingSearchRef = useRef(new Map<number, MidiOutputLike>());
  const nativeWaiterRef = useRef<((on: boolean) => void) | null>(null);
  const dumpWaiterRef = useRef<((pads: NanopadPad[]) => void) | null>(null);
  const dumpPadsRef = useRef<NanopadPad[] | null>(null);
  const sourceRef = useRef<'native' | 'dump' | null>(
    stored.mapping.name.startsWith('nanoPAD2 Scene Dump')
      ? 'dump'
      : stored.mapping.name.startsWith('nanoPAD2 Native')
        ? 'native'
        : null,
  );
  const handshakeGenRef = useRef(0);
  const pad1InputIdRef = useRef<string | null>(null);
  const pad1NoteRef = useRef(NANOPAD2_PAD1_NOTE);
  const postedCcRef = useRef(new Map<string, number>());
  const pendingCcRef = useRef(new Map<string, { value: number; action: DeckAction }>());
  const flushTimerRef = useRef<number | null>(null);
  const blinkOnRef = useRef(true);
  const onMessageRef = useRef<(ev: { data?: Uint8Array | null }, inputId: string) => void>(
    () => {},
  );

  const persistAll = useCallback((next: MidiMapping, prefs: MidiNanopadPrefs): void => {
    persist(next, prefs);
  }, []);

  const commitMapping = useCallback(
    (next: MidiMapping): void => {
      mappingRef.current = next;
      setMapping(next);
      savedRef.current = true;
      persistAll(next, nanopadRef.current);
    },
    [persistAll],
  );

  const endLearn = useCallback((): void => {
    setLearning(false);
    learningRef.current = false;
    learnLatchRef.current = null;
  }, []);

  const sendNativeOut = useCallback((): void => {
    const link = linkRef.current;
    if (!link?.nativeRequested) return;
    try {
      link.output.send(sysexNativeModeRequest(link.globalCh, false));
    } catch {
      // device already gone
    }
    link.native = false;
    link.nativeRequested = false;
    setNative(false);
  }, []);

  const sendLeds = useCallback(
    (blinkOn: boolean): void => {
      const link = linkRef.current;
      if (!link?.native) return;
      const leds = ledsRef.current;
      const error = mismatch || importError !== null || handshakeError;
      let led4 = false;
      if (error) led4 = blinkOn;
      else if (learningRef.current) led4 = true;
      try {
        link.output.send(ccSceneLed(1, leds.conn));
        link.output.send(ccSceneLed(2, leds.auto));
        link.output.send(ccSceneLed(3, leds.tempoLock));
        link.output.send(ccSceneLed(4, led4));
      } catch {
        // output disappeared
      }
    },
    [handshakeError, importError, mismatch],
  );

  const queueContinuous = useCallback((key: string, value: number, action: DeckAction): void => {
    if (postedCcRef.current.get(key) === value && !pendingCcRef.current.has(key)) return;
    pendingCcRef.current.set(key, { value, action });
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      for (const [pendingKey, pending] of pendingCcRef.current) {
        pendingCcRef.current.delete(pendingKey);
        if (postedCcRef.current.get(pendingKey) === pending.value) continue;
        postedCcRef.current.set(pendingKey, pending.value);
        dispatchRef.current(pending.action);
      }
    }, 16);
  }, []);

  const applyGenerated = useCallback(
    (
      generated: MidiMapping,
      source: 'native' | 'dump',
      pad1Note: number,
      inputId: string | null,
    ): void => {
      if (!shouldAutoApply(mappingRef.current, savedRef.current) && sourceRef.current === null)
        return;
      commitMapping(mergeGenerated(mappingRef.current, generated));
      sourceRef.current = source;
      setDumpMapped(source === 'dump');
      if (inputId) {
        pad1NoteRef.current = pad1Note;
        pad1InputIdRef.current = inputId;
        pad1ConfirmRef.current = true;
        setPad1Confirm(true);
        setMismatch(false);
      }
    },
    [commitMapping],
  );

  onMessageRef.current = (ev: { data?: Uint8Array | null }, inputId: string): void => {
    const raw = ev.data;
    if (!raw || raw.length === 0) return;
    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const msg = parseMidiMessage(data);
    if (msg === null) return;

    if (msg.kind === 'sysex') {
      const parsed = parseNanopadSysex(msg.data);
      if (parsed === null) return;
      if (parsed.kind === 'searchReply') {
        const output = pendingSearchRef.current.get(parsed.echoId);
        if (parsed.isNanopad2 && output && !linkRef.current) {
          linkRef.current = {
            inputId,
            output,
            globalCh: parsed.globalCh,
            native: false,
            nativeRequested: false,
          };
        }
        return;
      }
      if (parsed.kind === 'nativeMode') {
        const link = linkRef.current;
        if (link) link.native = parsed.on;
        setNative(parsed.on);
        nativeWaiterRef.current?.(parsed.on);
        return;
      }
      if (parsed.kind === 'modeData') {
        const link = linkRef.current;
        if (link) link.native = parsed.native;
        setNative(parsed.native);
        return;
      }
      if (parsed.kind === 'sceneDump') {
        dumpPadsRef.current = parsed.pads;
        dumpWaiterRef.current?.(parsed.pads);
      }
      return;
    }

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
      const nextIndex = learnIndexRef.current + 1;
      if (nextIndex >= MIDI_LEARN_ITEMS.length) {
        endLearn();
        return;
      }
      learnIndexRef.current = nextIndex;
      setLearnIndexState(nextIndex);
      return;
    }

    if (msg.kind === 'noteOff') return;
    const link = linkRef.current;
    if (link?.native && msg.ch === NANOPAD2_TOUCH_SCALE_CH) return;

    if (pad1ConfirmRef.current && msg.kind === 'noteOn') {
      if (inputId !== pad1InputIdRef.current) {
        // バナーを出した input 以外は確認に使わない
      } else {
        pad1ConfirmRef.current = false;
        setPad1Confirm(false);
        setMismatch(msg.note !== pad1NoteRef.current);
      }
    }

    const hit = resolveMidiBinding(msg, mappingRef.current);
    if (msg.kind === 'cc') {
      const key = `${msg.ch}:${msg.controller}`;
      const continuous =
        hit !== null && hit.binding.trigger.kind === 'cc' && hit.binding.trigger.edge === 'value';
      if (continuous && hit) {
        queueContinuous(key, msg.value, hit.action);
        return;
      }
      if (msg.value < 64) {
        ccHeldRef.current.delete(key);
        return;
      }
      if (ccHeldRef.current.has(key)) return;
      ccHeldRef.current.add(key);
    }
    if (hit) dispatchRef.current(hit.action);
  };

  const syncPorts = useCallback((access: MidiAccessLike): void => {
    const nextInputs = collect(access.inputs);
    const seen = new Set(nextInputs.map((input) => input.id));
    for (const input of nextInputs) {
      const id = input.id;
      input.onmidimessage = (ev) => {
        onMessageRef.current(ev, id);
      };
    }
    for (const prev of inputsRef.current) {
      if (!seen.has(prev.id)) prev.onmidimessage = null;
    }
    inputsRef.current = nextInputs;
    outputsRef.current = collect(access.outputs);
    setDevices(nextInputs.map((input) => ({ id: input.id, name: input.name ?? input.id })));

    const link = linkRef.current;
    if (link && !outputsRef.current.some((output) => output.id === link.output.id)) {
      linkRef.current = null;
      setNative(false);
    }
  }, []);

  const handshake = useCallback(async (): Promise<void> => {
    const access = accessRef.current;
    if (!access || !mountedRef.current) return;
    const gen = ++handshakeGenRef.current;
    syncPorts(access);
    const sysexOn = sysexRef.current || access.sysexEnabled === true;
    setSysex(sysexOn);
    if (!sysexOn) return;

    const outputs = outputsRef.current;
    const inputs = inputsRef.current;
    if (
      nanopadRef.current.preferNative &&
      linkRef.current?.native &&
      outputs.some((output) => output.id === linkRef.current?.output.id)
    ) {
      sendLeds(blinkOnRef.current);
      return;
    }
    pendingSearchRef.current = new Map();
    if (!linkRef.current?.native) linkRef.current = null;

    for (const [i, output] of outputs.entries()) {
      const echo = ((i + 1) * 17 + (Date.now() & 0x3f)) & 0x7f;
      pendingSearchRef.current.set(echo, output);
      try {
        output.send(sysexSearchDeviceRequest(echo));
      } catch {
        // some ports reject sysex
      }
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, SEARCH_MS);
    });
    if (gen !== handshakeGenRef.current || !mountedRef.current) return;

    if (!linkRef.current) {
      const input = inputs.find((port) => isNanopad2Name(port.name ?? ''));
      const output = outputs.find((port) => isNanopad2Name(port.name ?? ''));
      if (input && output) {
        linkRef.current = {
          inputId: input.id,
          output,
          globalCh: 0,
          native: false,
          nativeRequested: false,
        };
      }
    }

    const link = linkRef.current;
    if (!link) {
      setHandshakeError(false);
      return;
    }

    const prefs = nanopadRef.current;
    if (prefs.preferNative) {
      nativeWaiterRef.current = null;
      const nativeOn = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (on: boolean): void => {
          if (settled) return;
          settled = true;
          nativeWaiterRef.current = null;
          resolve(on);
        };
        nativeWaiterRef.current = finish;
        try {
          link.nativeRequested = true;
          link.output.send(sysexNativeModeRequest(link.globalCh, true));
        } catch {
          finish(false);
          return;
        }
        window.setTimeout(() => finish(link.native), NATIVE_MS);
      });
      if (gen !== handshakeGenRef.current || !mountedRef.current) return;
      if (nativeOn) {
        setNative(true);
        setHandshakeError(false);
        applyGenerated(nativeMapping(prefs.swapRows), 'native', NANOPAD2_PAD1_NOTE, link.inputId);
        try {
          link.output.send(ccSceneLed(1, false));
          link.output.send(ccSceneLed(2, false));
          link.output.send(ccSceneLed(3, false));
          link.output.send(ccSceneLed(4, false));
        } catch {
          // ignore
        }
        sendLeds(true);
        return;
      }
    } else {
      sendNativeOut();
    }

    dumpWaiterRef.current = null;
    const pads = await new Promise<NanopadPad[] | null>((resolve) => {
      let settled = false;
      const finish = (value: NanopadPad[] | null): void => {
        if (settled) return;
        settled = true;
        dumpWaiterRef.current = null;
        resolve(value);
      };
      dumpWaiterRef.current = (value) => finish(value);
      try {
        link.output.send(sysexSceneDumpRequest(link.globalCh));
      } catch {
        finish(null);
        return;
      }
      window.setTimeout(() => finish(null), DUMP_MS);
    });
    if (gen !== handshakeGenRef.current || !mountedRef.current) return;
    if (pads) {
      setHandshakeError(false);
      dumpPadsRef.current = pads;
      const pad1 = pads[0];
      applyGenerated(
        mappingFromPads(pads, prefs.swapRows),
        'dump',
        pad1?.assign === 'note' ? pad1.number : NANOPAD2_PAD1_NOTE,
        link.inputId,
      );
      return;
    }
    setHandshakeError(true);
  }, [applyGenerated, sendLeds, sendNativeOut, syncPorts]);

  const detach = useCallback((): void => {
    const access = accessRef.current;
    if (access) access.onstatechange = null;
    for (const input of inputsRef.current) input.onmidimessage = null;
    inputsRef.current = [];
    outputsRef.current = [];
    accessRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const onUnload = (): void => {
      sendNativeOut();
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      sendNativeOut();
      detach();
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    };
  }, [detach, sendNativeOut]);

  useEffect(() => {
    if (status !== 'on') return;
    sendLeds(blinkOnRef.current);
    const error = mismatch || importError !== null || handshakeError;
    if (!error) return;
    const id = window.setInterval(() => {
      blinkOnRef.current = !blinkOnRef.current;
      sendLeds(blinkOnRef.current);
    }, LED_BLINK_MS);
    return () => window.clearInterval(id);
  }, [
    handshakeError,
    importError,
    learning,
    mismatch,
    native,
    opts.leds?.auto,
    opts.leds?.conn,
    opts.leds?.tempoLock,
    sendLeds,
    status,
  ]);

  const enable = useCallback(async (): Promise<void> => {
    const request = (navigator as MidiNavigator).requestMIDIAccess;
    if (typeof request !== 'function') {
      setStatus('unsupported');
      return;
    }
    try {
      let access: MidiAccessLike;
      let sysexOn = true;
      try {
        access = await request.call(navigator, { sysex: true });
      } catch {
        sysexOn = false;
        access = await request.call(navigator, { sysex: false });
      }
      if (!mountedRef.current) return;
      accessRef.current = access;
      sysexRef.current = sysexOn && access.sysexEnabled !== false;
      setSysex(sysexRef.current);
      access.onstatechange = () => {
        if (accessRef.current) void handshake();
      };
      syncPorts(access);
      setStatus('on');
      void handshake();
    } catch {
      if (mountedRef.current) setStatus('denied');
    }
  }, [handshake, syncPorts]);

  const toggleLearn = useCallback((): void => {
    const next = !learningRef.current;
    learningRef.current = next;
    setLearning(next);
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

  const setSwapRows = useCallback(
    (on: boolean): void => {
      setSwapRowsState(on);
      nanopadRef.current = { ...nanopadRef.current, swapRows: on };
      persistAll(mappingRef.current, nanopadRef.current);
      if (sourceRef.current === 'native') {
        commitMapping(mergeGenerated(mappingRef.current, nativeMapping(on)));
      } else if (sourceRef.current === 'dump' && dumpPadsRef.current) {
        commitMapping(mergeGenerated(mappingRef.current, mappingFromPads(dumpPadsRef.current, on)));
      }
    },
    [commitMapping, persistAll],
  );

  const setPreferNative = useCallback(
    (on: boolean): void => {
      setPreferNativeState(on);
      nanopadRef.current = { ...nanopadRef.current, preferNative: on };
      persistAll(mappingRef.current, nanopadRef.current);
      if (status === 'on') void handshake();
    },
    [handshake, persistAll, status],
  );

  const setVelocityCutThreshold = useCallback(
    (threshold: number | null): void => {
      commitMapping(withVelocityCutThreshold(mappingRef.current, threshold));
    },
    [commitMapping],
  );

  const applyNanopadPreset = useCallback((): void => {
    const next = nativeMapping(nanopadRef.current.swapRows);
    commitMapping(next);
    sourceRef.current = 'native';
    setDumpMapped(false);
    setMismatch(false);
    pad1ConfirmRef.current = true;
    pad1NoteRef.current = NANOPAD2_PAD1_NOTE;
    pad1InputIdRef.current = linkRef.current?.inputId ?? null;
    setPad1Confirm(Boolean(linkRef.current?.inputId));
    endLearn();
  }, [commitMapping, endLearn]);

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
    setExportError(null);
    const json = JSON.stringify(mappingRef.current, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setExportOk(true);
    } catch {
      setExportError('clipboard に書けませんでした');
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
      sourceRef.current = mappingNext.name.startsWith('nanoPAD2 Scene Dump')
        ? 'dump'
        : mappingNext.name.startsWith('nanoPAD2 Native')
          ? 'native'
          : null;
      commitMapping(mappingNext);
      return true;
    },
    [commitMapping],
  );

  return {
    status,
    devices,
    mapping,
    learning,
    learnIndex,
    learnItems: MIDI_LEARN_ITEMS,
    learnWarning,
    importError,
    exportError,
    exportOk,
    native,
    dumpMapped,
    swapRows,
    preferNative,
    velocityCutThreshold: mappingVelocityCutThreshold(mapping),
    sysex,
    pad1Confirm,
    mismatch,
    enable,
    toggleLearn,
    endLearn,
    setLearnIndex,
    setMappingName,
    setSwapRows,
    setPreferNative,
    setVelocityCutThreshold,
    applyNanopadPreset,
    startLearnFromMismatch,
    exportToClipboard,
    importFromText,
  };
}
