import { useCallback, useEffect, useRef, useState } from 'react';
import { scenes } from '../scenes';
import { createCatalog } from '../synth/catalog';
import { allGeneratorDefinitions, inlineCatalog } from '../synth/generators';
import { serializePatch } from '../synth/schema';
import type { TransitionPresetId, VisualPatch } from '../synth/types';
import { randomSeed } from '../variation/generate';
import {
  dispatchDeckAction,
  keyToAction,
  wrapHue,
  type DeckAction,
  type DeckActionContext,
  type DeckKeyView,
} from './actions';
import {
  AUTO_BARS_DEFAULT,
  AUTO_BARS_MAX,
  AUTO_BARS_MIN,
  AUTO_SECONDS_DEFAULT,
  AUTO_SECONDS_MAX,
  AUTO_SECONDS_MIN,
  AUTO_SECONDS_STEP,
  clampAutoBars,
  clampAutoSeconds,
  useAutoAdvance,
  type AutoKind,
  type AutoMode,
  type AutoOrder,
} from './autoAdvance';
import {
  BANK_SLOT_IDS,
  emptyBankStore,
  isBankSnapshotStale,
  loadBankStore,
  makeBankSnapshot,
  nextEmptySlot,
  parseBankSnapshot,
  saveBankStore,
  type BankSlotId,
  type DeckBankSnapshot,
  type DeckBankStore,
} from './bankStore';
import { circularHueDelta } from './hue';
import { formatMidiTrigger } from './midi';
import { useMidi } from './useMidi';
import {
  DECK_CHANNEL,
  parseDeckResponse,
  type DeckCommand,
  type DeckRequest,
  type DeckSharedState,
} from './protocol';
import { createThumbRenderer, type ThumbRenderer } from './thumbs';
import { buildSceneBank, SCENE_BANK_SIZE, type DeckScene } from './variations';

const PRESET_CYCLE: TransitionPresetId[] = ['cut', 'default', 'slow'];
const CONNECT_TIMEOUT_MS = 1500;
const RETRY_MS = 1000;
const POLL_MS = 500;
const POLL_BARS_MS = 250;
const GRID_COLS = 4;
const GRID_ROWS = 2;
/** hue サイクル中に全サムネを描き直す最短円環距離。小さすぎると毎秒 8 draw になる。 */
const HUE_REDRAW_DEG = 12;
const BANK_AUTOSAVE_MS = 500;
const BANK_LONG_PRESS_MS = 500;
const META_CATALOG = createCatalog(allGeneratorDefinitions());

function readDeckBankStore(): DeckBankStore {
  try {
    return loadBankStore(localStorage);
  } catch {
    return emptyBankStore();
  }
}

function writeDeckBankStore(store: DeckBankStore): string | null {
  try {
    return saveBankStore(localStorage, store).warning;
  } catch {
    return 'バンクを保存できませんでした（容量不足？）';
  }
}

function clampBankCursor(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const n = Math.trunc(value);
  if (n < 0) return 0;
  if (n >= SCENE_BANK_SIZE) return SCENE_BANK_SIZE - 1;
  return n;
}

function restoreAuto(snap: DeckBankSnapshot): DeckBankSnapshot['auto'] {
  return {
    on: snap.auto.on,
    kind: snap.auto.kind,
    order: snap.auto.order,
    seconds: clampAutoSeconds(snap.auto.seconds),
    bars: clampAutoBars(snap.auto.bars),
  };
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // Fullscreen may be blocked; ignore.
  }
}

function nextPreset(current: TransitionPresetId): TransitionPresetId {
  const idx = PRESET_CYCLE.indexOf(current);
  return PRESET_CYCLE[(idx + 1) % PRESET_CYCLE.length]!;
}

function chipHue(patch: VisualPatch): number {
  for (const op of patch.operators) {
    const hue = op.parameters.hue;
    if (typeof hue === 'number' && Number.isFinite(hue)) {
      return ((hue % 360) + 360) % 360;
    }
  }
  return ((patch.palette.hueOffset % 360) + 360) % 360;
}

function isBaseChanged(current: VisualPatch, bank: DeckScene[], base: VisualPatch | null): boolean {
  const serial = serializePatch(current);
  if (base !== null && serializePatch(base) === serial) return false;
  return bank.every((scene) => serializePatch(scene.patch) !== serial);
}

function formatLockRemain(nowSec: number, lockedUntilSec: number): string | null {
  const remain = lockedUntilSec - nowSec;
  if (remain <= 0) return null;
  const n = Number.isInteger(remain) ? String(remain) : remain.toFixed(1);
  return `${n}s`;
}

function moveGridCursor(slot: number, code: string, size: number): number {
  if (size <= 0) return 0;
  const cols = GRID_COLS;
  const rows = GRID_ROWS;
  const bounded = ((slot % size) + size) % size;
  const col = bounded % cols;
  const row = Math.floor(bounded / cols);
  let nextCol = col;
  let nextRow = row;
  switch (code) {
    case 'ArrowLeft':
      nextCol = (col + cols - 1) % cols;
      break;
    case 'ArrowRight':
      nextCol = (col + 1) % cols;
      break;
    case 'ArrowUp':
      nextRow = (row + rows - 1) % rows;
      break;
    case 'ArrowDown':
      nextRow = (row + 1) % rows;
      break;
    default:
      return bounded;
  }
  const next = nextRow * cols + nextCol;
  return next >= size ? bounded : next;
}

/** Mirror 窓と seed を揃える。gacha / reroll は Deck 側で seed を決めて送る。 */
function withSyncSeed(command: DeckCommand): DeckCommand {
  if (command.kind === 'seed:gacha') {
    return { kind: 'seed:set', seed: randomSeed() };
  }
  if (command.kind === 'patch:rerollDetails' && command.seed === undefined) {
    return { kind: 'patch:rerollDetails', seed: randomSeed() };
  }
  return command;
}

function actionKey(action: DeckAction): string {
  return JSON.stringify(action);
}

function formatAutoStatus(
  autoOn: boolean,
  kind: AutoKind,
  order: AutoOrder,
  seconds: number,
  bars: number,
): string {
  const interval = kind === 'seconds' ? `${seconds}s` : `${bars} bars`;
  const ord = order === 'sequential' ? 'seq' : 'rnd';
  if (!autoOn) return `off · ${interval} ${ord}`;
  return `${interval} ${ord}`;
}

export function DeckApp(): React.ReactElement {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const gotStateRef = useRef(false);
  const lastStateAtRef = useRef(0);
  const bankRef = useRef<DeckScene[] | null>(null);
  const sharedRef = useRef<DeckSharedState | null>(null);
  const presetRef = useRef<TransitionPresetId>('default');
  const thumbsRef = useRef<ThumbRenderer | null>(null);
  const hueRef = useRef(0);
  const lastThumbHueRef = useRef<number | null>(null);
  const thumbUrlsRef = useRef<Array<string | null>>([]);
  const thumbBankRef = useRef<DeckScene[] | null>(null);
  const cursorRef = useRef(0);
  const pollMsRef = useRef(POLL_MS);
  const commandIdRef = useRef(0);
  const lastErrorCmdIdRef = useRef<string | null>(null);
  const viewRef = useRef<DeckKeyView | null>(null);
  const ctxRef = useRef<DeckActionContext | null>(null);
  // host が最後に受理したスロット。楽観更新した playhead の巻き戻し先。
  const acceptedSlotRef = useRef(0);
  const bankSeedRef = useRef('');
  const bankBaseRef = useRef<VisualPatch | null>(null);
  const autoOnRef = useRef(false);
  const autoKindRef = useRef<AutoKind>('seconds');
  const autoOrderRef = useRef<AutoOrder>('sequential');
  const autoSecondsRef = useRef(AUTO_SECONDS_DEFAULT);
  const autoBarsRef = useRef(AUTO_BARS_DEFAULT);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveToNextRef = useRef<() => void>(() => {});
  const longPressRef = useRef<{ id: BankSlotId; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const ignoreSlotClickRef = useRef(false);
  const skipRenameBlurRef = useRef(false);
  const clearedRef = useRef(false);

  const midiDispatch = useCallback((action: DeckAction): void => {
    const ctx = ctxRef.current;
    if (ctx) dispatchDeckAction(action, ctx);
  }, []);
  const [midiImport, setMidiImport] = useState('');

  const [shared, setShared] = useState<DeckSharedState | null>(null);
  const [missingHost, setMissingHost] = useState(false);
  const [initialStore] = useState(readDeckBankStore);
  const storeRef = useRef<DeckBankStore>(initialStore);
  const lastMainSeedRef = useRef<string | undefined>(initialStore.current?.mainSeed);
  const [adoptSeed, setAdoptSeed] = useState(initialStore.current?.mainSeed);
  const restored = initialStore.current;
  const [bank, setBank] = useState<DeckScene[] | null>(() =>
    restored ? buildSceneBank(restored.base, restored.bankSeed, inlineCatalog) : null,
  );
  const [bankBase, setBankBase] = useState<VisualPatch | null>(restored?.base ?? null);
  const [bankSeed, setBankSeed] = useState(restored?.bankSeed ?? '');
  const restoredAuto = restored ? restoreAuto(restored) : null;
  const [preset, setPreset] = useState<TransitionPresetId>(restored?.preset ?? 'default');
  const [lastError, setLastError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(restored ? clampBankCursor(restored.cursor) : 0);
  const [playhead, setPlayhead] = useState(0);
  const [autoOn, setAutoOn] = useState(restoredAuto?.on ?? false);
  const [autoKind, setAutoKind] = useState<AutoKind>(restoredAuto?.kind ?? 'seconds');
  const [autoOrder, setAutoOrder] = useState<AutoOrder>(restoredAuto?.order ?? 'sequential');
  const [autoSeconds, setAutoSeconds] = useState(restoredAuto?.seconds ?? AUTO_SECONDS_DEFAULT);
  const [autoBars, setAutoBars] = useState(restoredAuto?.bars ?? AUTO_BARS_DEFAULT);
  const [thumbUrls, setThumbUrls] = useState<Array<string | null>>([]);
  const [hueEpoch, setHueEpoch] = useState(0);
  const [hueEcho, setHueEcho] = useState<number | null>(null);
  const [slotMap, setSlotMap] = useState(initialStore.slots);
  const [activeSlotId, setActiveSlotId] = useState<BankSlotId | null>(null);
  const [bankStale, setBankStale] = useState(() =>
    restored ? isBankSnapshotStale(restored, META_CATALOG) : false,
  );
  const [renamingSlot, setRenamingSlot] = useState<BankSlotId | null>(null);
  const [bankMenuOpen, setBankMenuOpen] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [bankImport, setBankImport] = useState('');
  const [bankExportOk, setBankExportOk] = useState(false);
  const [bankImportError, setBankImportError] = useState<string | null>(null);
  const [bankSaveWarning, setBankSaveWarning] = useState<string | null>(null);

  bankRef.current = bank;
  sharedRef.current = shared;
  presetRef.current = preset;
  cursorRef.current = cursor;
  bankSeedRef.current = bankSeed;
  bankBaseRef.current = bankBase;
  autoOnRef.current = autoOn;
  autoKindRef.current = autoKind;
  autoOrderRef.current = autoOrder;
  autoSecondsRef.current = autoSeconds;
  autoBarsRef.current = autoBars;
  pollMsRef.current = autoOn && autoKind === 'bars' ? POLL_BARS_MS : POLL_MS;
  hueRef.current = shared?.hue ?? 0;
  if (shared?.app?.seed) lastMainSeedRef.current = shared.app.seed;

  const connected = shared !== null;
  const midi = useMidi({
    dispatch: midiDispatch,
    leds: {
      conn: connected,
      auto: autoOn,
      tempoLock: shared?.tempoLocked ?? false,
    },
  });

  const postRequest = useCallback((req: DeckRequest): void => {
    channelRef.current?.postMessage(req);
  }, []);

  const triggerSlot = useCallback(
    (scene: DeckScene, nextPresetId: TransitionPresetId): void => {
      setLastError(null);
      postRequest({
        kind: 'deck:trigger',
        patch: scene.patch,
        label: scene.label,
        preset: nextPresetId,
      });
    },
    [postRequest],
  );

  const autoMode: AutoMode = autoOn ? autoKind : 'off';

  const onAdvance = useCallback(
    (slot: number): void => {
      const scene = bankRef.current?.[slot];
      if (!scene) return;
      setPlayhead(slot);
      setCursor(slot);
      triggerSlot(scene, presetRef.current);
    },
    [triggerSlot],
  );

  const { noteManualTrigger, waitingForTempo } = useAutoAdvance({
    mode: autoMode,
    order: autoOrder,
    seconds: autoSeconds,
    bars: autoBars,
    connected,
    tempoLocked: shared?.tempoLocked ?? false,
    barCount: shared?.barCount ?? 0,
    currentSlot: playhead,
    size: bank?.length ?? 0,
    onAdvance,
  });

  const fireManual = useCallback(
    (scene: DeckScene, nextPresetId: TransitionPresetId): void => {
      setPlayhead(scene.slot);
      setCursor(scene.slot);
      triggerSlot(scene, nextPresetId);
      noteManualTrigger();
    },
    [noteManualTrigger, triggerSlot],
  );

  const rebuildFromLive = useCallback((): void => {
    const live = sharedRef.current?.currentPatch;
    if (!live) return;
    const seed = randomSeed();
    clearedRef.current = false;
    setBankSeed(seed);
    setBankBase(live);
    setBank(buildSceneBank(live, seed, inlineCatalog));
    setBankStale(false);
    setActiveSlotId(null);
  }, []);

  const gachaBank = useCallback((): void => {
    const base = bankBase;
    if (!base) return;
    const seed = randomSeed();
    clearedRef.current = false;
    setBankSeed(seed);
    setBank(buildSceneBank(base, seed, inlineCatalog));
    setActiveSlotId(null);
  }, [bankBase]);

  const bumpInterval = useCallback(
    (dir: -1 | 1): void => {
      if (autoKind === 'seconds') {
        // 素の加減算だと MIN=2 に張り付いたあと 2,7,12… とグリッドから外れる。
        setAutoSeconds((s) =>
          clampAutoSeconds(
            Math.round((s + dir * AUTO_SECONDS_STEP) / AUTO_SECONDS_STEP) * AUTO_SECONDS_STEP,
          ),
        );
      } else {
        setAutoBars((b) => clampAutoBars(b + dir));
      }
    },
    [autoKind],
  );

  const setIntervalAbs = useCallback(
    (value01: number): void => {
      const t = Number.isFinite(value01) ? Math.min(1, Math.max(0, value01)) : 0;
      if (autoKind === 'seconds') {
        const ratio = AUTO_SECONDS_MAX / AUTO_SECONDS_MIN;
        setAutoSeconds(clampAutoSeconds(AUTO_SECONDS_MIN * ratio ** t));
      } else {
        const ratio = AUTO_BARS_MAX / AUTO_BARS_MIN;
        setAutoBars(clampAutoBars(AUTO_BARS_MIN * ratio ** t));
      }
    },
    [autoKind],
  );

  useEffect(() => {
    const prevTitle = document.title;
    document.title = 'Scene Deck';
    document.documentElement.classList.add('deck-mode');
    return () => {
      document.title = prevTitle;
      document.documentElement.classList.remove('deck-mode');
    };
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel !== 'function') {
      setMissingHost(true);
      return;
    }

    const channel = new BroadcastChannel(DECK_CHANNEL);
    channelRef.current = channel;
    gotStateRef.current = false;
    lastStateAtRef.current = 0;

    const requestState = (): void => {
      channel.postMessage({ kind: 'deck:requestState' } satisfies DeckRequest);
    };

    let retryId: ReturnType<typeof setInterval> | null = null;
    const stopRetry = (): void => {
      if (retryId === null) return;
      window.clearInterval(retryId);
      retryId = null;
    };

    channel.onmessage = (ev: MessageEvent): void => {
      const parsed = parseDeckResponse(ev.data);
      if (parsed === null) return;
      if (parsed.kind === 'deck:state') {
        lastStateAtRef.current = Date.now();
        gotStateRef.current = true;
        stopRetry();
        setMissingHost(false);
        setShared(parsed.state);
        return;
      }
      if (parsed.kind === 'deck:commandResult') {
        if (parsed.ok) {
          if (lastErrorCmdIdRef.current === parsed.id) {
            lastErrorCmdIdRef.current = null;
            setLastError(null);
          }
        } else {
          lastErrorCmdIdRef.current = parsed.id;
          setLastError(parsed.issues.join(' · ') || 'rejected');
        }
        return;
      }
      if (!parsed.ok) {
        setLastError(parsed.issues.join(' · ') || 'rejected');
        // 拒否時 host は deck:state を投げない。楽観更新した playhead を戻す。
        setPlayhead(acceptedSlotRef.current);
      }
    };

    requestState();

    const missId = window.setTimeout(() => {
      if (gotStateRef.current) return;
      setMissingHost(true);
      retryId = window.setInterval(() => {
        if (!gotStateRef.current) requestState();
      }, RETRY_MS);
    }, CONNECT_TIMEOUT_MS);

    // bars オート中は 250ms。pollMsRef で切り替え、channel は張り直さない。
    let pollId: ReturnType<typeof setTimeout> | null = null;
    const schedulePoll = (): void => {
      pollId = window.setTimeout(() => {
        // 最後の deck:state から CONNECT_TIMEOUT_MS 応答が無ければ切断。
        // これをしないとメイン窓を閉じても auto が死んだ channel に打ち続ける。
        if (gotStateRef.current && Date.now() - lastStateAtRef.current >= CONNECT_TIMEOUT_MS) {
          gotStateRef.current = false;
          setShared(null);
          setMissingHost(true);
        }
        requestState();
        schedulePoll();
      }, pollMsRef.current);
    };
    schedulePoll();

    return () => {
      window.clearTimeout(missId);
      stopRetry();
      if (pollId !== null) window.clearTimeout(pollId);
      channel.close();
      channelRef.current = null;
    };
  }, []);

  // 初回の currentPatch だけでバンクを組む。トリガー後の追従再生成はドリフトするのでしない。
  // store.current から復元済みなら bank !== null なのでここは走らない。
  useEffect(() => {
    if (bank !== null) return;
    const patch = shared?.currentPatch;
    if (!patch) return;
    const seed = randomSeed();
    setBankSeed(seed);
    setBankBase(patch);
    setBank(buildSceneBank(patch, seed, inlineCatalog));
    setBankStale(false);
  }, [shared, bank]);

  // playhead は楽観更新なので、host が受理した label から実位置へ寄せ直す。
  useEffect(() => {
    const label = shared?.lastTriggerLabel;
    if (!label || !bank) return;
    const scene = bank.find((s) => s.label === label);
    if (!scene) return;
    acceptedSlotRef.current = scene.slot;
    setPlayhead((cur) => (cur === scene.slot ? cur : scene.slot));
  }, [shared?.lastTriggerLabel, bank]);

  useEffect(() => {
    // retina で 192×108 を引き伸ばすとぼやける。DPR ぶん解像度を上げる。
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const renderer = createThumbRenderer(192 * dpr, 108 * dpr);
    thumbsRef.current = renderer;
    return () => {
      renderer.dispose();
      thumbsRef.current = null;
    };
  }, []);

  // |Δhue| が閾値を超えたときだけ epoch を進めてサムネを描き直す。
  // 進行中ループのキャンセルは下の effect に任せる（ここが毎 poll で再実行されると途中の rAF が死ぬ）。
  useEffect(() => {
    const hue = shared?.hue ?? 0;
    const last = lastThumbHueRef.current;
    if (last === null || circularHueDelta(last, hue) < HUE_REDRAW_DEG) return;
    lastThumbHueRef.current = hue;
    setHueEpoch((n) => n + 1);
  }, [shared?.hue]);

  // サムネは 1 枚/フレーム。コンパイルが UI を止めないようにする。
  // hue だけの描き直しでは直前の画像を残し、bank が変わったときだけチップに戻す。
  useEffect(() => {
    if (!bank) {
      thumbUrlsRef.current = [];
      thumbBankRef.current = null;
      setThumbUrls([]);
      return;
    }
    let cancelled = false;
    let i = 0;
    let raf = 0;
    const passHue = hueRef.current;
    lastThumbHueRef.current = passHue;

    const sameBank = thumbBankRef.current === bank && thumbUrlsRef.current.length === bank.length;
    thumbBankRef.current = bank;
    const urls: Array<string | null> = sameBank
      ? thumbUrlsRef.current.slice()
      : Array.from({ length: bank.length }, () => null);
    if (!sameBank) {
      thumbUrlsRef.current = urls.slice();
      setThumbUrls(urls.slice());
    }

    const tick = (): void => {
      if (cancelled) return;
      const renderer = thumbsRef.current;
      if (!renderer) {
        raf = window.requestAnimationFrame(tick);
        return;
      }
      const scene = bank[i];
      if (!scene) return;
      urls[i] = renderer.render(scene.patch, { hue: passHue });
      const snapshot = urls.slice();
      thumbUrlsRef.current = snapshot;
      setThumbUrls(snapshot);
      i += 1;
      if (i < bank.length) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [bank, hueEpoch]);

  const postCommand = useCallback(
    (command: DeckCommand): void => {
      // 旧 host（app 未着）には command を送らない。パッド操作はそのまま。
      if (sharedRef.current?.app === undefined) return;
      commandIdRef.current += 1;
      postRequest({
        kind: 'deck:command',
        id: `cmd-${commandIdRef.current}`,
        command: withSyncSeed(command),
      });
    },
    [postRequest],
  );

  const persistStore = useCallback((next: DeckBankStore): void => {
    storeRef.current = next;
    setSlotMap(next.slots);
    setBankSaveWarning(writeDeckBankStore(next));
  }, []);

  const captureCurrent = useCallback((name = ''): DeckBankSnapshot | null => {
    const base = bankBaseRef.current;
    const seed = bankSeedRef.current;
    if (base === null || seed === '') return null;
    const mainSeed = sharedRef.current?.app?.seed ?? lastMainSeedRef.current;
    return makeBankSnapshot({
      name,
      base,
      bankSeed: seed,
      preset: presetRef.current,
      auto: {
        on: autoOnRef.current,
        kind: autoKindRef.current,
        order: autoOrderRef.current,
        seconds: autoSecondsRef.current,
        bars: autoBarsRef.current,
      },
      cursor: cursorRef.current,
      mainSeed,
    });
  }, []);

  const applySnapshot = useCallback((snap: DeckBankSnapshot): void => {
    const auto = restoreAuto(snap);
    clearedRef.current = false;
    setBankBase(snap.base);
    setBankSeed(snap.bankSeed);
    setBank(buildSceneBank(snap.base, snap.bankSeed, inlineCatalog));
    setPreset(snap.preset);
    setAutoOn(auto.on);
    setAutoKind(auto.kind);
    setAutoOrder(auto.order);
    setAutoSeconds(auto.seconds);
    setAutoBars(auto.bars);
    setCursor(clampBankCursor(snap.cursor));
    setBankStale(isBankSnapshotStale(snap, META_CATALOG));
    lastMainSeedRef.current = snap.mainSeed;
    setAdoptSeed(snap.mainSeed);
  }, []);

  const captureCurrentRef = useRef(captureCurrent);
  captureCurrentRef.current = captureCurrent;
  const persistStoreRef = useRef(persistStore);
  persistStoreRef.current = persistStore;

  const flushAutosave = useCallback((): void => {
    if (autosaveTimerRef.current === null) return;
    window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
    if (clearedRef.current) return;
    const snap = captureCurrentRef.current(storeRef.current.current?.name ?? '');
    if (snap === null) return;
    persistStoreRef.current({ ...storeRef.current, current: snap });
  }, []);

  // bankBase が無い（未接続・未復元）ときは書かない。500ms debounce。
  useEffect(() => {
    if (bankBase === null || bankSeed === '') return;
    if (clearedRef.current) return;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      if (clearedRef.current) return;
      const snap = captureCurrent(storeRef.current.current?.name ?? '');
      if (snap === null) return;
      persistStore({ ...storeRef.current, current: snap });
    }, BANK_AUTOSAVE_MS);
  }, [
    bank,
    bankSeed,
    bankBase,
    preset,
    autoOn,
    autoKind,
    autoOrder,
    autoSeconds,
    autoBars,
    cursor,
    shared?.app?.seed,
    captureCurrent,
    persistStore,
  ]);

  useEffect(() => {
    const onPageHide = (): void => {
      flushAutosave();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushAutosave();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      flushAutosave();
    };
  }, [flushAutosave]);

  const saveToSlot = useCallback(
    (id: BankSlotId): void => {
      const prev = storeRef.current.slots[id];
      const snap = captureCurrent(prev?.name ?? '');
      if (snap === null) return;
      clearedRef.current = false;
      persistStore({
        ...storeRef.current,
        current: snap,
        slots: { ...storeRef.current.slots, [id]: snap },
      });
      setActiveSlotId(id);
    },
    [captureCurrent, persistStore],
  );

  const saveToNextEmpty = useCallback((): void => {
    saveToSlot(nextEmptySlot(storeRef.current));
  }, [saveToSlot]);
  saveToNextRef.current = saveToNextEmpty;

  const loadSlot = useCallback(
    (id: BankSlotId): void => {
      const snap = storeRef.current.slots[id];
      if (!snap) return;
      applySnapshot(snap);
      persistStore({ ...storeRef.current, current: snap });
      setActiveSlotId(id);
    },
    [applySnapshot, persistStore],
  );

  const renameSlot = useCallback(
    (id: BankSlotId, name: string): void => {
      const snap = storeRef.current.slots[id];
      if (!snap) return;
      persistStore({
        ...storeRef.current,
        slots: { ...storeRef.current.slots, [id]: { ...snap, name } },
      });
    },
    [persistStore],
  );

  const clearCurrent = useCallback((): void => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    clearedRef.current = true;
    persistStore({ ...storeRef.current, current: null });
    setClearArmed(false);
    setBankMenuOpen(false);
  }, [persistStore]);

  const adoptMainSeed = useCallback((): void => {
    if (!adoptSeed) return;
    postCommand({ kind: 'seed:set', seed: adoptSeed });
  }, [adoptSeed, postCommand]);

  const exportCurrent = useCallback(async (): Promise<void> => {
    setBankExportOk(false);
    const snap = captureCurrent(storeRef.current.current?.name ?? '');
    if (snap === null) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(snap, null, 2));
      setBankExportOk(true);
      setBankImportError(null);
    } catch {
      setBankImportError('clipboard に書けませんでした');
    }
  }, [captureCurrent]);

  const importSnapshotText = useCallback(
    (text: string): void => {
      setBankExportOk(false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        setBankImportError('JSON が読めません');
        return;
      }
      const snap = parseBankSnapshot(parsed);
      if (snap === null) {
        setBankImportError('スナップショットが不正です');
        return;
      }
      applySnapshot(snap);
      persistStore({ ...storeRef.current, current: snap });
      setActiveSlotId(null);
      setBankImportError(null);
    },
    [applySnapshot, persistStore],
  );

  const startSlotPress = useCallback((id: BankSlotId): void => {
    ignoreSlotClickRef.current = false;
    skipRenameBlurRef.current = false;
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer);
    longPressRef.current = {
      id,
      timer: window.setTimeout(() => {
        longPressRef.current = null;
        if (!storeRef.current.slots[id]) return;
        ignoreSlotClickRef.current = true;
        setRenamingSlot(id);
      }, BANK_LONG_PRESS_MS),
    };
  }, []);

  const endSlotPress = useCallback((): void => {
    if (!longPressRef.current) return;
    window.clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  }, []);

  const actionCtx: DeckActionContext = {
    fireSlot(slot, cut) {
      const scene = bankRef.current?.[slot];
      if (!scene) return;
      fireManual(scene, cut ? 'cut' : presetRef.current);
    },
    fireCursor() {
      const scene = bankRef.current?.[cursorRef.current];
      if (!scene) return;
      fireManual(scene, presetRef.current);
    },
    moveCursor(dir) {
      const code =
        dir === 'left'
          ? 'ArrowLeft'
          : dir === 'right'
            ? 'ArrowRight'
            : dir === 'up'
              ? 'ArrowUp'
              : 'ArrowDown';
      setCursor((slot) => moveGridCursor(slot, code, bankRef.current?.length ?? 0));
    },
    cycleTransition() {
      setPreset((current) => nextPreset(current));
    },
    toggleAuto() {
      setAutoOn((on) => !on);
    },
    cycleAutoMode() {
      setAutoKind((kind) => (kind === 'seconds' ? 'bars' : 'seconds'));
    },
    bumpInterval,
    setIntervalAbs,
    rebuildBank: rebuildFromLive,
    gachaBank,
    postCommand,
  };
  ctxRef.current = actionCtx;

  const app = shared?.app;
  const consoleEnabled = app !== undefined;
  const keyView: DeckKeyView | null =
    app && shared
      ? {
          hueMode: app.hueMode,
          fixedHue: app.fixedHue,
          hue: app.baseHue,
          background: app.background,
          autoCycle: app.autoCycle,
          locked: shared.nowSec < shared.lockedUntilSec,
        }
      : null;
  viewRef.current = keyView;
  const midiLearningRef = useRef(midi.learning);
  midiLearningRef.current = midi.learning;
  const midiEndLearnRef = useRef(midi.endLearn);
  midiEndLearnRef.current = midi.endLearn;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Escape' && midiLearningRef.current) {
        e.preventDefault();
        midiEndLearnRef.current();
        return;
      }
      if (e.code === 'KeyF') {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      // スロット呼び出しはキーに載せない。Shift+S は次の空き（無ければ A）へ保存。
      if (e.code === 'KeyS' && e.shiftKey) {
        e.preventDefault();
        saveToNextRef.current();
        return;
      }
      const action = keyToAction(e, viewRef.current);
      if (action === null) return;
      e.preventDefault();
      const ctx = ctxRef.current;
      if (ctx) dispatchDeckAction(action, ctx);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const livePatch = shared?.currentPatch ?? null;
  const baseChanged =
    connected && livePatch !== null && bank !== null && isBaseChanged(livePatch, bank, bankBase);
  const lockRemain = shared ? formatLockRemain(shared.nowSec, shared.lockedUntilSec) : null;
  const hueSliderValue = app ? (app.hueMode === 'fixed' ? app.fixedHue : app.baseHue) : 0;
  const hueStatus =
    app?.hueMode === 'fixed'
      ? `${Math.round(app.fixedHue)}° fixed`
      : `${Math.round(shared?.hue ?? 0)}°`;

  let banner: string | null = null;
  if (!connected && missingHost) banner = 'メイン窓が見つかりません';
  else if (connected && livePatch === null) banner = 'semantic-synth シーンにしてください';

  return (
    <div className="deck-root">
      <header className="deck-header">
        <div>
          <div className="deck-title">Scene Deck</div>
          <div className="deck-sub">
            1–8 ポン出し · Shift+数字 cut · ←↑↓→ カーソル · Shift+←→ シーン · Enter/Space 決定 · T
            tap · , ÷2 · . ×2 · / AUTO · X 遷移 · Q ガチャ · W 細部 · A auto · Shift+A autocycle · R
            再生成 · G バンク · Shift+S 手札保存
          </div>
        </div>
        <div className="deck-toolbar">
          {PRESET_CYCLE.map((id) => (
            <button
              key={id}
              type="button"
              className={`btn toggle${preset === id ? ' on' : ''}`}
              onClick={() => setPreset(id)}
            >
              {id}
            </button>
          ))}
          <button
            type="button"
            className={`btn toggle${autoOn ? ' on' : ''}`}
            onClick={() => setAutoOn((on) => !on)}
          >
            auto
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setAutoKind((kind) => (kind === 'seconds' ? 'bars' : 'seconds'))}
          >
            {autoKind === 'seconds' ? `${autoSeconds}s` : `${autoBars} bars`}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setAutoOrder((o) => (o === 'sequential' ? 'random' : 'sequential'))}
          >
            {autoOrder === 'sequential' ? 'seq' : 'rnd'}
          </button>
          <button type="button" className="btn" onClick={rebuildFromLive} disabled={!livePatch}>
            R rebuild
          </button>
          <button type="button" className="btn" onClick={gachaBank} disabled={bankBase === null}>
            G gacha
          </button>
          <span className="deck-banks-label">A–H</span>
          {BANK_SLOT_IDS.map((id) => {
            const filled = slotMap[id] !== undefined;
            if (renamingSlot === id) {
              return (
                <input
                  key={id}
                  className="deck-bank-name"
                  defaultValue={slotMap[id]?.name ?? ''}
                  autoFocus
                  aria-label={`Bank ${id} name`}
                  onBlur={(e) => {
                    if (skipRenameBlurRef.current) {
                      skipRenameBlurRef.current = false;
                      return;
                    }
                    renameSlot(id, e.target.value);
                    setRenamingSlot(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      skipRenameBlurRef.current = true;
                      setRenamingSlot(null);
                    }
                  }}
                />
              );
            }
            return (
              <button
                key={id}
                type="button"
                className={`btn deck-bank-slot${filled ? '' : ' empty'}${activeSlotId === id ? ' toggle on' : ''}`}
                aria-label={`Bank ${id}`}
                title={
                  filled
                    ? `${id}${slotMap[id]?.name ? ` · ${slotMap[id]?.name}` : ''} · click 呼出 · Shift+click 保存 · 右クリックで改名`
                    : `${id} 空 · Shift+click で保存`
                }
                disabled={bankBase === null && !filled}
                onPointerDown={() => startSlotPress(id)}
                onPointerUp={endSlotPress}
                onPointerLeave={endSlotPress}
                onPointerCancel={endSlotPress}
                onContextMenu={(e) => {
                  e.preventDefault();
                  endSlotPress();
                  skipRenameBlurRef.current = false;
                  if (slotMap[id]) setRenamingSlot(id);
                }}
                onClick={(e) => {
                  if (ignoreSlotClickRef.current) {
                    ignoreSlotClickRef.current = false;
                    return;
                  }
                  if (e.shiftKey) {
                    saveToSlot(id);
                    return;
                  }
                  loadSlot(id);
                }}
              >
                {id}
              </button>
            );
          })}
          <button
            type="button"
            className={`btn toggle${midi.status === 'on' ? ' on' : ''}`}
            disabled={midi.status === 'unsupported' || midi.status === 'on'}
            onClick={() => void midi.enable()}
          >
            {midi.status === 'unsupported'
              ? 'MIDI 非対応'
              : midi.status === 'on'
                ? 'MIDI on'
                : midi.status === 'denied'
                  ? 'MIDI retry'
                  : 'MIDI'}
          </button>
          <button
            type="button"
            className={`btn toggle${midi.learning ? ' on' : ''}`}
            disabled={midi.status !== 'on'}
            onClick={midi.toggleLearn}
          >
            learn
          </button>
        </div>
      </header>

      <div className="deck-banks">
        <div className="deck-banks-row">
          <span className="deck-banks-label">手札</span>
          <button
            type="button"
            className="btn"
            disabled={bankBase === null}
            onClick={() => void exportCurrent()}
          >
            {bankExportOk ? 'copied' : 'JSON copy'}
          </button>
          <button type="button" className="btn" onClick={() => importSnapshotText(bankImport)}>
            JSON paste
          </button>
          <button
            type="button"
            className={`btn toggle${bankMenuOpen ? ' on' : ''}`}
            onClick={() => {
              setBankMenuOpen((open) => !open);
              setClearArmed(false);
            }}
          >
            menu
          </button>
        </div>
        {bankMenuOpen ? (
          <div className="deck-banks-row">
            <button type="button" className="btn" disabled={!adoptSeed} onClick={adoptMainSeed}>
              seed を採用
            </button>
            {clearArmed ? (
              <button type="button" className="btn" onClick={clearCurrent}>
                confirm clear current
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => setClearArmed(true)}>
                clear current
              </button>
            )}
          </div>
        ) : null}
        <textarea
          className="deck-bank-json"
          rows={2}
          value={bankImport}
          onChange={(e) => setBankImport(e.target.value)}
          placeholder='{"version":1,"name":"","base":…}'
          aria-label="Bank snapshot JSON"
        />
      </div>

      <div className="deck-midi">
        <div className="deck-midi-row">
          <span className="deck-midi-label">MIDI</span>
          {midi.status === 'unsupported' ? (
            <span className="deck-midi-unsupported">MIDI 非対応</span>
          ) : (
            <>
              {midi.native ? <span className="deck-midi-badge">native</span> : null}
              {midi.dumpMapped && !midi.native ? (
                <span className="deck-midi-badge">dump</span>
              ) : null}
              {midi.status === 'on' && !midi.sysex ? (
                <span className="deck-midi-unsupported">SysEx なし</span>
              ) : null}
              <label className="deck-midi-name">
                <input
                  type="text"
                  value={midi.mapping.name}
                  onChange={(e) => midi.setMappingName(e.target.value)}
                  aria-label="MIDI mapping name"
                />
              </label>
              <label className="deck-midi-check">
                <input
                  type="checkbox"
                  checked={midi.preferNative}
                  onChange={(e) => midi.setPreferNative(e.target.checked)}
                />
                Native
              </label>
              <label className="deck-midi-check">
                <input
                  type="checkbox"
                  checked={midi.swapRows}
                  onChange={(e) => midi.setSwapRows(e.target.checked)}
                />
                上下入替
              </label>
              <label className="deck-midi-cut">
                cut ≥
                <input
                  type="number"
                  min={1}
                  max={127}
                  placeholder="off"
                  value={midi.velocityCutThreshold ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === '') {
                      midi.setVelocityCutThreshold(null);
                      return;
                    }
                    const n = Number(raw);
                    if (!Number.isInteger(n)) return;
                    midi.setVelocityCutThreshold(Math.min(127, Math.max(1, n)));
                  }}
                  aria-label="Velocity cut threshold"
                />
              </label>
              <button type="button" className="btn" onClick={() => void midi.exportToClipboard()}>
                {midi.exportOk ? 'copied' : 'export'}
              </button>
              <button type="button" className="btn" onClick={() => midi.importFromText(midiImport)}>
                import
              </button>
            </>
          )}
        </div>
        {midi.status === 'on' ? (
          <div className="deck-midi-devices">
            {midi.devices.length === 0 ? 'no inputs' : midi.devices.map((d) => d.name).join(' · ')}
          </div>
        ) : null}
        {midi.status !== 'unsupported' ? (
          <>
            <div className="deck-midi-actions">
              {midi.learnItems.map((item, i) => {
                const bound = midi.mapping.bindings.find(
                  (b) => actionKey(b.action) === actionKey(item.action),
                );
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`btn deck-midi-action${midi.learnIndex === i ? ' toggle on' : ''}${bound ? ' bound' : ''}`}
                    onClick={() => midi.setLearnIndex(i)}
                  >
                    {item.label}
                    {bound ? ` · ${formatMidiTrigger(bound.trigger)}` : ''}
                  </button>
                );
              })}
            </div>
            <textarea
              className="deck-midi-json"
              rows={3}
              value={midiImport}
              onChange={(e) => setMidiImport(e.target.value)}
              placeholder='{"version":1,"name":"…","bindings":[]}'
              aria-label="MIDI mapping JSON"
            />
          </>
        ) : null}
      </div>

      <div className="deck-console">
        <button
          type="button"
          className="btn"
          disabled={!consoleEnabled}
          onClick={() => postCommand({ kind: 'seed:gacha' })}
        >
          Q gacha
        </button>
        <button
          type="button"
          className="btn"
          disabled={!consoleEnabled}
          onClick={() => postCommand({ kind: 'patch:rerollDetails' })}
        >
          W details
        </button>
        <button
          type="button"
          className="btn icon"
          disabled={!consoleEnabled}
          aria-label="Previous scene"
          onClick={() => postCommand({ kind: 'scene:shift', delta: -1 })}
        >
          ‹
        </button>
        <select
          className="deck-scene-select"
          disabled={!consoleEnabled}
          value={app?.sceneId ?? ''}
          aria-label="Scene"
          onChange={(e) => {
            postCommand({ kind: 'scene:set', sceneId: e.target.value });
            e.currentTarget.blur();
          }}
        >
          {app === undefined ? <option value="">scene</option> : null}
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn icon"
          disabled={!consoleEnabled}
          aria-label="Next scene"
          onClick={() => postCommand({ kind: 'scene:shift', delta: 1 })}
        >
          ›
        </button>
        <button
          type="button"
          className={`btn toggle${app?.hueMode === 'fixed' ? ' on' : ''}`}
          disabled={!consoleEnabled}
          onClick={() => {
            if (!app) return;
            if (app.hueMode === 'fixed') {
              postCommand({ kind: 'hue:mode', mode: 'cycle' });
            } else {
              postCommand({ kind: 'hue:fixed', hue: wrapHue(app.baseHue) });
            }
          }}
        >
          hue {app?.hueMode === 'fixed' ? 'fixed' : 'cycle'}
        </button>
        <label className="deck-hue">
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            disabled={!consoleEnabled}
            value={hueEcho ?? hueSliderValue}
            aria-label="Hue"
            onChange={(e) => {
              const hue = Number(e.target.value);
              setHueEcho(hue);
              postCommand({ kind: 'hue:fixed', hue });
            }}
            onPointerUp={(e) => {
              setHueEcho(null);
              e.currentTarget.blur();
            }}
            onPointerCancel={(e) => {
              setHueEcho(null);
              e.currentTarget.blur();
            }}
          />
        </label>
        <button
          type="button"
          className={`btn toggle${app?.background === 'transparent' ? ' on' : ''}`}
          disabled={!consoleEnabled}
          onClick={() => {
            if (!app) return;
            postCommand({
              kind: 'background:set',
              background: app.background === 'black' ? 'transparent' : 'black',
            });
          }}
        >
          bg {app?.background === 'transparent' ? 'clear' : 'black'}
        </button>
        <button
          type="button"
          className="btn tap"
          disabled={!consoleEnabled}
          onClick={() => postCommand({ kind: 'tempo:tap' })}
        >
          TAP
        </button>
        <button
          type="button"
          className="btn"
          disabled={!consoleEnabled}
          title="Halve tempo"
          onClick={() => postCommand({ kind: 'tempo:multiply', factor: 0.5 })}
        >
          ÷2
        </button>
        <button
          type="button"
          className="btn"
          disabled={!consoleEnabled}
          title="Double tempo"
          onClick={() => postCommand({ kind: 'tempo:multiply', factor: 2 })}
        >
          ×2
        </button>
        <button
          type="button"
          className="btn"
          disabled={!consoleEnabled}
          title="Auto-detect tempo"
          onClick={() => postCommand({ kind: 'tempo:auto' })}
        >
          AUTO
        </button>
        <button
          type="button"
          className={`btn toggle${app?.autoCycle ? ' on' : ''}`}
          disabled={!consoleEnabled}
          title="Main window auto-cycle (Shift+A)"
          onClick={() => {
            if (!app) return;
            postCommand({ kind: 'autoCycle:set', on: !app.autoCycle });
          }}
        >
          autocycle
        </button>
        <button
          type="button"
          className={`btn toggle${lockRemain ? ' on' : ''}`}
          disabled={!consoleEnabled}
          onClick={() => postCommand({ kind: 'timeline:lock', seconds: lockRemain ? 0 : 30 })}
        >
          {lockRemain ? `unlock ${lockRemain}` : 'lock 30s'}
        </button>
      </div>

      <div className="deck-status">
        <span>
          conn <strong>{connected ? 'live' : missingHost ? 'missing' : 'waiting'}</strong>
        </span>
        <span>
          hue <strong>{hueStatus}</strong>
        </span>
        {app ? (
          <span>
            bpm{' '}
            <strong>
              {app.bpm > 0 ? String(Math.round(app.bpm)) : '—'}
              {app.tempoLocked ? ' ● locked' : ''}
            </strong>
          </span>
        ) : null}
        {app && !app.audioRunning ? (
          <span className="deck-audio-stopped">AUDIO STOPPED</span>
        ) : null}
        <span>
          t <strong>{shared ? `${shared.nowSec.toFixed(1)}s` : '—'}</strong>
        </span>
        <span>
          bar <strong>{shared ? String(Math.floor(shared.barCount)) : '—'}</strong>
        </span>
        <span>
          tempo <strong>{shared?.tempoLocked ? 'LOCK' : 'FREE'}</strong>
        </span>
        <span>
          rec <strong>{shared?.recordingActive ? 'REC' : 'off'}</strong>
        </span>
        <span>
          lock <strong>{lockRemain ?? '—'}</strong>
        </span>
        <span>
          fx <strong>{preset}</strong>
        </span>
        <span>
          auto{' '}
          <strong>{formatAutoStatus(autoOn, autoKind, autoOrder, autoSeconds, autoBars)}</strong>
        </span>
        <span>
          midi{' '}
          <strong>
            {midi.status === 'on' ? 'on' : midi.status === 'unsupported' ? 'n/a' : 'off'}
            {midi.native ? ' · native' : midi.dumpMapped ? ' · dump' : ''}
            {midi.learning ? ' · learn' : ''}
          </strong>
        </span>
      </div>

      {banner ? <div className="deck-banner warn">{banner}</div> : null}
      {bankStale ? (
        <div className="deck-banner warn">STALE: generator 更新あり。R で live から取り直し</div>
      ) : null}
      {baseChanged ? <div className="deck-banner warn">BASE CHANGED — R で再生成</div> : null}
      {bankSaveWarning ? <div className="deck-banner warn">{bankSaveWarning}</div> : null}
      {bankImportError ? <div className="deck-banner warn">{bankImportError}</div> : null}
      {waitingForTempo ? (
        <div className="deck-banner warn">bars オートは tempo LOCK が必要です — 待機中</div>
      ) : null}
      {lastError ? <div className="deck-banner warn">{lastError}</div> : null}
      {midi.pad1Confirm ? <div className="deck-banner">pad 1 を叩いて確認してください</div> : null}
      {midi.mismatch ? (
        <div className="deck-banner warn">
          ズレています。learn しますか
          <button type="button" className="btn" onClick={midi.startLearnFromMismatch}>
            learn
          </button>
        </div>
      ) : null}
      {midi.learnWarning ? <div className="deck-banner warn">{midi.learnWarning}</div> : null}
      {midi.importError ? <div className="deck-banner warn">{midi.importError}</div> : null}
      {midi.exportError ? <div className="deck-banner warn">{midi.exportError}</div> : null}

      {bank ? (
        <div className="deck-grid">
          {bank.map((scene) => {
            const active = shared?.lastTriggerLabel === scene.label;
            const hue = chipHue(scene.patch);
            const thumb = thumbUrls[scene.slot];
            const isCursor = cursor === scene.slot;
            return (
              <button
                key={scene.slot}
                type="button"
                className={`deck-slot${active ? ' active' : ''}${isCursor ? ' cursor' : ''}`}
                onClick={() => fireManual(scene, preset)}
              >
                <div className="deck-slot-top">
                  <span className="deck-slot-key">{scene.slot + 1}</span>
                  <span className="deck-slot-label">{scene.label}</span>
                </div>
                {thumb ? (
                  <img className="deck-thumb" src={thumb} alt="" draggable={false} />
                ) : (
                  <div
                    className="deck-chip"
                    style={{ background: `hsl(${hue} 70% 52%)` }}
                    aria-hidden
                  />
                )}
                <div className="deck-slot-detail">{scene.detail}</div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="deck-banner">バンク待機中…</div>
      )}
    </div>
  );
}
