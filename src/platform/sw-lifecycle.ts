// Service Worker 的注册、盯新版本、回到前台查新版本、“更新”按钮。不在首屏：只经 sw-register.ts 的 loadSwLifecycle 按需下载。
// navigator.serviceWorker 只准出现在 platform；exe 里不注册，判断读 env.ts 的 isTauri
import { isTauri } from './env.ts';
import type { Lifecycle } from './net.ts';
import { rlog } from './run-log-api.ts';
import { SW_SCOPE, SW_UPDATE_WAIT_MS, SW_URL, type SwUpdateResult } from './sw-register.ts';

/** 注册 SW，等真实结果（不设超时）：exe 里、不支持回 null；注册失败照样抛出，由 sw-register.ts 的 registerSw 记错误名 */
export async function registerServiceWorker(win: object = globalThis): Promise<ServiceWorkerRegistration | null> {
  if (isTauri(win) || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
}

/**
 * 盯住“SW 在后台装好了新版本”（不强制刷新）。第一次安装不提示；别的标签页让新 SW 接管了本页也算。
 * onReady 可能被调多次，调用方自己去重。返回取消订阅
 */
export function watchServiceWorkerUpdate(reg: ServiceWorkerRegistration, onReady: () => void): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined;
  const hasController = (): boolean => navigator.serviceWorker.controller !== null;
  let stopped = false;
  const checkWaiting = (): void => {
    if (!stopped && reg.waiting && hasController()) onReady();
  };
  checkWaiting();
  // 不能只在挂上时读一次：WebKit 里 register() 刚回来时 waiting 可能还没补上，之后也不再发事件
  void navigator.serviceWorker.ready?.then(checkWaiting, () => undefined);
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') checkWaiting();
  };
  document.addEventListener('visibilitychange', onVisible);
  const onFound = (): void => {
    const sw = reg.installing;
    if (!sw) return;
    sw.addEventListener('statechange', () => {
      if (!stopped && sw.state === 'installed' && hasController()) onReady();
    });
  };
  // 第一次安装时的 controllerchange 不算
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
    document.removeEventListener('visibilitychange', onVisible);
  };
}

export const SW_FOREGROUND_CHECK_MS = 5 * 60 * 1000;

export interface ForegroundCheckDeps {
  life: Pick<Lifecycle, 'onVisibility' | 'isOnline'>;
  /** 默认 Date.now()。不用 performance.now()：iOS WebKit 锁屏睡眠时它不走 */
  now?: () => number;
  intervalMs?: number;
}

/**
 * 切到前台时主动查新版本（iOS 后台常驻时浏览器不一定自己查）：在线、距上次满 intervalMs 才 update()。返回取消订阅
 */
export function checkSwOnForeground(reg: ServiceWorkerRegistration, d: ForegroundCheckDeps): () => void {
  const now = d.now ?? (() => Date.now());
  const interval = d.intervalMs ?? SW_FOREGROUND_CHECK_MS;
  let last = now();
  return d.life.onVisibility((visible) => {
    if (!visible || !d.life.isOnline()) return;
    const t = now();
    // 系统时间往回调过：从现在重新计时，免得“上次”在未来而很久不查
    if (t < last) {
      last = t;
      return;
    }
    if (t - last < interval) {
      rlog(`sw check skip ago=${Math.round((t - last) / 1000)}s`);
      return;
    }
    last = t;
    // 查失败不影响使用，下次满间隔再查
    rlog('sw check');
    void reg.update().then(
      () => rlog(`sw check done installing=${reg.installing ? 1 : 0} waiting=${reg.waiting ? 1 : 0}`),
      (e: unknown) => rlog(`sw check fail ${e instanceof Error ? e.name : 'err'}`),
    );
  });
}

/** 等新 SW 装好（redundant = 安装失败） */
function waitInstalled(sw: ServiceWorker, ms: number): Promise<'installed' | 'redundant' | 'timeout'> {
  return new Promise((resolve) => {
    if (sw.state === 'installed' || sw.state === 'activated') {
      resolve('installed');
      return;
    }
    if (sw.state === 'redundant') {
      resolve('redundant');
      return;
    }
    const timer = setTimeout(() => resolve('timeout'), ms);
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' || sw.state === 'activated') {
        clearTimeout(timer);
        resolve('installed');
      } else if (sw.state === 'redundant') {
        clearTimeout(timer);
        resolve('redundant');
      }
    });
  });
}

/**
 * 按“更新”：update() → 等装好 → 发 SKIP_WAITING → 等 controllerchange。已有 reg.waiting 就不再 update()（断网时会失败）。
 * update() 失败且没有 installing / waiting 才回 failed（没查成，不能说“没有新版本”）。不自己重新载入，由 core/upgrade.ts 载入
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
    const installed = await waitInstalled(sw, waitMs);
    if (installed === 'redundant') return 'failed';
    if (installed === 'timeout') return 'takeover_timeout';
    const changed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), waitMs);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    });
    sw.postMessage({ type: 'SKIP_WAITING' });
    if (await changed) return 'reloading';
    // 没等到 controllerchange 但已 activated（本页原来没有 controller 时不派这个事件）：新版本已生效，照样 reloading
    return sw.state === 'activated' ? 'reloading' : 'takeover_timeout';
  } catch {
    return 'failed';
  }
}
