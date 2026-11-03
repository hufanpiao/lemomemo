// 本机推送替身（B2 任务单第三节第 15 行、QA“测试开发”一行；架构审 D1 第 6 点、D3 第 6 点）：
// 扮演 FCM / Mozilla / Apple / WNS 的推送端点，给 push-dispatch 的测试用。不联网、不碰真钥匙。
//
// 两种用法，行为完全一样（同一个 serve）：
//   ① 进程内：把 fake.fetch 注入函数的 deps.fetch（tests/functions 的写法），不开端口；
//      redirect 按真 fetch 的规矩处理——没写 redirect: 'manual' 时会跟随 3xx，跟随的那一跳记 viaRedirect = true
//   ② 端口：await fake.listen(port) 只听 127.0.0.1；fake.overrideUrl() 给 PUSH_SERVICE_OVERRIDE_URL，
//      容器里的 edge runtime 用 fake.overrideUrl('host.docker.internal')（只换地址里的主机名，监听不变，安全审查 1.5 第 ② 点）；
//      3xx 的默认 Location 指回替身自己的 REDIRECT_TARGET，发送方要是跟随了，记录里就有一条打到这个路径的请求（也记 viaRedirect）
//
// 能回：201、404、410、429（Retry-After）、3xx（Location）、任意 200～599、挂住不回、网络错误、很大的流式响应体（见 push-service-types.ts 的 reply）；
// 每个请求可统一拖 N 毫秒（delayMs，D3 第 6 点：拖 3 秒、造 300 条），拖延期间各请求互不阻塞。
// 规则按路径、按订阅方配（可限次数），没命中的用默认回复（默认 201）。给了 subscribers 就解每个请求的负载，记下是谁、明文是什么。
// 每个请求记一笔（PushRequestRecord）。可选 VAPID 校验（vapid 选项，检查项见 push-service-check.ts）；请求体超过 4096 字节一律回 413。
// Node（vitest）和 Deno（deno test，要 --allow-net=127.0.0.1）都能跑：端口一侧（push-service-port.ts）用 node:http，其余只用 Web 标准 API。
import { checkPushRequest } from './push-service-check.ts';
import { type Incoming, LoopbackServer, type Outgoing, sleep } from './push-service-port.ts';
import { assertReply, CONTROL_PREFIX, type FakePushOptions, type PushReply, type PushRequestRecord, type PushRule, REDIRECT_TARGET, reply, replyProblem, STREAM_CHUNK } from './push-service-types.ts';
import type { PushSubscriber } from './push-service-vapid.ts';

export * from './push-service-types.ts';
export { type FakePushCliConfig, parseFakePushArgs } from './push-service-args.ts';
export { SERVICE_ORIGIN } from './push-service-check.ts';
export { b64u, newPushSubscriber, type PushSubscriber, subscriberFromKeys, unb64u, type VapidResult } from './push-service-vapid.ts';

const isRedirect = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;
const abortError = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('This operation was aborted', 'AbortError');

function headersObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/** 拖延只收非负的有限数（毫秒，复核 N2）；不合格回原因 */
function delayProblem(ms: unknown): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? null : 'delayMs 要是非负的有限数';
}

function checkRules(rules: unknown): string | null {
  if (!Array.isArray(rules)) return 'rules 要是数组';
  for (const r of rules as Partial<PushRule>[]) {
    if (typeof r !== 'object' || r === null) return '规则要是对象';
    if (r.path !== undefined && typeof r.path !== 'string' && !(r.path instanceof RegExp)) return 'path 要是字符串或正则';
    if (r.subscriber !== undefined && typeof r.subscriber !== 'string') return 'subscriber 要是字符串';
    if (r.times !== undefined && !(Number.isInteger(r.times) && r.times >= 0)) return 'times 要是非负整数';
    if (r.delayMs !== undefined && delayProblem(r.delayMs)) return delayProblem(r.delayMs);
    const why = replyProblem(r.reply);
    if (why) return why;
  }
  return null;
}

function assertDelay(ms: unknown): number {
  const why = delayProblem(ms);
  if (why) throw new Error(`替身拖延配错了：${why}`);
  return ms as number;
}

export class FakePushService {
  readonly requests: PushRequestRecord[] = [];
  readonly subscribers: PushSubscriber[];
  private defaultReply: PushReply;
  private delayMs: number;
  private rules: { rule: PushRule; used: number }[] = [];
  private readonly opt: FakePushOptions;
  private readonly now: () => number;
  private readonly life = new AbortController();
  private server: LoopbackServer | null = null;
  private seq = 0;
  private waiters: { n: number; ok: () => void }[] = [];
  /** 端口模式下的 origin（http://127.0.0.1:<端口>）；没 listen 时是 null */
  origin: string | null = null;

  constructor(opt: FakePushOptions = {}) {
    this.opt = opt;
    this.defaultReply = assertReply(opt.defaultReply ?? reply.created());
    this.delayMs = assertDelay(opt.delayMs ?? 0);
    for (const r of opt.rules ?? []) this.addRule(r);
    this.subscribers = [...(opt.subscribers ?? [])];
    this.now = opt.now ?? Date.now;
  }

  // ---------- 配置（配错的回复当场抛错，代码审查 M4） ----------

  setDefault(r: PushReply): void {
    this.defaultReply = assertReply(r);
  }

  setDelay(ms: number): void {
    this.delayMs = assertDelay(ms);
  }

  /** 加一条规则（排在已有规则后面，先命中先用） */
  addRule(rule: PushRule): void {
    const why = checkRules([rule]);
    if (why) throw new Error(`替身规则配错了：${why}`);
    this.rules.push({ rule, used: 0 });
  }

  clearRules(): void {
    this.rules = [];
  }

  /** 加一个假订阅方（之后的请求都会试着用它解） */
  addSubscriber(s: PushSubscriber): void {
    this.subscribers.push(s);
  }

  /** 清记录（不动规则和默认回复） */
  clearRequests(): void {
    this.requests.length = 0;
  }

  /** 等到收到至少 n 个请求（不含控制接口）；超时抛错 */
  waitForRequests(n: number, timeoutMs = 5000): Promise<void> {
    if (this.requests.length >= n) return Promise.resolve();
    return new Promise((ok, fail) => {
      const w = {
        n,
        ok: () => {
          clearTimeout(t);
          ok();
        },
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        fail(new Error(`等了 ${timeoutMs} 毫秒只收到 ${this.requests.length} 个请求，要 ${n} 个`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  // ---------- 进程内 ----------

  /** 当 deps.fetch 用：按真 fetch 的规矩处理 signal 和 redirect（follow 默认跟随，manual 原样回 3xx，error 抛 TypeError）；已中止的 signal 直接抛错、不记录 */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let req = new Request(input, init);
    if (req.signal.aborted) throw abortError(req.signal);
    let body = new Uint8Array(await req.arrayBuffer());
    for (let hop = 0; ; hop++) {
      const out = await this.serve({ method: req.method, url: req.url, headers: req.headers, body, viaRedirect: hop > 0 }, req.signal);
      if (out === null) throw abortError(req.signal);
      if (out === 'reset') return Response.error();
      const location = out.headers.get('location');
      if (!isRedirect(out.status) || location === null || req.redirect === 'manual') return out;
      if (req.redirect === 'error') throw new TypeError('fetch failed: redirect mode is error');
      if (hop >= 19) throw new TypeError('fetch failed: redirect count exceeded');
      const keep = out.status === 307 || out.status === 308 || (out.status !== 303 && req.method !== 'POST');
      if (!keep) body = new Uint8Array(0);
      req = new Request(new URL(location, req.url), {
        method: keep ? req.method : 'GET',
        headers: req.headers,
        redirect: req.redirect,
        signal: req.signal,
        ...(keep && body.length > 0 ? { body } : {}),
      });
    }
  };

  /** 只处理一个 Request，不跟随重定向（和端口模式下服务器收到的完全一样） */
  async handle(req: Request): Promise<Response> {
    if (req.signal.aborted) throw abortError(req.signal);
    const body = new Uint8Array(await req.arrayBuffer());
    const out = await this.serve({ method: req.method, url: req.url, headers: req.headers, body, viaRedirect: false }, req.signal);
    if (out === null) throw abortError(req.signal);
    return out === 'reset' ? Response.error() : out;
  }

  // ---------- 端口 ----------

  /** 只听 127.0.0.1；port 为 0 时随机分配。回 origin（http://127.0.0.1:<端口>） */
  async listen(port = 0): Promise<string> {
    if (this.server) throw new Error('已经在监听了');
    this.server = await LoopbackServer.start(port, (inc, signal) => {
      const path = new URL(inc.url).pathname;
      if (this.opt.control && path.startsWith(CONTROL_PREFIX) && path !== REDIRECT_TARGET) return this.controlApi(inc.method, path, inc.body);
      return this.serve(inc, signal);
    });
    this.origin = this.server.origin;
    return this.origin;
  }

  /**
   * 填给 PUSH_SERVICE_OVERRIDE_URL 的地址（安全审查 1.5 第 ② 点、D1-8）。替身本身仍只听 127.0.0.1，这里只换地址里的主机名：
   * 容器里的 edge runtime 用 'host.docker.internal'，宿主机上跑的用 '127.0.0.1' 或 'localhost'。
   * 生成的地址按 D1-8 的写法自查（端口 1024～65535、不带用户名、查询串和 #），不合格就抛错，免得测试拿一个函数会拒的地址去测
   */
  overrideUrl(host: '127.0.0.1' | 'localhost' | 'host.docker.internal' = '127.0.0.1', path = ''): string {
    if (!this.origin) throw new Error('还没 listen');
    const url = `http://${host}:${new URL(this.origin).port}${path}`;
    const m = /^http:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal):([0-9]{4,5})(\/[A-Za-z0-9._~:/=&+-]*)?$/.exec(url);
    const port = Number(m?.[2]);
    if (!m || port < 1024 || port > 65535) throw new Error(`替身地址不合 D1-8 的写法：${url}`);
    return url;
  }

  /** 停止：挂着的、拖着的请求一律断开（记 hung / aborted，closeReason = shutdown），端口释放 */
  async close(): Promise<void> {
    this.life.abort(new Error('fake push service closed'));
    const server = this.server;
    this.server = null;
    await server?.close();
  }

  /** 控制接口：GET requests（记录）、POST reset（清记录）、POST config（{ defaultReply?, delayMs?, rules?: 路径只能是前缀字符串 }，配错回 400） */
  private async controlApi(method: string, path: string, body: Uint8Array): Promise<Response> {
    const sub = path.slice(CONTROL_PREFIX.length);
    if (method === 'GET' && sub === 'requests') return Response.json(this.requests);
    if (method === 'POST' && sub === 'reset') {
      this.clearRequests();
      return new Response(null, { status: 204 });
    }
    if (method !== 'POST' || sub !== 'config') return new Response('not found', { status: 404 });
    let c: { defaultReply?: unknown; delayMs?: unknown; rules?: unknown };
    try {
      c = JSON.parse(new TextDecoder().decode(body)) as typeof c;
    } catch {
      return new Response('bad config: 不是 JSON', { status: 400 });
    }
    const why =
      (c.defaultReply !== undefined ? replyProblem(c.defaultReply) : null) ??
      (c.delayMs !== undefined ? delayProblem(c.delayMs) : null) ??
      (c.rules !== undefined ? checkRules(c.rules) : null);
    if (why) return new Response(`bad config: ${why}`, { status: 400 });
    if (c.defaultReply !== undefined) this.defaultReply = c.defaultReply as PushReply;
    if (c.delayMs !== undefined) this.delayMs = c.delayMs as number;
    if (c.rules !== undefined) this.rules = (c.rules as PushRule[]).map((rule) => ({ rule, used: 0 }));
    return new Response(null, { status: 204 });
  }

  // ---------- 核心 ----------

  private pick(path: string, rec: PushRequestRecord): PushRule | null {
    for (const r of this.rules) {
      const { path: p, subscriber: who, times } = r.rule;
      if (p !== undefined && !(typeof p === 'string' ? path.startsWith(p) : p.test(path))) continue;
      if (who !== undefined && who !== rec.subscriber?.p256dh && who !== rec.subscriber?.endpoint) continue;
      if (times !== undefined && r.used >= times) continue;
      r.used++;
      return r.rule;
    }
    return null;
  }

  private produce(r: PushReply, rec: PushRequestRecord): Outgoing {
    if (r.kind === 'hang') throw new Error('hang 回复不该走到 produce');
    if (r.kind === 'error') {
      rec.outcome = 'network-error';
      rec.respondedAt = this.now();
      return 'reset';
    }
    rec.outcome = 'replied';
    rec.status = r.status;
    rec.respondedAt = this.now();
    if (r.kind === 'status') return new Response(r.body ?? null, { status: r.status, headers: r.headers ?? {} });
    const total = r.bytes;
    rec.responseBytesSent = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: (ctrl) => {
          const sent = rec.responseBytesSent ?? 0;
          if (sent >= total) return ctrl.close();
          const n = Math.min(STREAM_CHUNK, total - sent);
          rec.responseBytesSent = sent + n;
          ctrl.enqueue(new Uint8Array(n).fill(0x61));
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { status: r.status, headers: { 'content-type': 'application/octet-stream' } });
  }

  private async serve(inc: Incoming, signal: AbortSignal): Promise<Outgoing> {
    const u = new URL(inc.url);
    const rec: PushRequestRecord = {
      seq: ++this.seq,
      receivedAt: this.now(),
      method: inc.method,
      url: inc.url,
      path: u.pathname,
      search: u.search,
      headers: headersObject(inc.headers),
      bodyBytes: inc.body.length,
      outcome: 'pending',
      status: null,
      respondedAt: null,
      clientClosedAt: null,
      closeReason: null,
      viaRedirect: inc.viaRedirect || u.pathname === REDIRECT_TARGET,
      vapid: null,
      subscriber: null,
      payload: null,
      responseBytesSent: null,
      error: null,
    };
    this.requests.push(rec);
    this.waiters = this.waiters.filter((w) => {
      if (this.requests.length < w.n) return true;
      w.ok();
      return false;
    });
    // 发送方断开、或替身关闭，都算“这个请求等不到回复了”；分开记原因（代码审查 S7）
    const stop = AbortSignal.any([signal, this.life.signal]);
    stop.addEventListener(
      'abort',
      () => {
        if (rec.outcome !== 'pending' && rec.outcome !== 'hung') return;
        rec.clientClosedAt = this.now();
        rec.closeReason = signal.aborted ? 'client' : 'shutdown';
        if (rec.outcome === 'pending') rec.outcome = 'aborted';
      },
      { once: true },
    );
    try {
      let r: PushReply;
      let extraDelay = 0;
      if (rec.viaRedirect && u.pathname === REDIRECT_TARGET) {
        r = reply.status(200, { 'content-type': 'text/plain' }, 'redirect followed');
      } else {
        const c = await checkPushRequest(inc, {
          subscribers: this.subscribers,
          vapid: this.opt.vapid,
          maxBodyBytes: this.opt.maxBodyBytes ?? 4096,
          nowSec: Math.floor(this.now() / 1000),
        });
        [rec.vapid, rec.subscriber, rec.payload] = [c.vapid, c.subscriber, c.payload];
        // 先检查再按规则选：被拒的请求不消耗规则次数（代码审查 S6）
        const rule = c.reject ? null : this.pick(u.pathname, rec);
        extraDelay = rule?.delayMs ?? 0;
        r = c.reject ?? rule?.reply ?? this.defaultReply;
      }
      if (!(await sleep(this.delayMs + extraDelay, stop))) return null;
      if (r.kind === 'hang') {
        rec.outcome = 'hung';
        await new Promise<void>((ok) => {
          if (stop.aborted) ok();
          else stop.addEventListener('abort', () => ok(), { once: true });
        });
        return null;
      }
      return this.produce(r, rec);
    } catch (e) {
      // 替身自己出错：回 500 并记下来，不让它变成未处理异常（代码审查 M4）
      rec.outcome = 'error';
      rec.status = 500;
      rec.respondedAt = this.now();
      rec.error = e instanceof Error ? e.message : String(e);
      return new Response(`fake push service error: ${rec.error}`, { status: 500 });
    }
  }
}

export function createFakePush(opt: FakePushOptions = {}): FakePushService {
  return new FakePushService(opt);
}
