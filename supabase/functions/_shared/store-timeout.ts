// 函数的 store 调用超时（接手清单 INVITE-store-timeout；做法照 account/store-timeout.ts，架构 0.47 第 22 条、安全复核 T1～T3）。
// supabase-js 的查询和 rpc 本身不设超时，库或网络卡住时请求会一直挂到运行时掐掉。每次调用新建一个 AbortController，
//   把 signal 交给 make(signal)（各查询挂 .abortSignal(signal)），到点 abort 并抛 StoreTimeout；默认 10 秒。
// 超时只记 store_timeout:<方法名>，不带参数（参数里有计数键、邮箱哈希、码哈希、user_id）。
// 中止的只是 HTTP 请求，库里的语句可能稍后仍提交——调用方按“可能做了、也可能没做”收尾。
// account、invite-signup、invite-admin 都用这一份（account 的 export_size_over 另建一个 20 秒档的 storeTimer）；全仓只有这一个 StoreTimeout 类。
// 不 import npm 包、不碰 Deno 全局，Vitest 直接测。

export const STORE_TIMEOUT_MS = 10_000;

/** store 调用超时：只带方法名 */
export class StoreTimeout extends Error {
  readonly method: string;
  constructor(method: string) {
    super('store_timeout');
    this.method = method;
  }
}

export interface StoreTimeoutOpts {
  /** 超时（毫秒），测试换小值 */
  ms?: number;
  log?: ((code: string) => void) | undefined;
}

/**
 * 返回 t(method, f)：f 拿到 make(signal) 建出来的 store 去调；到点 abort、记日志、抛 StoreTimeout。
 * 成功、出错、超时三条路都清掉计时器。make 每次调用都新建一个 store（makeStore 只是一组闭包，代价可忽略）。
 */
export function storeTimer<S>(make: (signal: AbortSignal) => S, opts: StoreTimeoutOpts = {}) {
  const ms = opts.ms ?? STORE_TIMEOUT_MS;
  return function t<R>(method: string, f: (s: S) => Promise<R>): Promise<R> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        opts.log?.(`store_timeout:${method}`);
        reject(new StoreTimeout(method));
      }, ms);
    });
    const work = Promise.resolve().then(() => f(make(ctl.signal)));
    work.catch(() => {});   // 超时先赢以后底下再报错（abort 引起的）不算未处理
    return Promise.race([work, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  };
}
