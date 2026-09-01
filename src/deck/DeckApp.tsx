import { useCallback, useEffect, useRef, useState } from 'react';
import { inlineCatalog } from '../synth/generators';
import { serializePatch } from '../synth/schema';
import type { TransitionPresetId, VisualPatch } from '../synth/types';
import { randomSeed } from '../variation/generate';
import {
  AUTO_BARS_DEFAULT,
  AUTO_SECONDS_DEFAULT,
  AUTO_SECONDS_STEP,
  clampAutoBars,
  clampAutoSeconds,
  useAutoAdvance,
  type AutoKind,
  type AutoMode,
  type AutoOrder,
} from './autoAdvance';
import {
  DECK_CHANNEL,
  parseDeckResponse,
  type DeckRequest,
  type DeckSharedState,
} from './protocol';
import { createThumbRenderer, type ThumbRenderer } from './thumbs';
import { buildSceneBank, type DeckScene } from './variations';

const PRESET_CYCLE: TransitionPresetId[] = ['cut', 'default', 'slow'];
const CONNECT_TIMEOUT_MS = 1500;
const RETRY_MS = 1000;
const POLL_MS = 500;
const POLL_BARS_MS = 250;
const GRID_COLS = 4;
const GRID_ROWS = 2;
/** hue サイクル中に全サムネを描き直す最短円環距離。小さすぎると毎秒 8 draw になる。 */
const HUE_REDRAW_DEG = 12;

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

/** 円環上の最短距離（度）。359→1 は 2。 */
function circularHueDelta(from: number, to: number): number {
  const d = Math.abs(to - from) % 360;
  return d > 180 ? 360 - d : d;
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
  const cursorRef = useRef(0);
  const pollMsRef = useRef(POLL_MS);
  // host が最後に受理したスロット。楽観更新した playhead の巻き戻し先。
  const acceptedSlotRef = useRef(0);

  const [shared, setShared] = useState<DeckSharedState | null>(null);
  const [missingHost, setMissingHost] = useState(false);
  const [bank, setBank] = useState<DeckScene[] | null>(null);
  const [bankBase, setBankBase] = useState<VisualPatch | null>(null);
  const [preset, setPreset] = useState<TransitionPresetId>('default');
  const [lastError, setLastError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [autoOn, setAutoOn] = useState(false);
  const [autoKind, setAutoKind] = useState<AutoKind>('seconds');
  const [autoOrder, setAutoOrder] = useState<AutoOrder>('sequential');
  const [autoSeconds, setAutoSeconds] = useState(AUTO_SECONDS_DEFAULT);
  const [autoBars, setAutoBars] = useState(AUTO_BARS_DEFAULT);
  const [thumbUrls, setThumbUrls] = useState<Array<string | null>>([]);
  const [hueEpoch, setHueEpoch] = useState(0);

  bankRef.current = bank;
  sharedRef.current = shared;
  presetRef.current = preset;
  cursorRef.current = cursor;
  pollMsRef.current = autoOn && autoKind === 'bars' ? POLL_BARS_MS : POLL_MS;
  hueRef.current = shared?.hue ?? 0;

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

  const connected = shared !== null;
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
    const next = buildSceneBank(live, randomSeed(), inlineCatalog);
    setBankBase(live);
    setBank(next);
  }, []);

  const gachaBank = useCallback((): void => {
    const base = bankBase;
    if (!base) return;
    setBank(buildSceneBank(base, randomSeed(), inlineCatalog));
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
  useEffect(() => {
    if (bank !== null) return;
    const patch = shared?.currentPatch;
    if (!patch) return;
    setBankBase(patch);
    setBank(buildSceneBank(patch, randomSeed(), inlineCatalog));
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
  useEffect(() => {
    if (!bank) {
      setThumbUrls([]);
      return;
    }
    let cancelled = false;
    let i = 0;
    const urls: Array<string | null> = Array.from({ length: bank.length }, () => null);
    setThumbUrls(urls.slice());
    lastThumbHueRef.current = hueRef.current;

    const tick = (): void => {
      if (cancelled) return;
      const renderer = thumbsRef.current;
      const scene = bank[i];
      if (!renderer || !scene) return;
      urls[i] = renderer.render(scene.patch, { hue: hueRef.current });
      setThumbUrls(urls.slice());
      i += 1;
      if (i < bank.length) window.requestAnimationFrame(tick);
    };
    const raf = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [bank, hueEpoch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const size = bankRef.current?.length ?? 0;

      if (e.code >= 'Digit1' && e.code <= 'Digit8') {
        const scene = bankRef.current?.[Number(e.code.slice(5)) - 1];
        if (!scene) return;
        e.preventDefault();
        fireManual(scene, e.shiftKey ? 'cut' : presetRef.current);
        return;
      }

      switch (e.code) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown':
          e.preventDefault();
          setCursor((slot) => moveGridCursor(slot, e.code, size));
          break;
        case 'Enter':
        case 'Space': {
          const scene = bankRef.current?.[cursorRef.current];
          if (!scene) return;
          e.preventDefault();
          fireManual(scene, presetRef.current);
          break;
        }
        case 'KeyT':
          e.preventDefault();
          setPreset((current) => nextPreset(current));
          break;
        case 'KeyA':
          e.preventDefault();
          setAutoOn((on) => !on);
          break;
        case 'KeyM':
          e.preventDefault();
          setAutoKind((kind) => (kind === 'seconds' ? 'bars' : 'seconds'));
          break;
        case 'Minus':
        case 'NumpadSubtract':
          e.preventDefault();
          bumpInterval(-1);
          break;
        case 'Equal':
        case 'NumpadAdd':
          e.preventDefault();
          bumpInterval(1);
          break;
        case 'KeyR':
          e.preventDefault();
          rebuildFromLive();
          break;
        case 'KeyG':
          e.preventDefault();
          gachaBank();
          break;
        case 'KeyF':
          e.preventDefault();
          void toggleFullscreen();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bumpInterval, fireManual, gachaBank, rebuildFromLive]);

  const livePatch = shared?.currentPatch ?? null;
  const baseChanged =
    connected && livePatch !== null && bank !== null && isBaseChanged(livePatch, bank, bankBase);
  const lockRemain = shared ? formatLockRemain(shared.nowSec, shared.lockedUntilSec) : null;

  let banner: string | null = null;
  if (!connected && missingHost) banner = 'メイン窓が見つかりません';
  else if (connected && livePatch === null) banner = 'semantic-synth シーンにしてください';

  return (
    <div className="deck-root">
      <header className="deck-header">
        <div>
          <div className="deck-title">Scene Deck</div>
          <div className="deck-sub">
            1–8 ポン出し · Shift+数字 cut · ←↑↓→ カーソル · Enter/Space 決定 · A auto · M 秒/小節 ·
            −/= 間隔 · R 再生成 · G ガチャ
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
        </div>
      </header>

      <div className="deck-status">
        <span>
          conn <strong>{connected ? 'live' : missingHost ? 'missing' : 'waiting'}</strong>
        </span>
        <span>
          hue <strong>{`${Math.round(shared?.hue ?? 0)}°`}</strong>
        </span>
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
      </div>

      {banner ? <div className="deck-banner warn">{banner}</div> : null}
      {baseChanged ? <div className="deck-banner warn">BASE CHANGED — R で再生成</div> : null}
      {waitingForTempo ? (
        <div className="deck-banner warn">bars オートは tempo LOCK が必要です — 待機中</div>
      ) : null}
      {lastError ? <div className="deck-banner warn">{lastError}</div> : null}

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
