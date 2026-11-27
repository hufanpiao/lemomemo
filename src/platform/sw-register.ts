// Service Worker 的按需下载和注册（这类事只在这里做）：sw.js 放在 /app/，scope 只管 /app/。
// 不变量：sw-lifecycle.ts 只经 loadSwLifecycle 一个加载器下载；注册不设超时、等真实结果，结果和耗时记一行运行日志。
// navigator.serviceWorker 只准出现在 platform；exe（Tauri）里不注册，判断在 sw-lifecycle.ts 读 env.ts 的 isTauri
import { errName } from './env.ts';
import { withTimeout } from './exit-basics.ts';
import type { Lifecycle } from './net.ts';
import { rlog } from './run-log-api.ts';
import type * as SwLifecycle from './sw-lifecycle.ts';

export const SW_URL = '/app/sw.js';
export const SW_SCOPE = '/app/';

/** 本机库来自更新版本时整屏提示渲染前最多等注册这么久（不白屏）；“更新”按钮每次下载 sw-lifecycle.ts 也最多等这么久 */
export const SW_REGISTER_WAIT_MS = 3000;

/** “更新”时等新 SW 装好、接管的最长时间（主路径和退路 skipWaitingDirect 共用，时长必须一致） */
export const SW_UPDATE_WAIT_MS = 30_000;

/**
 * “更新”按钮的结果：reloading = 新 SW 已接管，调用方重新载入；no_update = 没有新版本；
 * failed = 没查成或新 SW 安装失败；takeover_timeout = 查到了新 SW，但没装好或发了 SKIP_WAITING 后没接管
 */
export type SwUpdateResult = 'reloading' | 'no_update' | 'failed' | 'takeover_timeout' | 'unsupported';

/** sw-lifecycle.ts 的导出（按需下载） */
export type SwLifecycleModule = typeof SwLifecycle;

const importLifecycle = (): Promise<SwLifecycleModule> => import('./sw-lifecycle.ts');

/** 跑一次下载：失败回 null；给了 waitMs 就最多等这么久（到点回 null；超时工具只有 exit-basics.ts 的 withTimeout 一份） */
function attempt(load: () => Promise<SwLifecycleModule>, waitMs: number | undefined): Promise<SwLifecycleModule | null> {
  return waitMs === undefined ? Promise.resolve().then(load).catch(() => null) : withTimeout<SwLifecycleModule | null>(load, waitMs, () => null);
}

export interface SwLoadOptions {
  /** 每次下载最多等多久；不给就等到真实结果 */
  waitMs?: number;
  /** 原地址拿不到时换个地址再下载一次（有的浏览器记住失败的动态 import，同一地址一直失败；“更新”按钮用） */
  retry?: boolean;
  /** 测试用：换掉原地址、换地址两种下载 */
  load?: () => Promise<SwLifecycleModule>;
  fresh?: () => Promise<SwLifecycleModule>;
}

/** 下载 sw-lifecycle.ts（唯一的加载器）：拿不到回 null，永远 resolve、不抛 */
export async function loadSwLifecycle(o: SwLoadOptions = {}): Promise<SwLifecycleModule | null> {
  const m = await attempt(o.load ?? importLifecycle, o.waitMs);
  return m ?? (o.retry ? attempt(o.fresh ?? importLifecycleFresh, o.waitMs) : null);
}

export interface SwRegisterDeps {
  /** SW 在后台装好了新版本（watchServiceWorkerUpdate 的回调）；不给就不盯 */
  onReady?: () => void;
  /** platform/net.ts 的 browserLifecycle：给了才在回到前台时查新版本 */
  life?: Pick<Lifecycle, 'onVisibility' | 'isOnline'>;
  /** 测试用：换掉下载 sw-lifecycle.ts */
  load?: () => Promise<SwLifecycleModule>;
}

/**
 * 下载 sw-lifecycle.ts 后注册 SW（app/main.tsx 调）：下载、注册都不设超时，晚到照常注册、挂监听；结果和耗时记运行日志。
 * 拿到注册后再按 d 挂“有新版本”和回到前台查新版本，两个监听各自接住抛错。下载失败、注册失败、exe、不支持都回 null，永远 resolve
 */
export async function registerSw(d: SwRegisterDeps = {}): Promise<ServiceWorkerRegistration | null> {
  const t0 = Date.now();
  const took = (): string => `${Date.now() - t0}ms`;
  const sw = await loadSwLifecycle(d.load ? { load: d.load } : {});
  if (!sw) {
    rlog(`sw register fail load ${took()}`);
    return null;
  }
  let reg: ServiceWorkerRegistration | null;
  try {
    reg = await sw.registerServiceWorker();
  } catch (e) {
    rlog(`sw register fail ${errName(e) || typeof e} ${took()}`); // 只记名字，不记 message（可能带网址）
    return null;
  }
  rlog(`sw register ${reg ? 'ok' : 'skip'} ${took()}`);
  if (!reg) return null;
  if (d.onReady) {
    try {
      sw.watchServiceWorkerUpdate(reg, d.onReady);
    } catch {
      // 只是少了“有新版本”提示
    }
  }
  if (d.life) {
    try {
      // 切到前台、在线、距上次查满 1 小时才主动查新版本
      sw.checkSwOnForeground(reg, { life: d.life });
    } catch {
      // 只是少了回到前台时的主动检查
    }
  }
  return reg;
}

/**
 * 加载器换地址那次的地址：从 src（importLifecycle 打包后的源码）里取 import(…) 括号里的地址，按 base 解析，
 * 加查询串 r 换成新地址；只认同源，取不到回 null
 */
export function freshLifecycleUrl(src: string, base: string, stamp: string): string | null {
  // 压缩后的产物用反引号，开发时是双引号：三种引号都认。写成十六进制转义，check_arch 的字符串扫描才不会把后面的注释当成字符串
  const m = /import\(\s*[\x22\x27\x60]([^\x22\x27\x60$]+)[\x22\x27\x60]\s*\)/.exec(src);
  if (!m?.[1]) return null;
  // base 是本模块自己的地址（import.meta.url），new URL 不会抛
  const u = new URL(m[1], base);
  if (u.origin !== new URL(base).origin) return null;
  u.searchParams.set('r', stamp);
  return u.href;
}

// 换地址下载会生成第二份 sw-lifecycle 模块实例：给 sw-lifecycle.ts 加模块级状态时要考虑两份并存
function importLifecycleFresh(): Promise<SwLifecycleModule> {
  const url = freshLifecycleUrl(importLifecycle.toString(), import.meta.url, String(Date.now()));
  return url ? import(/* @vite-ignore */ url) : Promise.reject();
}

/**
 * “更新”的退路：不靠 sw-lifecycle.ts，本页 scope 有等着接管的新 SW（waiting，就是 SW_URL）才发 SKIP_WAITING，照主路径等它真正接管：
 * 等到 controllerchange 或新 SW 已 activated 回 reloading；waitMs 内没接管回 takeover_timeout。
 * 没注册、没 waiting、地址不对、拿注册出错回 failed。不重新载入
 */
export async function skipWaitingDirect(
  sw: Pick<ServiceWorkerContainer, 'getRegistration' | 'addEventListener'> | undefined = navigator.serviceWorker,
  waitMs: number = SW_UPDATE_WAIT_MS,
): Promise<SwUpdateResult> {
  try {
    const w = (await sw?.getRegistration(SW_SCOPE))?.waiting;
    // scriptURL 整串等于本站的 /app/sw.js 才发（查询串、别的路径都不认）
    if (!sw || !w || w.scriptURL !== location.origin + SW_URL) return 'failed';
    // 接管时 resolve 成事件对象（真值），到点 resolve 成 undefined。不清计时器（省字节）：先接管时再 resolve 是空操作
    const changed = new Promise((resolve) => {
      setTimeout(resolve, waitMs);
      sw.addEventListener('controllerchange', resolve, { once: true });
    });
    w.postMessage({ type: 'SKIP_WAITING' });
    return (await changed) || w.state === 'activated' ? 'reloading' : 'takeover_timeout';
  } catch {
    return 'failed';
  }
}

/**
 * 按需下载后走“更新”（native-bridge.ts 网页版的 requestAppUpdate）。拿不到模块时先换地址再下一次；
 * 还不行，有等着接管的新 SW 就发 SKIP_WAITING（skip），都不行回 failed。
 * 只返回结果，**不自己重新载入**：由调用方定（core/upgrade.ts 的 reloadWhenIdle）。get、skip 只给测试换
 */
export async function updateServiceWorkerLazy(
  get: () => Promise<SwLifecycleModule | null> = () => loadSwLifecycle({ waitMs: SW_REGISTER_WAIT_MS, retry: true }),
  skip: () => Promise<SwUpdateResult> = () => skipWaitingDirect(),
): Promise<SwUpdateResult> {
  const m = await get();
  return m ? m.updateServiceWorker() : skip();
}

const UPDATE_ATTEMPT_KEY = 'lemo.update_attempt';

/**
 * 跨一次重新载入记住“刚按过更新”（sessionStorage，只存版本号，不含账号信息）：
 * 新页面启动时还低于最低版本，就只提示“已是最新版本，请稍后再试”，不再自动重新载入
 */
export const updateAttemptStore = {
  get(): string | null {
    try {
      return sessionStorage.getItem(UPDATE_ATTEMPT_KEY);
    } catch {
      return null;
    }
  },
  set(min: string | null): void {
    try {
      if (min === null) sessionStorage.removeItem(UPDATE_ATTEMPT_KEY);
      else sessionStorage.setItem(UPDATE_ATTEMPT_KEY, min);
    } catch {
      // 隐私模式等拿不到 sessionStorage：只是少了“仍不够新”的提示
    }
  },
};

const UPGRADE_LOG_COUNT_KEY = 'lemo.upglog';

/**
 * 升级中心日志的每日计数（core/upgrade.ts 的 logCounts）：localStorage，只存 {d: 本机日期, c: {act: 条数}}，
 * 不含账号信息；跨重新载入、跨标签页都算在同一天里
 */
export const upgradeLogCountStore = {
  get(): string | null {
    try {
      return localStorage.getItem(UPGRADE_LOG_COUNT_KEY);
    } catch {
      return null;
    }
  },
  set(v: string): void {
    // 写不进（存储满、隐私模式）会抛：由升级中心接住，退回只在内存里计
    localStorage.setItem(UPGRADE_LOG_COUNT_KEY, v);
  },
};

/** 重新载入页面 */
export function reloadPage(): void {
  location.reload();
}
