import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

/**
 * RelayRoom — scripts/vj-bridge.mjs と同じ中継を Durable Object の上でやる。
 *
 * ローカル版と同じく、ここには VJ のロジックを一切置かない。判断はすべて
 * 呼び出し側（CLI / AI Director）とブラウザ側（getSynthControl の実体）が持ち、
 * この中継は「どの ctl の要求か」を覚えて応答を返すだけの郵便局に徹する。
 *
 * プロトコル（JSON テキストフレーム）は vj-bridge.mjs と完全に同一:
 *   client → server  {"hello":"synth"} | {"hello":"ctl"} | {"hello":"mirror"}
 *   ctl    → server  {"id":<ctlId>,"method":"<name>","params":<object|undefined>}
 *   server → synth   {"id":<serverId>,"method":...,"params":...}   （応答を期待）
 *   server → mirror  {"method":...,"params":...}                   （片道・id 無し）
 *   synth  → server  {"id":<serverId>,"result":<any>} | {"id":<serverId>,"error":"<message>"}
 *   mirror → server  id 付きなら {"id":...,"error":"mirror is receive-only"}、それ以外は無視
 *   server → ctl     {"id":<ctlId>,"result":...} | {"id":<ctlId>,"error":...}
 *
 * mirror は表示専用の受信クライアント。ctl コマンドは synth に送ると同時に
 * 接続中の全 mirror へ id 無しでブロードキャストする。応答の一意性は synth 1 台
 * が担うので、findSynth() は mirror を無視する。新しい synth が来ても mirror は
 * 切らない（逆に mirror が何台いても synth は切られない）。mirror 0 台のとき
 * の挙動は従来と完全に同一。
 *
 * ローカル版との唯一の構造的な違いは **WebSocket Hibernation API を使う**こと。
 * VJ の中継は「接続しっぱなしで、たまにしか喋らない」典型的な形なので、無通信の
 * 間に DO をメモリから落とせないと課金も安定性も割に合わない。ただし休止すると
 * クラスのフィールド（ローカル版でいう `synth` / `mirrors` / `pending` /
 * `nextServerId`）は消えるので、中継の維持に要る情報は次の 2 か所に逃がしてある:
 *
 *   - 接続ごとの状態（role・その接続が抱えている pending・レート制限の窓）
 *     → その WebSocket の serialized attachment
 *   - serverId のカウンタ（巻き戻ると古い pending と衝突する）
 *     → DO の storage
 *
 * 「今 synth は誰か」「mirror は誰か」も、フィールドではなく ctx.getWebSockets()
 * を舐めて attachment の role で判定する。休止から復帰した直後でも同じ答えになる。
 */

/** synth の応答を待つ上限。ローカル版（vj-bridge.mjs）と同じ 15 秒。 */
const PENDING_TIMEOUT_MS = 15_000;

/**
 * 1 接続あたり毎秒のメッセージ数上限。VJ の操作は人間か AI Director が
 * 1 秒に数回叩く程度なので、この値は「事故で暴走したループを止める」ための
 * ものであって、正常な操作を絞るためのものではない。
 */
const RATE_LIMIT_PER_SEC = 40;

/** 1 つの ctl 接続が同時に抱えられる pending の数。attachment の 16KB 制限の保険。 */
const MAX_PENDING_PER_CTL = 64;

/** serverId カウンタの storage キー。 */
const NEXT_SERVER_ID_KEY = 'nextServerId';

type Role = 'synth' | 'ctl' | 'mirror';

interface PendingEntry {
  /** ctl 側の id 空間での id。応答を返すときはこれに戻す。 */
  ctlId: number;
  /** epoch ms。これを過ぎたものを alarm が timeout として返す。 */
  deadline: number;
}

/**
 * WebSocket 1 本ぶんの状態。Hibernation で DO がメモリから落ちても生き残る
 * 必要があるので、クラスのフィールドではなく attachment に置く。
 */
interface Attachment {
  /** hello を受け取るまでは null。ローカル版の `let role = null` に対応する。 */
  role: Role | null;
  /** ctl のみ使う。serverId（文字列キー）→ 誰にどの id で返すか。 */
  pending: Record<string, PendingEntry>;
  /** レート制限の窓の開始時刻（epoch ms）。 */
  windowStart: number;
  /** その窓で受けたメッセージ数。 */
  count: number;
}

/** 受信フレーム。どのキーが来るかは送り主の role 次第なので、すべて任意扱い。 */
interface Frame {
  hello?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function freshAttachment(now: number): Attachment {
  return { role: null, pending: {}, windowStart: now, count: 0 };
}

/**
 * attachment を読み出して形を保証する。返るのは**コピー**なので、書き換えたら
 * 必ず serializeAttachment() で書き戻すこと。
 *
 * 中身を素直に信用しないのは、attachment がデプロイを跨いで残るため。
 * このファイルの Attachment を将来変えたとき、古い形のまま繋ぎっぱなしの
 * 接続が復帰しても中継が壊れないようにしておく。
 */
function readAttachment(ws: WebSocket): Attachment {
  const raw: unknown = ws.deserializeAttachment();
  if (typeof raw !== 'object' || raw === null) return freshAttachment(0);
  const a = raw as Partial<Attachment>;
  return {
    role: a.role === 'synth' || a.role === 'ctl' || a.role === 'mirror' ? a.role : null,
    pending: typeof a.pending === 'object' && a.pending !== null ? a.pending : {},
    windowStart: typeof a.windowStart === 'number' ? a.windowStart : 0,
    count: typeof a.count === 'number' ? a.count : 0,
  };
}

/**
 * synth が返してきた error を ctl に渡せる文字列に均す。
 * まっとうな synth は文字列を入れてくるが、そうでないフレームで
 * `[object Object]` を送り返しても呼び出し側が原因を追えない。
 */
function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'unknown error';
}

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.READY_STATE_OPEN;
}

function send(ws: WebSocket, payload: unknown): void {
  if (!isOpen(ws)) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // 相手が送信中に落ちただけ。中継全体を巻き込まない。
  }
}

export class RelayRoom extends DurableObject<Env> {
  /**
   * 次に払い出す serverId。ctl の id 空間は接続ごとに独立なので、そのまま
   * synth へ流すと別 ctl の id と衝突する。中継側で採番し直して覚える。
   */
  private nextServerId = 1;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 休止から復帰したときにカウンタが 1 に巻き戻ると、時間切れ間際の pending と
    // 新しい要求が同じ id を持ちうる。storage から読み直す。
    // constructor は async にできないので await しない。ランタイムがこの Promise を
    // 見ていて、解決するまで他のイベント（webSocketMessage 等）を止めてくれる。
    void ctx.blockConcurrencyWhile(async () => {
      this.nextServerId = (await ctx.storage.get<number>(NEXT_SERVER_ID_KEY)) ?? 1;
    });
  }

  /** Worker から転送されてきた Upgrade リクエストを WebSocket に昇格させる。 */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected Upgrade: websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // accept() ではなく acceptWebSocket()。前者だと DO がメモリに居座り続ける。
    this.ctx.acceptWebSocket(server);
    // hello 前でもレート制限の窓は要るので、この時点で attachment を作っておく。
    // 以後 deserializeAttachment() が null を返さなくなる。
    server.serializeAttachment(freshAttachment(Date.now()));

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // このプロトコルはテキストフレームしか使わない。
    if (typeof message !== 'string') return;

    const att = readAttachment(ws);
    try {
      await this.route(ws, att, message);
    } finally {
      // どの経路を通っても、この接続の状態（role / pending / 窓）は必ず書き戻す。
      // ここを 1 か所に集めておくと、分岐が増えても書き忘れが起きない。
      ws.serializeAttachment(att);
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    this.handleGone(ws);
    // 閉じ返さないと server 側が half-closed のまま残る。1005（コード無し）と
    // 1006（異常終了）は送り返せない予約値なので 1000 に倒す。
    try {
      ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
    } catch {
      // 既に閉じている。
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.handleGone(ws);
  }

  /** pending の期限切れを掃除する。setTimeout は休止を跨げないので alarm でやる。 */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;

    for (const ws of this.ctx.getWebSockets()) {
      const att = readAttachment(ws);
      if (att.role !== 'ctl') continue;

      let changed = false;
      for (const [key, entry] of Object.entries(att.pending)) {
        if (entry.deadline <= now) {
          delete att.pending[key];
          send(ws, { id: entry.ctlId, error: 'timeout waiting for synth' });
          changed = true;
        } else if (next === null || entry.deadline < next) {
          next = entry.deadline;
        }
      }
      if (changed) ws.serializeAttachment(att);
    }

    // まだ待っているものがあれば、その最短の期限で張り直す。
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  // -------------------------------------------------------------------------
  // routing
  // -------------------------------------------------------------------------

  private async route(ws: WebSocket, att: Attachment, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 壊れたフレームで中継ごと落とさない
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as Frame;

    if (!this.admit(ws, att, frame)) return;

    if (typeof frame.hello === 'string') {
      this.handleHello(ws, att, frame.hello);
      return;
    }

    if (att.role === null) {
      if (typeof frame.id === 'number') {
        send(ws, { id: frame.id, error: 'client must send {"hello":"ctl"} first' });
      }
      return;
    }

    if (att.role === 'synth') this.handleSynthResponse(frame);
    else if (att.role === 'mirror') this.handleMirrorMessage(ws, frame);
    else await this.handleCtlRequest(ws, att, frame);
  }

  /**
   * 雑なレート制限。1 秒の固定窓で数えるだけで、境界をまたぐと瞬間的に 2 倍まで
   * 通るが、狙いは暴走ループを止めることなので厳密さは要らない。窓が切り替われば
   * 自然に復帰するので接続は切らない（ライブ中に締め出す方が事故）。
   */
  private admit(ws: WebSocket, att: Attachment, frame: Frame): boolean {
    const now = Date.now();
    if (now - att.windowStart >= 1000) {
      att.windowStart = now;
      att.count = 0;
    }
    att.count += 1;
    if (att.count <= RATE_LIMIT_PER_SEC) return true;

    // 黙って捨てると呼び出し側が原因不明のタイムアウトを見ることになる。
    // 返す先が分かるときだけ理由を返す。
    if (typeof frame.id === 'number' && att.role !== 'synth') {
      send(ws, { id: frame.id, error: 'rate limit exceeded' });
    }
    return false;
  }

  private handleHello(ws: WebSocket, att: Attachment, hello: string): void {
    if (hello === 'synth') {
      // 映像を出しているタブは 1 枚だけを正とする（複数あるとどこに届いたか
      // 分からない）。タブの開き直しで古い接続が残ることがあるので、新しい方を
      // 採って古い方を蹴る。mirror は表示専用なのでここでは絶対に切らない。
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        if (readAttachment(other).role !== 'synth') continue;
        other.close(4000, 'replaced by a newer synth');
      }
      att.role = 'synth';
    } else if (hello === 'ctl') {
      att.role = 'ctl';
    } else if (hello === 'mirror') {
      // 表示専用。何台いてもよく、synth の差し替え対象にもならない。
      att.role = 'mirror';
    }
    // 知らない hello は無視する（role は未確定のまま）。
  }

  private async handleCtlRequest(ws: WebSocket, att: Attachment, frame: Frame): Promise<void> {
    if (typeof frame.id !== 'number') return; // 返す先が無いので黙って捨てる
    if (typeof frame.method !== 'string') {
      send(ws, { id: frame.id, error: 'missing method' });
      return;
    }

    const synth = this.findSynth();
    if (synth === null) {
      // synth が居ないときは従来どおり。mirror だけ居ても応答の正本が無い。
      send(ws, { id: frame.id, error: 'no synth connected' });
      return;
    }
    if (Object.keys(att.pending).length >= MAX_PENDING_PER_CTL) {
      send(ws, { id: frame.id, error: 'too many pending requests' });
      return;
    }

    const serverId = await this.allocateServerId();
    att.pending[String(serverId)] = {
      ctlId: frame.id,
      deadline: Date.now() + PENDING_TIMEOUT_MS,
    };
    // params が undefined なら JSON.stringify がキーごと落とす。仕様どおり。
    send(synth, { id: serverId, method: frame.method, params: frame.params });
    // synth が居るときだけ mirror にも同じコマンドを片道で配る（応答は synth だけ）。
    // id を付けないことで mirror 側が「応答を返す」経路に乗らない。
    this.broadcastToMirrors({ method: frame.method, params: frame.params });
    await this.armSweep();
  }

  /**
   * mirror は表示専用。コマンドを送ってきても実行も中継もしない。
   * id 付きなら「receive-only」と返して呼び出し側に気付けるようにし、
   * id 無しは返す先が無いので黙って捨てる。
   */
  private handleMirrorMessage(ws: WebSocket, frame: Frame): void {
    if (typeof frame.id === 'number') {
      send(ws, { id: frame.id, error: 'mirror is receive-only' });
    }
  }

  private handleSynthResponse(frame: Frame): void {
    if (typeof frame.id !== 'number') return;
    const key = String(frame.id);

    // pending は ctl の attachment に散らばっている。接続数は多くて数本なので
    // 舐めて探す方が、中央の索引を別途永続化するより壊れにくい。
    for (const ws of this.ctx.getWebSockets()) {
      const att = readAttachment(ws);
      if (att.role !== 'ctl') continue;
      const entry = att.pending[key];
      if (entry === undefined) continue;

      delete att.pending[key];
      ws.serializeAttachment(att);

      if (frame.error !== undefined) {
        send(ws, { id: entry.ctlId, error: errorText(frame.error) });
      } else {
        // undefined のまま stringify すると result キーごと消え、ctl 側からは
        // 「応答が無い」フレームに見えてしまうので null に倒す。
        send(ws, { id: entry.ctlId, result: frame.result === undefined ? null : frame.result });
      }
      return;
    }
    // 見つからないのは timeout 後に遅れて届いた応答。捨てる。
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** 応答を返す正本の synth。mirror は表示専用なのでここには入らない。 */
  private findSynth(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      if (readAttachment(ws).role === 'synth' && isOpen(ws)) return ws;
    }
    return null;
  }

  /** 接続中の表示専用クライアントへ片道ブロードキャストする。 */
  private broadcastToMirrors(payload: { method: string; params: unknown }): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (readAttachment(ws).role === 'mirror' && isOpen(ws)) send(ws, payload);
    }
  }

  private async allocateServerId(): Promise<number> {
    const id = this.nextServerId;
    this.nextServerId += 1;
    await this.ctx.storage.put(NEXT_SERVER_ID_KEY, this.nextServerId);
    return id;
  }

  /** 期限切れ掃除の alarm を仕掛ける。既にあるなら触らない（DO の alarm は 1 本だけ）。 */
  private async armSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + PENDING_TIMEOUT_MS);
  }

  private handleGone(ws: WebSocket): void {
    if (readAttachment(ws).role !== 'synth') {
      // ctl が消えただけ。応答の行き先は attachment ごと消えるので後始末は要らない。
      return;
    }
    // pending は常に「唯一の synth」宛なので、この接続が死んだ時点で中身は
    // 全部死んでいる（replaced の場合も同じ）。待っている ctl を全員起こす。
    this.flushPending('synth disconnected');
  }

  private flushPending(message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = readAttachment(ws);
      if (att.role !== 'ctl') continue;

      let changed = false;
      for (const [key, entry] of Object.entries(att.pending)) {
        delete att.pending[key];
        send(ws, { id: entry.ctlId, error: message });
        changed = true;
      }
      if (changed) ws.serializeAttachment(att);
    }
  }
}
