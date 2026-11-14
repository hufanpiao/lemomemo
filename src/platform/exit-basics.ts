// 退出流程里首屏也要用的几样（本机库名、删库、超时、withTimeout、清本机痕迹）：首屏只引这里，platform/sign-out.ts 本体不进首屏
// 不变量：退出、换账号清 localStorage 里账号留下的痕迹只走 forgetAccountLocal（core/account.ts 的 wipeLocal、claimCache，
// core/boot.ts 没会话的冷启动，platform/sign-out.ts 的 wipeThisDevice）；调用方不再各自补 clearLogQueue
import { clearLogQueue } from './log-store.ts';
// 不变量：WIPE_TIMEOUT_MS、CACHES_TIMEOUT_MS、DELETE_WAIT_MS 只在这里定义（core/account.ts、platform/sign-out.ts 都从这里引）
/** 本机库名（= core/cache.ts 的 DB_NAME；platform 不引 core，测试守着两边一致） */
export const LOCAL_DB_NAME = 'planner-v4';
/** 删库最多等多久（别的标签页开着库时浏览器会等它关） */
export const DELETE_WAIT_MS = 3000;
/** 清本机库最多等多久，超时改按库名删库 */
export const WIPE_TIMEOUT_MS = 3000;
/** 清 Cache Storage（运行时缓存）最多等多久 */
export const CACHES_TIMEOUT_MS = 2000;

/** 这台设备缓存的外观（皮肤、深浅色、两个开关、字体；platform/look.ts 读写）。定义在这里：清本机痕迹要删它，
 *  引 look.ts 本身会当场套一次皮肤 */
export const LOOK_CACHE_KEY = 'pv-look';
/** 隐私记附件交不交给微软预览的同意（core/ms-pref.ts 读写）：换人以后要重新问（第三方审查第 13 条）；普通附件那份是设备级，不清 */
export const MS_VAULT_PREF_KEY = 'att.ms_preview_vault';

/**
 * 退出、换账号时清掉 localStorage 里上一个账号留下的痕迹：外观缓存（下一个账号从默认外观开始，皮肤整块评审第 13 条）、
 * 隐私记预览同意、日志上传队列（给 userId 只清这个账号的，null 清全部，false 不动：换账号时由 main 的 clearOtherLogQueues 清）。不抛
 */
export function forgetAccountLocal(logsOf: string | null | false): void {
  try {
    localStorage.removeItem(LOOK_CACHE_KEY);
    localStorage.removeItem(MS_VAULT_PREF_KEY);
  } catch {
    // 隐私模式读写不了：本来也没存下
  }
  if (logsOf !== false) clearLogQueue(logsOf);
}

/**
 * 到点还没返回就用 fallback() 的值；run 抛错（同步或异步）也用 fallback()。fallback 只给值，不要有副作用。
 * 原来的请求不取消：它在超时以后才回来时调一次 onLate
 */
export function withTimeout<T>(run: () => Promise<T>, ms: number, fallback: () => T, onLate?: () => void): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const req = Promise.resolve().then(run);
  const late = (): void => {
    if (timedOut) onLate?.();
  };
  req.then(late, late);
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(fallback());
    }, ms);
  });
  return Promise.race([req.catch(() => fallback()), timeout]).finally(() => clearTimeout(timer));
}

export type DeleteDbResult = 'deleted' | 'blocked' | 'error' | 'unavailable';

/** 按库名删掉本机库；永远 resolve。别的标签页没关库（blocked）时最多等 waitMs，删库请求留在浏览器里，那边一关就删 */
export function deleteLocalDb(
  factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
  name: string = LOCAL_DB_NAME,
  waitMs: number = DELETE_WAIT_MS,
): Promise<DeleteDbResult> {
  if (!factory) return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: DeleteDbResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish('blocked'), waitMs);
    try {
      const req = factory.deleteDatabase(name);
      req.onsuccess = () => finish('deleted');
      req.onerror = () => finish('error');
    } catch {
      finish('error');
    }
  });
}
