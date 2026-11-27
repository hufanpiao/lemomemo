// 退出流程里首屏也要用的几样（本机库名、删库、超时、withTimeout、清本机痕迹、清本机入口 wipeThisDevice）：首屏只引这里，platform/sign-out.ts 本体不进首屏
// 不变量：清本机只有 wipeThisDevice 一个入口、一套超时（core/account.ts 的 wipeLocal 只给它配上本页的库）
// 不变量：退出、换账号清 localStorage 里账号留下的痕迹只走 forgetAccountLocal；调用方不各自补 clearLogQueue
import { LOCAL_DB_NAME } from '../../shared/local-db.ts';
import { clearReauth } from './auth-loss-store.ts';
import { clearLogQueue } from './log-store.ts';
import { rlog } from './run-log-api.ts';
// 不变量：WIPE_TIMEOUT_MS、CACHES_TIMEOUT_MS、DELETE_WAIT_MS 只在这里定义；本机库名只在 shared/local-db.ts（调用方直接引那里）
/** 删库最多等多久（别的标签页开着库时浏览器会等它关） */
export const DELETE_WAIT_MS = 3000;
/** 清本机库最多等多久，超时改按库名删库 */
export const WIPE_TIMEOUT_MS = 3000;
/** 清 Cache Storage（运行时缓存）最多等多久 */
export const CACHES_TIMEOUT_MS = 2000;

/** 这台设备缓存的外观（look.ts 读写）。定义在这里：引 look.ts 本身会当场套一次皮肤 */
export const LOOK_CACHE_KEY = 'pv-look';
/** 隐私记附件交不交给微软预览的同意：换人以后要重新问；普通附件那份是设备级，不清 */
export const MS_VAULT_PREF_KEY = 'att.ms_preview_vault';
/** 今天页天气在本机记的城市、粗坐标、天气包（weather-store.ts 读写）。定义在这里：引 weather-store.ts 会把 zod 带进首屏 */
export const WX_LOCAL_KEY = 'lemo.wx';

/**
 * 退出、换账号时清掉上一个账号留下的痕迹：外观缓存、隐私记预览同意、天气的城市和坐标、日志上传队列
 * （给 userId 只清这个账号的，null 清全部，false 不动：换账号时由 main 的 clearOtherLogQueues 清）。不抛
 */
export function forgetAccountLocal(logsOf: string | null | false): void {
  try {
    localStorage.removeItem(LOOK_CACHE_KEY);
    localStorage.removeItem(MS_VAULT_PREF_KEY);
    localStorage.removeItem(WX_LOCAL_KEY);
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
  return new Promise<T>((resolve) => {
    const req = Promise.resolve().then(run);
    const timer = setTimeout(() => {
      if (onLate) req.then(onLate, onLate);
      resolve(fallback());
    }, ms);
    req.then(resolve, () => resolve(fallback())).finally(() => clearTimeout(timer));
  });
}

export type DeleteDbResult = 'deleted' | 'blocked' | 'error' | 'unavailable';

/** 按库名删掉本机库；永远 resolve。别的标签页没关库（blocked）时最多等 waitMs，删库请求留在浏览器里，那边一关就删 */
export function deleteLocalDb(
  factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
  name: string = LOCAL_DB_NAME,
  waitMs: number = DELETE_WAIT_MS,
): Promise<DeleteDbResult> {
  if (!factory) return Promise.resolve('unavailable');
  const run = (): Promise<DeleteDbResult> =>
    new Promise((resolve) => {
      try {
        const req = factory.deleteDatabase(name);
        req.onsuccess = () => resolve('deleted');
        req.onerror = () => resolve('error');
      } catch {
        resolve('error');
      }
    });
  return withTimeout(run, waitMs, () => 'blocked');
}

/** 清本机的几步（wipeThisDevice 用；测试换掉） */
export interface WipeSteps {
  /** 主 App：先设闸再清空本机库和内存集合；出错、超时照样往下按库名删库。登录页不传 */
  wipe?(): Promise<unknown>;
  /** 按库名删库（默认 deleteLocalDb；主 App 先关本页连接，免得本页自己收到 versionchange） */
  deleteDb(): Promise<unknown>;
  clearCacheStorage(): Promise<void>;
  /** 断开浏览器推送：关掉已显示的通知、退订（push-disconnect.ts 的 disconnectPushLazy，自带上限）。在清库之后、删库之前调 */
  disconnectPush?(): Promise<void>;
  /** 记一条日志（只有 act：删不掉 lemo.reauth 时记 auth_loss_store_failed）；不填不记 */
  log?(act: string): void;
}

/** 到点或出错都回 false，按时做完回 true；原来的操作不取消 */
export const withinLimit = (run: () => Promise<unknown>, ms: number): Promise<boolean> => withTimeout(async () => (await run(), true), ms, () => false);

/**
 * 清本机的唯一入口（架构约定 10.1）：删 lemo.reauth → 设闸清库 → 断开推送 → 按库名删库（一律删）→ 清 Cache Storage
 * → forgetAccountLocal(logsOf)。某一步失败或超时不挡后面，永远 resolve；最坏约 10 秒。运行日志记一行各步结果（不记账号）
 */
export async function wipeThisDevice(
  steps: WipeSteps, logsOf: string | null = null, wipeMs = WIPE_TIMEOUT_MS, cachesMs = CACHES_TIMEOUT_MS, deleteMs = DELETE_WAIT_MS,
): Promise<void> {
  // 删不掉时下次冷启动登录页会再查 session_fate
  const reauth = clearReauth();
  if (!reauth) steps.log?.('auth_loss_store_failed');
  const { wipe } = steps;
  const cleared = wipe ? await withinLimit(wipe, wipeMs) : null;
  // 通知中心不留上一个账号的标题、旧账号的推送不再到达；这里再兜一层异常
  try {
    await steps.disconnectPush?.();
  } catch {
    // 断不开不挡退出
  }
  // 清完也按库名删：本机不留库文件；清库卡住、出错时靠它清掉
  const dropped = await withinLimit(() => steps.deleteDb(), deleteMs);
  const caches = await withinLimit(() => steps.clearCacheStorage(), cachesMs);
  forgetAccountLocal(logsOf);
  rlog(`wipe app=${cleared ?? '-'} db=${dropped} caches=${caches} reauth=${reauth}`);
}
