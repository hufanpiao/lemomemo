// 注册 SW（K6 复审建议 3）：注册一直不返回时最多等 waitMs，返回 null，入口不会白屏；失败、不支持也返回 null
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from '../sw-register.ts';

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
