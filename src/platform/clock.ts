// 时钟偏差（架构 4.3“时钟偏差”，第七轮；TC-B1-31）
// • 每次收到 /sb/ 的响应读响应头 Date：一次样本 = 服务器时间 − 本机收到响应的时间
// • clock_offset = 最近 5 次样本的中位数（一个离群值不影响）；绝对值小于 2 秒当 0（Date 头只精确到秒，不值得校）
// • 显示“现在”、倒计时、本机提醒判断都用 now() = Date.now() + clock_offset，统一从这里取；
//   outbox 的 client_ts 照常记本机时间（不经这里），不参与冲突判断
// • 偏差超过 5 分钟：isClockWrong() 为 true，设置 › 关于 显示“手机时间不准”
// • 喂样本：platform/http.ts 的 appFetch 收到 /sb/ 的响应时调 observeResponse(url, res.headers.get('Date'))（接线见接手清单 K8-clock）；
//   跨域时 Date 要在 Access-Control-Expose-Headers 里（架构 5.10），读不到就是 null，跳过
export const CLOCK_SAMPLES = 5;
/** 偏差小于这个当 0 */
export const CLOCK_IGNORE_MS = 2_000;
/** 偏差超过这个算“手机时间不准” */
export const CLOCK_WRONG_MS = 5 * 60_000;

/** 最近几次样本的中位数；绝对值小于 2 秒当 0；没有样本为 0（纯函数，单独测） */
export function offsetOf(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  return Math.abs(m) < CLOCK_IGNORE_MS ? 0 : Math.round(m);
}

/** 只认 /sb/ 的响应（Supabase 经转发层；别的站点的 Date 不可信、也不是我们的服务器） */
export function isSbUrl(url: string): boolean {
  try {
    return new URL(url, 'http://local.invalid').pathname.startsWith('/sb/');
  } catch {
    return false;
  }
}

export interface Clock {
  /** 记一次响应头 Date；localMs 默认本机现在。解析不了的忽略 */
  record(dateHeader: string | null | undefined, localMs?: number): void;
  /** 收到响应时调：不是 /sb/ 的、没有 Date 的忽略 */
  observeResponse(url: string, dateHeader: string | null | undefined): void;
  /** 服务器时间 − 本机时间（毫秒） */
  offset(): number;
  /** 校正后的现在（epoch ms） */
  now(): number;
  /** 偏差超过 5 分钟 */
  isClockWrong(): boolean;
  /** offset 变了时通知（设置 › 关于 用）；返回取消函数 */
  subscribe(fn: () => void): () => void;
  /** 测试用 */
  reset(): void;
}

export function createClock(localNow: () => number = () => Date.now()): Clock {
  let samples: number[] = [];
  let off = 0;
  const listeners = new Set<() => void>();
  const c: Clock = {
    record(dateHeader, localMs) {
      if (!dateHeader) return;
      const server = Date.parse(dateHeader);
      if (!Number.isFinite(server)) return;
      samples = [...samples, server - (localMs ?? localNow())].slice(-CLOCK_SAMPLES);
      const next = offsetOf(samples);
      if (next === off) return;
      off = next;
      for (const l of [...listeners]) l();
    },
    observeResponse(url, dateHeader) {
      if (isSbUrl(url)) c.record(dateHeader);
    },
    offset: () => off,
    now: () => localNow() + off,
    isClockWrong: () => Math.abs(off) > CLOCK_WRONG_MS,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    reset() {
      samples = [];
      off = 0;
    },
  };
  return c;
}

/** 全 App 共用的一个 */
export const clock: Clock = createClock();
