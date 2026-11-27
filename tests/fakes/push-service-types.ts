// 本机推送替身的类型和回复写法（push-service.ts 用、也从那里再导出）：回复、规则、选项、请求记录，以及回复的合法性检查
import type { PushSubscriber, VapidResult } from './push-service-vapid.ts';

/** 替身怎么回一个请求 */
export type PushReply =
  | { kind: 'status'; status: number; headers?: Record<string, string>; body?: string }
  | { kind: 'hang' }
  /** 进程内回 Response.error()（status 0、type 'error'）；端口模式下直接断开连接（发送方 fetch 抛错）。测 D1-4“状态 0 算失败” */
  | { kind: 'error' }
  /** 一个很大的响应体，按读取进度一块一块给出，记下发出了多少字节。测 D1-4“响应体最多读 1 KB 后 cancel()” */
  | { kind: 'stream'; status: number; bytes: number };

/** 3xx 默认跳到这里（替身自己），发送方跟随了就能在记录里看到 */
export const REDIRECT_TARGET = '/__fake/redirect-target';
/** 控制接口的前缀（只在 control: true 时生效；这个前缀下的请求不记录，REDIRECT_TARGET 除外） */
export const CONTROL_PREFIX = '/__fake/';
/** 流式响应体每块的字节数 */
export const STREAM_CHUNK = 256;

export const reply = {
  /** 推送服务收下了（真 FCM、Mozilla 回 201 并带 Location） */
  created: (): PushReply => ({ kind: 'status', status: 201, headers: { location: '/m/fake-message-id' } }),
  /** 订阅不存在 */
  notFound: (): PushReply => ({ kind: 'status', status: 404 }),
  /** 订阅已失效 */
  gone: (): PushReply => ({ kind: 'status', status: 410 }),
  /** 限流；retryAfter 是秒数或 HTTP 日期 */
  tooMany: (retryAfter: number | string = 30): PushReply => ({ kind: 'status', status: 429, headers: { 'retry-after': String(retryAfter) } }),
  /** 重定向；Location 默认指回替身的 REDIRECT_TARGET（相对地址，端口模式下真 fetch 会按请求地址解析） */
  redirect: (location: string = REDIRECT_TARGET, status: 301 | 302 | 303 | 307 | 308 = 307): PushReply => ({
    kind: 'status',
    status,
    headers: { location },
  }),
  /** 任意状态码（200～599），例如 401、403（VAPID 对不上）、413、500 */
  status: (status: number, headers?: Record<string, string>, body?: string): PushReply => ({
    kind: 'status',
    status,
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  }),
  /** 挂住不回：一直不发响应，直到发送方放弃（测 5 秒超时）或 close() */
  hang: (): PushReply => ({ kind: 'hang' }),
  /** 网络错误：进程内回 Response.error()，端口模式断开连接 */
  error: (): PushReply => ({ kind: 'error' }),
  /** 很大的响应体（默认 1 MB），记录发出了多少字节 */
  bigBody: (bytes = 1024 * 1024, status = 201): PushReply => ({ kind: 'stream', status, bytes }),
};

const NULL_BODY = new Set([204, 205, 304]);

/** 回复合不合法；不合法回原因（代码审查 M4：配错的回复不能变成未处理异常、把连接挂住） */
export function replyProblem(r: unknown): string | null {
  if (typeof r !== 'object' || r === null) return '回复要是对象';
  const x = r as { kind?: unknown; status?: unknown; headers?: unknown; body?: unknown; bytes?: unknown };
  if (x.kind === 'hang' || x.kind === 'error') return null;
  if (x.kind !== 'status' && x.kind !== 'stream') return `不认识的 kind：${String(x.kind)}`;
  if (typeof x.status !== 'number' || !Number.isInteger(x.status) || x.status < 200 || x.status > 599) return `状态码要是 200～599 的整数：${String(x.status)}`;
  if (x.kind === 'stream') {
    if (typeof x.bytes !== 'number' || !Number.isInteger(x.bytes) || x.bytes < 1) return 'bytes 要是正整数';
    if (NULL_BODY.has(x.status)) return `${x.status} 不能带响应体`;
    return null;
  }
  if (x.body !== undefined && typeof x.body !== 'string') return 'body 要是字符串';
  if (x.body !== undefined && NULL_BODY.has(x.status)) return `${x.status} 不能带响应体`;
  if (x.headers !== undefined) {
    if (typeof x.headers !== 'object' || x.headers === null) return 'headers 要是对象';
    for (const v of Object.values(x.headers)) if (typeof v !== 'string') return 'headers 的值要是字符串';
  }
  return null;
}

export function assertReply(r: PushReply): PushReply {
  const why = replyProblem(r);
  if (why) throw new Error(`替身回复配错了：${why}`);
  return r;
}

export interface PushRule {
  /** 字符串按路径前缀匹配，正则按路径（不含查询串）匹配；不写不限路径 */
  path?: string | RegExp;
  /** 按订阅方匹配：等于命中订阅方的 p256dh 或 endpoint（解开负载才知道是谁，要配 subscribers）；不写不限订阅方 */
  subscriber?: string;
  reply: PushReply;
  /** 命中这条规则时额外再拖多少毫秒（加在全局 delayMs 上） */
  delayMs?: number;
  /** 只生效几次，用完就跳过（例如“第一次 429、之后 201”）。被 VAPID 等检查拒掉的请求不消耗次数 */
  times?: number;
}

export interface FakeVapidOptions {
  /** 不过就回 403（验签、aud、exp、sub）或 400（缺 TTL、编码、头不对、解不开）；默认 true。false 时只记录 */
  enforce?: boolean;
  /**
   * 认哪些 aud。默认绑定本次请求的源（代码审查 M1、安全审查 D1-6）：进程内用请求地址的源；端口模式用解开负载的那个订阅方的 endpoint 的源；
   * 端口模式下订阅方必须带 endpoint：没带（或没配订阅方）时不放行，记 aud_unbound、回 403（复核 N3）。替身自己的地址（含 host.docker.internal）一律不认（D1-8）。
   * expected 是按上面算出来的期望源（拿不到时 null）
   */
  audienceOk?: (aud: string, expected: string | null) => boolean;
  /** exp 最多比现在晚多少秒，默认 12 小时（架构审 D1 第 4 点） */
  maxExpiresInSec?: number;
  /** 要求 k 等于这把公钥（base64url） */
  publicKey?: string;
  /** 要求带 TTL 头（真推送服务都要），默认 true */
  requireTtl?: boolean;
}

export interface FakePushOptions {
  /** 没命中规则时怎么回，默认 reply.created() */
  defaultReply?: PushReply;
  /** 每个请求统一拖多少毫秒再回（D3 第 6 点用 3000）；只收非负的有限数，不合格构造时抛错（复核 N2） */
  delayMs?: number;
  rules?: PushRule[];
  /**
   * 假订阅方：给了就解每个请求的负载，记下是谁、明文是什么，规则能按订阅方匹配。请求路径等于某个订阅方 endpoint 的路径时先试它。
   * 端口模式下开 VAPID 时每个订阅方都要带 endpoint（aud 按它绑，复核 N3）。
   * 造数据按“少量设备、每台多条”（复核 N1）：端口模式下每个请求要把订阅方挨个试解，例如每人每分钟最多 20 条，300 条约 15 台设备，
   * 别 300 条配 300 个订阅方，免得把 TC-B2-81 的 25 秒计时拖慢
   */
  subscribers?: readonly PushSubscriber[];
  /** 不写就不验 VAPID */
  vapid?: FakeVapidOptions;
  /** 请求体超过多少字节回 413（推送服务的上限是 4096），默认 4096 */
  maxBodyBytes?: number;
  /** 端口模式下开 /__fake/ 控制接口（命令行入口用；替身跑在另一个进程时，测试经它取记录、改配置） */
  control?: boolean;
  /** 毫秒时钟，默认 Date.now。只影响记录的时刻和 VAPID 的“现在”；拖延用全局 setTimeout，不跟它走 */
  now?: () => number;
}

/** pending：还在拖；replied：回了；hung：按 hang 不回；aborted：拖的时候等不到了；network-error：按 error 回；error：替身自己出错、回了 500 */
export type PushOutcome = 'pending' | 'replied' | 'hung' | 'aborted' | 'network-error' | 'error';

export interface PushRequestRecord {
  seq: number;
  /** 收到的时刻（毫秒） */
  receivedAt: number;
  method: string;
  url: string;
  path: string;
  search: string;
  /** 请求头，键一律小写 */
  headers: Record<string, string>;
  bodyBytes: number;
  outcome: PushOutcome;
  status: number | null;
  respondedAt: number | null;
  /** 等不到回复的时刻（超时测试用：clientClosedAt − receivedAt 约等于发送方的超时） */
  clientClosedAt: number | null;
  /** 为什么等不到：client 是发送方放弃或断开，shutdown 是替身 close() 了（代码审查 S7） */
  closeReason: 'client' | 'shutdown' | null;
  /** 这一跳是跟随重定向来的（发送方没写 redirect: 'manual'） */
  viaRedirect: boolean;
  /** 没开 VAPID 校验时是 null */
  vapid: VapidResult | null;
  /** 解开负载的是哪个订阅方（subscribers 里的序号、p256dh、endpoint）；没给 subscribers 或解不开时是 null */
  subscriber: { index: number; p256dh: string; endpoint: string | null } | null;
  /** 解出来的明文负载 */
  payload: string | null;
  /** stream 回复发出了多少字节（进程内是发送方实际读走的；端口模式是写进连接的，含 TCP 缓冲，偏大） */
  responseBytesSent: number | null;
  /** outcome 为 error 时的错误信息 */
  error: string | null;
}
