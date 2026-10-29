// 设置页 dropLocalSession(sid, prior)：拿到客户端以后、紧贴 signOut 之前再读本机会话（接手清单 K6-signout-lib、R-257；
// settings-api.test.ts 已二百七十多行，单独放）。已换成别的标签页的新会话：不调 signOut、不兜底删，用旧令牌直接 logout
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import { createSettingsApi } from '../data/settings-api.ts';

const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;

function make(local: string | null, signOutError: unknown = null) {
  const signOut = vi.fn(async () => ({ error: signOutError }));
  const clear = vi.fn();
  const db = { auth: { signOut } } as unknown as Db;
  return { signOut, clear, api: createSettingsApi(async () => db, clear, 1000, () => local) };
}

afterEach(() => vi.unstubAllGlobals());

describe('dropLocalSession(sid, prior)（K6-signout-lib）', () => {
  it('本机已是 s2：不调 signOut、不 clear()；用旧令牌发一次 logout，204 = serverDone', async () => {
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchFn);
    const m = make('s2');
    expect(await m.api.dropLocalSession('s1', { token: tok('s1'), budgetMs: 4000 })).toEqual({ serverDone: true });
    expect(m.signOut).not.toHaveBeenCalled();
    expect(m.clear).not.toHaveBeenCalled();
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${tok('s1')}`);
  });

  it('旧令牌过期（401）：serverDone = false，仍不 clear()（本机是别人的新会话）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const m = make('s2');
    expect(await m.api.dropLocalSession('s1', { token: tok('s1'), budgetMs: 4000 })).toEqual({ serverDone: false });
    expect(m.clear).not.toHaveBeenCalled();
  });

  it('没传 prior（被移除时后台那次）且已换：不调 signOut、不发请求', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const m = make('s2');
    expect(await m.api.dropLocalSession('s1')).toEqual({ serverDone: true });
    expect(m.signOut).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('还是 s1、或本机已没有会话：照常 signOut；不是 ok 照旧兜底 clear(s1)', async () => {
    for (const local of ['s1', null]) {
      const m = make(local, { name: 'AuthRetryableFetchError', status: 0 });
      expect(await m.api.dropLocalSession('s1', { token: tok('s1'), budgetMs: 4000 })).toEqual({ serverDone: false });
      expect(m.signOut).toHaveBeenCalledTimes(1);
      expect(m.clear).toHaveBeenCalledWith('s1');
    }
  });
});
