// 退出、换账号时断开浏览器推送改成按需下载 push.ts（11-05 首屏瘦身，主持人定第 3 项）：
// 认领记录先删、不等下载（安全审查 FA2-1）；下载失败、断开抛错都不抛，记 push_disconnect_fail；设置页退出（wipeThisDevice）照常删库、清缓存
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 默认路径上的 push.ts 下载失败（模拟分包取不到）
vi.mock('../push.ts', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const { disconnectPushLazy, fallbackDisconnect, LOAD_PUSH_MS, setPushDisconnectLog } = await import('../push-disconnect.ts');
const { DISCONNECT_PUSH_MS } = await import('../push-claim-key.ts');
const { CLAIM_STORAGE_KEY } = await import('../push-claim-key.ts');
const { defaultExitSteps, wipeThisDevice } = await import('../sign-out.ts');

const logs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  setPushDisconnectLog(null);
  logs.length = 0;
  localStorage.clear();
});

describe('disconnectPushLazy', () => {
  it('下载失败：认领记录照样删掉，不抛，记一条 load', async () => {
    setPushDisconnectLog((code) => void logs.push(code));
    localStorage.setItem(CLAIM_STORAGE_KEY, 'ok\nabc');
    await expect(disconnectPushLazy()).resolves.toBeUndefined();
    expect(localStorage.getItem(CLAIM_STORAGE_KEY)).toBeNull();
    expect(logs).toEqual(['load']);
  });

  it('下载成功：调 disconnectBrowserPush，不记日志', async () => {
    setPushDisconnectLog((code) => void logs.push(code));
    const disconnectBrowserPush = vi.fn(async () => undefined);
    await disconnectPushLazy(async () => ({ disconnectBrowserPush }));
    expect(disconnectBrowserPush).toHaveBeenCalledOnce();
    expect(logs).toEqual([]);
  });

  it('断开抛错：不抛，记一条 error；日志通道自己出错也不抛；没接日志通道也不抛', async () => {
    const boom = async (): Promise<never> => Promise.reject(new Error('x'));
    setPushDisconnectLog((code) => void logs.push(code));
    await expect(disconnectPushLazy(async () => ({ disconnectBrowserPush: boom }))).resolves.toBeUndefined();
    expect(logs).toEqual(['error']);
    setPushDisconnectLog(() => {
      throw new Error('log');
    });
    await expect(disconnectPushLazy(async () => ({ disconnectBrowserPush: boom }))).resolves.toBeUndefined();
    setPushDisconnectLog(null);
    await expect(disconnectPushLazy()).resolves.toBeUndefined();
  });
});

/** 假的 SW 注册：记下关了几条通知、有没有取订阅、退订 */
function fakeReg(o: { notes?: number; sub?: boolean; hangSub?: boolean } = {}) {
  const log: string[] = [];
  const reg = {
    getNotifications: async () => Array.from({ length: o.notes ?? 2 }, (_, i) => ({ close: () => void log.push(`close${i}`) })),
    pushManager: {
      getSubscription: () => {
        log.push('getSub');
        if (o.hangSub) return new Promise<never>(() => undefined);
        return Promise.resolve(o.sub === false ? null : { unsubscribe: async () => (log.push('unsub'), true) });
      },
    },
  } as unknown as PushRegistration;
  return { reg, log };
}
type PushRegistration = Pick<ServiceWorkerRegistration, 'pushManager' | 'getNotifications'>;
const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);

describe('安全审查必改 1：下载 + 断开整体有上限（DISCONNECT_PUSH_MS）', () => {
  it('下载一直不回：LOAD_PUSH_MS 时记 timeout、走兜底（关通知、退订），整体在上限内结束', async () => {
    vi.useFakeTimers();
    setPushDisconnectLog((code) => void logs.push(code));
    localStorage.setItem(CLAIM_STORAGE_KEY, 'ok\nabc');
    const { reg, log } = fakeReg();
    let done = false;
    const p = disconnectPushLazy(never, { registration: async () => reg, permission: () => 'granted' }).then(() => void (done = true));
    // 认领记录不等下载
    expect(localStorage.getItem(CLAIM_STORAGE_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(LOAD_PUSH_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(logs).toEqual(['timeout']);
    expect(log).toEqual(['close0', 'close1', 'getSub', 'unsub']);
  });

  it('下载一直不回、兜底也卡住（取注册不回、getSubscription 不回）：最多 DISCONNECT_PUSH_MS 就返回，记 timeout、fallback', async () => {
    vi.useFakeTimers();
    setPushDisconnectLog((code) => void logs.push(code));
    for (const env of [{ registration: never }, { registration: async () => fakeReg({ hangSub: true }).reg, permission: () => 'granted' as const }]) {
      logs.length = 0;
      let done = false;
      const p = disconnectPushLazy(never, env).then(() => void (done = true));
      await vi.advanceTimersByTimeAsync(DISCONNECT_PUSH_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(logs).toEqual(['timeout', 'fallback']);
    }
  });

  it('下载到了、断开一直不回：整体到 DISCONNECT_PUSH_MS 返回，记 timeout；断开拿到的上限是剩下的时间', async () => {
    vi.useFakeTimers();
    setPushDisconnectLog((code) => void logs.push(code));
    const got: unknown[] = [];
    const disconnectBrowserPush = vi.fn((...a: unknown[]) => (got.push(a[1]), never<void>()));
    const slow = () => new Promise<{ disconnectBrowserPush: typeof disconnectBrowserPush }>((r) => setTimeout(() => r({ disconnectBrowserPush }), 300));
    let done = false;
    const p = disconnectPushLazy(slow as never).then(() => void (done = true));
    await vi.advanceTimersByTimeAsync(300);
    expect(got).toEqual([DISCONNECT_PUSH_MS - 300]);
    await vi.advanceTimersByTimeAsync(DISCONNECT_PUSH_MS - 301);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(logs).toEqual(['timeout']);
  });
});

describe('安全审查 S1：下载失败时不依赖 push.ts 的兜底', () => {
  it('下载失败：关掉已显示的通知、退订（权限 granted）', async () => {
    setPushDisconnectLog((code) => void logs.push(code));
    const { reg, log } = fakeReg();
    await disconnectPushLazy(async () => Promise.reject(new Error('x')), { registration: async () => reg, permission: () => 'granted' });
    expect(logs).toEqual(['load']);
    expect(log).toEqual(['close0', 'close1', 'getSub', 'unsub']);
  });

  it('退订的跳过条件和 push.ts 同一套：权限 default、denied 只关通知、不取订阅；没有 Notification（null）照常退订', async () => {
    for (const [perm, want] of [
      ['default', ['close0']],
      ['denied', ['close0']],
      [null, ['close0', 'getSub', 'unsub']],
    ] as const) {
      const { reg, log } = fakeReg({ notes: 1 });
      await fallbackDisconnect({ registration: async () => reg, permission: () => perm });
      expect(log, String(perm)).toEqual(want);
    }
  });

  it('没有订阅、getNotifications 抛错、没有 SW：都不抛', async () => {
    const { reg, log } = fakeReg({ sub: false, notes: 0 });
    await expect(fallbackDisconnect({ registration: async () => reg, permission: () => 'granted' })).resolves.toBeUndefined();
    expect(log).toEqual(['getSub']);
    const bad = { ...reg, getNotifications: async () => Promise.reject(new Error('no')) } as PushRegistration;
    await expect(fallbackDisconnect({ registration: async () => bad, permission: () => 'granted' })).resolves.toBeUndefined();
    // jsdom 没有 navigator.serviceWorker：默认取注册返回 null
    await expect(fallbackDisconnect()).resolves.toBeUndefined();
  });

  it('兜底出错：不抛，记 fallback', async () => {
    setPushDisconnectLog((code) => void logs.push(code));
    await expect(disconnectPushLazy(async () => Promise.reject(new Error('x')), { registration: async () => Promise.reject(new Error('sw')) })).resolves.toBeUndefined();
    expect(logs).toEqual(['load', 'fallback']);
  });

  it('exe（S3）：兜底关掉已弹出的全部本机通知，不碰 SW', async () => {
    const closeLocal = vi.fn(async () => undefined);
    const registration = vi.fn(async () => null);
    await disconnectPushLazy(async () => Promise.reject(new Error('x')), { win: { __TAURI_INTERNALS__: {} }, closeLocal, registration });
    expect(closeLocal).toHaveBeenCalledOnce();
    expect(registration).not.toHaveBeenCalled();
  });

  it('下载成功时不走兜底', async () => {
    const registration = vi.fn(async () => null);
    await disconnectPushLazy(async () => ({ disconnectBrowserPush: async () => undefined }), { registration });
    expect(registration).not.toHaveBeenCalled();
  });
});

describe('复审 S4、S5', () => {
  it('S4：默认取注册用 getRegistration("/app/")，没注册立刻结束，不等满剩余时间、不记 fallback', async () => {
    vi.useFakeTimers();
    setPushDisconnectLog((code) => void logs.push(code));
    const getRegistration = vi.fn(async (_scope?: string) => undefined);
    const sw = { getRegistration, get ready(): Promise<never> { throw new Error('不该用 ready'); } };
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    try {
      let done = false;
      const p = disconnectPushLazy(async () => Promise.reject(new Error('x'))).then(() => void (done = true));
      await vi.advanceTimersByTimeAsync(0);
      await p;
      expect(done).toBe(true);
      expect(getRegistration).toHaveBeenCalledWith('/app/');
      expect(logs).toEqual(['load']);
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  });

  it('S5：load、取注册在返回 promise 之前就同步抛错：照样接住、不抛，分别记 load、fallback', async () => {
    setPushDisconnectLog((code) => void logs.push(code));
    const syncThrow = (): Promise<never> => {
      throw new Error('sync');
    };
    await expect(disconnectPushLazy(syncThrow, { registration: syncThrow })).resolves.toBeUndefined();
    expect(logs).toEqual(['load', 'fallback']);
  });
});

describe('设置页退出：push.ts 下载失败照样退出', () => {
  it('默认的几步（defaultExitSteps.disconnectPush）：删库、清缓存照常，认领记录删掉，记 load', async () => {
    setPushDisconnectLog((code) => void logs.push(code));
    localStorage.setItem(CLAIM_STORAGE_KEY, 'ok\nabc');
    const order: string[] = [];
    await expect(
      wipeThisDevice({
        ...defaultExitSteps,
        wipe: async () => (order.push('wipe'), false),
        deleteDb: async () => void order.push('deleteDb'),
        clearCacheStorage: async () => void order.push('clearCacheStorage'),
      }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['wipe', 'deleteDb', 'clearCacheStorage']);
    expect(localStorage.getItem(CLAIM_STORAGE_KEY)).toBeNull();
    expect(logs).toEqual(['load']);
  });
});

describe('接线', () => {
  it('account.ts、sign-out.ts 不再静态引 push.ts，默认都走 disconnectPushLazy；main.tsx 接上日志', () => {
    for (const f of ['src/core/account.ts', 'src/platform/sign-out.ts']) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/^import [^;]*from '[^']*\/push\.ts';$/m);
      expect(s, f).toContain('disconnectPushLazy()');
    }
    expect(readFileSync('src/app/main.tsx', 'utf8')).toContain("setPushDisconnectLog((code) => logs.log('push_disconnect_fail', { code }))");
  });
});
