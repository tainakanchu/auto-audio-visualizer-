/**
 * Scene Deck のメイン窓側ホスト。
 *
 * bridgeClient と同じ二層: 純粋なルーティング（handleDeckRequest）と
 * BroadcastChannel の生死（initDeckHost）。Timeline の intent.patch は検証を
 * 通さないので、ポン出しはここで parsePatch + gatePatchProposal を通してから積む。
 * add は lockedUntilSec の保護対象外なので、lock 中の拒否も host が見る。
 * App レベル操作（seed / scene / hue / tempo）は handlers に委譲する。
 * timeline:lock だけは control.applyTimelineOp を host が直接叩く。
 */
import { gatePatchProposal } from '../synth/apply';
import { createCatalog } from '../synth/catalog';
import { getSynthControl } from '../synth/control';
import type { SynthControl } from '../synth/control';
import { DEFAULT_BUDGETS } from '../synth/cost';
import { allGeneratorDefinitions } from '../synth/generators';
import { parsePatch } from '../synth/schema';
import { TRANSITION_PRESETS } from '../synth/types';
import type { DeckAppState, DeckCommand, DeckResponse, DeckSharedState } from './protocol';
import { DECK_CHANNEL, parseDeckRequest } from './protocol';

const metaCatalog = createCatalog(allGeneratorDefinitions());

const STATE_THROTTLE_MS = 150;

export interface DeckHostHandlers {
  getAppState(): DeckAppState;
  runCommand(command: DeckCommand): { ok: boolean; issues: string[] };
}

/** host が最後に受理した trigger の label。SynthControlState には載せない。 */
let lastTriggerLabel: string | null = null;
let eventCounter = 0;

function snapshot(control: SynthControl, handlers: DeckHostHandlers): DeckSharedState {
  const state = control.getState();
  return {
    currentPatch: state.currentPatch,
    nowSec: state.nowSec,
    barCount: state.barCount,
    tempoLocked: state.tempoLocked,
    transitionActive: state.transitionActive,
    lockedUntilSec: state.timeline.lockedUntilSec,
    recordingActive: state.recordingActive,
    lastTriggerLabel,
    hue: state.hue,
    app: handlers.getAppState(),
  };
}

function formatLockedRemain(nowSec: number, lockedUntilSec: number): string {
  const remain = lockedUntilSec - nowSec;
  const n = Number.isInteger(remain) ? String(remain) : remain.toFixed(1);
  return `timeline is locked for ${n}s`;
}

export function handleDeckRequest(
  msg: unknown,
  control: SynthControl,
  handlers: DeckHostHandlers,
  post: (res: DeckResponse) => void,
): void {
  const req = parseDeckRequest(msg);
  if (req === null) return;

  if (req.kind === 'deck:requestState') {
    post({ kind: 'deck:state', state: snapshot(control, handlers) });
    return;
  }

  if (req.kind === 'deck:command') {
    let ok: boolean;
    let issues: string[];
    if (req.command.kind === 'timeline:lock') {
      // 0 は nowSec+0 = nowSec で即解除（lock 判定は nowSec < lockedUntilSec）。
      const sec = control.getState().nowSec + req.command.seconds;
      const applied = control.applyTimelineOp({ op: 'setLockedUntil', sec });
      ok = applied.ok;
      issues = applied.ok ? [] : [applied.issue ?? 'setLockedUntil failed'];
    } else {
      const result = handlers.runCommand(req.command);
      ok = result.ok;
      issues = result.issues;
    }
    post({ kind: 'deck:commandResult', id: req.id, ok, issues });
    post({ kind: 'deck:state', state: snapshot(control, handlers) });
    return;
  }

  const parsed = parsePatch(req.patch);
  if (!parsed.ok) {
    post({ kind: 'deck:result', ok: false, label: req.label, issues: parsed.issues });
    return;
  }

  const gated = gatePatchProposal(
    parsed.patch,
    metaCatalog,
    DEFAULT_BUDGETS[parsed.patch.qualityTier],
  );
  if (!gated.ok || gated.patch === undefined) {
    post({
      kind: 'deck:result',
      ok: false,
      label: req.label,
      issues: gated.issues.map((issue) => issue.message),
    });
    return;
  }

  const state = control.getState();
  if (state.nowSec < state.timeline.lockedUntilSec) {
    post({
      kind: 'deck:result',
      ok: false,
      label: req.label,
      issues: [formatLockedRemain(state.nowSec, state.timeline.lockedUntilSec)],
    });
    return;
  }

  const fired = new Set(state.firedIds);
  for (const event of state.timeline.events) {
    if (!event.id.startsWith('deck-') || !fired.has(event.id)) continue;
    try {
      control.applyTimelineOp({ op: 'remove', id: event.id });
    } catch {
      // protection で拒否されても掃除はベストエフォート。
    }
  }

  eventCounter += 1;
  const id = `deck-${Math.round(state.nowSec * 1000).toString(36)}-${eventCounter}`;
  const added = control.applyTimelineOp({
    op: 'add',
    event: {
      id,
      start: { kind: 'seconds', atSec: state.nowSec },
      duration: { kind: 'untilNext' },
      intent: { label: req.label, patch: gated.patch },
      transition: TRANSITION_PRESETS[req.preset],
      confidence: 1,
      locked: false,
    },
  });
  if (!added.ok) {
    post({
      kind: 'deck:result',
      ok: false,
      label: req.label,
      issues: [added.issue ?? 'applyTimelineOp failed'],
    });
    return;
  }

  lastTriggerLabel = req.label;
  post({ kind: 'deck:state', state: snapshot(control, handlers) });
}

function labelOf(msg: unknown): string {
  if (typeof msg !== 'object' || msg === null) return '';
  const label = (msg as { label?: unknown }).label;
  return typeof label === 'string' ? label : '';
}

function commandIdOf(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const rec = msg as { kind?: unknown; id?: unknown };
  if (rec.kind !== 'deck:command' || typeof rec.id !== 'string') return null;
  return rec.id;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function initDeckHost(handlers: DeckHostHandlers): { close(): void } | null {
  if (typeof BroadcastChannel !== 'function') return null;

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(DECK_CHANNEL);
  } catch {
    return null;
  }

  const control = getSynthControl();
  let disposed = false;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  const post = (res: DeckResponse): void => {
    if (disposed) return;
    channel.postMessage(res);
  };

  const postState = (): void => {
    post({ kind: 'deck:state', state: snapshot(control, handlers) });
  };

  channel.onmessage = (ev: MessageEvent): void => {
    if (disposed) return;
    try {
      handleDeckRequest(ev.data, control, handlers, post);
    } catch (err) {
      // 想定外の throw でもデッキ窓を「待ち」のまま放置しない。
      const commandId = commandIdOf(ev.data);
      if (commandId !== null) {
        post({
          kind: 'deck:commandResult',
          id: commandId,
          ok: false,
          issues: [errorMessage(err)],
        });
        return;
      }
      const label = labelOf(ev.data);
      post({ kind: 'deck:result', ok: false, label, issues: [errorMessage(err)] });
    }
  };

  const unsub = control.subscribe(() => {
    if (disposed) return;
    if (throttleTimer !== null) clearTimeout(throttleTimer);
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      if (!disposed) postState();
    }, STATE_THROTTLE_MS);
  });

  return {
    close(): void {
      disposed = true;
      unsub();
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      channel.close();
    },
  };
}
