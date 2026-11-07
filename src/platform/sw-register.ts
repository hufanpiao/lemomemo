// 注册 Service Worker（架构 8.1、16.1）：sw.js 放在 /app/，scope 只管 /app/，首页不受影响
// navigator.serviceWorker 只准出现在 platform（A13）
// exe（Tauri 窗口）里不注册（架构 5.10；B2 架构审 D4 第 1 点、B6-exe 约定 3）：WebView2 收不到 Web Push，exe 的界面文件在本机，
// 用不着离线缓存；判断读 env.ts 的 isTauri，不在这里另写一份 __TAURI__ 检查（在 sw-lifecycle.ts）
// 11-07 B2-UI-a 首屏瘦身 U7（主持人定 B）：注册、盯新版本、回到前台查新版本、“更新”按钮这几样原样搬到 sw-lifecycle.ts，一行没改，
// 用时按需下载：注册在首屏画完以后（registerSwAfterPaint，下载不设超时；version_too_new 的整屏提示前那次用 registerServiceWorkerLazy，有上限），
// “更新”在用户按下时（native-bridge.ts）。这里只留首屏到处要用的 reloadPage、两个存储和类型
import type { Lifecycle } from './net.ts';
import type * as SwLifecycle from './sw-lifecycle.ts';

export const SW_URL = '/app/sw.js';
export const SW_SCOPE = '/app/';

/** 注册最多等这么久（K6 复审建议 3：本机库来自更新版本时入口要等注册完再渲染，注册一直不返回不能白屏） */
export const SW_REGISTER_WAIT_MS = 3000;

/**
 * “更新”按钮的结果（0.27 第 1 点）：reloading = 新 SW 已接管，调用方重新载入；no_update = 没有新版本；
 * failed = 没查成（update() 失败且没有在装、装好的，或者拿注册出错）或新 SW 安装失败（redundant）；
 * takeover_timeout = 查到了新 SW，但 waitMs 内没装好，或发了 SKIP_WAITING 后没接管、也没 activated（BANNER-sugg ⑤：和“没查成”分开，
 * 调用方不能因为 swReady 就重新载入——载入后还是旧版本）
 */
export type SwUpdateResult = 'reloading' | 'no_update' | 'failed' | 'takeover_timeout' | 'unsupported';

/** sw-lifecycle.ts 的导出（按需下载） */
export type SwLifecycleModule = typeof SwLifecycle;

/**
 * 按需下载 sw-lifecycle.ts：下载失败或超过 waitMs（默认和注册同一个上限）都返回 null，永远 resolve，不抛错。
 * 调用方按“没注册（没有离线缓存、没有新版本提示）/ 没查成（failed）”处理，和注册失败、update() 失败同一条路。
 * load 只给测试换（模拟下载失败、一直不回）
 */
export function loadSwLifecycle(
  waitMs: number = SW_REGISTER_WAIT_MS,
  load: () => Promise<SwLifecycleModule> = () => import('./sw-lifecycle.ts'),
): Promise<SwLifecycleModule | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  const got = Promise.resolve()
    .then(load)
    .catch(() => null);
  return Promise.race([got, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 按需下载后注册 SW，只给 version_too_new 渲染前那一次用（app/main.tsx 传给 root.tsx）：下载失败、超时返回 null。get 只给测试换。
 * 最长等 6 秒：下载 SW_REGISTER_WAIT_MS（3 秒）+ 注册本身 SW_REGISTER_WAIT_MS（3 秒），都到点也照样渲染整屏提示，不白屏（安全审 S2）
 */
export async function registerServiceWorkerLazy(
  get: () => Promise<SwLifecycleModule | null> = () => loadSwLifecycle(),
): Promise<ServiceWorkerRegistration | null> {
  const m = await get();
  return m ? m.registerServiceWorker() : null;
}

/** 首屏画完以后那一次注册要用的（app/main.tsx） */
export interface AfterPaintSwDeps {
  /** SW 在后台装好了新版本（watchServiceWorkerUpdate 的回调） */
  onReady: () => void;
  /** platform/net.ts 的 browserLifecycle（回到前台时查新版本） */
  life: Pick<Lifecycle, 'onVisibility' | 'isOnline'>;
  /** 测试用：换掉下载 sw-lifecycle.ts */
  load?: () => Promise<SwLifecycleModule>;
}

/**
 * 首屏画完以后注册 SW，并盯住新版本、回到前台查新版本（app/main.tsx；返回值交给推送认领）。
 * 下载代码不设超时（安全审 M1）：网络慢、首屏后同步那批代码同时在下载时，代码晚到几秒也照常注册、挂监听，
 * 推送认领（main.tsx 里等这个 Promise 拿到 reg 才跑）也照常跑；原来首屏里直接 register 时，注册慢也只是“不再等”、照样会装上，这里保持一样。
 * 只有下载真的失败（网络断、分块缺失）才返回 null，和注册失败同一条路：本次没有 SW、离线缓存、新版本提示，照常使用。永远 resolve
 */
export async function registerSwAfterPaint(d: AfterPaintSwDeps): Promise<ServiceWorkerRegistration | null> {
  let sw: SwLifecycleModule;
  try {
    sw = await (d.load ?? (() => import('./sw-lifecycle.ts')))();
  } catch {
    return null;
  }
  const reg = await sw.registerServiceWorker();
  if (reg) {
    // 两个监听各自接住抛错（安全复查建议）：一个挂不上不挡另一个，也不把已经拿到的注册丢掉（推送认领照样跑）
    try {
      sw.watchServiceWorkerUpdate(reg, d.onReady);
    } catch {
      // 只是少了“有新版本”提示
    }
    try {
      // 切到前台、在线、距上次查满 1 小时才主动查新版本（架构师 10-30 第 5 点；和同步引擎“切到前台时比较最低版本”同一个时机）
      sw.checkSwOnForeground(reg, { life: d.life });
    } catch {
      // 只是少了回到前台时的主动检查
    }
  }
  return reg;
}

/** 按需下载后走“更新”（native-bridge.ts 网页版的 requestAppUpdate）：下载失败、超时回 failed（没查成）。get 只给测试换 */
export async function updateServiceWorkerLazy(get: () => Promise<SwLifecycleModule | null> = () => loadSwLifecycle()): Promise<SwUpdateResult> {
  const m = await get();
  return m ? m.updateServiceWorker() : 'failed';
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
 * 升级中心日志的每日计数（core/upgrade.ts 的 logCounts；B 组审查建议 1，照 js_error 的 lemo.jserr）：
 * localStorage，只存 {d: 本机日期, c: {act: 条数}}，不含账号信息；跨重新载入、跨标签页都算在同一天里
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
