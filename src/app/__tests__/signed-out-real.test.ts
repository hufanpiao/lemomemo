// 本页的 SIGNED_OUT 用真实的 supabase-js（auth-js）走一遍（K6-signedout 审查 M1；TC-B1-61 ②、TC-B1-83）：
// 冷启动读到旧会话 → 别处（同步的 ensureSession）先 getSupabase() → initialize 里刷新被拒（session_not_found）→ auth-js 删本机会话键、发 SIGNED_OUT
// → 会话层（platform/session.ts 的 onAuthUser → core/account.ts 的 watchAccount）清库、删库 → goToAuth('removed')。
// 订阅要在客户端一建好就挂上：等 whenIdle 才挂的话 SIGNED_OUT 已经发完，只收得到 INITIAL_SESSION null，库会留在本机。
// 两道保险（SIGNED_OUT、“INITIAL_SESSION 为 null 且会话键已没了”）都会走到 onSignedOut：在它前面挂一个只记事件的订阅，
// 断言触发 onSignedOut 的那一刻收到的是 SIGNED_OUT（K6-signedout 复查建议 ②），分得清是哪一道起的作用
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimCache, watchAccount } from '../../core/account.ts';
import { coldStart, resetBootForTest } from '../../core/boot.ts';
import { deleteCacheDb } from '../../core/cache.ts';
import { clearAllCollections } from '../../core/store.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { buildInfo } from '../../platform/env.ts';
import {
  clearCacheStorage, goToAuth, onAuthUser, readExitNotice, readSessionUserId, resetSelfSignOutForTest, sessionStorageKey, takeLocalSession,
} from '../../platform/session.ts';
import { createSupabaseTransport } from '../../platform/sync-net.ts';

/** 只记事件名的订阅：在模块载入时就挂上，排在会话层（session.ts 的 onAuthUser）之前（app 不能直接引 platform/supabase，A1） */
const events = vi.hoisted(() => [] as string[]);
vi.mock('../../platform/supabase/client.ts', async (importOriginal) => {
  type Db = { auth: { onAuthStateChange(cb: (e: string) => void): unknown } };
  const real = await importOriginal<{ onClientReady(f: (db: Db) => void): () => void }>();
  real.onClientReady((db) => void db.auth.onAuthStateChange((e) => void events.push(e)));
  return real;
});

const URL_ = 'https://lemotest.supabase.co';
const A = '00000000-0000-4000-8000-00000000000a';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  resetSelfSignOutForTest();
  clearAllCollections();
  resetBootForTest();
});

/** 假的服务器：刷新令牌一律回 session_not_found（这台设备已在别的设备上被移除），其余 404 */
function fakeFetch() {
  const calls: string[] = [];
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes('/auth/v1/token') && url.includes('grant_type=refresh_token')) {
      return new Response(JSON.stringify({ code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  });
  return { f, calls };
}

describe('真实 auth-js：冷启动时刷新被拒 → 清库 → 回登录页提示被移除（审查 M1）', () => {
  it('同步先建客户端，SIGNED_OUT 在 initialize 里就发出：照样收到，整库删掉，goToAuth(removed)、本机会话已删', async () => {
    const b = buildInfo as { supabaseUrl: string; anonKey: string };
    b.supabaseUrl = URL_;
    b.anonKey = 'anon-test';
    const { f, calls } = fakeFetch();
    vi.stubGlobal('fetch', f);
    const replace = vi.fn();
    vi.stubGlobal('location', { replace });
    // 旧会话：access token 已过期（PWA 关着时过了 600 秒以上）
    const key = sessionStorageKey(URL_) ?? '';
    const past = Math.floor(Date.now() / 1000) - 3600;
    localStorage.setItem(key, JSON.stringify({
      access_token: 'h.e30.s', token_type: 'bearer', expires_in: 600, expires_at: past, refresh_token: 'r1',
      user: { id: A, aud: 'authenticated', role: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
    }));
    expect(readSessionUserId()).toBe(A);

    const { factory, fake } = fakeIndexedDB();
    const boot = await coldStart({ userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve() });
    const cache = boot.cache;
    if (!cache) throw new Error('no cache');
    await claimCache(cache, A);
    await cache.putDraft({ id: 'd', kind: 'capture', data: 'A 还没上传的草稿', updated_at: 1 });
    expect(fake.dbs.has('planner-v4')).toBe(true);

    // 同一个 onAuthStateChange 里按挂上的先后分发：会话层回调 onSignedOut 时，events 的最后一个就是触发它的那个事件
    const trigger: string[] = [];
    watchAccount(boot, {
      clearCacheStorage,
      onAuthUser: (fn, out) => onAuthUser(fn, out && (() => (trigger.push(events.at(-1) ?? 'none'), out()))),
      onStorageUser: () => () => undefined, currentUserId: () => readSessionUserId(), dropSession: () => takeLocalSession(),
      onSignedOut: goToAuth, deleteDb: () => deleteCacheDb({ factory, waitMs: 50 }), onSwitched: vi.fn(),
    });
    // 主页拿到锁后同步的 ensureSession 先调 getSupabase()，比 whenIdle 早（真实的那条路）
    void createSupabaseTransport().ensureSession().catch(() => undefined);

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/app/auth/'), { timeout: 3000 });
    expect(calls.some((u) => u.includes('grant_type=refresh_token'))).toBe(true);
    expect(trigger[0]).toBe('SIGNED_OUT');   // 是 SIGNED_OUT 那一道起的作用，不是 INITIAL_SESSION null 的兜底
    expect(events).toContain('SIGNED_OUT');
    expect(readExitNotice()).toBe('removed');
    expect(readSessionUserId()).toBeNull();
    expect(boot.switching).toBe(true);
    expect(boot.cache?.isClosed()).toBe(true);
    await vi.waitFor(() => expect(fake.dbs.has('planner-v4')).toBe(false));
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
