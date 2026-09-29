#!/usr/bin/env node
/**
 * prolink-sim — Pro DJ Link のビートパケット（type 0x28）を指定 BPM で送り続ける
 * シミュレータ。実機（CDJ/DJM）無しで prolink-bridge とブラウザの同期を試すためのもの。
 *
 * 既定は 127.0.0.1:50001 へのユニキャスト。本番 LAN に偽のビートを流さないよう、
 * ブロードキャストは --broadcast を明示したときだけ有効にする。
 */
import dgram from 'node:dgram';
import { PROLINK_BEAT_PORT, buildBeatPacket } from './prolink-packet.mjs';

const USAGE = `usage: node scripts/prolink-sim.mjs [--bpm <n>] [--pitch <pct>] [--device <n>] [--name <s>]
                                   [--host <addr>] [--port <n>] [--broadcast]

  --bpm <n>       track BPM（既定 128）
  --pitch <pct>   pitch %（既定 0。effective BPM = bpm × (1 + pitch/100)）
  --device <n>    device number（既定 1。33 以上はミキサー扱い）
  --name <s>      device name（既定 CDJ-SIM）
  --host <addr>   送信先（既定 127.0.0.1）
  --port <n>      送信先 UDP ポート（既定 ${PROLINK_BEAT_PORT}）
  --broadcast     SO_BROADCAST を有効にする（--host に 255.255.255.255 等を指定するとき）`;

function parseArgs(argv) {
  const opts = {
    bpm: 128,
    pitch: 0,
    device: 1,
    name: 'CDJ-SIM',
    host: '127.0.0.1',
    port: PROLINK_BEAT_PORT,
    broadcast: false,
  };
  const num = (name, raw, lo, hi) => {
    const n = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(n) || n < lo || n > hi) {
      console.error(`prolink-sim: invalid ${name}: ${raw}`);
      process.exit(1);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a === '--bpm') opts.bpm = num('--bpm', argv[++i], 20, 600);
    else if (a === '--pitch') opts.pitch = num('--pitch', argv[++i], -100, 100);
    else if (a === '--device') opts.device = Math.trunc(num('--device', argv[++i], 1, 255));
    else if (a === '--name') opts.name = String(argv[++i] ?? '');
    else if (a === '--host') opts.host = String(argv[++i] ?? '');
    else if (a === '--port') opts.port = Math.trunc(num('--port', argv[++i], 1, 65535));
    else if (a === '--broadcast') opts.broadcast = true;
    else {
      console.error(`prolink-sim: unknown argument: ${a}\n${USAGE}`);
      process.exit(1);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

function log(line) {
  console.log(`[prolink-sim] ${line}`);
}

const effectiveBpm = opts.bpm * (1 + opts.pitch / 100);
if (!(effectiveBpm > 0)) {
  console.error('prolink-sim: effective BPM must be > 0');
  process.exit(1);
}
const periodMs = 60000 / effectiveBpm;

const sock = dgram.createSocket('udp4');
sock.on('error', (err) => {
  console.error(`prolink-sim: ${err.message}`);
  process.exit(1);
});

sock.bind(() => {
  if (opts.broadcast) sock.setBroadcast(true);
  log(
    `sending beats to ${opts.host}:${opts.port} as device ${opts.device} "${opts.name}" at ${effectiveBpm.toFixed(2)} BPM (track ${opts.bpm}, pitch ${opts.pitch}%)`,
  );

  let beatInBar = 1;
  const start = performance.now();
  let n = 0;
  // setInterval は誤差が積もるので、開始時刻からの絶対時刻で次の拍を予約する。
  const tick = () => {
    const packet = buildBeatPacket({
      device: opts.device,
      name: opts.name,
      bpm: opts.bpm,
      pitch: opts.pitch,
      beatInBar,
    });
    sock.send(packet, opts.port, opts.host);
    beatInBar = (beatInBar % 4) + 1;
    n++;
    const delay = start + n * periodMs - performance.now();
    setTimeout(tick, Math.max(0, delay));
  };
  tick();
});
