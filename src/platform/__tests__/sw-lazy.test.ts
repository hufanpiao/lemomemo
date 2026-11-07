// SW 注册、更新按需下载（首屏瘦身 U7，11-07 主持人定 B）：sw-lifecycle.ts 下载失败、一直不回都有退路，永远 resolve、不抛错。
// version_too_new 那次注册拿不到 → null；“更新”拿不到 → failed（没查成）。首屏画完以后那次注册（registerSwAfterPaint）下载不设超时（安全审 M1）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSwLifecycle, registerServiceWorkerLazy, registerSwAfterPaint, SW_REGISTER_WAIT_MS, updateServiceWorkerLazy, type SwLifecycleModule } from '../sw-register.ts';

afterEach(() => {
  vi.useRealTimers();
});

const fakeModule = (over: Partial<SwLifecycleModule> = {}): SwLifecycleModule =>
  ({
    registerServiceWorker: vi.fn(async () => ({ scope: '/app/' }) as unknown as ServiceWorkerRegistration),
    updateServiceWorker: vi.fn(async () => 'no_update' as const),
    ...over,
  }) as unknown as SwLifecycleModule;

describe('loadSwLifecycle', () => {
  it('下载成功：返回模块', async () => {
    const m = fakeModule();
    expect(await loadSwLifecycle(1000, async () => m)).toBe(m);
  });

  it('下载失败（同步抛、异步拒绝）：返回 null，不抛', async () => {
    expect(await loadSwLifecycle(1000, () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')))).toBeNull();
    expect(
      await loadSwLifecycle(1000, () => {
        throw new Error('boom');
      }),
    ).toBeNull();
  });

  it('一直不回：到 waitMs 返回 null（默认和注册同一个上限 SW_REGISTER_WAIT_MS）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = loadSwLifecycle(undefined, () => new Promise<SwLifecycleModule>(() => undefined));
    let done: unknown = 'pending';
    void p.then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(SW_REGISTER_WAIT_MS - 1);
    expect(done).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBeNull();
  });
});

describe('registerServiceWorkerLazy、updateServiceWorkerLazy', () => {
  it('拿到模块：照原来的函数走', async () => {
    const m = fakeModule();
    expect(await registerServiceWorkerLazy(async () => m)).toEqual({ scope: '/app/' });
    expect(await updateServiceWorkerLazy(async () => m)).toBe('no_update');
  });

  it('拿不到模块（下载失败、超时）：注册回 null，“更新”回 failed（没查成），都不抛', async () => {
    expect(await registerServiceWorkerLazy(async () => null)).toBeNull();
    expect(await updateServiceWorkerLazy(async () => null)).toBe('failed');
  });
});

describe('registerSwAfterPaint（首屏画完以后那次注册，安全审 M1）', () => {
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
    const swReg = registerSwAfterPaint({ onReady, life, load: () => new Promise((res) => setTimeout(() => res(m), 5000)) });
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

  it('下载失败：返回 null，不注册、不认领，不抛', async () => {
    const runPushClaim = vi.fn();
    const r = await registerSwAfterPaint({ onReady: vi.fn(), life, load: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')) });
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
      const swReg = registerSwAfterPaint({ onReady: vi.fn(), life, load: async () => m }).catch(() => null);
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

  it('注册本身失败（exe、不支持）：返回 null，不挂监听', async () => {
    const { m } = lateModule();
    (m.registerServiceWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect(await registerSwAfterPaint({ onReady: vi.fn(), life, load: async () => m })).toBeNull();
    expect(m.watchServiceWorkerUpdate).not.toHaveBeenCalled();
    expect(m.checkSwOnForeground).not.toHaveBeenCalled();
  });
});
