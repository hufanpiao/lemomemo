// 网页推送订阅（src/platform/push.ts；B2 任务单 FA-1，第一天派工表第 9 行）
// 真公钥还没生成（运维 O-x、tools/keys/），这里全用假公钥和模拟的 pushManager：
//   公钥格式校验、exe 不订、权限被拒、没有 SW、公钥相同复用、公钥换了先退订再订、退订
import { describe, expect, it, vi } from 'vitest';
import { resetNativeBridgeForTest, setNativeBridge } from '../native-bridge.ts';
import { CLAIM_STORAGE_KEY, decodeVapidKey, disconnectBrowserPush, subscribePush, unsubscribePush, VAPID_KEY_BYTES, type PushEnv, type PushRegistrationLike } from '../push.ts';

const b64u = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 假公钥：0x04 开头的 65 字节（只测格式，不需要是曲线上的点） */
function fakeKey(seed: number): { text: string; bytes: Uint8Array } {
  const bytes = new Uint8Array(VAPID_KEY_BYTES);
  bytes[0] = 0x04;
  for (let i = 1; i < bytes.length; i++) bytes[i] = (i * 7 + seed) & 0xff;
  return { text: b64u(bytes), bytes };
}
const K1 = fakeKey(1);
const K2 = fakeKey(2);

function fakeSub(key: Uint8Array, endpoint = 'https://push.example/ep/1') {
  const p256dh = new Uint8Array(65).fill(4);
  const auth = new Uint8Array(16).fill(9);
  return {
    endpoint,
    options: { applicationServerKey: key.slice().buffer, userVisibleOnly: true },
    getKey: (n: string) => (n === 'p256dh' ? p256dh.buffer : n === 'auth' ? auth.buffer : null),
    unsubscribe: vi.fn(async () => true),
  };
}

function env(over: { existing?: ReturnType<typeof fakeSub> | null; subscribeError?: Error; key?: string; win?: object } = {}) {
  let current = over.existing ?? null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (o: PushSubscriptionOptionsInit) => {
      if (over.subscribeError) throw over.subscribeError;
      current = fakeSub(o.applicationServerKey as Uint8Array, 'https://push.example/ep/new');
      return current;
    }),
  };
  const e: PushEnv = {
    key: over.key ?? K1.text,
    win: over.win ?? {},
    registration: async () => ({ pushManager }) as unknown as ServiceWorkerRegistration,
    permission: () => 'granted',
  };
  return { e, pushManager };
}

describe('decodeVapidKey', () => {
  it('65 字节、首字节 0x04 的 base64url 才算数（带不带 = 补位都行）', () => {
    expect(decodeVapidKey(K1.text)).toEqual(K1.bytes);
    expect(decodeVapidKey(`${K1.text}=`)).toEqual(K1.bytes); // 65 字节的标准补位正好一个 =
    expect(decodeVapidKey(`  ${K1.text}
`)).toEqual(K1.bytes); // 环境变量里多出的空白、换行去掉
    const std = btoa(String.fromCharCode(...K1.bytes));
    expect(decodeVapidKey(std.replace(/\+/g, '-').replace(/\//g, '_'))).toEqual(K1.bytes);
  });

  it.each([
    ['空串', ''],
    ['不是 base64url', 'abc$%'],
    ['长度不对（64 字节）', b64u(K1.bytes.slice(0, 64))],
    ['首字节不是 0x04（压缩点）', b64u(Uint8Array.from(K1.bytes, (v, i) => (i === 0 ? 0x02 : v)))],
    ['标准 base64 的 + /', btoa(String.fromCharCode(...K1.bytes)).replace(/-/g, '+') + '/'],
  ])('%s → null', (_n, k) => {
    expect(decodeVapidKey(k)).toBeNull();
  });
});

describe('subscribePush', () => {
  it('exe 里不订：返回 tauri，不碰 pushManager', async () => {
    const { e, pushManager } = env({ win: { __TAURI_INTERNALS__: {} } });
    expect(await subscribePush(e)).toEqual({ ok: false, reason: 'tauri' });
    expect(pushManager.getSubscription).not.toHaveBeenCalled();
  });

  it('没配公钥 / 公钥格式不对：不订', async () => {
    expect(await subscribePush({ ...env().e, key: '' })).toEqual({ ok: false, reason: 'no_key' });
    const { e, pushManager } = env({ key: 'not-a-key' });
    expect(await subscribePush(e)).toEqual({ ok: false, reason: 'bad_key' });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('权限已拒绝 / 没有 SW 注册', async () => {
    const { e, pushManager } = env();
    expect(await subscribePush({ ...e, permission: () => 'denied' })).toEqual({ ok: false, reason: 'denied' });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(await subscribePush({ ...e, registration: async () => null })).toEqual({ ok: false, reason: 'no_sw' });
    expect(await subscribePush({ ...e, registration: () => Promise.reject(new Error('x')) })).toEqual({ ok: false, reason: 'no_sw' });
  });

  it('第一次：用解出来的公钥订阅（userVisibleOnly），交回 endpoint、p256dh、auth', async () => {
    const { e, pushManager } = env();
    const r = await subscribePush(e);
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: K1.bytes });
    expect(r).toEqual({
      ok: true,
      changed: true,
      sub: { endpoint: 'https://push.example/ep/new', p256dh: b64u(new Uint8Array(65).fill(4)), auth: b64u(new Uint8Array(16).fill(9)) },
    });
  });

  it('已有订阅且公钥相同：原样返回，不重新订', async () => {
    const old = fakeSub(K1.bytes);
    const { e, pushManager } = env({ existing: old });
    const r = await subscribePush(e);
    expect(r).toMatchObject({ ok: true, changed: false, sub: { endpoint: 'https://push.example/ep/1' } });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(old.unsubscribe).not.toHaveBeenCalled();
  });

  it('公钥换了（轮换 VAPID）：先退订旧的，再用新公钥订', async () => {
    const old = fakeSub(K1.bytes);
    const { e, pushManager } = env({ existing: old, key: K2.text });
    const r = await subscribePush(e);
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: K2.bytes });
    expect(old.unsubscribe.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(pushManager.subscribe.mock.invocationCallOrder[0] ?? -Infinity);
    expect(r).toMatchObject({ ok: true, changed: true, sub: { endpoint: 'https://push.example/ep/new' } });
  });

  it('弹框里点了拒绝（NotAllowedError）→ denied；别的错 → failed；都不抛', async () => {
    expect(await subscribePush(env({ subscribeError: new DOMException('no', 'NotAllowedError') }).e)).toEqual({ ok: false, reason: 'denied' });
    expect(await subscribePush(env({ subscribeError: new DOMException('x', 'AbortError') }).e)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('unsubscribePush', () => {
  it('有订阅：退订并交回原 endpoint；没有订阅、exe 里：null', async () => {
    const old = fakeSub(K1.bytes);
    const { e } = env({ existing: old });
    expect(await unsubscribePush(e)).toBe('https://push.example/ep/1');
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(await unsubscribePush(env().e)).toBeNull();
    expect(await unsubscribePush({ ...env({ existing: fakeSub(K1.bytes) }).e, win: { __TAURI__: {} } })).toBeNull();
  });
});

describe('subscribePush：旧订阅读不到公钥、重订失败（代码审查 S6）', () => {
  it('applicationServerKey 读不到（null）：当作没换，原样用，不退订', async () => {
    const old = { ...fakeSub(K1.bytes), options: { applicationServerKey: null, userVisibleOnly: true } };
    const { e, pushManager } = env({ existing: old as unknown as ReturnType<typeof fakeSub>, key: K2.text });
    expect(await subscribePush(e)).toMatchObject({ ok: true, changed: false, sub: { endpoint: 'https://push.example/ep/1' } });
    expect(old.unsubscribe).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('公钥换了、旧的已退掉、新的没订上：resubscribe_failed（设置页据此提示重新打开）', async () => {
    const old = fakeSub(K1.bytes);
    const { e } = env({ existing: old, key: K2.text, subscribeError: new DOMException('x', 'AbortError') });
    expect(await subscribePush(e)).toEqual({ ok: false, reason: 'resubscribe_failed' });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    // 第一次订（没有旧的）失败仍是 failed
    expect(await subscribePush(env({ subscribeError: new DOMException('x', 'AbortError') }).e)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('disconnectBrowserPush（B2 安全审查 FE-2）', () => {
  const note = (tag: string, closed: string[]) => ({ tag, close: () => void closed.push(tag) });

  it('先关掉所有已显示的通知，再退订', async () => {
    const closed: string[] = [];
    const order: string[] = [];
    const sub = fakeSub(K1.bytes);
    sub.unsubscribe.mockImplementation(async () => (order.push('unsubscribe'), true));
    const reg = {
      getNotifications: vi.fn(async () => {
        order.push('getNotifications');
        return [note('event:a:1', closed), note('todo:b:2', closed)];
      }),
      pushManager: { getSubscription: vi.fn(async () => sub) },
    };
    await disconnectBrowserPush({ win: {}, registration: async () => reg as unknown as PushRegistrationLike });
    expect(closed).toEqual(['event:a:1', 'todo:b:2']);
    expect(order).toEqual(['getNotifications', 'unsubscribe']);
  });

  it('getNotifications 不支持、退订出错、取不到 SW：都不抛', async () => {
    const sub = fakeSub(K1.bytes);
    sub.unsubscribe.mockRejectedValue(new Error('x'));
    const reg = { getNotifications: vi.fn(async () => Promise.reject(new Error('no'))), pushManager: { getSubscription: vi.fn(async () => sub) } };
    await expect(disconnectBrowserPush({ win: {}, registration: async () => reg as unknown as PushRegistrationLike })).resolves.toBeUndefined();
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    await expect(disconnectBrowserPush({ win: {}, registration: () => Promise.reject(new Error('x')) })).resolves.toBeUndefined();
    await expect(disconnectBrowserPush({ win: {}, registration: async () => null })).resolves.toBeUndefined();
  });

  it('卡住也不挡退出：到上限就返回', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const p = disconnectBrowserPush({ win: {}, registration: () => new Promise(() => undefined) }, 2000).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exe 里：不碰网页推送，只关掉已弹出的全部本机通知（安全审查 X-5）', async () => {
    const registration = vi.fn(async () => null);
    const closeLocal = vi.fn(async () => undefined);
    await disconnectBrowserPush({ win: { __TAURI_INTERNALS__: {} }, registration, closeLocal });
    expect(registration).not.toHaveBeenCalled();
    expect(closeLocal).toHaveBeenCalledOnce();
  });

  it('exe 里关本机通知出错、同步抛、卡住都不挡退出（X-5）', async () => {
    const win = { __TAURI_INTERNALS__: {} };
    await expect(disconnectBrowserPush({ win, closeLocal: () => Promise.reject(new Error('x')) })).resolves.toBeUndefined();
    await expect(disconnectBrowserPush({ win, closeLocal: () => { throw new Error('y'); } })).resolves.toBeUndefined();
    vi.useFakeTimers();
    try {
      let done = false;
      const p = disconnectBrowserPush({ win, closeLocal: () => new Promise(() => undefined) }, 2000).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('默认接的是 platform 桥的 closeAllLocalReminders（exe 装桥后转给 desktop.ts）', async () => {
    const b = {
      openReminder: vi.fn(async () => undefined), openAuth: vi.fn(async () => undefined),
      requestAppUpdate: vi.fn(async () => 'no_update' as const), showLocalReminder: vi.fn(async () => undefined),
      closeLocalReminder: vi.fn(async () => undefined), closeAllLocalReminders: vi.fn(async () => undefined),
    };
    setNativeBridge(b);
    try {
      await disconnectBrowserPush({ win: { __TAURI_INTERNALS__: {} } });
      expect(b.closeAllLocalReminders).toHaveBeenCalledOnce();
    } finally {
      resetNativeBridgeForTest();
    }
  });

  it('网页、exe 两边都删掉本机的认领记录（安全审查 FA2-1、M2）；读不了存储也不抛', async () => {
    for (const win of [{}, { __TAURI_INTERNALS__: {} }]) {
      const m = new Map<string, string>([[CLAIM_STORAGE_KEY, 'ok\nxxxx'], ['other', '1']]);
      const storage = { removeItem: (k: string) => void m.delete(k) } as unknown as Storage;
      await disconnectBrowserPush({ win, registration: async () => null, closeLocal: async () => undefined, storage: () => storage });
      expect(m.has(CLAIM_STORAGE_KEY)).toBe(false);
      expect(m.get('other')).toBe('1');
    }
    await expect(
      disconnectBrowserPush({ win: {}, registration: async () => null, storage: () => { throw new Error('blocked'); } }),
    ).resolves.toBeUndefined();
  });

  it('网页里不调本机通知那一份（网页的通知用 getNotifications 关）', async () => {
    const closeLocal = vi.fn(async () => undefined);
    await disconnectBrowserPush({ win: {}, registration: async () => null, closeLocal });
    expect(closeLocal).not.toHaveBeenCalled();
  });
});
