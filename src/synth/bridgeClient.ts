import { getSynthControl } from './control';
import { inlineCatalog } from './generators';
import type { TimelineOp } from './timeline';

/**
 * Control Bridge (browser side).
 *
 * External Control Interface（control.ts）は transport-agnostic に作ってある。
 * このモジュールはその上に載る最初の「外から来る」トランスポートで、中継サーバ
 * （scripts/vj-bridge.mjs）経由で CLI から control を叩けるようにする。
 *
 * 接続先は 2 通りある。どちらも中継のプロトコルは同一で、違うのは URL だけ:
 * - `?bridge=1|<port>` … ローカルの中継（scripts/vj-bridge.mjs）
 * - `?room=<id>`       … 同一オリジンの Cloudflare Worker のリレー（worker/relay.ts）
 *
 * 設計方針:
 * - 本番の VJ 中に事故らないよう、URL に `bridge` か `room` があるときだけ有効。
 *   何も指定しなければ WebSocket を1本も張らない（副作用ゼロ）。
 * - プロトコルの純粋な部分（URL ゲートとメッセージのルーティング）を
 *   resolveBridgeUrl / handleBridgeMessage に切り出し、ソケットの生死管理だけを
 *   initBridgeClient に残す。こうするとテストが実ネットワーク無しで書ける。
 */

/** `?bridge=1` のときに使う既定ポート。scripts/vj-bridge.mjs の既定と揃えること。 */
const DEFAULT_BRIDGE_PORT = 7877;

/**
 * room id として通す形。worker/index.ts の ROOM_PATH と揃えること。
 * ずれると「ブラウザは繋ぎにいくが Worker が 400 を返す」という分かりにくい形で壊れる。
 */
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** 切断後の再接続間隔。ライブ中に手で貼り直さずに済む程度の短さ。 */
const RECONNECT_DELAY_MS = 3000;

export interface BridgeClientHandle {
  close(): void;
}

/**
 * URL の query から Bridge の接続先ポートを決める。接続しないなら null。
 *
 * `bridge=1` / `bridge=true` / `bridge`（値なし）→ 既定ポート、
 * `bridge=<2..65535>` → そのポート、それ以外は「無効な指定」として接続しない。
 * タイプミスで意図しないポートへ繋ぎにいくより、繋がない方が安全。
 */
export function parseBridgePort(search: string): number | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('bridge');
  } catch {
    return null;
  }
  if (raw === null) return null;
  // 値なし（`?bridge`）は URLSearchParams だと空文字になる。
  if (raw === '' || raw === '1' || raw === 'true') return DEFAULT_BRIDGE_PORT;
  // parseInt だと '80abc' が 80 になってしまうので、数字だけの文字列に限定する。
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 2 && port <= 65535 ? port : null;
}

/**
 * URL の query から room id を取り出す。使わない（= リレーに繋がない）なら null。
 *
 * 形が違うものを弾いて null に倒すのは port と同じ理由。打ち間違えた id で
 * 別の room に入り込むより、繋がずに `no synth connected` を出す方が安全。
 */
export function parseRoomId(search: string): string | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('room');
  } catch {
    return null;
  }
  if (raw === null) return null;
  return ROOM_ID_PATTERN.test(raw) ? raw : null;
}

/**
 * 接続先の WebSocket URL を決める。繋がないなら null。
 *
 * `room` を `bridge` より優先するのは、両方付いた URL は「リレー用の URL を
 * 開いたが、ローカル開発の名残で bridge も残っている」形がほとんどで、
 * ユーザーが意図しているのは後から足した room の方だから。
 *
 * location を丸ごと受け取らずに host / protocol を個別に取るのは、テストから
 * 呼びやすくするため（location のモックを組み立てなくてよい）。
 */
export function resolveBridgeUrl(search: string, host: string, protocol: string): string | null {
  const room = parseRoomId(search);
  if (room !== null) {
    // host が空なのは location が無い環境。繋ぎ先を組み立てられないので諦める。
    if (host === '') return null;
    // アプリと同一オリジンなので、ページが https なら wss で揃える（揃えないと
    // mixed content でブラウザに落とされる）。
    return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/room/${room}`;
  }

  const port = parseBridgePort(search);
  if (port === null) return null;
  // アプリは vite の basicSsl により https で配信されるが、ws://127.0.0.1 は
  // mixed content としてブロックされない: ループバックは仕様上
  // "potentially trustworthy origin" と定義されているため。
  // ホスト名に localhost ではなく 127.0.0.1 を使うのは、環境によって localhost が
  // ::1 に解決され、IPv4 で listen している中継サーバに繋がらないのを避けるため。
  return `ws://127.0.0.1:${port}`;
}

/**
 * URL の query から表示専用（mirror）モードかどうかを決める。
 *
 * `mirror=1` / `mirror=true` だけを true にする。`?mirror`（値なし）や不正値は
 * false。autocycle と同じ作法。mirror は URL 専用・非永続で、bridge / room と
 * 併用して「同じ中継に表示専用として接続する」用途に使う。
 */
export function parseMirrorMode(search: string): boolean {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('mirror');
  } catch {
    return false;
  }
  if (raw === null) return false;
  return raw === '1' || raw === 'true';
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

type DispatchResult = { ok: true; result: unknown } | { ok: false; error: string };

function ok(result: unknown): DispatchResult {
  return { ok: true, result };
}

function fail(error: string): DispatchResult {
  return { ok: false, error };
}

/**
 * method 名 → control 呼び出し。
 *
 * getSynthControl() をここで呼ぶ（モジュールトップで束縛しない）のは、facade が
 * シーン切り替えを跨いで有効とはいえ、テストから差し替えられる形にしておきたい
 * ためと、将来 facade が差し替え可能になったときに追随させるため。
 */
function dispatch(
  method: string,
  params: Record<string, unknown> | undefined,
): DispatchResult | Promise<DispatchResult> {
  const control = getSynthControl();
  switch (method) {
    case 'getState':
      return ok(control.getState());

    case 'getCatalog':
      // def だけを返す。emit は GLSL を組み立てるクロージャで JSON 化できないし、
      // CLI 側が欲しいのは parameters / cost などのメタデータだけ。
      return ok(inlineCatalog.all().map((g) => g.def));

    case 'proposePatch':
      if (params === undefined || !('patch' in params)) {
        return fail('proposePatch requires params.patch');
      }
      // patch の中身は proposePatch（gatePatchProposal）が検証して issues を返す。
      return ok(control.proposePatch(params.patch));

    case 'proposeSeed': {
      const seed = params?.seed;
      if (typeof seed !== 'string') return fail('proposeSeed requires params.seed as string');
      control.proposeSeed(seed);
      return ok({ ok: true });
    }

    case 'setBlendMode': {
      const mode = params?.mode;
      if (typeof mode !== 'string') return fail('setBlendMode requires params.mode as string');
      // 不正値は control 側が normal に倒して warning を返す（常に ok）。
      return ok(control.setBlendMode(mode));
    }

    case 'setImage': {
      const name = params?.name;
      const bytes = params?.bytesBase64;
      const mime = params?.mime;
      if (typeof name !== 'string') return fail('setImage requires params.name as string');
      if (typeof bytes !== 'string') return fail('setImage requires params.bytesBase64 as string');
      // ハッシュ計算と decode は非同期なので、ここだけ Promise を返す。
      // 応答は handleBridgeMessage が解決してから送る。
      return control
        .setImage(name, bytes, typeof mime === 'string' ? mime : '')
        .then((result) => ok(result));
    }

    case 'applyTimelineOp': {
      const op = params?.op;
      if (typeof op !== 'object' || op === null) {
        return fail('applyTimelineOp requires params.op as object');
      }
      // op の妥当性は applyTimelineOp 側が判定して issue を返すので、
      // ここでは「オブジェクトであること」しか見ない。
      return ok(control.applyTimelineOp(op as TimelineOp));
    }

    case 'fireExternal': {
      const id = params?.id;
      if (typeof id !== 'string') return fail('fireExternal requires params.id as string');
      control.fireExternal(id);
      return ok({ ok: true });
    }

    case 'startRecording':
      control.startRecording();
      return ok({ ok: true });

    case 'stopRecording': {
      // 未開始なら null が返る。CLI 側が分岐しやすいよう ok も添える。
      const json = control.stopRecording();
      return ok({ ok: json !== null, json });
    }

    case 'loadRecording': {
      const json = params?.json;
      if (typeof json !== 'string') return fail('loadRecording requires params.json as string');
      return ok(control.loadRecording(json));
    }

    default:
      return fail(`unknown method: ${method}`);
  }
}

/**
 * 受信フレーム1件を処理して、返すべきレスポンスフレームを返す（返さない場合は null）。
 *
 * 同期で答えられる method は同期のまま返す（既存の呼び出し側とテストを変えない）。
 * setImage のように待ちがある method だけ Promise を返すので、送信側は
 * Promise.resolve() で受けること。
 *
 * `options.role`:
 * - `'synth'`（既定）… 現行どおり id 必須・応答を返す。
 * - `'mirror'` … method があれば id 無しでも dispatch し、**常に null** を返す
 *   （片道受信専用。中継は mirror に id 無しフレームを配る）。Promise の method
 *   も解決後に null に倒すので、呼び出し側は送らない。
 */
export function handleBridgeMessage(
  raw: string,
  options?: { role?: 'synth' | 'mirror' },
): object | null | Promise<object | null> {
  const role = options?.role ?? 'synth';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 壊れたフレームは黙って捨てる。id が読めない以上、返す相手を特定できない。
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof frame.method !== 'string') return null;

  // synth は応答の正本なので id が要る。mirror は片道なので id 無しでも実行する。
  if (role === 'synth' && typeof frame.id !== 'number') return null;

  const rawParams = frame.params;
  const params =
    typeof rawParams === 'object' && rawParams !== null && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : undefined;

  if (role === 'mirror') {
    // 表示専用: 実行するだけで応答は返さない。例外も接続を落とさないために飲む。
    try {
      const out = dispatch(frame.method, params);
      if (out instanceof Promise) {
        return out.then(
          () => null,
          () => null,
        );
      }
    } catch {
      // swallow — mirror はエラーを返す先も持たない。
    }
    return null;
  }

  const id = frame.id as number;
  const toFrame = (out: DispatchResult): object =>
    out.ok ? { id, result: out.result } : { id, error: out.error };

  try {
    const out = dispatch(frame.method, params);
    if (out instanceof Promise) {
      // 非同期 method でも、拒否で接続を落とさないのは同期と同じ扱い。
      return out.then(toFrame, (e: unknown) => ({ id, error: String(e) }));
    }
    return toFrame(out);
  } catch (e) {
    // ハンドラの例外で WebSocket を落とさない。シーン側の失敗はあくまで
    // 「そのリクエストの失敗」として返し、接続は生かしたままにする。
    return { id, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Socket lifecycle
// ---------------------------------------------------------------------------

/**
 * URL に `room` か `bridge` パラメータがあるときだけ中継へ接続する。
 * 無効・未指定なら何もせず null を返す。
 */
export function initBridgeClient(): BridgeClientHandle | null {
  // location が無い環境（Node のテストなど）でも落ちないように読む。
  const loc = globalThis.location as Location | undefined;
  const search = loc?.search ?? '';
  const resolved = resolveBridgeUrl(search, loc?.host ?? '', loc?.protocol ?? '');
  if (resolved === null) return null;
  // 下のクロージャから読むので、null を落とした形で束ね直す（クロージャ越しには
  // 絞り込みが効かない）。
  const url: string = resolved;
  // mirror は URL 専用・非永続。bridge / room と併用して表示専用接続になる。
  const isMirror = parseMirrorMode(search);
  const bridgeRole: 'synth' | 'mirror' = isMirror ? 'mirror' : 'synth';

  const SocketCtor = globalThis.WebSocket;
  if (typeof SocketCtor !== 'function') return null;

  let disposed = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // 切断ログは状態が変わったときだけ出す。3秒ごとの再試行でコンソールを
  // 埋めると、肝心の描画側の警告が見えなくなる。
  let downLogged = false;

  const scheduleReconnect = (): void => {
    // タイマは常に1本。onerror と onclose が両方来ても二重には張らない。
    if (disposed || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  };

  /** 現行ソケットが落ちたときの後始末。同じソケットに対して冪等。 */
  const handleDown = (ws: WebSocket): void => {
    if (socket !== ws) return;
    socket = null;
    if (!downLogged) {
      console.info(`[vj-bridge] disconnected from ${url}; retrying every 3s`);
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
      // コンストラクタが投げるのは URL 不正くらいだが、投げても諦めずに retry する。
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = (): void => {
      downLogged = false;
      console.info(`[vj-bridge] connected to ${url}`);
      // 中継サーバはロール別にソケットを仕分けるので、まず名乗る。
      // mirror は表示専用で応答を返さない（中継は id 無しフレームを配る）。
      ws.send(JSON.stringify({ hello: bridgeRole }));
    };

    ws.onmessage = (ev: MessageEvent): void => {
      if (typeof ev.data !== 'string') return;
      const response = handleBridgeMessage(ev.data, { role: bridgeRole });
      if (response === null) return;
      if (response instanceof Promise) {
        void response.then((resolved) => {
          // 待っている間に切れていることがあるので、送る前に現行ソケットか確かめる。
          // mirror は常に null を返すのでここには来ないが、同じ経路で安全に扱う。
          if (resolved !== null && socket === ws) ws.send(JSON.stringify(resolved));
        });
        return;
      }
      ws.send(JSON.stringify(response));
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
