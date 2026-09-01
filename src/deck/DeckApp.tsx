import { useCallback, useEffect, useRef, useState } from 'react';
import { inlineCatalog } from '../synth/generators';
import { serializePatch } from '../synth/schema';
import type { TransitionPresetId, VisualPatch } from '../synth/types';
import { randomSeed } from '../variation/generate';
import {
  DECK_CHANNEL,
  parseDeckResponse,
  type DeckRequest,
  type DeckSharedState,
} from './protocol';
import { buildSceneBank, type DeckScene } from './variations';

const PRESET_CYCLE: TransitionPresetId[] = ['cut', 'default', 'slow'];
const CONNECT_TIMEOUT_MS = 1500;
const RETRY_MS = 1000;
const POLL_MS = 500;

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

export function DeckApp(): React.ReactElement {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const gotStateRef = useRef(false);
  const bankRef = useRef<DeckScene[] | null>(null);
  const sharedRef = useRef<DeckSharedState | null>(null);
  const presetRef = useRef<TransitionPresetId>('default');

  const [shared, setShared] = useState<DeckSharedState | null>(null);
  const [missingHost, setMissingHost] = useState(false);
  const [bank, setBank] = useState<DeckScene[] | null>(null);
  const [bankBase, setBankBase] = useState<VisualPatch | null>(null);
  const [preset, setPreset] = useState<TransitionPresetId>('default');
  const [lastError, setLastError] = useState<string | null>(null);

  bankRef.current = bank;
  sharedRef.current = shared;
  presetRef.current = preset;

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
        gotStateRef.current = true;
        stopRetry();
        setMissingHost(false);
        setShared(parsed.state);
        return;
      }
      if (!parsed.ok) {
        setLastError(parsed.issues.join(' · ') || 'rejected');
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

    const pollId = window.setInterval(requestState, POLL_MS);

    return () => {
      window.clearTimeout(missId);
      stopRetry();
      window.clearInterval(pollId);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code >= 'Digit1' && e.code <= 'Digit8') {
        const scene = bankRef.current?.[Number(e.code.slice(5)) - 1];
        if (!scene) return;
        e.preventDefault();
        triggerSlot(scene, e.shiftKey ? 'cut' : presetRef.current);
        return;
      }
      switch (e.code) {
        case 'KeyT':
          e.preventDefault();
          setPreset((current) => nextPreset(current));
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
  }, [gachaBank, rebuildFromLive, triggerSlot]);

  const connected = shared !== null;
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
            1–8 ポン出し · Shift+数字 cut · T 遷移 · R 再生成 · G ガチャ
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
      </div>

      {banner ? <div className="deck-banner warn">{banner}</div> : null}
      {baseChanged ? <div className="deck-banner warn">BASE CHANGED — R で再生成</div> : null}
      {lastError ? <div className="deck-banner warn">{lastError}</div> : null}

      {bank ? (
        <div className="deck-grid">
          {bank.map((scene) => {
            const active = shared?.lastTriggerLabel === scene.label;
            const hue = chipHue(scene.patch);
            return (
              <button
                key={scene.slot}
                type="button"
                className={`deck-slot${active ? ' active' : ''}`}
                onClick={() => triggerSlot(scene, preset)}
              >
                <div className="deck-slot-top">
                  <span className="deck-slot-key">{scene.slot + 1}</span>
                  <span className="deck-slot-label">{scene.label}</span>
                </div>
                <div className="deck-slot-detail">{scene.detail}</div>
                <div
                  className="deck-chip"
                  style={{ background: `hsl(${hue} 70% 52%)` }}
                  aria-hidden
                />
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
