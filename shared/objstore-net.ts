// shared/objstore.ts 的网络一层（B0 第一轮评审返工拆出来，objstore.ts 超过 300 行）：
// 和运行环境之间的最小接口、错误类型、地址和超时的检查、带超时的 fetch、取消用不到的响应体。
// 和 objstore.ts 一样不碰全局 fetch、不读系统时间（A2、A12）；计时器用运行环境的 setTimeout（Workers、Deno、Node 都有）。
// 代码审查中 3（超时）、低 1（取消响应体）、低 2 / 安全审查低 3（deletePrefix 只认 <uuid>/）、安全审查低 2（非本机只许 https）

// ---------- 和运行环境之间的最小接口（shared 的 lib 里没有 DOM 类型，按结构写） ----------

export interface ObjHeaders {
  get(name: string): string | null;
}

export interface ObjResponse {
  status: number;
  headers: ObjHeaders;
  /** 流式响应体（Web ReadableStream）；只透传给调用方，这里不读 */
  body: unknown;
  text(): Promise<string>;
}

export interface ObjRequestInit {
  method: string;
  /** aws4fetch 签好的 Headers 对象，原样交给 fetch */
  headers: unknown;
  body?: unknown;
  /** Node（undici）发流式请求体要带 */
  duplex?: 'half';
  /** AbortSignal：超时时中止请求 */
  signal?: unknown;
}

export type ObjFetch = (url: string, init: ObjRequestInit) => Promise<ObjResponse>;

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_TRANSFER_TIMEOUT_MS = 30_000;

export type ObjStoreErrorCode =
  | 'exists' // 条件写：对象已存在（S3 回 412）
  | 'denied' // 403：令牌没有这个桶的权限
  | 'http' // 其他非预期状态码
  | 'network' // fetch 抛错
  | 'timeout' // 超过 timeoutMs / transferTimeoutMs 没回（请求已中止）
  | 'bad_response' // 响应体解析不了
  | 'bad_input' // 桶名、键、参数不合规（没发请求）
  | 'delete_partial' // DeleteObjects 有删失败的
  | 'not_empty'; // 删完再列一次，前缀下还有对象

export class ObjStoreError extends Error {
  readonly code: ObjStoreErrorCode;
  readonly status: number | null;
  constructor(code: ObjStoreErrorCode, status: number | null = null) {
    super(status === null ? `objstore_${code}` : `objstore_${code}_${status}`);
    this.name = 'ObjStoreError';
    this.code = code;
    this.status = status;
  }
}

/** deletePrefix 只认一个人的整个前缀：小写 uuid 加 /（安全审查低 3：防止少写 / 或传了更短的前缀删到别人） */
export const USER_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/;

/** 主机（可带端口，不带路径、用户名）；http 只许回环地址（安全审查低 2：UNSIGNED-PAYLOAD 的请求体不能明文过公网） */
const ENDPOINT_RE = /^(https|http):\/\/([^/?#@\s]+)$/;
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

export function checkEndpoint(endpoint: string): void {
  const m = ENDPOINT_RE.exec(endpoint);
  if (!m) throw new ObjStoreError('bad_input');
  if (m[1] === 'http' && !LOOPBACK_HOST_RE.test(m[2] ?? '')) throw new ObjStoreError('bad_input');
}

export function checkTimeout(ms: number | undefined, dflt: number): number {
  if (ms === undefined) return dflt;
  if (!Number.isInteger(ms) || ms < 1) throw new ObjStoreError('bad_input');
  return ms;
}

// ---------- 计时器和中止（shared 的 lib 里没有 DOM 类型；Workers、Deno、Node 都有这几个全局） ----------

interface Abortable {
  readonly signal: unknown;
  abort(): void;
}

interface TimerGlobals {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  AbortController?: new () => Abortable;
}

const G = globalThis as unknown as TimerGlobals;

/** 取消用不到的响应体；没有体、已读完、已取消都不报错 */
export function discard(res: ObjResponse): void {
  const body = res.body as { cancel?: () => Promise<unknown> } | null | undefined;
  if (!body || typeof body.cancel !== 'function') return;
  try {
    void body.cancel().catch(() => {});
  } catch {
    // 已锁定的流：忽略
  }
}

/**
 * 发请求，并在 ms 毫秒内跑完 then（拿到响应后的处理：判断状态码、需要时读响应体）。
 * 超时：中止请求（init.signal）、抛 timeout；超时后才回来的响应把体取消掉。then 抛错（不读体的出错分支）时也取消响应体。
 */
export async function timedFetch<T>(
  fetch: ObjFetch,
  url: string,
  init: ObjRequestInit,
  ms: number,
  then: (res: ObjResponse) => Promise<T> | T,
): Promise<T> {
  const ac = G.AbortController ? new G.AbortController() : null;
  if (ac) init.signal = ac.signal;
  let timedOut = false;
  let timer: unknown;
  const deadline = new Promise<never>((_, reject) => {
    timer = G.setTimeout(() => {
      timedOut = true;
      ac?.abort();
      reject(new ObjStoreError('timeout'));
    }, ms);
  });
  const work = (async () => {
    let res: ObjResponse;
    try {
      res = await fetch(url, init);
    } catch {
      throw new ObjStoreError(timedOut ? 'timeout' : 'network');
    }
    if (timedOut) {
      discard(res);
      throw new ObjStoreError('timeout');
    }
    try {
      return await then(res);
    } catch (e) {
      discard(res);
      if (e instanceof ObjStoreError) throw e;
      throw new ObjStoreError(timedOut ? 'timeout' : 'network');
    }
  })();
  work.catch(() => {}); // 超时以后 work 才失败：不留未处理的拒绝
  try {
    return await Promise.race([work, deadline]);
  } finally {
    G.clearTimeout(timer);
  }
}
