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

/** “更新”时等新 SW 装好、接管的最长时间（主路径 sw-lifecycle.ts 和退路 ② skipWaitingDirect 共用，W6 安全复审要求时长一致） */
export const SW_UPDATE_WAIT_MS = 30_000;

/**
 * “更新”按钮的结果（0.27 第 1 点）：reloading = 新 SW 已接管，调用方重新载入；no_update = 没有新版本；
 * failed = 没查成（update() 失败且没有在装、装好的，或者拿注册出错）或新 SW 安装失败（redundant）；
 * takeover_timeout = 查到了新 SW，但 waitMs 内没装好，或发了 SKIP_WAITING 后没接管、也没 activated（BANNER-sugg ⑤：和“没查成”分开，
 * 调用方不能因为 swReady 就重新载入——载入后还是旧版本）
 */
export type SwUpdateResult = 'reloading' | 'no_update' | 'failed' | 'takeover_timeout' | 'unsupported';

/** sw-lifecycle.ts 的导出（按需下载） */
export type SwLifecycleModule = typeof SwLifecycle;

/** 按需下载 sw-lifecycle.ts（三处共用这一个写法）；“更新”的退路 ① 从它打包后的源码里取出真实地址（freshLifecycleUrl） */
const importLifecycle = (): Promise<SwLifecycleModule> => import('./sw-lifecycle.ts');

/**
 * 按需下载 sw-lifecycle.ts：下载失败或超过 waitMs（默认和注册同一个上限）都返回 null，永远 resolve，不抛错。
 * 调用方按“没注册（没有离线缓存、没有新版本提示）/ 没查成（failed）”处理，和注册失败、update() 失败同一条路。
 * load 只给测试换（模拟下载失败、一直不回）
 */
export function loadSwLifecycle(
  waitMs: number = SW_REGISTER_WAIT_MS,
  load: () => Promise<SwLifecycleModule> = importLifecycle,
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
    sw = await (d.load ?? importLifecycle)();
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

/**
 * 退路 ① 的地址（B2-UI-b W6，首屏瘦身安全审 S1）：有的浏览器把失败的动态 import 记住，之后同一地址一直失败。
 * 从 src（importLifecycle 打包后的源码）里取 import(…) 括号里的地址，按 base 解析，加查询串 r 换成新地址；只认同源，取不到回 null
 */
export function freshLifecycleUrl(src: string, base: string, stamp: string): string | null {
  // 压缩后的产物把地址写成模板字符串（反引号），开发时是双引号：单引号、双引号、反引号三种都认。
  // 正则里三种引号写成十六进制转义（同义），源码里不出现裸引号，check_arch 的字符串扫描（A20）才不会把后面的注释当成字符串
  const m = /import\(\s*[\x22\x27\x60]([^\x22\x27\x60$]+)[\x22\x27\x60]\s*\)/.exec(src);
  if (!m?.[1]) return null;
  // base 是本模块自己的地址（import.meta.url），new URL 不会抛
  const u = new URL(m[1], base);
  if (u.origin !== new URL(base).origin) return null;
  u.searchParams.set('r', stamp);
  return u.href;
}

// 注意（W6 安全复审建议）：换地址下载会生成第二份 sw-lifecycle 模块实例（和原地址那份互不相通）。
// 以后给 sw-lifecycle.ts 加模块级状态（计数、缓存、监听登记等）时要考虑两份并存的情况
function importLifecycleFresh(): Promise<SwLifecycleModule> {
  const url = freshLifecycleUrl(importLifecycle.toString(), import.meta.url, String(Date.now()));
  return url ? import(/* @vite-ignore */ url) : Promise.reject();
}

/**
 * 退路 ②：不靠 sw-lifecycle.ts，本页 scope 的注册里有等着接管的新 SW（waiting，同源、就是 SW_URL）才发 SKIP_WAITING，
 * 然后照主路径（sw-lifecycle.ts 的 updateServiceWorker）等它真正接管（W6 安全复审建议，负责人 D3 原话“有新版本在等就切过去”）：
 * 等到 controllerchange，或没等到但新 SW 已经 activated，才回 reloading；waitMs（和主路径同一个 SW_UPDATE_WAIT_MS）内没接管回 takeover_timeout。
 * 没注册、没 waiting、地址不对、拿注册出错回 failed。不重新载入
 */
export async function skipWaitingDirect(
  sw: Pick<ServiceWorkerContainer, 'getRegistration' | 'addEventListener'> | undefined = navigator.serviceWorker,
  waitMs: number = SW_UPDATE_WAIT_MS,
): Promise<SwUpdateResult> {
  try {
    const w = (await sw?.getRegistration(SW_SCOPE))?.waiting;
    // scriptURL 是浏览器给的绝对地址：整串等于本站的 /app/sw.js 才发（同源、就是这个脚本，查询串、别的路径都不认）
    if (!sw || !w || w.scriptURL !== location.origin + SW_URL) return 'failed';
    // 接管时 resolve 成事件对象（真值），到点 resolve 成 undefined。为省首屏字节不清计时器：先接管时到点再 resolve 一次是空操作
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

/** updateServiceWorkerLazy 的两条退路（只给测试换） */
export interface SwUpdateFallback {
  /** 退路 ①：换个地址再下载一次 */
  retry?: () => Promise<SwLifecycleModule | null>;
  /** 退路 ②：直接给等着的新 SW 发 SKIP_WAITING，等接管 */
  skip?: () => Promise<SwUpdateResult>;
}

/**
 * 按需下载后走“更新”（native-bridge.ts 网页版的 requestAppUpdate）。拿不到模块时（B2-UI-b W6，D3 ①）：
 * ① 换个地址再下载一次（绕开浏览器缓存的失败），拿到了照常走；② 还不行，有等着接管的新 SW 就发 SKIP_WAITING，接管了回 reloading、
 * 超时回 takeover_timeout；都不行回 failed（没查成）。这里只返回结果，**不自己重新载入**：什么时候载入由调用方定（core/upgrade.ts 的 reloadWhenIdle 先看
 * 编辑中、录音等忙碌状态；“最多重载一次”的会话标记也在调用方）。get 只给测试换
 */
export async function updateServiceWorkerLazy(
  get: () => Promise<SwLifecycleModule | null> = () => loadSwLifecycle(),
  fb: SwUpdateFallback = {},
): Promise<SwUpdateResult> {
  const m = (await get()) ?? (await (fb.retry ?? (() => loadSwLifecycle(SW_REGISTER_WAIT_MS, importLifecycleFresh)))());
  if (m) return m.updateServiceWorker();
  return (fb.skip ?? (() => skipWaitingDirect()))();
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
