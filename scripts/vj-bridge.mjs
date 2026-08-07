#!/usr/bin/env node
/**
 * vj-bridge — CLI（vj-ctl）とブラウザ内の SynthControl をつなぐ WebSocket 中継。
 *
 * ここには VJ のロジックを一切置かない。判断はすべて呼び出し側（CLI / AI
 * Director）とブラウザ側（getSynthControl の実体）が持ち、この中継は
 * 「どの ctl の要求か」を覚えて応答を返すだけの郵便局に徹する。そうしておくと
 * control.ts の surface が増えても、このファイルは触らずに済む。
 *
 * プロトコル（JSON テキストフレーム）:
 *   client → server  {"hello":"synth"} | {"hello":"ctl"} | {"hello":"mirror"}
 *   ctl    → server  {"id":<ctlId>,"method":"<name>","params":<object|undefined>}
 *   server → synth   {"id":<serverId>,"method":...,"params":...}   （応答を期待）
 *   server → mirror  {"method":...,"params":...}                   （片道・id 無し）
 *   synth  → server  {"id":<serverId>,"result":<any>} | {"id":<serverId>,"error":"<message>"}
 *   mirror → server  id 付きなら {"id":...,"error":"mirror is receive-only"}、それ以外は無視
 *   server → ctl     {"id":<ctlId>,"result":...} | {"id":<ctlId>,"error":...}
 *
 * mirror は表示専用。ctl コマンドは synth へ送ると同時に接続中の全 mirror へ
 * id 無しでブロードキャストする。応答の正本は synth 1 台。新しい synth が来ても
 * mirror は切らない。mirror 0 台のときは従来と完全に同一。
 */
import { WebSocket, WebSocketServer } from 'ws';

const DEFAULT_PORT = 7877;

/**
 * synth の応答を待つ上限。ブラウザのタブが背面に回ると requestAnimationFrame が
 * 止まって応答が返らなくなることがあるため、ctl を無限に待たせない保険。
 */
const PENDING_TIMEOUT_MS = 15_000;

/** 依存を増やさないための最小限の手書きパース。見るのは --port だけ。 */
function parsePort(argv) {
  const i = argv.indexOf('--port');
  if (i < 0) return DEFAULT_PORT;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    console.error(`vj-bridge: invalid --port: ${raw}`);
    process.exit(1);
  }
  return n;
}

const port = parsePort(process.argv.slice(2));

// 127.0.0.1 固定。この中継は無認証で getSynthControl() を丸ごと開放するので、
// LAN に晒すと同じネットワークの誰でも本番中の映像を差し替えられてしまう。
const wss = new WebSocketServer({ host: '127.0.0.1', port });

/** 映像を出しているタブは 1 枚だけを正とする（複数あるとどこに届いたか分からない）。 */
let synth = null;

/**
 * 表示専用クライアント。何台いてもよい。応答は返さず、ctl コマンドの
 * 片道ブロードキャストだけを受け取る。synth の差し替え対象にもならない。
 */
const mirrors = new Set();

/**
 * serverId → { socket, ctlId, timer }。ctl の id 空間は接続ごとに独立なので、
 * そのまま synth へ流すと別 ctl の id と衝突する。中継側で採番し直して覚える。
 */
const pending = new Map();
let nextServerId = 1;

function log(line) {
  console.log(`[vj-bridge] ${line}`);
}

function send(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

/** 待っている ctl を全員同じ理由で起こす（synth が落ちたとき用）。 */
function flushPending(message) {
  for (const [serverId, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(serverId);
    send(entry.socket, { id: entry.ctlId, error: message });
  }
}

function handleCtlRequest(socket, msg) {
  if (typeof msg.id !== 'number') return; // 返す先が無いので黙って捨てる
  if (typeof msg.method !== 'string') {
    send(socket, { id: msg.id, error: 'missing method' });
    return;
  }
  if (!synth || synth.readyState !== WebSocket.OPEN) {
    // synth が居ないときは従来どおり。mirror だけ居ても応答の正本が無い。
    send(socket, { id: msg.id, error: 'no synth connected' });
    return;
  }

  const serverId = nextServerId++;
  const timer = setTimeout(() => {
    pending.delete(serverId);
    send(socket, { id: msg.id, error: 'timeout waiting for synth' });
  }, PENDING_TIMEOUT_MS);
  pending.set(serverId, { socket, ctlId: msg.id, timer });
  // params が undefined なら JSON.stringify がキーごと落とす。仕様どおり。
  send(synth, { id: serverId, method: msg.method, params: msg.params });
  // synth が居るときだけ mirror にも同じコマンドを片道で配る（応答は synth だけ）。
  // id を付けないことで mirror 側が「応答を返す」経路に乗らない。
  for (const m of mirrors) {
    send(m, { method: msg.method, params: msg.params });
  }
}

function handleSynthResponse(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return; // timeout 後に遅れて届いた応答
  clearTimeout(entry.timer);
  pending.delete(msg.id);

  if (msg.error !== undefined) {
    send(entry.socket, { id: entry.ctlId, error: String(msg.error) });
    return;
  }
  // undefined のまま stringify すると result キーごと消え、ctl 側からは
  // 「応答が無い」フレームに見えてしまうので null に倒す。
  send(entry.socket, { id: entry.ctlId, result: msg.result === undefined ? null : msg.result });
}

wss.on('connection', (socket) => {
  // hello を受け取るまで role は未確定。
  let role = null;

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // 壊れたフレームで中継ごと落とさない
    }
    if (!msg || typeof msg !== 'object') return;

    if (typeof msg.hello === 'string') {
      if (msg.hello === 'synth') {
        role = 'synth';
        if (synth && synth !== socket) {
          // Vite の HMR やタブの開き直しで古い接続が残ることがある。
          // mirror は表示専用なのでここでは絶対に切らない。
          synth.close(4000, 'replaced by a newer synth');
        }
        synth = socket;
        log('synth connected');
      } else if (msg.hello === 'ctl') {
        role = 'ctl';
        log('ctl connected');
      } else if (msg.hello === 'mirror') {
        role = 'mirror';
        mirrors.add(socket);
        log('mirror connected');
      }
      return;
    }

    if (role === null) {
      if (typeof msg.id === 'number') {
        send(socket, { id: msg.id, error: 'client must send {"hello":"ctl"} first' });
      }
      return;
    }

    if (role === 'synth') {
      handleSynthResponse(msg);
    } else if (role === 'mirror') {
      // 表示専用。コマンドを送ってきても実行も中継もしない。
      // id 付きなら呼び出し側に気付けるよう理由を返し、id 無しは黙って捨てる。
      if (typeof msg.id === 'number') {
        send(socket, { id: msg.id, error: 'mirror is receive-only' });
      }
    } else {
      handleCtlRequest(socket, msg);
    }
  });

  socket.on('close', () => {
    if (role === 'synth') {
      if (synth === socket) synth = null;
      // pending は常に「唯一の synth」宛なので、この socket が落ちた時点で
      // 中身は全部死んでいる（replaced の場合も同じ）。
      flushPending('synth disconnected');
      log('synth disconnected');
    } else if (role === 'ctl') {
      // 応答の行き先が消えただけ。捨てるが synth 側の処理は止めない。
      for (const [serverId, entry] of pending) {
        if (entry.socket !== socket) continue;
        clearTimeout(entry.timer);
        pending.delete(serverId);
      }
      log('ctl disconnected');
    } else if (role === 'mirror') {
      mirrors.delete(socket);
      log('mirror disconnected');
    }
  });

  // ECONNRESET などをここで飲まないと未処理例外でサーバごと落ちる。
  socket.on('error', () => {});
});

wss.on('listening', () => {
  console.log(
    `vj-bridge listening on ws://127.0.0.1:${port}  (open the app with ?scene=semantic-synth&bridge=1)`,
  );
});

wss.on('error', (err) => {
  // EADDRINUSE などは復帰しようがないので、理由を出して落ちる。
  console.error(`vj-bridge: ${err.message}`);
  process.exit(1);
});
