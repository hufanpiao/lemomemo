// R-382（架构 4.1a 第 1 点 ①、第 2 点）用真实的 supabase-js（auth-js）复现 11-11 那次：刷新令牌的回包丢了、重试时被判为复用
// → 服务器回 400 refresh_token_already_used → auth-js 删本机会话键、发 SIGNED_OUT。
// 刷新观察（platform/supabase/refresh-observer.ts，client.ts 的 global.fetch 外面那一层）记下码，会话层带给 watchAccount，
// resolveAuthLoss 判 expired（不查服务器）：本机库和没上传的草稿原样留着、写 lemo.reauth、回登录页提示“登录已过期”。
// supabase 客户端是单例（只 initialize 一次），所以和 signed-out-real.test.ts（被移除那一条）分成两个文件
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimCache, watchAccount } from '../../core/account.ts';
import { coldStart, resetBootForTest } from '../../core/boot.ts';
import { deleteCacheDb } from '../../core/cache.ts';
import { clearAllCollections } from '../../core/store.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { readAuthLoss } from '../../platform/auth-loss-log.ts';
import { readReauth } from '../../platform/auth-loss-store.ts';
import { buildInfo } from '../../platform/env.ts';
import {
  clearCacheStorage, goToAuth, onAuthUser, readExitNotice, readSessionUserId, resetSelfSignOutForTest, sessionStorageKey, takeLocalSession,
} from '../../platform/session.ts';
import { createSupabaseTransport } from '../../platform/sync-net.ts';

const URL_ = 'https://lemotest.supabase.co';
const A = '00000000-0000-4000-8000-00000000000a';
const S = '00000000-0000-4000-8000-0000000000c1';
const TOKEN = `h.${btoa(JSON.stringify({ session_id: S })).replace(/=+$/, '')}.s`;

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  resetSelfSignOutForTest();
  clearAllCollections();
  resetBootForTest();
});

describe('真实 auth-js：刷新被判复用（refresh_token_already_used）→ 登录过期，本机内容留着', () => {
  it('SIGNED_OUT 带上观察到的码：不查 session_fate、不删库，写 lemo.reauth，记一条 lemo.authloss，goToAuth(expired)', async () => {
    const b = buildInfo as { supabaseUrl: string; anonKey: string };
    b.supabaseUrl = URL_;
    b.anonKey = 'anon-test';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes('/auth/v1/token') && url.includes('grant_type=refresh_token')) {
        return new Response(JSON.stringify({ code: 400, error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }));
    const replace = vi.fn();
    vi.stubGlobal('location', { replace });
    localStorage.setItem('lemo.install_id', '11111111-1111-4111-8111-111111111111');
    const key = sessionStorageKey(URL_) ?? '';
    localStorage.setItem(key, JSON.stringify({
      access_token: TOKEN, token_type: 'bearer', expires_in: 600, expires_at: Math.floor(Date.now() / 1000) - 3600, refresh_token: 'r1',
      user: { id: A, aud: 'authenticated', role: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
    }));

    const { factory, fake } = fakeIndexedDB();
    const boot = await coldStart({ userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve() });
    const cache = boot.cache;
    if (!cache) throw new Error('no cache');
    await claimCache(cache, A);
    await cache.putDraft({ id: 'd', kind: 'capture', data: 'A 还没上传的草稿', updated_at: 1 });
    watchAccount(boot, {
      clearCacheStorage, onAuthUser, onStorageUser: () => () => undefined, currentUserId: () => readSessionUserId(), dropSession: () => takeLocalSession(),
      onSignedOut: goToAuth, deleteDb: () => deleteCacheDb({ factory, waitMs: 50 }), onSwitched: vi.fn(),
    });
    void createSupabaseTransport().ensureSession().catch(() => undefined);

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/app/auth/'), { timeout: 3000 });
    expect(calls.some((u) => u.includes('grant_type=refresh_token'))).toBe(true);
    expect(calls.some((u) => u.includes('session_fate'))).toBe(false);   // expired 类的码不查服务器
    expect(readExitNotice()).toBe('expired');
    expect(readSessionUserId()).toBeNull();
    expect(readReauth()).toMatchObject({ v: 1, user_id: A, session_id: S });
    expect(boot.switching).toBe(true);
    expect(boot.cache?.isClosed()).toBe(true);
    expect(fake.dbs.has('planner-v4')).toBe(true);   // 库没删
    expect(replace).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(readAuthLoss()).toHaveLength(1));
    expect(readAuthLoss()[0]).toMatchObject({ path: 'sdk', code: 'refresh_token_already_used', status: 400, fate: 'expired' });
    const raw = localStorage.getItem('lemo.authloss') ?? '';
    expect(raw).not.toContain(A);
    expect(raw).not.toContain(S);
  });
});
