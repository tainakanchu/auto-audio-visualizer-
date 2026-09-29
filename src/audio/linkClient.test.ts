// linkClient の URL ゲートとメッセージ処理（純粋部分）と、ソケット生死管理を
// FakeWebSocket で検証する。実ネットワークには出ない（bridgeClient.test.ts と同じ方針）。
// prolink-bridge との実結合は `pnpm prolink` + `pnpm prolink:sim` の手動検証で担保する。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LINK_PORT,
  initLinkClient,
  parseLinkMessage,
  parseLinkPort,
  resolveLinkUrl,
} from './linkClient';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls += 1;
  }
}

function stubEnv(search: string): void {
  vi.stubGlobal('location', { search });
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('parseLinkPort / resolveLinkUrl', () => {
  it('returns null without a link param (no side effects by default)', () => {
    expect(parseLinkPort('')).toBeNull();
    expect(parseLinkPort('?bridge=1')).toBeNull();
    expect(resolveLinkUrl('?scene=bars')).toBeNull();
  });

  it('uses the default port for link=1 / true / bare', () => {
    expect(DEFAULT_LINK_PORT).toBe(7878);
    expect(parseLinkPort('?link=1')).toBe(7878);
    expect(parseLinkPort('?link=true')).toBe(7878);
    expect(parseLinkPort('?link')).toBe(7878);
    expect(resolveLinkUrl('?bridge=1&link=1')).toBe('ws://127.0.0.1:7878');
  });

  it('accepts an explicit port and rejects junk', () => {
    expect(parseLinkPort('?link=9000')).toBe(9000);
    expect(resolveLinkUrl('?link=9000')).toBe('ws://127.0.0.1:9000');
    expect(parseLinkPort('?link=0')).toBeNull();
    expect(parseLinkPort('?link=70000')).toBeNull();
    expect(parseLinkPort('?link=80abc')).toBeNull();
    expect(parseLinkPort('?link=yes')).toBeNull();
  });
});

describe('parseLinkMessage', () => {
  const frame = {
    type: 'beat',
    bpm: 130.56,
    trackBpm: 128,
    pitch: 2,
    beatInBar: 3,
    nextBeatMs: 460,
    device: 2,
    name: 'CDJ-3000',
  };

  it('reads a bridge beat frame', () => {
    expect(parseLinkMessage(JSON.stringify(frame))).toEqual({
      bpm: 130.56,
      beatInBar: 3,
      device: 2,
      name: 'CDJ-3000',
    });
  });

  it('drops broken JSON, other types and bad BPMs', () => {
    expect(parseLinkMessage('{nope')).toBeNull();
    expect(parseLinkMessage('null')).toBeNull();
    expect(parseLinkMessage(JSON.stringify({ ...frame, type: 'status' }))).toBeNull();
    expect(parseLinkMessage(JSON.stringify({ ...frame, bpm: 0 }))).toBeNull();
    expect(parseLinkMessage(JSON.stringify({ ...frame, bpm: '128' }))).toBeNull();
    expect(parseLinkMessage(JSON.stringify({ ...frame, bpm: null }))).toBeNull();
  });

  it('maps an invalid beatInBar to null but keeps the beat', () => {
    expect(parseLinkMessage(JSON.stringify({ ...frame, beatInBar: null }))!.beatInBar).toBeNull();
    expect(parseLinkMessage(JSON.stringify({ ...frame, beatInBar: 5 }))!.beatInBar).toBeNull();
    expect(parseLinkMessage(JSON.stringify({ ...frame, beatInBar: 1.5 }))!.beatInBar).toBeNull();
  });
});

describe('initLinkClient', () => {
  it('opens no socket without ?link', () => {
    stubEnv('?scene=bars');
    expect(initLinkClient(() => {})).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('connects, forwards beats, and sends nothing', () => {
    stubEnv('?link=1');
    const onBeat = vi.fn();
    const handle = initLinkClient(onBeat);
    expect(handle).not.toBeNull();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('ws://127.0.0.1:7878');
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: 'beat', bpm: 128, beatInBar: 1 }) });
    ws.onmessage?.({ data: 'garbage' });
    ws.onmessage?.({ data: new ArrayBuffer(4) });
    expect(onBeat).toHaveBeenCalledTimes(1);
    expect(onBeat.mock.calls[0]![0]).toMatchObject({ bpm: 128, beatInBar: 1 });
    expect(ws.sent).toEqual([]);
    handle!.close();
    expect(ws.closeCalls).toBe(1);
  });

  it('reconnects 3 s after a disconnect, once, and stops after close()', () => {
    vi.useFakeTimers();
    stubEnv('?link=9001');
    const handle = initLinkClient(() => {})!;
    const ws = FakeWebSocket.instances[0]!;
    ws.onerror?.();
    ws.onclose?.();
    vi.advanceTimersByTime(2999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://127.0.0.1:9001');
    handle.close();
    FakeWebSocket.instances[1]!.onclose?.();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
