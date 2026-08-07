// Node の ws サーバを立てた結合テストは、ポート競合とタイミング依存で CI に
// 不安定さを持ち込むため書かない。ここではプロトコルの純粋な部分（URL ゲートと
// メッセージのルーティング）だけを、WebSocket と control をモックして検証する。
// サーバとの実結合は scripts/vj-bridge.mjs を使った手動の統合検証で担保する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleBridgeMessage,
  initBridgeClient,
  parseBridgePort,
  parseRoomId,
  resolveBridgeUrl,
} from './bridgeClient';
import type { GeneratorDefinition } from './types';

// vi.mock はホイストされるので、モックの実体も vi.hoisted で先に用意する。
const control = vi.hoisted(() => ({
  getState: vi.fn(),
  proposePatch: vi.fn(),
  proposeSeed: vi.fn(),
  applyTimelineOp: vi.fn(),
  fireExternal: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  loadRecording: vi.fn(),
  setBlendMode: vi.fn(),
}));

vi.mock('./control', () => ({
  getSynthControl: () => control,
}));

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

/**
 * Node 24 には組み込みの globalThis.WebSocket があるので、必ずこれで上書きしてから
 * initBridgeClient() を呼ぶこと。上書きし忘れるとテストが実ネットワークに出る。
 */
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

function stubEnv(search: string, host?: string, protocol?: string): void {
  // host / protocol は `?room=` の経路だけが読む。既定で省くことで、
  // ローカル bridge の経路が location の形に依存していないことも一緒に確かめる。
  vi.stubGlobal('location', { search, host, protocol });
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  // mockReturnValue / mockImplementation はテストを跨いで残るので毎回落とす。
  for (const fn of Object.values(control)) fn.mockReset();
  // ログで出力を汚さない（接続/切断で1行ずつ出る）。
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseBridgePort
// ---------------------------------------------------------------------------

describe('parseBridgePort', () => {
  it('returns null when the parameter is absent', () => {
    expect(parseBridgePort('')).toBeNull();
    expect(parseBridgePort('?scene=bars&ui=hide')).toBeNull();
  });

  it('maps the enable forms to the default port', () => {
    expect(parseBridgePort('?bridge=1')).toBe(7877);
    expect(parseBridgePort('?bridge=true')).toBe(7877);
    expect(parseBridgePort('?bridge')).toBe(7877);
    expect(parseBridgePort('?scene=bars&bridge=1')).toBe(7877);
  });

  it('accepts an explicit port', () => {
    expect(parseBridgePort('?bridge=7900')).toBe(7900);
    expect(parseBridgePort('?bridge=65535')).toBe(65535);
  });

  it('refuses malformed values rather than guessing a port', () => {
    expect(parseBridgePort('?bridge=abc')).toBeNull();
    expect(parseBridgePort('?bridge=79zz')).toBeNull();
    expect(parseBridgePort('?bridge=0')).toBeNull();
    expect(parseBridgePort('?bridge=70000')).toBeNull();
    expect(parseBridgePort('?bridge=-1')).toBeNull();
    expect(parseBridgePort('?bridge=78.5')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseRoomId / resolveBridgeUrl
// ---------------------------------------------------------------------------

describe('parseRoomId', () => {
  it('returns null when the parameter is absent', () => {
    expect(parseRoomId('')).toBeNull();
    expect(parseRoomId('?scene=semantic-synth&bridge=1')).toBeNull();
  });

  it('accepts base64url ids in the accepted length range', () => {
    // scripts/vj-ctl.mjs の `room` が吐く形（randomBytes(16) の base64url、22 文字）。
    expect(parseRoomId('?room=Zm9vYmFyYmF6cXV1eDE')).toBe('Zm9vYmFyYmF6cXV1eDE');
    expect(parseRoomId('?room=abcd1234')).toBe('abcd1234');
    expect(parseRoomId('?room=a-b_c-d_')).toBe('a-b_c-d_');
    expect(parseRoomId(`?room=${'x'.repeat(64)}`)).toBe('x'.repeat(64));
  });

  it('refuses ids the worker would reject rather than connecting anyway', () => {
    expect(parseRoomId('?room=')).toBeNull();
    expect(parseRoomId('?room=short')).toBeNull(); // 8 文字未満
    expect(parseRoomId(`?room=${'x'.repeat(65)}`)).toBeNull();
    expect(parseRoomId('?room=has.dot.here')).toBeNull();
    expect(parseRoomId('?room=has/slash/x')).toBeNull();
  });
});

describe('resolveBridgeUrl', () => {
  it('returns null when neither parameter is present', () => {
    expect(resolveBridgeUrl('?scene=bars', 'example.com', 'https:')).toBeNull();
  });

  it('builds a same-origin relay URL, matching the page scheme', () => {
    expect(resolveBridgeUrl('?room=abcd1234', 'vj.example.com', 'https:')).toBe(
      'wss://vj.example.com/room/abcd1234',
    );
    expect(resolveBridgeUrl('?room=abcd1234', '127.0.0.1:8787', 'http:')).toBe(
      'ws://127.0.0.1:8787/room/abcd1234',
    );
  });

  it('falls back to the local bridge when only bridge is given', () => {
    expect(resolveBridgeUrl('?bridge=1', 'vj.example.com', 'https:')).toBe('ws://127.0.0.1:7877');
    expect(resolveBridgeUrl('?bridge=7900', '', '')).toBe('ws://127.0.0.1:7900');
  });

  it('prefers room over bridge when both are present', () => {
    expect(resolveBridgeUrl('?bridge=1&room=abcd1234', 'vj.example.com', 'https:')).toBe(
      'wss://vj.example.com/room/abcd1234',
    );
  });

  it('gives up on a room without a host instead of building a broken URL', () => {
    expect(resolveBridgeUrl('?room=abcd1234', '', 'https:')).toBeNull();
  });

  it('falls back to the local bridge when the room id is malformed', () => {
    expect(resolveBridgeUrl('?bridge=1&room=nope', 'vj.example.com', 'https:')).toBe(
      'ws://127.0.0.1:7877',
    );
  });
});

// ---------------------------------------------------------------------------
// initBridgeClient
// ---------------------------------------------------------------------------

describe('initBridgeClient', () => {
  it('does not construct a WebSocket without the URL parameter', () => {
    stubEnv('?scene=bars');
    expect(initBridgeClient()).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('does not construct a WebSocket for a malformed value', () => {
    stubEnv('?bridge=abc');
    expect(initBridgeClient()).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('survives a missing location (non-browser environment)', () => {
    vi.stubGlobal('location', undefined);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    expect(initBridgeClient()).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('connects to the loopback address and announces the synth role', () => {
    stubEnv('?bridge=1');
    const handle = initBridgeClient();
    expect(handle).not.toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('ws://127.0.0.1:7877');
    expect(ws.sent).toEqual([]);

    ws.onopen?.();
    expect(ws.sent).toEqual(['{"hello":"synth"}']);

    handle?.close();
    expect(ws.closeCalls).toBe(1);
  });

  it('uses the explicit port', () => {
    stubEnv('?bridge=7900');
    const handle = initBridgeClient();
    expect(FakeWebSocket.instances[0].url).toBe('ws://127.0.0.1:7900');
    handle?.close();
  });

  it('connects to the same-origin relay and announces the synth role', () => {
    stubEnv('?scene=semantic-synth&room=abcd1234', 'vj.example.com', 'https:');
    const handle = initBridgeClient();
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://vj.example.com/room/abcd1234');

    ws.onopen?.();
    // 名乗り方はローカル bridge と同一。中継の実装が変わっても hello は変えない。
    expect(ws.sent).toEqual(['{"hello":"synth"}']);

    handle?.close();
  });

  it('does not construct a WebSocket for a malformed room id', () => {
    stubEnv('?room=nope', 'vj.example.com', 'https:');
    expect(initBridgeClient()).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('answers a request frame over the socket', () => {
    stubEnv('?bridge=1');
    control.getState.mockReturnValue({ qualityScale: 1 });
    const handle = initBridgeClient();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();

    ws.onmessage?.({ data: '{"id":1,"method":"getState"}' });
    expect(ws.sent[1]).toBe('{"id":1,"result":{"qualityScale":1}}');

    handle?.close();
  });

  it('reconnects on close, with a single timer even if onerror also fires', () => {
    vi.useFakeTimers();
    try {
      stubEnv('?bridge=1');
      const handle = initBridgeClient();
      const ws = FakeWebSocket.instances[0];
      ws.onopen?.();

      ws.onerror?.();
      ws.onclose?.();
      vi.advanceTimersByTime(3000);
      expect(FakeWebSocket.instances).toHaveLength(2);

      // close() 後は再接続しない。
      handle?.close();
      FakeWebSocket.instances[1].onclose?.();
      vi.advanceTimersByTime(10_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// handleBridgeMessage — routing
// ---------------------------------------------------------------------------

describe('handleBridgeMessage', () => {
  it('routes getState', () => {
    const state = { qualityScale: 0.5, recordingActive: false };
    control.getState.mockReturnValue(state);
    expect(handleBridgeMessage('{"id":7,"method":"getState"}')).toEqual({ id: 7, result: state });
    expect(control.getState).toHaveBeenCalledTimes(1);
  });

  it('routes proposePatch with the raw patch', () => {
    control.proposePatch.mockReturnValue({ ok: false, issues: ['bad'] });
    const res = handleBridgeMessage('{"id":1,"method":"proposePatch","params":{"patch":{"a":1}}}');
    expect(control.proposePatch).toHaveBeenCalledWith({ a: 1 });
    expect(res).toEqual({ id: 1, result: { ok: false, issues: ['bad'] } });
  });

  it('routes proposeSeed', () => {
    const res = handleBridgeMessage('{"id":2,"method":"proposeSeed","params":{"seed":"neon-01"}}');
    expect(control.proposeSeed).toHaveBeenCalledWith('neon-01');
    expect(res).toEqual({ id: 2, result: { ok: true } });
  });

  it('rejects proposeSeed with a non-string seed', () => {
    const res = handleBridgeMessage('{"id":3,"method":"proposeSeed","params":{"seed":42}}');
    expect(control.proposeSeed).not.toHaveBeenCalled();
    expect(res).toEqual({ id: 3, error: 'proposeSeed requires params.seed as string' });
  });

  it('routes setBlendMode', () => {
    control.setBlendMode.mockReturnValue({ ok: true, mode: 'screen' });
    const res = handleBridgeMessage('{"id":20,"method":"setBlendMode","params":{"mode":"screen"}}');
    expect(control.setBlendMode).toHaveBeenCalledWith('screen');
    expect(res).toEqual({ id: 20, result: { ok: true, mode: 'screen' } });
  });

  it('rejects setBlendMode with a non-string mode', () => {
    const res = handleBridgeMessage('{"id":21,"method":"setBlendMode","params":{"mode":1}}');
    expect(control.setBlendMode).not.toHaveBeenCalled();
    expect(res).toEqual({ id: 21, error: 'setBlendMode requires params.mode as string' });
  });

  it('routes applyTimelineOp', () => {
    control.applyTimelineOp.mockReturnValue({ ok: true });
    const op = { op: 'remove', id: 'e1' };
    const res = handleBridgeMessage(
      JSON.stringify({ id: 4, method: 'applyTimelineOp', params: { op } }),
    );
    expect(control.applyTimelineOp).toHaveBeenCalledWith(op);
    expect(res).toEqual({ id: 4, result: { ok: true } });
  });

  it('rejects applyTimelineOp without an op object', () => {
    const res = handleBridgeMessage('{"id":5,"method":"applyTimelineOp","params":{}}');
    expect(control.applyTimelineOp).not.toHaveBeenCalled();
    expect(res).toEqual({ id: 5, error: 'applyTimelineOp requires params.op as object' });
  });

  it('routes fireExternal', () => {
    const res = handleBridgeMessage('{"id":6,"method":"fireExternal","params":{"id":"drop"}}');
    expect(control.fireExternal).toHaveBeenCalledWith('drop');
    expect(res).toEqual({ id: 6, result: { ok: true } });
  });

  it('routes startRecording', () => {
    const res = handleBridgeMessage('{"id":8,"method":"startRecording"}');
    expect(control.startRecording).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ id: 8, result: { ok: true } });
  });

  it('routes stopRecording and reports whether anything was recorded', () => {
    control.stopRecording.mockReturnValue('{"events":[]}');
    expect(handleBridgeMessage('{"id":9,"method":"stopRecording"}')).toEqual({
      id: 9,
      result: { ok: true, json: '{"events":[]}' },
    });

    control.stopRecording.mockReturnValue(null);
    expect(handleBridgeMessage('{"id":10,"method":"stopRecording"}')).toEqual({
      id: 10,
      result: { ok: false, json: null },
    });
  });

  it('routes loadRecording', () => {
    control.loadRecording.mockReturnValue({ ok: true, issues: [] });
    const res = handleBridgeMessage('{"id":11,"method":"loadRecording","params":{"json":"{}"}}');
    expect(control.loadRecording).toHaveBeenCalledWith('{}');
    expect(res).toEqual({ id: 11, result: { ok: true, issues: [] } });
  });

  it('returns generator definitions without the GLSL emit closure', () => {
    const res = handleBridgeMessage('{"id":12,"method":"getCatalog"}') as {
      id: number;
      result: GeneratorDefinition[];
    };
    expect(res.id).toBe(12);
    expect(Array.isArray(res.result)).toBe(true);
    expect(res.result.length).toBeGreaterThan(0);

    for (const def of res.result) {
      expect(Object.hasOwn(def, 'emit')).toBe(false);
      expect(typeof def.id).toBe('string');
      expect(Array.isArray(def.parameters)).toBe(true);
    }
    // JSON にできること（emit のようなクロージャが混ざっていない）。
    expect(() => JSON.stringify(res.result)).not.toThrow();
  });

  it('reports unknown methods', () => {
    expect(handleBridgeMessage('{"id":13,"method":"nope"}')).toEqual({
      id: 13,
      error: 'unknown method: nope',
    });
  });

  it('swallows handler exceptions instead of tearing down the socket', () => {
    control.getState.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(handleBridgeMessage('{"id":14,"method":"getState"}')).toEqual({
      id: 14,
      error: 'Error: boom',
    });
  });

  it('ignores frames it cannot answer', () => {
    expect(handleBridgeMessage('not json')).toBeNull();
    expect(handleBridgeMessage('')).toBeNull();
    expect(handleBridgeMessage('null')).toBeNull();
    expect(handleBridgeMessage('[1,2]')).toBeNull();
    // id / method が無いフレームは返信先が決まらない。
    expect(handleBridgeMessage('{"method":"getState"}')).toBeNull();
    expect(handleBridgeMessage('{"id":"1","method":"getState"}')).toBeNull();
    expect(handleBridgeMessage('{"id":1}')).toBeNull();
  });
});
