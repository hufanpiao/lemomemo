// SW 注册、更新按需下载（首屏瘦身 U7）：sw-lifecycle.ts 只经 loadSwLifecycle 下载，拿不到回 null，永远 resolve、不抛错。
// 注册（registerSw）下载、注册都不设超时（安全审 M1、Q-23）；“更新”每次下载最多 SW_REGISTER_WAIT_MS，拿不到先换地址再下、再走 SKIP_WAITING（W6），都不行才 failed
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  freshLifecycleUrl,
  loadSwLifecycle,
  registerSw,
  skipWaitingDirect,
  SW_REGISTER_WAIT_MS,
  SW_SCOPE,
  SW_UPDATE_WAIT_MS,
  SW_URL,
  updateServiceWorkerLazy,
  type SwLifecycleModule,
} from '../sw-register.ts';

afterEach(() => {
  vi.useRealTimers();
});

const fakeModule = (over: Partial<SwLifecycleModule> = {}): SwLifecycleModule =>
  ({
    registerServiceWorker: vi.fn(async () => ({ scope: '/app/' }) as unknown as ServiceWorkerRegistration),
    updateServiceWorker: vi.fn(async () => 'no_update' as const),
    ...over,
  }) as unknown as SwLifecycleModule;

describe('loadSwLifecycle（唯一的加载器）', () => {
  it('下载成功：返回模块', async () => {
    const m = fakeModule();
    expect(await loadSwLifecycle({ load: async () => m })).toBe(m);
  });

  it('下载失败（同步抛、异步拒绝）：返回 null，不抛；不要 retry 时不换地址', async () => {
    const fresh = vi.fn(async () => fakeModule());
    expect(await loadSwLifecycle({ load: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')), fresh })).toBeNull();
    expect(
      await loadSwLifecycle({
        load: () => {
          throw new Error('boom');
        },
        fresh,
      }),
    ).toBeNull();
    expect(fresh).not.toHaveBeenCalled();
  });

  it('不给 waitMs：一直等到真实结果（5 秒才到也照样拿到）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const m = fakeModule();
    let done: unknown = 'pending';
    void loadSwLifecycle({ load: () => new Promise((res) => setTimeout(() => res(m), 5000)) }).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(m);
  });

  it('给了 waitMs、一直不回：到点返回 null；retry 时换地址再等一轮', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hang = () => new Promise<SwLifecycleModule>(() => undefined);
    const fresh = vi.fn(hang);
    let done: unknown = 'pending';
    void loadSwLifecycle({ waitMs: SW_REGISTER_WAIT_MS, retry: true, load: hang, fresh }).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(SW_REGISTER_WAIT_MS);
    expect(fresh).toHaveBeenCalledOnce();
    expect(done).toBe('pending');
    await vi.advanceTimersByTimeAsync(SW_REGISTER_WAIT_MS);
    expect(done).toBeNull();
  });
});

describe('updateServiceWorkerLazy', () => {
  it('拿到模块：照原来的函数走', async () => {
    const m = fakeModule();
    expect(await updateServiceWorkerLazy(async () => m)).toBe('no_update');
  });

  it('拿不到模块、SKIP_WAITING 也不行：回 failed（没查成），不抛', async () => {
    expect(await updateServiceWorkerLazy(async () => null, async () => 'failed' as const)).toBe('failed');
  });
});

// B2-UI-b W6（首屏瘦身安全审 S1，D3 ①）：“更新”拿不到 sw-lifecycle.ts 时的退路。任务单验收 ①～⑤ 依次对应下面五条
describe('updateServiceWorkerLazy 的退路（W6）', () => {
  it('① 第一次下载被拒、换地址那次拿到：照常走 updateServiceWorker，不发 SKIP_WAITING', async () => {
    const m = fakeModule({ updateServiceWorker: vi.fn(async () => 'reloading' as const) });
    const skip = vi.fn(async () => 'reloading' as const);
    const get = () => loadSwLifecycle({ retry: true, load: () => Promise.reject(new TypeError('x')), fresh: async () => m });
    expect(await updateServiceWorkerLazy(get, skip)).toBe('reloading');
    expect(m.updateServiceWorker).toHaveBeenCalledTimes(1);
    expect(skip).not.toHaveBeenCalled();
  });

  // ② 发了 SKIP_WAITING 要等新 SW 真正接管才回 reloading（W6 安全复审建议，和主路径 updateServiceWorker 同一写法、同一时长）
  describe('② 两次都拿不到、有等着接管的新 SW：发 SKIP_WAITING，等接管', () => {
    const fakeSw = (state = 'installed') => {
      const listeners: Array<(e: Event) => void> = [];
      const waiting = { scriptURL: `${location.origin}${SW_URL}`, postMessage: vi.fn(), state };
      const sw = {
        getRegistration: vi.fn(async () => ({ waiting }) as unknown as ServiceWorkerRegistration),
        addEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
          if (type === 'controllerchange') listeners.push(fn);
        }),
      };
      // 浏览器派 controllerchange 时带事件对象（skipWaitingDirect 靠它是真值判断“接管了”）
      return { sw, waiting, takeover: () => listeners.splice(0).forEach((f) => f(new Event('controllerchange'))) };
    };
    const lazy = (sw: Parameters<typeof skipWaitingDirect>[0], ms?: number) =>
      updateServiceWorkerLazy(async () => null, () => skipWaitingDirect(sw, ms));
    afterEach(() => vi.useRealTimers());

    it('接管了（controllerchange）才回 reloading', async () => {
      const f = fakeSw();
      const r = lazy(f.sw, 1000);
      await vi.waitFor(() => expect(f.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }));
      expect(f.sw.getRegistration).toHaveBeenCalledWith(SW_SCOPE);
      f.takeover();
      expect(await r).toBe('reloading');
    });

    it('接管之前不回 reloading（还在等）', async () => {
      vi.useFakeTimers();
      const f = fakeSw();
      let done: string | undefined;
      void lazy(f.sw, 1000).then((v) => (done = v));
      await vi.advanceTimersByTimeAsync(999);
      expect(f.waiting.postMessage).toHaveBeenCalledTimes(1);
      expect(done).toBeUndefined();
      f.takeover();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe('reloading');
    });

    it('超时没接管回 takeover_timeout；没等到 controllerchange 但新 SW 已 activated 回 reloading（同主路径）', async () => {
      vi.useFakeTimers();
      const f = fakeSw();
      const r = lazy(f.sw, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await r).toBe('takeover_timeout');
      const g = fakeSw('activated');
      const r2 = lazy(g.sw, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await r2).toBe('reloading');
    });

    it('默认等待时长和主路径同一个常量（30 秒）', async () => {
      vi.useFakeTimers();
      const f = fakeSw();
      let done: string | undefined;
      void skipWaitingDirect(f.sw).then((v) => (done = v));
      await vi.advanceTimersByTimeAsync(SW_UPDATE_WAIT_MS - 1);
      expect(done).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe('takeover_timeout');
      expect(SW_UPDATE_WAIT_MS).toBe(30_000);
    });
  });

  it('③ 都不行（没有 waiting）：回 failed，界面显示新提示（update.failedReopen，见 update-banner、CacheTooNewScreen 的测试）', async () => {
    const sw = { getRegistration: vi.fn(async () => ({ waiting: null }) as unknown as ServiceWorkerRegistration), addEventListener: vi.fn() };
    expect(await updateServiceWorkerLazy(async () => null, () => skipWaitingDirect(sw))).toBe('failed');
    expect(await skipWaitingDirect(undefined)).toBe('failed');
    expect(await skipWaitingDirect({ getRegistration: async () => Promise.reject(new Error('x')), addEventListener: () => undefined })).toBe('failed');
  });

  // ④ 退路不绕过调用方的忙碌检查：platform 不准引 core，放在 src/app/__tests__/sw-update-fallback-busy.test.ts

  it('⑤ “更新”和退路里没有重新载入的调用（什么时候载入只由调用方定；文件末尾的 reloadPage 是别处用的，不在这一段）', () => {
    const all = readFileSync(join(import.meta.dirname, '..', 'sw-register.ts'), 'utf8');
    const from = all.indexOf('export function freshLifecycleUrl');
    const to = all.indexOf('const UPDATE_ATTEMPT_KEY');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const src = all.slice(from, to);
    expect(src).toContain('export async function updateServiceWorkerLazy');
    expect(src).not.toMatch(/reloadPage/);
    expect(src).not.toMatch(/\.reload\s*\(/);
    expect(src).not.toMatch(/location\s*\.\s*(href|assign|replace)/);
  });

  it('退路 ① 的地址：从打包后的源码取 import("…")，按本文件地址解析、加查询串；不同源、取不到都回 null', () => {
    const base = 'https://lemo.example/app/assets/main-abc.js';
    const built = '()=>__vitePreload(()=>import("./sw-lifecycle-X1y2.js"),__VITE_IS_MODERN__?__VITE_PRELOAD__:void 0,import.meta.url)';
    expect(freshLifecycleUrl(built, base, '42')).toBe('https://lemo.example/app/assets/sw-lifecycle-X1y2.js?r=42');
    // 真实产物的样子（11-09 构建的 native-bridge-*.js 里原样摘的）：压缩器写成模板字符串
    const minified = '()=>e(()=>import(`./sw-lifecycle-BgEyuNtU.js`),__vite__mapDeps([0,1,2]))';
    expect(freshLifecycleUrl(minified, base, '7')).toBe('https://lemo.example/app/assets/sw-lifecycle-BgEyuNtU.js?r=7');
    expect(freshLifecycleUrl("() => import('/src/platform/sw-lifecycle.ts')", 'http://127.0.0.1:5173/src/platform/sw-register.ts', '1')).toBe(
      'http://127.0.0.1:5173/src/platform/sw-lifecycle.ts?r=1',
    );
    expect(freshLifecycleUrl('()=>import("https://evil.example/x.js")', base, '1')).toBeNull();
    expect(freshLifecycleUrl('()=>foo()', base, '1')).toBeNull();
  });

  it('退路 ② 只发给本 scope、同源、就是 sw.js 的 waiting', async () => {
    const postMessage = vi.fn();
    const reg = (scriptURL: string) => ({ getRegistration: async () => ({ waiting: { scriptURL, postMessage } }) as unknown as ServiceWorkerRegistration, addEventListener: vi.fn() });
    expect(await skipWaitingDirect(reg(`https://evil.example${SW_URL}`))).toBe('failed');
    expect(await skipWaitingDirect(reg(`${location.origin}/app/other.js`))).toBe('failed');
    expect(await skipWaitingDirect(reg(`${location.origin}${SW_URL}?x=1`))).toBe('failed');
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('registerSw（下载、注册都不设超时，安全审 M1、Q-23）', () => {
  const life = { onVisibility: vi.fn(() => () => undefined), isOnline: () => true };
  const lateModule = () => {
    const reg = { scope: '/app/' } as unknown as ServiceWorkerRegistration;
    const m = fakeModule({
      registerServiceWorker: vi.fn(async () => reg),
      watchServiceWorkerUpdate: vi.fn(() => () => undefined),
      checkSwOnForeground: vi.fn(() => () => undefined),
    } as Partial<SwLifecycleModule>);
    return { reg, m };
  };

  it('代码过了 3 秒才下载完（5 秒）：照常注册、挂上新版本监听和回到前台检查；推送认领（main.tsx 等这个 Promise 拿到 reg 才跑）照常跑', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { reg, m } = lateModule();
    const onReady = vi.fn();
    const runPushClaim = vi.fn();
    const swReg = registerSw({ onReady, life, load: () => new Promise((res) => setTimeout(() => res(m), 5000)) });
    // 和 app/main.tsx 同一个写法：swReg.then((reg) => { if (reg) void runPushClaim(); })
    void swReg.then((r) => {
      if (r) runPushClaim();
    });
    await vi.advanceTimersByTimeAsync(SW_REGISTER_WAIT_MS + 1);
    expect(m.registerServiceWorker).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await swReg).toBe(reg);
    expect(m.registerServiceWorker).toHaveBeenCalledOnce();
    expect(m.watchServiceWorkerUpdate).toHaveBeenCalledWith(reg, onReady);
    expect(m.checkSwOnForeground).toHaveBeenCalledWith(reg, { life });
    expect(runPushClaim).toHaveBeenCalledOnce();
  });

  it('Q-23：注册本身过了 3 秒才回来（5 秒）：等真实结果，拿到 reg、挂上监听，不当失败；运行日志记一行结果和耗时', async () => {
    const real = await import('../sw-lifecycle.ts');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const reg = Object.assign(new EventTarget(), { installing: null, waiting: null }) as unknown as ServiceWorkerRegistration;
    const sw = Object.assign(new EventTarget(), { controller: null, register: vi.fn(() => new Promise((res) => setTimeout(() => res(reg), 5000))) });
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    const lines: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g['__lemoRunLog'] = { q: [], sink: (l: string) => void lines.push(l) };
    try {
      const swReg = registerSw({ onReady: vi.fn(), life, load: async () => real });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await swReg).toBe(reg);
      expect(life.onVisibility).toHaveBeenCalled();
      expect(lines).toEqual(['sw register ok 5000ms']);
    } finally {
      Reflect.deleteProperty(g, '__lemoRunLog');
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  });

  it('下载失败：返回 null，不注册、不认领，不抛', async () => {
    const runPushClaim = vi.fn();
    const r = await registerSw({ onReady: vi.fn(), life, load: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')) });
    if (r) runPushClaim();
    expect(r).toBeNull();
    expect(runPushClaim).not.toHaveBeenCalled();
  });

  it('watchServiceWorkerUpdate 抛错：照样拿到注册、回到前台检查照挂、推送认领照跑，没有未处理的拒绝', async () => {
    const { reg, m } = lateModule();
    (m.watchServiceWorkerUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const runPushClaim = vi.fn();
      // 和 app/main.tsx 同一个写法：.catch(() => null) 兜底，再 .then 认领
      const swReg = registerSw({ onReady: vi.fn(), life, load: async () => m }).catch(() => null);
      void swReg.then((r) => {
        if (r) runPushClaim();
      });
      expect(await swReg).toBe(reg);
      expect(m.checkSwOnForeground).toHaveBeenCalledOnce();
      await new Promise((r) => setTimeout(r, 0));
      expect(runPushClaim).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('exe、不支持（registerServiceWorker 回 null）、注册失败（抛错）、下载失败：返回 null，不挂监听；运行日志记 skip / 错误名（不记 message）', async () => {
    const lines: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g['__lemoRunLog'] = { q: [], sink: (l: string) => void lines.push(l) };
    try {
      const { m } = lateModule();
      (m.registerServiceWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      expect(await registerSw({ onReady: vi.fn(), life, load: async () => m })).toBeNull();
      (m.registerServiceWorker as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DOMException('https://x/app/sw.js?a=1 failed', 'SecurityError'));
      expect(await registerSw({ onReady: vi.fn(), life, load: async () => m })).toBeNull();
      expect(await registerSw({ load: () => Promise.reject(new TypeError('x')) })).toBeNull();
      expect(m.watchServiceWorkerUpdate).not.toHaveBeenCalled();
      expect(m.checkSwOnForeground).not.toHaveBeenCalled();
      expect(lines.map((l) => l.replace(/\d+ms$/, 'Nms'))).toEqual(['sw register skip Nms', 'sw register fail SecurityError Nms', 'sw register fail load Nms']);
    } finally {
      Reflect.deleteProperty(g, '__lemoRunLog');
    }
  });

  it('不给 onReady、life（version_too_new 的整屏提示前那次）：只注册，不挂监听', async () => {
    const { reg, m } = lateModule();
    expect(await registerSw({ load: async () => m })).toBe(reg);
    expect(m.watchServiceWorkerUpdate).not.toHaveBeenCalled();
    expect(m.checkSwOnForeground).not.toHaveBeenCalled();
  });
});
