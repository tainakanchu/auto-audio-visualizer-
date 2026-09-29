#!/usr/bin/env node
/**
 * prolink-bridge — Pro DJ Link のビートパケットを UDP で受けて、ブラウザ
 * （src/audio/linkClient.ts → TempoTracker）へ WebSocket で流す受信専用の中継。
 *
 *   CDJ/DJM --UDP 50001--> この中継 --ws://127.0.0.1:7878--> ブラウザ
 *
 * 受信専用: 仮想 CDJ としての announce / status 送信や dbserver 問い合わせは
 * 一切しない。ネットワークへは 1 パケットも送らないので、本番のクラブの
 * Pro DJ Link ネットワークに繋いでも CDJ 側の挙動には影響しない（CDJ から
 * このマシンは見えない）。その代わり取れるのはビートパケットの情報だけ。
 *
 * パケットのパースとデバイス選択は scripts/prolink-packet.mjs の純粋関数。
 * ここはソケットの生死とログだけを持つ。
 *
 * ブラウザへ送る JSON（テキストフレーム、片道）:
 *   {"type":"beat","bpm":<effective>,"trackBpm":..,"pitch":..,"beatInBar":1..4|null,
 *    "nextBeatMs":..|null,"device":n,"name":"CDJ-3000"}
 * 時刻は送らない。Node とブラウザの時計は揃っていない前提で、ブラウザ側が
 * 受信時刻を拍の時刻として使う。
 */
import dgram from 'node:dgram';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DEFAULT_LINK_WS_PORT,
  PROLINK_BEAT_PORT,
  initialSelection,
  parseBeatPacket,
  selectBeat,
  toBeatMessage,
} from './prolink-packet.mjs';

const USAGE = `usage: node scripts/prolink-bridge.mjs [--port <ws port>] [--udp-port <port>] [--device <n>] [--verbose]

  --port <n>      ブラウザ向け WebSocket のポート（既定 ${DEFAULT_LINK_WS_PORT}、127.0.0.1 固定）
  --udp-port <n>  ビートパケットを受ける UDP ポート（既定 ${PROLINK_BEAT_PORT}）
  --device <n>    追従するデバイス番号を固定する（既定: 自動選択）
  --verbose       受け取ったビートを 1 件ずつログに出す`;

/** 依存を増やさないための最小限の手書きパース。 */
function parseArgs(argv) {
  const opts = {
    port: DEFAULT_LINK_WS_PORT,
    udpPort: PROLINK_BEAT_PORT,
    device: null,
    verbose: false,
  };
  const intArg = (name, raw, lo, hi) => {
    const n = Number(raw);
    if (raw === undefined || !/^\d+$/.test(raw) || n < lo || n > hi) {
      console.error(`prolink-bridge: invalid ${name}: ${raw}`);
      process.exit(1);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a === '--port') {
      opts.port = intArg('--port', argv[++i], 1, 65535);
    } else if (a === '--udp-port') {
      opts.udpPort = intArg('--udp-port', argv[++i], 1, 65535);
    } else if (a === '--device') {
      opts.device = intArg('--device', argv[++i], 1, 255);
    } else if (a === '--verbose') {
      opts.verbose = true;
    } else {
      console.error(`prolink-bridge: unknown argument: ${a}\n${USAGE}`);
      process.exit(1);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

function log(line) {
  console.log(`[prolink-bridge] ${line}`);
}

// ---- WebSocket（ブラウザ向け） ----

// 127.0.0.1 固定。vj-bridge と同じく無認証なので、LAN に晒すと同じネットワーク
// の誰でもテンポを偽装したビートを流し込めてしまう。特に Pro DJ Link は
// クラブの共有 LAN に繋ぐ前提なので、ここだけは絶対にループバックに閉じる。
const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port });
const clients = new Set();

wss.on('connection', (socket) => {
  clients.add(socket);
  log(`browser connected (${clients.size})`);
  // ブラウザからのフレームは使わない（片道）。来ても無視する。
  socket.on('close', () => {
    clients.delete(socket);
    log(`browser disconnected (${clients.size})`);
  });
  // ECONNRESET などをここで飲まないと未処理例外でサーバごと落ちる。
  socket.on('error', () => {});
});

wss.on('listening', () => {
  log(`listening on ws://127.0.0.1:${opts.port}  (open the app with ?link=1)`);
});

wss.on('error', (err) => {
  console.error(`prolink-bridge: ${err.message}`);
  process.exit(1);
});

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(text);
  }
}

// ---- UDP（Pro DJ Link 受信） ----

// reuseAddr: 同じマシンで rekordbox や Beat Link Trigger 等が 50001 を開いていても
// 並べて受けられるようにする（ブロードキャストは全ソケットに配られる）。
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

let selection = initialSelection();
/** ログを状態変化のときだけ出すための前回値。 */
let lastFollowed = null;
let packetCount = 0;

udp.on('message', (msg) => {
  const beat = parseBeatPacket(msg);
  if (beat === null) return; // 0x28 以外（on-air 通知・絶対位置パケット等）は無視
  const now = Date.now();
  const { accept, state } = selectBeat(selection, beat.device, now, opts.device);
  selection = state;
  if (state.current !== lastFollowed) {
    lastFollowed = state.current;
    log(`following device ${state.current}${accept ? ` (${beat.name})` : ''}`);
  }
  if (!accept) return;
  const out = toBeatMessage(beat);
  if (out === null) return; // BPM 不明
  packetCount++;
  if (opts.verbose) {
    log(
      `beat dev=${out.device} ${out.bpm.toFixed(2)} BPM (track ${out.trackBpm} ${out.pitch >= 0 ? '+' : ''}${out.pitch.toFixed(2)}%) bb=${out.beatInBar}`,
    );
  }
  broadcast(out);
});

udp.on('listening', () => {
  const a = udp.address();
  log(`receiving Pro DJ Link beats on udp ${a.address}:${a.port} (receive-only, sends nothing)`);
});

udp.on('error', (err) => {
  console.error(`prolink-bridge: udp: ${err.message}`);
  process.exit(1);
});

udp.bind({ address: '0.0.0.0', port: opts.udpPort });

// 何も来ていないとき（LAN 未接続・ポート違い）に気付けるよう、たまに状況を出す。
setInterval(() => {
  if (packetCount === 0) {
    log(`no beat packets yet on udp ${opts.udpPort} — is a CDJ playing an analysed track?`);
  }
  packetCount = 0;
}, 10_000).unref();
