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
