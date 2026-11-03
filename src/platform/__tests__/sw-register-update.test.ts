// SW 更新那一半（updateServiceWorker：断网、接管超时和没查成、activated 与安装失败）和升级日志计数（upgradeLogCountStore）；
// 从 sw-register.test.ts 分出来（那个文件超过 300 行），注册、有新版本、回到前台检查留在原文件
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateServiceWorker } from '../sw-register.ts';

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('updateServiceWorker：断网时（复审必改）', () => {
  function stubReg(reg: object) {
    const sw = Object.assign(new EventTarget(), { controller: {}, getRegistration: () => Promise.resolve(reg) });
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    return sw;
  }

  it('已有等着接管的新版本（reg.waiting）：不调 update()（断网会失败），直接发 SKIP_WAITING，接管后回 reloading', async () => {
    const waiting = { state: 'installed', addEventListener: vi.fn(), postMessage: vi.fn() };
    const update = vi.fn(() => Promise.reject(new Error('offline')));
    const sw = stubReg({ waiting, installing: null, update });
    waiting.postMessage.mockImplementation(() => sw.dispatchEvent(new Event('controllerchange')));
    expect(await updateServiceWorker(1000)).toBe('reloading');
    expect(update).not.toHaveBeenCalled();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('本页已被别的标签页让新 SW 接管、没有 waiting，update() 断网失败：回 failed（交给升级中心按 swReady 重新载入），不回 no_update', async () => {
    const update = vi.fn(() => Promise.reject(new Error('offline')));
    stubReg({ waiting: null, installing: null, update });
    expect(await updateServiceWorker(1000)).toBe('failed');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('update() 成功、什么也没查到：回 no_update', async () => {
    stubReg({ waiting: null, installing: null, update: () => Promise.resolve() });
    expect(await updateServiceWorker(1000)).toBe('no_update');
  });
});

describe('updateServiceWorker：接管超时和没查成分开（BANNER-sugg ⑤）', () => {
  function stubReg(reg: object) {
    const sw = Object.assign(new EventTarget(), { controller: {}, getRegistration: () => Promise.resolve(reg) });
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    return sw;
  }

  it('发了 SKIP_WAITING、waitMs 内没有 controllerchange：回 takeover_timeout，不回 failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const waiting = { state: 'installed', addEventListener: vi.fn(), postMessage: vi.fn() };
    stubReg({ waiting, installing: null, update: vi.fn() });
    let r: unknown = 'pending';
    void updateServiceWorker(1000).then((x) => (r = x));
    await vi.advanceTimersByTimeAsync(999);
    expect(r).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(r).toBe('takeover_timeout');
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('查到正在装的新 SW，waitMs 内没装好：回 takeover_timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const installing = Object.assign(new EventTarget(), { state: 'installing', postMessage: vi.fn() });
    stubReg({ waiting: null, installing, update: () => Promise.resolve() });
    let r: unknown = 'pending';
    void updateServiceWorker(1000).then((x) => (r = x));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r).toBe('takeover_timeout');
    expect(installing.postMessage).not.toHaveBeenCalled();
  });

  it('拿注册就出错：仍是 failed（没查成）', async () => {
    const sw = Object.assign(new EventTarget(), { controller: {}, getRegistration: () => Promise.reject(new Error('x')) });
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    expect(await updateServiceWorker(1000)).toBe('failed');
  });
});

describe('updateServiceWorker：activated 与安装失败（B 组审查建议 3）', () => {
  function stubReg(reg: object) {
    const sw = Object.assign(new EventTarget(), { controller: null, getRegistration: () => Promise.resolve(reg) });
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    return sw;
  }

  it('没等到 controllerchange 但新 SW 已 activated（本页没有 controller）：回 reloading，不卡在 stalled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const waiting = { state: 'installed', addEventListener: vi.fn(), postMessage: vi.fn() };
    waiting.postMessage.mockImplementation(() => void (waiting.state = 'activated'));
    stubReg({ waiting, installing: null, update: vi.fn() });
    let r: unknown = 'pending';
    void updateServiceWorker(1000).then((x) => (r = x));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r).toBe('reloading');
  });

  it('新 SW 安装失败（redundant）：回 failed，不算接管超时；一开始就是 redundant 也一样', async () => {
    const installing = Object.assign(new EventTarget(), { state: 'installing', postMessage: vi.fn() });
    stubReg({ waiting: null, installing, update: () => Promise.resolve() });
    const p = updateServiceWorker(1000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    installing.state = 'redundant';
    installing.dispatchEvent(new Event('statechange'));
    expect(await p).toBe('failed');
    expect(installing.postMessage).not.toHaveBeenCalled();

    const dead = Object.assign(new EventTarget(), { state: 'redundant', postMessage: vi.fn() });
    stubReg({ waiting: null, installing: dead, update: () => Promise.resolve() });
    expect(await updateServiceWorker(1000)).toBe('failed');
  });
});

describe('upgradeLogCountStore（B 组审查建议 1）', () => {
  it('读写 localStorage 的 lemo.upglog；写不进时抛出（交给升级中心退回内存计数）', async () => {
    const { upgradeLogCountStore } = await import('../sw-register.ts');
    localStorage.removeItem('lemo.upglog');
    expect(upgradeLogCountStore.get()).toBeNull();
    upgradeLogCountStore.set('{"d":"2026-10-30","c":{}}');
    expect(localStorage.getItem('lemo.upglog')).toBe('{"d":"2026-10-30","c":{}}');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => upgradeLogCountStore.set('x')).toThrow();
    } finally {
      spy.mockRestore();
      localStorage.removeItem('lemo.upglog');
    }
  });
});
