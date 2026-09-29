/**
 * Pro DJ Link beat client (browser side).
 *
 * scripts/prolink-bridge.mjs が CDJ/DJM のビートパケット（UDP 50001）を受けて
 * WebSocket（127.0.0.1）に流す beat JSON を受け取り、TempoTracker に渡す。
 * 片道受信専用で、こちらからは何も送らない。
 *
 * 設計方針は src/synth/bridgeClient.ts と同じ:
 * - URL に `?link=1|<port>` があるときだけ接続する。無ければ WebSocket を
 *   1 本も張らない（副作用ゼロ）。
 * - URL 解析（parseLinkPort / resolveLinkUrl）とメッセージ処理
 *   （parseLinkMessage）は純粋関数に切り出し、ソケットの生死管理だけを
 *   initLinkClient に残す。
 * - 切断時は 3 秒で再接続する。
 *
 * 時刻はブリッジから受け取らない。Node とブラウザの時計は揃っていない前提で、
 * 受信時刻（performance.now()）を拍の時刻とする（AudioEngine.externalBeat）。
 */

/**
 * `?link=1` のときに使う既定ポート。scripts/prolink-packet.mjs の
 * DEFAULT_LINK_WS_PORT と揃えること（scripts/constants-drift.test.mjs が検査する）。
 */
export const DEFAULT_LINK_PORT = 7878;

/** 切断後の再接続間隔。bridgeClient と同じ。 */
const RECONNECT_DELAY_MS = 3000;

/** ブリッジから届く beat 1 件（ブラウザが使うフィールドだけ）。 */
export interface LinkBeat {
  /** effective BPM（track BPM × pitch 反映済み）。 */
  bpm: number;
  /** 小節内の拍（1..4）。不明なら null。 */
  beatInBar: number | null;
  /** 送ってきたデバイス番号。 */
  device: number;
  /** デバイス名（例 "CDJ-3000"）。 */
  name: string;
}

export interface LinkClientHandle {
  close(): void;
}

/**
 * URL の query から接続先ポートを決める。接続しないなら null。
 *
 * `link=1` / `link=true` / `link`（値なし）→ 既定ポート、`link=<2..65535>` →
 * そのポート、それ以外は接続しない（bridgeClient.parseBridgePort と同じ作法）。
 */
export function parseLinkPort(search: string): number | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('link');
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (raw === '' || raw === '1' || raw === 'true') return DEFAULT_LINK_PORT;
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 2 && port <= 65535 ? port : null;
}

/**
 * 接続先の WebSocket URL。繋がないなら null。
 * 127.0.0.1 固定（localhost が ::1 に解決される環境を避ける。ループバックは
 * https ページからでも mixed content にならない — bridgeClient と同じ理由）。
 */
export function resolveLinkUrl(search: string): string | null {
  const port = parseLinkPort(search);
  return port === null ? null : `ws://127.0.0.1:${port}`;
}

/**
 * 受信フレーム 1 件を beat として読む。beat でなければ null。
 *
 * 壊れた JSON・type 違い・BPM が正の有限数でないものは捨てる。beatInBar は
 * 1..4 の整数以外なら null（位相だけ合わせ、小節は合わせない）。
 */
export function parseLinkMessage(raw: string): LinkBeat | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (m.type !== 'beat') return null;
  const bpm = m.bpm;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return null;
  const bb = m.beatInBar;
  const beatInBar =
    typeof bb === 'number' && Number.isInteger(bb) && bb >= 1 && bb <= 4 ? bb : null;
  return {
    bpm,
    beatInBar,
    device: typeof m.device === 'number' ? m.device : 0,
    name: typeof m.name === 'string' ? m.name : '',
  };
}

/**
 * URL に `link` パラメータがあるときだけ prolink-bridge へ接続し、beat を
 * `onBeat` に渡す。無効・未指定なら何もせず null。
 */
export function initLinkClient(onBeat: (beat: LinkBeat) => void): LinkClientHandle | null {
  const loc = globalThis.location as Location | undefined;
  const resolved = resolveLinkUrl(loc?.search ?? '');
  if (resolved === null) return null;
  const url: string = resolved;

  const SocketCtor = globalThis.WebSocket;
  if (typeof SocketCtor !== 'function') return null;

  let disposed = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // 切断ログは状態が変わったときだけ出す（3 秒ごとの再試行でコンソールを埋めない）。
  let downLogged = false;

  const scheduleReconnect = (): void => {
    if (disposed || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  };

  const handleDown = (ws: WebSocket): void => {
    if (socket !== ws) return;
    socket = null;
    if (!downLogged) {
      console.info(`[prolink] disconnected from ${url}; retrying every 3s`);
      downLogged = true;
    }
    scheduleReconnect();
  };

  function connect(): void {
    if (disposed) return;
    let ws: WebSocket;
    try {
      ws = new SocketCtor(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = (): void => {
      downLogged = false;
      console.info(`[prolink] connected to ${url}`);
    };
    ws.onmessage = (ev: MessageEvent): void => {
      if (typeof ev.data !== 'string') return;
      const beat = parseLinkMessage(ev.data);
      if (beat !== null) onBeat(beat);
    };
    ws.onclose = (): void => handleDown(ws);
    ws.onerror = (): void => handleDown(ws);
  }

  connect();

  return {
    close(): void {
      disposed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const ws = socket;
      socket = null;
      ws?.close();
    },
  };
}
