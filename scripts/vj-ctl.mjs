#!/usr/bin/env node
/**
 * vj-ctl — vj-bridge 経由でブラウザ内の SynthControl を 1 コマンドだけ叩く CLI。
 *
 * 1 実行 = 1 接続。常駐させないのは、AI Director（Claude Code など）から
 * 「1 コマンド叩いて JSON を読む」形で使うのが主用途で、セッションを跨いだ
 * 状態を CLI 側に持たせたくないため。状態はすべてブラウザ側が正。
 *
 * 出力の約束:
 *   - 成功            → 結果 JSON を stdout（整形）、exit 0
 *   - ok:false        → issues / issue を含む結果 JSON を stdout、ヒントを stderr、exit 1
 *   - 通信/引数エラー → {"error":"..."} を stdout、ヒントを stderr、exit 1
 *   - record stop     → recording JSON を再整形せずそのまま stdout（> recording.json 用）
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

const DEFAULT_PORT = 7877;

/**
 * image コマンドが送れるファイルサイズの上限。
 * base64 で 4/3 に膨らんだうえ WebSocket フレーム1本に載るので、
 * ブラウザとリレーの両方が黙って詰まらない範囲に切っておく。
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 拡張子 → MIME。ブラウザ側の decode 分岐（特に SVG）に効く。 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

// room コマンドの既定 host。<account> はプレースホルダで、実際の host は
// Cloudflare ダッシュボードの workers.dev サブドメイン、または独自ドメインを確認して
// 差し替えること（--host で毎回上書きもできる）。
const DEFAULT_ROOM_HOST = 'auto-audio-visualizer.<account>.workers.dev';

/** 接続からコマンド完了までの全体上限。bridge も synth も無言のまま固まる場合の保険。 */
const OVERALL_TIMEOUT_MS = 20_000;

// 由来: src/synth/types.ts の DEFAULT_TRANSITION と src/ui/TimelinePanel.tsx の
// TRANSITION_PRESETS を写したもの（CLI は .ts を import できないため複製）。
// default = DEFAULT_TRANSITION / slow = 各 ms を 2 倍 / cut = 全て 120ms。easing は 3 つとも 'easeInOut'。
const TRANSITION_PRESETS = {
  default: {
    paletteMs: 1200,
    parameterMs: 800,
    modulationMs: 1000,
    topologyMs: 2000,
    easing: 'easeInOut',
  },
  slow: {
    paletteMs: 2400,
    parameterMs: 1600,
    modulationMs: 2000,
    topologyMs: 4000,
    easing: 'easeInOut',
  },
  cut: {
    paletteMs: 120,
    parameterMs: 120,
    modulationMs: 120,
    topologyMs: 120,
    easing: 'easeInOut',
  },
};

const USAGE = `使い方: node scripts/vj-ctl.mjs <command> [options]

  state                        現在の SynthControlState を表示
  catalog                      Generator カタログ（id / category / tags / parameters）を表示
  seed <seed>                  seed から派生した Patch へ即遷移
  patch <file.json>            VisualPatch を即適用（検証に落ちると issues が返る）
  blend <mode>                 オーバーレイ合成のブレンドモード
                               （normal/screen/multiply/overlay/difference/exclusion/
                               color-dodge/hard-light/lighten/darken）
  image <file> [--name <n>]    画像 (png/jpg/webp/svg) を読み込ませる（上限 ${
    MAX_IMAGE_BYTES / 1024 / 1024
  }MB）
                               返る hash を Patch の images["<opId>.image"] に入れて使う
  event add --in <sec>|--bar <n>|--cue <id> [--seed <s>] [--patch <file>]
                               [--label <s>] [--transition default|slow|cut]
                               「N 秒後 / N 小節後に切り替える」、または external anchor
                               （手動発火専用）のイベントを Timeline に追加
  event remove <id>            イベントを削除
  lock <sec>                   今から <sec> 秒間 Timeline をロックする（相対指定）
  fire <externalId>            external anchor のイベントを手動発火
  record start                 録画開始
  record stop                  録画を止めて recording JSON を stdout へ（> recording.json）
  load <recording.json>        recording を読み込んで Timeline を復元
  room                         新しい room id と接続 URL を生成する（Cloudflare Worker 経由で使う）

共通オプション:
  --port <n>                   bridge のポート（既定 ${DEFAULT_PORT}）
  --url <ws(s)://…/room/<id>>  Cloudflare Worker のリレーに接続する（--port と排他）
  --help                       このヘルプ

room 専用オプション:
  --host <host>                 room の URL に使うホスト名（既定 ${DEFAULT_ROOM_HOST}）

例:
  node scripts/vj-ctl.mjs state
  node scripts/vj-ctl.mjs seed "humid-night-market"
  node scripts/vj-ctl.mjs blend screen
  node scripts/vj-ctl.mjs image ./logo.png --name event-logo
  node scripts/vj-ctl.mjs event add --in 30 --seed rainy-qilou --transition slow
  node scripts/vj-ctl.mjs event add --bar 8 --patch /tmp/patch.json
  node scripts/vj-ctl.mjs event add --cue drop --patch /tmp/patch.json --label "drop"
  node scripts/vj-ctl.mjs lock 60
  node scripts/vj-ctl.mjs record stop > recording.json
  node scripts/vj-ctl.mjs room --host auto-audio-visualizer.example.workers.dev
  node scripts/vj-ctl.mjs --url wss://auto-audio-visualizer.example.workers.dev/room/xxxx state`;

/** 引数の誤り。main が usage を出して exit 1 にする。 */
class UsageError extends Error {}

/** bridge / synth が返したエラー文字列。ローカルの例外と区別してヒントを出し分ける。 */
class BridgeError extends Error {}

// process.exit は書き込み途中の stdout を切り落とすことがあるので使わない。
// 例外で main まで戻し、exitCode を立てて自然に終了させる。
function usageError(message) {
  throw new UsageError(message);
}

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

/** `--name value` と位置引数だけを解釈する。負数を値に取れるよう `--` 始まりだけをフラグ扱いにする。 */
function parseArgv(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === 'help') {
      flags.set('help', true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      usageError(`--${name} には値が必要です`);
    }
    flags.set(name, value);
    i++;
  }
  return { positional, flags };
}

function numberFlag(flags, name) {
  const raw = flags.get(name);
  const n = Number(raw);
  if (!Number.isFinite(n)) usageError(`--${name} には数値を指定してください（${raw}）`);
  return n;
}

function readTextFile(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    return usageError(`${what} を読めません: ${path} (${e.message})`);
  }
}

function readJsonFile(path, what) {
  const text = readTextFile(path, what);
  try {
    return JSON.parse(text);
  } catch (e) {
    return usageError(`${what} が JSON として不正です: ${path} (${e.message})`);
  }
}

/** 画像を読んで base64 にする。上限超過はここで止め、無駄に送らない。 */
function readImageFile(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    return usageError(`画像を読めません: ${path} (${e.message})`);
  }
  if (bytes.length === 0) usageError(`画像が空です: ${path}`);
  if (bytes.length > MAX_IMAGE_BYTES) {
    usageError(
      `画像が大きすぎます: ${path} (${(bytes.length / 1024 / 1024).toFixed(1)}MB > ` +
        `${MAX_IMAGE_BYTES / 1024 / 1024}MB)。書き出し解像度を落としてください。`,
    );
  }
  const ext = extname(path).toLowerCase();
  return {
    bytesBase64: bytes.toString('base64'),
    // 未知の拡張子でも送る: ブラウザ側は Blob の type が空でも
    // createImageBitmap で中身から判定できる（SVG だけは拡張子が頼り）。
    mime: IMAGE_MIME[ext] ?? '',
    fileName: basename(path),
    byteLength: bytes.length,
  };
}

// ---------------------------------------------------------------------------
// 接続
// ---------------------------------------------------------------------------

/** 接続先 URL を決める。--url があればそれ、無ければローカル bridge。 */
function resolveTarget(flags) {
  if (flags.has('url')) {
    if (flags.has('port')) usageError('--url と --port は同時に指定できません');
    const url = flags.get('url');
    if (!/^wss?:\/\//.test(url)) {
      usageError(`--url は ws:// か wss:// で始まる必要があります（${url}）`);
    }
    return url;
  }
  const port = flags.has('port') ? numberFlag(flags, 'port') : DEFAULT_PORT;
  return `ws://127.0.0.1:${port}`;
}

function openConnection(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ hello: 'ctl' }));
      resolve();
    });
    // open 済みなら no-op。open 前の ECONNREFUSED をここで拾う。
    ws.on('error', reject);
  });

  function rejectAll(err) {
    for (const entry of pending.values()) entry.rej(err);
    pending.clear();
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const entry = pending.get(msg?.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) entry.rej(new BridgeError(String(msg.error)));
    else entry.res(msg.result);
  });

  ws.on('close', () => rejectAll(new BridgeError('bridge との接続が切れました')));
  ws.on('error', (err) => rejectAll(err));

  return {
    ready,
    request(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
      // close ハンドシェイクを返さない相手でもプロセスを残さない。unref してあるので
      // 正常終了時にこのタイマーが待ち時間を作ることはない。
      setTimeout(() => ws.terminate(), 1000).unref();
    },
    /** 全体タイムアウト用。イベントループを空にして自然終了させる。 */
    abort() {
      ws.terminate();
    },
  };
}

// ---------------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------------

function jsonOut(value) {
  return { ok: true, output: `${JSON.stringify(value, null, 2)}\n` };
}

/**
 * control が返す {ok, issues?/issue?} をそのまま結果として出す。
 * ok:false は「通信は成功したが提案が却下された」状態なので、{"error"} に潰さず
 * issues を残したまま exit 1 にする（呼び出し側が直して投げ直せるように）。
 */
function resultOut(result, extra, hint) {
  const payload = { ...result, ...extra };
  const ok = result?.ok !== false;
  return { ok, output: `${JSON.stringify(payload, null, 2)}\n`, hint: ok ? undefined : hint };
}

export async function buildEventAdd(conn, flags) {
  // 相対指定（N 秒後 / N 小節後）を絶対 anchor に直すには、いま何秒・何小節かが要る。
  const state = await conn.request('getState');

  let start;
  if (flags.has('bar')) {
    // barCount は barPhase 込みの小数で来ることがあるので、現在の小節頭を基準にする。
    start = { kind: 'bar', bar: Math.floor(state.barCount) + numberFlag(flags, 'bar') };
  } else if (flags.has('in')) {
    start = { kind: 'seconds', atSec: state.nowSec + numberFlag(flags, 'in') };
  } else if (flags.has('cue')) {
    // external anchor: isDue は 'external' に対して常に false を返すので、
    // fire <id> で手動発火するまで絶対に自動発火しない（vj-set.mjs の cue-load 用）。
    start = { kind: 'external', id: flags.get('cue') };
  } else {
    usageError('event add には --in <sec> か --bar <n> か --cue <id> のいずれかが必要です');
  }

  const intent = {};
  if (flags.has('label')) intent.label = flags.get('label');
  if (flags.has('seed')) intent.seed = flags.get('seed');
  if (flags.has('patch')) intent.patch = readJsonFile(flags.get('patch'), 'patch');
  if (Object.keys(intent).length === 0) {
    usageError('intent が空です（--label / --seed / --patch のいずれかを指定してください）');
  }

  const presetId = flags.has('transition') ? flags.get('transition') : 'default';
  const transition = TRANSITION_PRESETS[presetId];
  if (!transition) {
    usageError(`--transition は ${Object.keys(TRANSITION_PRESETS).join(' | ')} のいずれかです`);
  }

  return {
    // 後から remove しやすいよう、由来が分かる接頭辞 + 実行時刻。
    id: `ctl-${Date.now()}`,
    start,
    duration: { kind: 'untilNext' },
    intent,
    transition,
    confidence: 1,
    locked: false,
  };
}

async function run(conn, positional, flags) {
  const [command, ...rest] = positional;

  switch (command) {
    case 'state':
      return jsonOut(await conn.request('getState'));

    case 'catalog':
      return jsonOut(await conn.request('getCatalog'));

    case 'seed': {
      if (rest.length === 0) usageError('seed には <seed> が必要です');
      return jsonOut(await conn.request('proposeSeed', { seed: rest[0] }));
    }

    case 'blend': {
      if (rest.length === 0) usageError('blend には <mode> が必要です');
      // 不正値も control 側が normal に倒して ok:true + warning を返す。
      return jsonOut(await conn.request('setBlendMode', { mode: rest[0] }));
    }

    case 'patch': {
      if (rest.length === 0) usageError('patch には <file.json> が必要です');
      const patch = readJsonFile(rest[0], 'patch');
      const result = await conn.request('proposePatch', { patch });
      return resultOut(
        result,
        undefined,
        'Patch が検証ゲートに落ちました。issues を見て直してください。',
      );
    }

    case 'image': {
      if (rest.length === 0) usageError('image には <file> が必要です');
      const { bytesBase64, mime, fileName, byteLength } = readImageFile(rest[0]);
      const name = flags.has('name') ? flags.get('name') : fileName;
      const result = await conn.request('setImage', { name, bytesBase64, mime });
      return resultOut(
        result,
        { name, byteLength },
        '画像を登録できませんでした。issues を確認してください。',
      );
    }

    case 'event': {
      const sub = rest[0];
      if (sub === 'add') {
        const event = await buildEventAdd(conn, flags);
        const result = await conn.request('applyTimelineOp', { op: { op: 'add', event } });
        return resultOut(
          result,
          { event },
          'イベントを追加できませんでした。issue を確認してください。',
        );
      }
      if (sub === 'remove') {
        if (rest.length < 2) usageError('event remove には <id> が必要です');
        const result = await conn.request('applyTimelineOp', { op: { op: 'remove', id: rest[1] } });
        return resultOut(
          result,
          { id: rest[1] },
          'イベントを削除できませんでした（ロック中か id 違い）。',
        );
      }
      return usageError('event のサブコマンドは add か remove です');
    }

    case 'lock': {
      if (rest.length === 0) usageError('lock には <sec>（今から何秒ロックするか）が必要です');
      const sec = Number(rest[0]);
      if (!Number.isFinite(sec)) usageError(`lock の <sec> は数値です（${rest[0]}）`);
      // control 側は絶対秒を期待する。相対 → 絶対の変換は CLI の仕事。
      const state = await conn.request('getState');
      const lockedUntilSec = state.nowSec + sec;
      const result = await conn.request('applyTimelineOp', {
        op: { op: 'setLockedUntil', sec: lockedUntilSec },
      });
      return resultOut(result, { lockedUntilSec }, 'ロックを設定できませんでした。');
    }

    case 'fire': {
      if (rest.length === 0) usageError('fire には <externalId> が必要です');
      return jsonOut(await conn.request('fireExternal', { id: rest[0] }));
    }

    case 'record': {
      const sub = rest[0];
      if (sub === 'start') return jsonOut(await conn.request('startRecording'));
      if (sub === 'stop') {
        const result = await conn.request('stopRecording');
        if (!result?.ok || typeof result.json !== 'string') {
          return {
            ok: false,
            output: `${JSON.stringify({ error: 'not recording' })}\n`,
            hint: '録画していません。先に `record start` を実行してください。',
          };
        }
        // 再整形しない: この出力をそのまま `load` に食わせられることが契約。
        // 末尾改行だけはシェルで扱いやすいように足す（JSON としては同値）。
        return { ok: true, output: `${result.json}\n` };
      }
      return usageError('record のサブコマンドは start か stop です');
    }

    case 'load': {
      if (rest.length === 0) usageError('load には <recording.json> が必要です');
      // 中身は control 側が検証するので、ここでは読めることだけ確かめて素通しする。
      const json = readTextFile(rest[0], 'recording');
      const result = await conn.request('loadRecording', { json });
      return resultOut(
        result,
        undefined,
        'recording を読み込めませんでした。issues を確認してください。',
      );
    }

    default:
      return usageError(`不明なコマンド: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function fail(message, hint) {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  if (hint) process.stderr.write(`${hint}\n`);
  process.exitCode = 1;
}

function hintFor(message, target) {
  // /room/ を含む URL はリレー（Cloudflare Worker）宛。ローカル bridge とは
  // 起動手段もヒントも別なので、接続先で文言を出し分ける。
  const isRelay = target.includes('/room/');
  if (message.includes('no synth connected')) {
    return isRelay
      ? 'ブラウザで `?scene=semantic-synth&room=<id>` 付きの URL を開いているか、room id が一致しているか確認してください。'
      : 'アプリを `?scene=semantic-synth&bridge=1` 付きで開いているか確認してください。';
  }
  if (message.includes('ECONNREFUSED') || message.includes('接続が切れました')) {
    return isRelay
      ? `${target} につながりません。Worker が動いているか、URL が正しいか確認してください（\`node scripts/vj-ctl.mjs room\` で URL を作れます）。`
      : `${target} につながりません。\`pnpm bridge\` が起動しているか確認してください。`;
  }
  if (message.includes('timeout waiting for synth')) {
    return 'ブラウザが応答していません。タブが背面に回っていないか確認してください。';
  }
  return undefined;
}

async function main() {
  let target = `ws://127.0.0.1:${DEFAULT_PORT}`;
  let conn = null;
  let overall = null;
  let timedOut = false;

  try {
    const { positional, flags } = parseArgv(process.argv.slice(2));
    if (flags.get('help') === true || positional.length === 0) {
      usageError('コマンドを指定してください');
    }

    if (positional[0] === 'room') {
      // room は WebSocket を一切開かないローカル専用コマンド。ここで完結させて
      // 以降の接続処理（タイムアウトタイマーも含む）には進ませない。
      const host = flags.has('host') ? flags.get('host') : DEFAULT_ROOM_HOST;
      // room id は「URL を知っていれば誰でも操縦できる合鍵」。認証は無く、
      // 128bit のランダム性だけが防御。使い捨てにして、人目に付く場所には貼らないこと。
      const room = randomBytes(16).toString('base64url');
      const res = jsonOut({
        room,
        pageUrl: `https://${host}/?scene=semantic-synth&room=${room}`,
        ctlArgs: `--url wss://${host}/room/${room}`,
      });
      process.stdout.write(res.output);
      return;
    }

    target = resolveTarget(flags);

    conn = openConnection(target);
    // 通信が固まったまま端末を占有しないための最終防衛線。
    overall = setTimeout(() => {
      timedOut = true;
      // 接続が拒否されずに沈黙する環境（WSL 等）ではここが唯一の手掛かりになるので、
      // bridge / Worker 未起動とブラウザ無応答の両方を疑えるヒントを出す。
      fail(
        `timeout after ${OVERALL_TIMEOUT_MS / 1000}s`,
        `${target} に接続できているか、ブラウザが応答しているか確認してください。`,
      );
      conn.abort();
    }, OVERALL_TIMEOUT_MS);

    await conn.ready;
    const res = await run(conn, positional, flags);
    process.stdout.write(res.output);
    if (!res.ok) {
      if (res.hint) process.stderr.write(`${res.hint}\n`);
      process.exitCode = 1;
    }
  } catch (e) {
    if (timedOut) {
      // 報告済み。abort の後始末で飛んでくる例外はここで握りつぶす。
    } else if (e instanceof UsageError) {
      process.stderr.write(`vj-ctl: ${e.message}\n\n${USAGE}\n`);
      process.exitCode = 1;
    } else {
      const detail = e?.message ?? String(e);
      fail(detail, hintFor(detail, target));
    }
  } finally {
    if (overall) clearTimeout(overall);
    conn?.close();
  }
}

// buildEventAdd を直接 import してユニットテストできるよう export したことで、
// このファイルは「スクリプトとして実行される」だけでなく「モジュールとして import
// される」経路も持つようになった。import された側で main() まで動いてしまうと、
// テストプロセスの argv で実ネットワーク接続（openConnection）を試みかねない
// （本番の bridge/relay に触れてはいけない、という制約に抵触する）ので、
// 直接実行されたときだけ起動する。`node scripts/vj-ctl.mjs ...` として動かした
// ときの挙動はこれまでと変わらない。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
