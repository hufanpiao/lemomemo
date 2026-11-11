// Service Worker 的注册、盯新版本、回到前台查新版本、“更新”按钮。不在首屏：只经 sw-register.ts 的 loadSwLifecycle 按需下载。
// navigator.serviceWorker 只准出现在 platform（A13）；exe（Tauri 窗口）里不注册，判断读 env.ts 的 isTauri
import { isTauri } from './env.ts';
import type { Lifecycle } from './net.ts';
import { SW_SCOPE, SW_UPDATE_WAIT_MS, SW_URL, type SwUpdateResult } from './sw-register.ts';

/** 注册 SW，等真实结果（不设超时，Q-23）：exe 里、不支持回 null；注册失败照样抛出，由 sw-register.ts 的 registerSw 记下错误名。
 * win 默认 globalThis（测试时传假的） */
export async function registerServiceWorker(win: object = globalThis): Promise<ServiceWorkerRegistration | null> {
  if (isTauri(win) || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
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
  let stopped = false;
  /** 已经有等着接管的新 SW（上次打开时装好、还没接管）：报一次。onReady 可以被调多次，调用方去重 */
  const checkWaiting = (): void => {
    if (!stopped && reg.waiting && hasController()) onReady();
  };
  checkWaiting();
  // 11-10 负责人 iPhone 主屏幕版实测：新 SW 已是 waiting=installed，横幅却一直不出（冷启动两次都没有）。
  // 原来只在挂上这一刻读一次 reg.waiting；WebKit 的注册对象跨进程同步，register() 刚回来时 waiting 可能还没补上，
  // 而装好的新 SW 之后不会再发 updatefound、controllerchange，这次启动就再也不提示。补两处再查：
  // ① navigator.serviceWorker.ready 之后；② 页面每次回到前台（visibilitychange 变成 visible）
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
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** 切到前台时主动查新版本的最短间隔（架构师 10-30 第 5 点：满 1 小时才查） */
export const SW_FOREGROUND_CHECK_MS = 60 * 60 * 1000;

export interface ForegroundCheckDeps {
  /** platform/net.ts 的 browserLifecycle（切到前台：和“切到前台时比较最低版本”同一个时机，visibilitychange） */
  life: Pick<Lifecycle, 'onVisibility' | 'isOnline'>;
  /** 默认 Date.now()。不用 performance.now()：iOS WebKit 锁屏睡眠时它不走，后台放一夜也算不满 1 小时（B 组审查必改） */
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
    if (!visible || !d.life.isOnline()) return;
    const t = now();
    // 系统时间往回调过（BANNER-sugg ②）：从现在重新计时，不会因为“上次”在未来而很久不查
    if (t < last) {
      last = t;
      return;
    }
    if (t - last < interval) return;
    last = t;
    // 查失败（断网、服务器错）不影响使用，下一次满间隔再查
    void reg.update().catch(() => undefined);
  });
}

/** 等新 SW 装好：installed = 装好了；redundant = 安装失败；timeout = ms 内没装好 */
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
 * 按“更新”：registration.update() → 等新 SW 装好 → 发 SKIP_WAITING（sw.ts 收到后 skipWaiting）→ 等 controllerchange。
 * 已经有等着接管的（reg.waiting）就不再 update()，直接发 SKIP_WAITING：断网时 update() 会失败，但新版本早就装好了（复审必改）。
 * update() 单独接住：失败了仍看一眼 installing / waiting，都没有才回 failed（没查成，不能说“没有新版本”）。
 * 有新 SW 但 waitMs 内没装好、或 SKIP_WAITING 后没接管也没 activated：回 takeover_timeout；安装失败（redundant）回 failed。
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
    const installed = await waitInstalled(sw, waitMs);
    // 安装失败（redundant）算更新失败，不是接管超时（B 组审查建议 3）
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
    // 没等到 controllerchange，但新 SW 已经 activated（例如本页原来没有 controller，不会派 controllerchange）：
    // 新版本已经生效，重新载入就是新版本，不能卡在 stalled（B 组审查建议 3）
    return sw.state === 'activated' ? 'reloading' : 'takeover_timeout';
  } catch {
    return 'failed';
  }
}
