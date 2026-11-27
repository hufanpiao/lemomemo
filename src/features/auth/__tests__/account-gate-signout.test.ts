// 恢复页“保持注销并退出”的 signOutLocal(prior)（data/account-gate.ts；接手清单 GATE-sugg ③）：
// 会话被换时走 platform/sign-out.ts 的 logoutReplaced → 默认的 logoutWithToken，这一层不打桩，直接看发出去的请求
// • 本机已是别的标签页的新会话：不调 supabase-js 的 signOut，用旧令牌 POST /auth/v1/logout?scope=local；2xx 为 true，401 为 false
// • 没换（还是那一个、或本机已没有会话）：照常 db.auth.signOut({scope: 'local'})
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import { createAccountGateApi } from '../data/account-gate.ts';

const KEY = 'sb-lemotest-auth-token';
const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
const put = (sid: string): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: 'u' } }));

function make() {
  const signOut = vi.fn(async () => ({ error: null }));
  const db = { auth: { signOut } } as unknown as Db;
  return { signOut, api: createAccountGateApi(async () => db) };
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('signOutLocal(prior)：会话被换时走默认的 logoutWithToken（GATE-sugg ③）', () => {
  it('本机已是 s2：不调 signOut，用旧令牌发一次 logout?scope=local；204 → true、s2 的键还在', async () => {
    put('s2');
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchFn);
    const m = make();
    expect(await m.api.signOutLocal({ sid: 's1', token: tok('s1'), budgetMs: 4000 })).toBe(true);
    expect(m.signOut).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('/auth/v1/logout?scope=local');
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${tok('s1')}`);
    expect(localStorage.getItem(KEY)).toContain(tok('s2'));
  });

  it('旧令牌已过期（401）、断网：false（服务器上没吊销成），也不调 signOut', async () => {
    for (const fetchFn of [vi.fn(async () => new Response(null, { status: 401 })), vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')))]) {
      put('s2');
      vi.stubGlobal('fetch', fetchFn);
      const m = make();
      expect(await m.api.signOutLocal({ sid: 's1', token: tok('s1'), budgetMs: 4000 })).toBe(false);
      expect(m.signOut).not.toHaveBeenCalled();
    }
  });

  it('没有旧令牌（退出前本来就没有会话）：不发请求，算退成', async () => {
    put('s2');
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    expect(await make().api.signOutLocal({ sid: null, token: null, budgetMs: 4000 })).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('没换（还是 s1）、本机已没有会话、不传 prior：照常 signOut local，不发直接 logout', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    for (const local of ['s1', null] as const) {
      localStorage.clear();
      if (local) put(local);
      const m = make();
      expect(await m.api.signOutLocal({ sid: 's1', token: tok('s1'), budgetMs: 4000 })).toBe(true);
      expect(m.signOut).toHaveBeenCalledWith({ scope: 'local' });
    }
    put('s2');
    const m = make();
    expect(await m.api.signOutLocal()).toBe(true);
    expect(m.signOut).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
