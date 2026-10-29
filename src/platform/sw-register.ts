// 注册 Service Worker（架构 8.1、16.1）：sw.js 放在 /app/，scope 只管 /app/，首页不受影响
// navigator.serviceWorker 只准出现在 platform（A13）
import type { Lifecycle } from './net.ts';

export const SW_URL = '/app/sw.js';
export const SW_SCOPE = '/app/';

/** 注册最多等这么久（K6 复审建议 3：本机库来自更新版本时入口要等注册完再渲染，注册一直不返回不能白屏） */
export const SW_REGISTER_WAIT_MS = 3000;

/** 注册 SW；不支持、失败或超过 waitMs 都返回 null（超时只是不再等，注册请求本身照常进行）。永远 resolve */
export async function registerServiceWorker(waitMs: number = SW_REGISTER_WAIT_MS): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }), timeout]);
  } catch {
    // 注册失败不影响使用（只是没有离线）；B1 接上日志后记错误码
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 盯住“SW 在后台装好了新版本”（8.1：下载完提示“有新版本 · 重新打开”，不强制刷新）。
 * 只认“本页已经有 controller 时装好的”：第一次安装（还没有 controller）不是新版本，不提示。
 * 注册时已经有等着的（reg.waiting，例如上次打开时装好、还没接管）也算；挂上时正在装的（reg.installing）也盯上。
 * 别的标签页按了“重新打开”、新 SW 接管了本页（controllerchange）也算：这一页的 reg.waiting 已经没了，
 * 但新版本就在那里，重新载入就能用上（审查必改 2）。onReady 可能被调多次，调用方自己去重。返回取消订阅
 */
export function watchServiceWorkerUpdate(reg: ServiceWorkerRegistration, onReady: () => void): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined;
  const hasController = (): boolean => navigator.serviceWorker.controller !== null;
  if (reg.waiting && hasController()) onReady();
  let stopped = false;
  const onFound = (): void => {
    const sw = reg.installing;
    if (!sw) return;
    sw.addEventListener('statechange', () => {
      if (!stopped && sw.state === 'installed' && hasController()) onReady();
    });
  };
  // 本页原来就有 controller 时才算“换了新版本”；第一次安装时的 controllerchange 不算
  const hadController = hasController();
  const onTakeover = (): void => {
    if (!stopped && hadController) onReady();
  };
  if (reg.installing) onFound();
  reg.addEventListener('updatefound', onFound);
  navigator.serviceWorker.addEventListener('controllerchange', onTakeover);
  return () => {
    stopped = true;
    reg.removeEventListener('updatefound', onFound);
    navigator.serviceWorker.removeEventListener('controllerchange', onTakeover);
  };
}

/** 切到前台时主动查新版本的最短间隔（架构师 10-30 第 5 点：满 1 小时才查） */
export const SW_FOREGROUND_CHECK_MS = 60 * 60 * 1000;

export interface ForegroundCheckDeps {
  /** platform/net.ts 的 browserLifecycle（切到前台：和“切到前台时比较最低版本”同一个时机，visibilitychange） */
  life: Pick<Lifecycle, 'onVisibility' | 'isOnline'>;
  now?: () => number;
  intervalMs?: number;
}

/**
 * 切到前台时主动查新版本（iOS 后台标签常驻时，浏览器自己不一定去查）：页面变成可见、在线、距离上次查已满 intervalMs，
 * 才调 registration.update()。计时从这里挂上算起（注册本身刚查过）。查到的新版本由 watchServiceWorkerUpdate 报。返回取消订阅
 */
export function checkSwOnForeground(reg: ServiceWorkerRegistration, d: ForegroundCheckDeps): () => void {
  const now = d.now ?? (() => Date.now());
  const interval = d.intervalMs ?? SW_FOREGROUND_CHECK_MS;
  let last = now();
  return d.life.onVisibility((visible) => {
    if (!visible || !d.life.isOnline() || now() - last < interval) return;
    last = now();
    // 查失败（断网、服务器错）不影响使用，下一次满间隔再查
    void reg.update().catch(() => undefined);
  });
}

/** “更新”按钮的结果（0.27 第 1 点）：reloading = 新 SW 已接管，调用方重新载入；no_update = 没有新版本；failed = 更新失败 */
export type SwUpdateResult = 'reloading' | 'no_update' | 'failed' | 'unsupported';

/** 等新 SW 装好、接管的最长时间 */
const SW_UPDATE_WAIT_MS = 30_000;

function waitInstalled(sw: ServiceWorker, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (sw.state === 'installed' || sw.state === 'activated') {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' || sw.state === 'activated') {
        clearTimeout(timer);
        resolve(true);
      } else if (sw.state === 'redundant') {
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}

/**
 * 按“更新”：registration.update() → 等新 SW 装好 → 发 SKIP_WAITING（sw.ts 收到后 skipWaiting）→ 等 controllerchange。
 * 已经有等着接管的（reg.waiting）就不再 update()，直接发 SKIP_WAITING：断网时 update() 会失败，但新版本早就装好了（复审必改）。
 * update() 单独接住：失败了仍看一眼 installing / waiting，都没有才回 failed（没查成，不能说“没有新版本”）。
 * 不自己重新载入，返回 reloading 由调用方（core/upgrade.ts）载入
 */
export async function updateServiceWorker(waitMs: number = SW_UPDATE_WAIT_MS): Promise<SwUpdateResult> {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if (!reg) return 'unsupported';
    let checkFailed = false;
    if (!reg.waiting) {
      try {
        await reg.update();
      } catch {
        checkFailed = true;   // 断网、服务器错：接着看有没有已经在装或装好的
      }
    }
    const sw = reg.installing ?? reg.waiting;
    if (!sw) return checkFailed ? 'failed' : 'no_update';
    if (!(await waitInstalled(sw, waitMs))) return 'failed';
    const changed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), waitMs);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    });
    sw.postMessage({ type: 'SKIP_WAITING' });
    return (await changed) ? 'reloading' : 'failed';
  } catch {
    return 'failed';
  }
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

/** 重新载入页面 */
export function reloadPage(): void {
  location.reload();
}
