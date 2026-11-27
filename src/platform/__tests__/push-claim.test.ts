// 启动时重订、认领推送（FA-1；换账号后旧订阅已退订，新账号要重新订阅并认领——协调者转来的第 1 件；风险 R1；0.38 第 35 条）
// claim_endpoint 用假实现测（“接口先定”第 1 条）；本机记录只存摘要（FA2-1、FA2-2），认领前先登记设备行（M3）
import { describe, expect, it, vi } from 'vitest';
import type { NetResult } from '../../../shared/schema/sync.ts';
import {
  CLAIM_STORAGE_KEY, claimParams, defaultPushLabel, ensurePushSubscription, parseClaimResult, sha256Short, UNSUPPORTED_TTL_MS,
  type ClaimArgs, type EnsurePushDeps, type KeyValueLike,
} from '../push-claim.ts';
import type { PushSubscribeResult } from '../push.ts';

const EP = { endpoint: 'https://web.push.apple.com/abc', p256dh: 'B' + 'a'.repeat(86), auth: 'b'.repeat(22) };

function memStore(): KeyValueLike & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

function deps(over: Partial<EnsurePushDeps> = {}, sub: PushSubscribeResult = { ok: true, sub: EP, changed: false }) {
  const store = memStore();
  const claim = vi.fn(async (_a: ClaimArgs): Promise<NetResult<unknown>> => ({ ok: true, value: { ok: true } }));
  const subscribe = vi.fn(async () => sub);
  const d: EnsurePushDeps = {
    userId: 'A', platform: 'ios', label: 'iPhone', win: {}, permission: () => 'granted', subscribe, claim, storage: () => store,
    sessionId: () => 'S1', ...over,
  };
  return { d, store, claim, subscribe };
}

const NL = '\n';
const okVal = async (user: string, sid: string, ep: string): Promise<string> => `ok${NL}${await sha256Short([user, sid, ep].join(NL))}`;
const notFound = (): NetResult<unknown> => ({ ok: false, error: { status: 400, code: 'device_not_found' } });

describe('parseClaimResult（“接口先定”第 1 条）', () => {
  it('成功、被同账号占用、不支持、设备行不在、其他失败', () => {
    expect(parseClaimResult({ ok: true, value: { ok: true } })).toEqual({ ok: true });
    const holder = { id: 'd1', label: 'iPad', last_seen_at: '2026-11-03T00:00:00Z', install_id: 'i1' };
    expect(parseClaimResult({ ok: true, value: { error: 'endpoint_in_use', holder } })).toEqual({ ok: false, reason: 'endpoint_in_use', holder });
    for (const code of ['endpoint_not_allowed', 'bad_push_keys']) {
      expect(parseClaimResult({ ok: false, error: { status: 400, code, detail: '22023' } })).toEqual({ ok: false, reason: 'not_supported' });
    }
    expect(parseClaimResult(notFound())).toEqual({ ok: false, reason: 'device_not_found' });
    expect(parseClaimResult({ ok: false, error: { network: true } })).toEqual({ ok: false, reason: 'failed' });
    expect(parseClaimResult({ ok: false, error: { status: 401, code: 'session_revoked' } })).toEqual({ ok: false, reason: 'failed' });
  });

  it('形状不认识的一律 failed', () => {
    for (const v of [null, 'ok', 1, {}, { ok: 'true' }, { error: 'endpoint_in_use' }, { error: 'endpoint_in_use', holder: { id: '' } }]) {
      expect(parseClaimResult({ ok: true, value: v })).toEqual({ ok: false, reason: 'failed' });
    }
  });
});

describe('ensurePushSubscription', () => {
  it('第一次：订阅后按五个入参认领，本机只存摘要（不含 endpoint、user_id、session_id 原文，FA2-1）', async () => {
    const { d, store, claim } = deps({ userId: 'user-A-uuid', sessionId: () => 'sess-1-uuid' }, { ok: true, sub: EP, changed: true });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(claim).toHaveBeenCalledWith({ ...EP, label: 'iPhone', platform: 'ios' });
    const v = store.m.get(CLAIM_STORAGE_KEY) ?? '';
    expect(v).toBe(await okVal('user-A-uuid', 'sess-1-uuid', EP.endpoint));
    for (const plain of ['https://', 'web.push', 'user-A-uuid', 'sess-1-uuid', EP.p256dh, EP.auth]) expect(v).not.toContain(plain);
    expect(v.split(NL)[1]).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('同账号、同会话、同 endpoint、没换订阅：不再认领', async () => {
    const { d, store, claim } = deps();
    store.m.set(CLAIM_STORAGE_KEY, await okVal('A', 'S1', EP.endpoint));
    expect(await ensurePushSubscription(d)).toEqual({ result: 'already' });
    expect(claim).not.toHaveBeenCalled();
  });

  it('换了会话（同一账号重新登录）：再认领，记录换成新会话的（FA2-2）', async () => {
    const { d, store, claim } = deps({ sessionId: () => 'S2' });
    store.m.set(CLAIM_STORAGE_KEY, await okVal('A', 'S1', EP.endpoint));
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(claim).toHaveBeenCalledOnce();
    expect(store.m.get(CLAIM_STORAGE_KEY)).toBe(await okVal('A', 'S2', EP.endpoint));
  });

  it('取不到会话：不跳过、照常认领，也不写“已认领”', async () => {
    const { d, store, claim } = deps({ sessionId: () => null });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(claim).toHaveBeenCalledTimes(2);
    expect(store.m.has(CLAIM_STORAGE_KEY)).toBe(false);
  });

  it('摘要算不出来：当没认领、照常认领', async () => {
    const { d, claim } = deps({ digest: async () => null });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('换账号后：新账号启动时重订并认领到新账号', async () => {
    const ep2 = 'https://web.push.apple.com/new';
    const { d, store, claim, subscribe } = deps({ userId: 'B' }, { ok: true, sub: { ...EP, endpoint: ep2 }, changed: true });
    store.m.set(CLAIM_STORAGE_KEY, await okVal('A', 'S1', EP.endpoint));
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
    expect(store.m.get(CLAIM_STORAGE_KEY)).toBe(await okVal('B', 'S1', ep2));
  });

  it('换账号但浏览器还留着同一个订阅（退订失败）：照样认领到新账号（M9）', async () => {
    const { d, store, claim } = deps({ userId: 'B' });
    store.m.set(CLAIM_STORAGE_KEY, await okVal('A', 'S1', EP.endpoint));
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(claim).toHaveBeenCalledOnce();
  });

  it('同账号但订阅换了（公钥轮换、订阅失效后重订）：再认领', async () => {
    const { d, store, claim } = deps({}, { ok: true, sub: EP, changed: true });
    store.m.set(CLAIM_STORAGE_KEY, await okVal('A', 'S1', EP.endpoint));
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(claim).toHaveBeenCalledOnce();
  });

  it('先等本会话的设备行登记好再认领（M3、安全 S1）', async () => {
    const order: string[] = [];
    const ensureDevice = vi.fn(async () => {
      order.push('device');
      return 'dev1';
    });
    const claim = vi.fn(async (): Promise<NetResult<unknown>> => {
      order.push('claim');
      return { ok: true, value: { ok: true } };
    });
    const { d } = deps({ ensureDevice, claim });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(order).toEqual(['device', 'claim']);
  });

  it('设备行登记不上：这次不认领，算稍后重试（device_pending），不记', async () => {
    const { d, store, claim } = deps({ ensureDevice: async () => null });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'device_pending' });
    expect(claim).not.toHaveBeenCalled();
    expect(store.m.has(CLAIM_STORAGE_KEY)).toBe(false);
  });

  it('device_not_found：补登记一次、再认领一次，成功就记下', async () => {
    const ensureDevice = vi.fn(async () => 'dev1');
    const claim = vi.fn<(a: ClaimArgs) => Promise<NetResult<unknown>>>()
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce({ ok: true, value: { ok: true } });
    const { d, store } = deps({ ensureDevice, claim });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(ensureDevice).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(store.m.get(CLAIM_STORAGE_KEY)).toBe(await okVal('A', 'S1', EP.endpoint));
  });

  it('L9：订阅前会话已经换成别的账号（或退出了）：不订阅、不认领，回 claim_failed', async () => {
    for (const now of ['B', null]) {
      const { d, claim, subscribe } = deps({ currentUserId: () => now });
      expect(await ensurePushSubscription(d)).toEqual({ result: 'claim_failed' });
      expect(subscribe).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
    }
  });

  it('L9：订阅、登记设备行的期间换了账号：不认领（不拿新账号的令牌认领旧账号的订阅），不记', async () => {
    let now = 'A';
    const ensureDevice = vi.fn(async () => {
      now = 'B';
      return 'dev1';
    });
    const { d, claim, store } = deps({ currentUserId: () => now, ensureDevice });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claim_failed' });
    expect(claim).not.toHaveBeenCalled();
    expect(store.m.get(CLAIM_STORAGE_KEY)).toBeUndefined();
  });

  it('L9：device_not_found 后补登记的期间换了账号：不再认领第二次', async () => {
    let now = 'A';
    let n = 0;
    const ensureDevice = vi.fn(async () => {
      n += 1;
      if (n === 2) now = 'B';
      return 'dev1';
    });
    const claim = vi.fn(async (_a: ClaimArgs): Promise<NetResult<unknown>> => notFound());
    const { d } = deps({ currentUserId: () => now, ensureDevice, claim });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claim_failed' });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('L9：会话一直是这个账号：照常认领', async () => {
    const { d, claim } = deps({ currentUserId: () => 'A' });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('device_not_found：先 invalidateDevice 忘掉旧 id，再补登记', async () => {
    const order: string[] = [];
    const ensureDevice = vi.fn(async () => {
      order.push('ensure');
      return order.includes('invalidate:dev1') ? 'dev2' : 'dev1';
    });
    const invalidateDevice = vi.fn(async (id: string) => {
      order.push(`invalidate:${id}`);
    });
    const claim = vi.fn<(a: ClaimArgs) => Promise<NetResult<unknown>>>()
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce({ ok: true, value: { ok: true } });
    const { d } = deps({ ensureDevice, invalidateDevice, claim });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(order).toEqual(['ensure', 'invalidate:dev1', 'ensure']);
  });

  it('两次都 device_not_found：稍后重试（claim_failed），不记成不支持，下次启动再试', async () => {
    const claim = vi.fn(async (): Promise<NetResult<unknown>> => notFound());
    const { d, store } = deps({ ensureDevice: async () => 'dev1', claim });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claim_failed' });
    expect(claim).toHaveBeenCalledTimes(2);
    expect(store.m.has(CLAIM_STORAGE_KEY)).toBe(false);
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claim_failed' });
    expect(claim).toHaveBeenCalledTimes(4);
  });

  it('device_not_found 后补登记登记不上：device_pending', async () => {
    const ensureDevice = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce('dev1').mockResolvedValueOnce(null);
    const claim = vi.fn(async (): Promise<NetResult<unknown>> => notFound());
    const { d } = deps({ ensureDevice, claim });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'device_pending' });
    expect(claim).toHaveBeenCalledOnce();
  });

  it('认领包在锁里（多标签页一个一个来，安全 S2）', async () => {
    let locked = 0;
    const lock = <T,>(fn: () => Promise<T>): Promise<T> => {
      locked += 1;
      return fn();
    };
    const { d, claim } = deps({ lock });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(locked).toBe(1);
    expect(claim).toHaveBeenCalledOnce();
  });

  it('通知权限没给：不订阅、不弹权限框、不认领', async () => {
    for (const p of ['default', 'denied'] as const) {
      const { d, claim, subscribe } = deps({ permission: () => p });
      expect(await ensurePushSubscription(d)).toEqual({ result: 'not_granted' });
      expect(subscribe).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
    }
  });

  it('exe：什么都不做', async () => {
    const { d, subscribe } = deps({ win: { __TAURI_INTERNALS__: {} } });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'tauri' });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('订阅失败：原样交回原因（resubscribe_failed 给设置 › 提醒提示“点一下”），不认领', async () => {
    const { d, claim } = deps({}, { ok: false, reason: 'resubscribe_failed' });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'resubscribe_failed' });
    expect(claim).not.toHaveBeenCalled();
  });

  it('endpoint_in_use：交回 holder，不记已认领（下次启动、FA-4 移除后再认领）', async () => {
    const holder = { id: 'd1', label: null, last_seen_at: null, install_id: null };
    const { d, store } = deps({ claim: async () => ({ ok: true, value: { error: 'endpoint_in_use', holder } }) });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'endpoint_in_use', holder });
    expect(store.m.has(CLAIM_STORAGE_KEY)).toBe(false);
  });

  it('不支持（22023）：只按 endpoint 摘要记下，30 天内不再问，满 30 天再问一次（安全 S6）', async () => {
    const claim = vi.fn(async (): Promise<NetResult<unknown>> => ({ ok: false, error: { status: 400, code: 'endpoint_not_allowed' } }));
    let t = 1_000_000;
    const { d, store } = deps({ claim, now: () => t });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'not_supported' });
    const v = store.m.get(CLAIM_STORAGE_KEY) ?? '';
    expect(v).toBe(['unsupported', await sha256Short(EP.endpoint), String(t)].join(NL));
    expect(v).not.toContain('https://');
    t += UNSUPPORTED_TTL_MS - 1;
    expect(await ensurePushSubscription(d)).toEqual({ result: 'not_supported' });
    expect(claim).toHaveBeenCalledOnce();
    t += 1;
    expect(await ensurePushSubscription(d)).toEqual({ result: 'not_supported' });
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('“不支持”记的是别的 endpoint：照常认领', async () => {
    const { d, store, claim } = deps({ now: () => 5 });
    store.m.set(CLAIM_STORAGE_KEY, ['unsupported', await sha256Short('https://other/x'), '1'].join(NL));
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claimed' });
    expect(claim).toHaveBeenCalledOnce();
  });

  it('断网、出错、抛错：不记，下次启动再试；永远 resolve', async () => {
    const { d, store } = deps({ claim: async () => ({ ok: false, error: { network: true } }) });
    expect(await ensurePushSubscription(d)).toEqual({ result: 'claim_failed' });
    expect(store.m.has(CLAIM_STORAGE_KEY)).toBe(false);
    const thrower = deps({ claim: () => Promise.reject(new Error('x')) });
    expect(await ensurePushSubscription(thrower.d)).toEqual({ result: 'claim_failed' });
    const noStore = deps({ storage: () => { throw new Error('blocked'); } });
    expect((await ensurePushSubscription(noStore.d)).result).toBe('claim_failed');
  });

  it('label 截到 80 字', async () => {
    const { d, claim } = deps({ label: 'x'.repeat(200) });
    await ensurePushSubscription(d);
    expect(claim.mock.calls[0]?.[0].label).toHaveLength(80);
  });
});

describe('claimParams（安全 S3）', () => {
  it('只带五个键，多余的 expirationTime、keys 不带', () => {
    const extra = { ...EP, label: 'x', platform: 'ios', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } } as unknown as ClaimArgs;
    expect(Object.keys(claimParams(extra)).sort()).toEqual(['auth', 'endpoint', 'label', 'p256dh', 'platform']);
  });
});

describe('sha256Short', () => {
  it('base64url 前 22 位、同输入同输出', async () => {
    const a = await sha256Short('x');
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await sha256Short('x')).toBe(a);
    expect(await sha256Short('y')).not.toBe(a);
  });
});

describe('defaultPushLabel', () => {
  it('按 userAgent 粗分，不带版本号', () => {
    expect(defaultPushLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(defaultPushLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
    expect(defaultPushLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac');
    expect(defaultPushLabel('')).toBe('Web');
  });
});
