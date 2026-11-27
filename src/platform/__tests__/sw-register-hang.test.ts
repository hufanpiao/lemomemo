// registerSw 一直等不到结果（安全审 M1、Q-23 的不变量“不设超时、等真实结果”，从 sw-lazy.test.ts 拆出，那边超过 300 行）：
// 原来只钉到 5 秒（sw-lazy.test.ts 的 Q-23 用例）；这里推 10 分钟，以后不管在 registerServiceWorker 或 registerSw 里加多长的超时都会变红
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSw, type SwLifecycleModule } from '../sw-register.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('一直不回来：推 10 分钟仍在等，不当失败', () => {
  const TEN_MIN = 10 * 60_000;
  /** 跑一遍和 app/main.tsx 同样的接法：registerSw(...).catch(() => null)，拿到 reg 才推送认领；时钟全换成假的推 10 分钟 */
  async function hangFor(load: () => Promise<SwLifecycleModule>) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const lines: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g['__lemoRunLog'] = { q: [], sink: (l: string) => void lines.push(l) };
    const hangLife = { onVisibility: vi.fn(() => () => undefined), isOnline: () => true };
    const runPushClaim = vi.fn();
    let got: unknown = 'pending';
    const swReg = registerSw({ onReady: vi.fn(), life: hangLife, load }).catch(() => null);
    void swReg.then((r) => {
      got = r;
      if (r) runPushClaim();
    });
    await vi.advanceTimersByTimeAsync(TEN_MIN);
    Reflect.deleteProperty(g, '__lemoRunLog');
    return { got, lines, hangLife, runPushClaim };
  }

  it('① register 永远不 resolve（真实 sw-lifecycle.ts、假 navigator.serviceWorker）：仍 pending，不记 sw register 行，不挂新版本监听、回到前台检查，不认领', async () => {
    const real = await import('../sw-lifecycle.ts');
    const sw = Object.assign(new EventTarget(), { controller: null, register: vi.fn(() => new Promise<never>(() => undefined)) });
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    try {
      // 只给两个挂监听的函数套上 spy（模块命名空间不能 spyOn），注册本身走真的 registerServiceWorker
      const m = { ...real, watchServiceWorkerUpdate: vi.fn(real.watchServiceWorkerUpdate), checkSwOnForeground: vi.fn(real.checkSwOnForeground) };
      const r = await hangFor(async () => m);
      expect(sw.register).toHaveBeenCalledOnce();
      expect(r.got).toBe('pending');
      expect(r.lines.filter((l) => l.startsWith('sw register'))).toEqual([]);
      expect(m.watchServiceWorkerUpdate).not.toHaveBeenCalled();
      expect(m.checkSwOnForeground).not.toHaveBeenCalled();
      expect(r.hangLife.onVisibility).not.toHaveBeenCalled();
      expect(r.runPushClaim).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  });

  it('② 注册代码的下载（load）永远不 resolve：仍 pending，没有 sw register fail load 行，不认领', async () => {
    const r = await hangFor(() => new Promise<never>(() => undefined));
    expect(r.got).toBe('pending');
    expect(r.lines.filter((l) => l.startsWith('sw register'))).toEqual([]);
    expect(r.hangLife.onVisibility).not.toHaveBeenCalled();
    expect(r.runPushClaim).not.toHaveBeenCalled();
  });
});
