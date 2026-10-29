// 注册 SW（K6 复审建议 3）：注册一直不返回时最多等 waitMs，返回 null，入口不会白屏；失败、不支持也返回 null
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSwOnForeground, registerServiceWorker, SW_FOREGROUND_CHECK_MS, updateServiceWorker, watchServiceWorkerUpdate } from '../sw-register.ts';

function stubSw(register: () => Promise<unknown>) {
  Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('registerServiceWorker', () => {
  it('注册一直不返回：waitMs 后返回 null', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubSw(() => new Promise(() => undefined));
    let done: unknown = 'pending';
    void registerServiceWorker(3000).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBeNull();
  });

  it('正常注册：返回注册对象；注册抛错：返回 null；不支持：返回 null', async () => {
    const reg = { scope: '/app/' };
    stubSw(() => Promise.resolve(reg));
    expect(await registerServiceWorker()).toBe(reg);
    stubSw(() => Promise.reject(new Error('x')));
    expect(await registerServiceWorker()).toBeNull();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    expect(await registerServiceWorker()).toBeNull();
  });
});

/** 假的 registration：能发 updatefound，installing 能发 statechange */
function fakeReg(waiting: object | null = null) {
  const reg = new EventTarget() as EventTarget & { installing: (EventTarget & { state: string }) | null; waiting: object | null };
  reg.installing = null;
  reg.waiting = waiting;
  const install = () => {
    const sw = Object.assign(new EventTarget(), { state: 'installing' });
    reg.installing = sw;
    reg.dispatchEvent(new Event('updatefound'));
    return (state: string) => {
      sw.state = state;
      sw.dispatchEvent(new Event('statechange'));
    };
  };
  return { reg: reg as unknown as ServiceWorkerRegistration, install };
}

function stubController(controller: object | null) {
  const sw = Object.assign(new EventTarget(), { controller });
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  return sw;
}

describe('watchServiceWorkerUpdate（8.1 有新版本）', () => {
  it('已有 controller 时新 SW 装好（installed）：回调一次；装到一半不回调', () => {
    stubController({});
    const { reg, install } = fakeReg();
    const onReady = vi.fn();
    watchServiceWorkerUpdate(reg, onReady);
    const to = install();
    to('installing');
    expect(onReady).not.toHaveBeenCalled();
    to('installed');
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('第一次安装（还没有 controller）不算新版本，不回调', () => {
    stubController(null);
    const { reg, install } = fakeReg();
    const onReady = vi.fn();
    watchServiceWorkerUpdate(reg, onReady);
    install()('installed');
    expect(onReady).not.toHaveBeenCalled();
  });

  it('注册时已经有等着接管的（reg.waiting）：马上回调；取消订阅后不再回调', () => {
    stubController({});
    const { reg, install } = fakeReg({});
    const onReady = vi.fn();
    const off = watchServiceWorkerUpdate(reg, onReady);
    expect(onReady).toHaveBeenCalledTimes(1);
    off();
    install()('installed');
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

describe('watchServiceWorkerUpdate：挂上时正在装、别的标签页让新 SW 接管', () => {
  it('挂上时 reg.installing 已经在装：装好照样回调', () => {
    stubController({});
    const { reg } = fakeReg();
    const sw = Object.assign(new EventTarget(), { state: 'installing' });
    (reg as unknown as { installing: unknown }).installing = sw;
    const onReady = vi.fn();
    watchServiceWorkerUpdate(reg, onReady);
    sw.state = 'installed';
    sw.dispatchEvent(new Event('statechange'));
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('别的标签页按了“重新打开”、新 SW 接管本页（controllerchange）：回调（审查必改 2）；本页原来没有 controller 时不算', () => {
    const c1 = stubController({});
    const onReady = vi.fn();
    watchServiceWorkerUpdate(fakeReg().reg, onReady);
    c1.dispatchEvent(new Event('controllerchange'));
    expect(onReady).toHaveBeenCalledTimes(1);

    const c2 = stubController(null);
    const first = vi.fn();
    watchServiceWorkerUpdate(fakeReg().reg, first);
    c2.dispatchEvent(new Event('controllerchange'));
    expect(first).not.toHaveBeenCalled();
  });
});

describe('checkSwOnForeground（架构师 10-30 第 5 点）', () => {
  function life() {
    let fire: (v: boolean) => void = () => undefined;
    const l = { online: true, onVisibility: (fn: (v: boolean) => void) => ((fire = fn), () => (fire = () => undefined)), isOnline: () => l.online };
    return { l, show: (v = true) => fire(v) };
  }

  it('切到前台、在线、距上次已满 1 小时才调 registration.update()；不满、在后台、离线都不调；查过以后重新计时', () => {
    const clock = { t: 0 };
    const update = vi.fn(() => Promise.resolve());
    const reg = { update } as unknown as ServiceWorkerRegistration;
    const { l, show } = life();
    checkSwOnForeground(reg, { life: l, now: () => clock.t });
    clock.t = SW_FOREGROUND_CHECK_MS - 1;
    show();
    expect(update).not.toHaveBeenCalled();
    clock.t = SW_FOREGROUND_CHECK_MS;
    show(false);
    l.online = false;
    show();
    expect(update).not.toHaveBeenCalled();
    l.online = true;
    show();
    expect(update).toHaveBeenCalledTimes(1);
    clock.t += SW_FOREGROUND_CHECK_MS - 1;
    show();
    expect(update).toHaveBeenCalledTimes(1);
    clock.t += 1;
    show();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('update() 失败不抛；取消订阅后不再查', async () => {
    const clock = { t: 0 };
    const update = vi.fn(() => Promise.reject(new Error('offline')));
    const { l, show } = life();
    const off = checkSwOnForeground({ update } as unknown as ServiceWorkerRegistration, { life: l, now: () => clock.t, intervalMs: 10 });
    clock.t = 10;
    show();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
    off();
    clock.t = 100;
    show();
    expect(update).toHaveBeenCalledTimes(1);
  });
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

describe('checkSwOnForeground：系统时间往回调（BANNER-sugg ②，B 组审查必改）', () => {
  it('默认用 Date.now()（不用 performance.now()：iOS 锁屏睡眠时它不走）', () => {
    let wall = 2_000_000_000_000;
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => 0);
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    try {
      let fire: (v: boolean) => void = () => undefined;
      const update = vi.fn(() => Promise.resolve());
      checkSwOnForeground({ update } as unknown as ServiceWorkerRegistration, {
        life: { onVisibility: (fn) => ((fire = fn), () => undefined), isOnline: () => true },
      });
      wall += SW_FOREGROUND_CHECK_MS;   // 后台睡了 1 小时：墙上时钟走了，performance.now 没走
      fire(true);
      expect(update).toHaveBeenCalledTimes(1);
      expect(perf).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('时间往回调：从现在重新计时、不卡住；之后满 1 小时照样查', () => {
    const clock = { t: 10 * SW_FOREGROUND_CHECK_MS };
    let fire: (v: boolean) => void = () => undefined;
    const update = vi.fn(() => Promise.resolve());
    checkSwOnForeground({ update } as unknown as ServiceWorkerRegistration, {
      life: { onVisibility: (fn) => ((fire = fn), () => undefined), isOnline: () => true }, now: () => clock.t,
    });
    clock.t -= 5 * SW_FOREGROUND_CHECK_MS;   // 往回调 5 小时
    fire(true);
    expect(update).not.toHaveBeenCalled();
    clock.t += SW_FOREGROUND_CHECK_MS - 1;
    fire(true);
    expect(update).not.toHaveBeenCalled();
    clock.t += 1;   // 从回调那一刻起满 1 小时（不用等回到原来的时刻再过 1 小时）
    fire(true);
    expect(update).toHaveBeenCalledTimes(1);
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
