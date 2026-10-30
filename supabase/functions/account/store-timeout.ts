// account 的 store 调用一律带超时（架构 0.47 第 22 条；安全复核 T1～T3）。
// supabase-js 的查询和 rpc 本身不设超时，库或网络卡住时请求会一直挂到运行时掐掉，start 已扣的当天次数就走不到退回。
// 做法：index.ts 建 store 时套一层——每次调用新建一个 AbortController，把它的 signal 交给 makeStore（各查询挂 .abortSignal(signal)），
//   到点就 abort 并抛 StoreTimeout；默认 10 秒，export_size_over 20 秒（必须大于它自己的 15 秒预算，让函数内的“提前返回 -1”先生效）。
//   requireActiveUser 的 2 秒在 _shared/auth.ts，不经这里。
// 超时按临时性失败处理，调用方怎么收尾见 export.ts（start：扣次数前直接 try_later，扣了之后走 fail() 退回并删任务行）、
//   export-part.ts（try_later、不退分片数）、core.ts（delete、restore try_later、不退次数）。
// T3：超时只记 store_timeout:<方法名>，不带参数（参数里有 user_id、export_id、计数键）。
// 每个方法逐个写出来（不用方括号按名字取，check_backend F7）；返回值标成 AccountStore，少包一个方法类型检查就报。
// 和 core.ts 同样的约束：不 import npm 包、不碰 Deno 全局，Vitest 直接测。

import type { AccountStore } from './common.ts';

export const STORE_TIMEOUT_MS = 10_000;
/** export_size_over 单独一档：20 秒（> EXPORT_LIMITS.sizeCheckBudgetMs 15 秒） */
export const STORE_SIZE_TIMEOUT_MS = 20_000;

/** store 调用超时：只带方法名（T3） */
export class StoreTimeout extends Error {
  readonly method: string;
  constructor(method: string) {
    super('store_timeout');
    this.method = method;
  }
}

export interface StoreTimeoutOpts {
  /** 默认档（毫秒），测试换小值 */
  ms?: number;
  /** export_size_over 那一档（毫秒），测试换小值 */
  sizeMs?: number;
  log?: ((code: string) => void) | undefined;
}

/**
 * 给 store 的每个方法套超时。make(signal) 每次调用都新建一个 store（makeStore 只是一组闭包，代价可忽略），
 * 这一次调用里的查询都挂这个 signal；到点 abort，同时不管底下回不回都先抛 StoreTimeout（桩 store 不认 signal 也一样到点结束）。
 * 中止的只是 HTTP 请求，库里的语句可能稍后仍提交（架构第 22 条“已知取舍”）
 */
export function withStoreTimeouts(make: (signal: AbortSignal) => AccountStore, opts: StoreTimeoutOpts = {}): AccountStore {
  const base = opts.ms ?? STORE_TIMEOUT_MS;
  const sizeMs = opts.sizeMs ?? STORE_SIZE_TIMEOUT_MS;
  function run<R>(method: string, ms: number, f: (s: AccountStore) => Promise<R>): Promise<R> {
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
  }
  const t = <R>(method: string, f: (s: AccountStore) => Promise<R>) => run(method, base, f);
  return {
    isAdmin: (u) => t('isAdmin', (s) => s.isAdmin(u)),
    takeRate: (k, l, w) => t('takeRate', (s) => s.takeRate(k, l, w)),
    refundRate: (k) => t('refundRate', (s) => s.refundRate(k)),
    peekRate: (k) => t('peekRate', (s) => s.peekRate(k)),
    deleteCounterKey: (k) => t('deleteCounterKey', (s) => s.deleteCounterKey(k)),
    exportSizeOver: (u, m, l, b) => run('exportSizeOver', sizeMs, (s) => s.exportSizeOver(u, m, l, b)),
    exportJobStart: (u, e, m, sid) => t('exportJobStart', (s) => s.exportJobStart(u, e, m, sid)),
    exportJobTake: (u, e, m, sid, max, ttl) => t('exportJobTake', (s) => s.exportJobTake(u, e, m, sid, max, ttl)),
    requestDeletion: (u) => t('requestDeletion', (s) => s.requestDeletion(u)),
    restore: (u) => t('restore', (s) => s.restore(u)),
    profile: (u) => t('profile', (s) => s.profile(u)),
    deviceLabel: (u, d) => t('deviceLabel', (s) => s.deviceLabel(u, d)),
    insertLog: (u, row) => t('insertLog', (s) => s.insertLog(u, row)),
    exportDoneLogged: (u, e) => t('exportDoneLogged', (s) => s.exportDoneLogged(u, e)),
    exportStarted: (u, e) => t('exportStarted', (s) => s.exportStarted(u, e)),
    readPage: (tb, k, u, after, limit) => t('readPage', (s) => s.readPage(tb, k, u, after, limit)),
  };
}
