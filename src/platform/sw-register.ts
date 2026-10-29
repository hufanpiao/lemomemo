// 注册 Service Worker（架构 8.1、16.1）：sw.js 放在 /app/，scope 只管 /app/，首页不受影响
// navigator.serviceWorker 只准出现在 platform（A13）
export const SW_URL = '/app/sw.js';
export const SW_SCOPE = '/app/';

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  } catch {
    // 注册失败不影响使用（只是没有离线）；B1 接上日志后记错误码
    return null;
  }
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
 * 不自己重新载入，返回 reloading 由调用方（core/upgrade.ts）载入
 */
export async function updateServiceWorker(waitMs: number = SW_UPDATE_WAIT_MS): Promise<SwUpdateResult> {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if (!reg) return 'unsupported';
    await reg.update();
    const sw = reg.installing ?? reg.waiting;
    if (!sw) return 'no_update';
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
