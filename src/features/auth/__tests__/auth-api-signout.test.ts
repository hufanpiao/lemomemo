// 登录页“退出并换账号”的封装：signOutHere(prior)（接手清单 K6-signout-lib、R-257；auth-api.test.ts 已近 300 行，单独放）
// • 删 devices 行用退出一开头记下的 prior.sid，不在 ④ 时现读
// • 删完行、紧贴 db.auth.signOut 之前再读本机会话：已换成别的标签页的新会话就不调 signOut，用 prior.token 直接 logout
// • 复审建议 ①：删行之前会话就已被换，删行改用旧令牌（setHeader）；没有旧令牌不删。② logout 的预算扣掉已用掉的时间
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import { createAuthApi } from '../data/auth-api.ts';

const KEY = 'sb-lemotest-auth-token';
const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
const put = (sid: string): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: 'u' } }));

function fakeDb(onDelete: () => void = () => undefined) {
  const signOut = vi.fn(async () => ({ error: null }));
  const eq = vi.fn(async (_c: string, _v: string) => {
    onDelete();
    return { error: null };
  });
  const db = { auth: { signOut }, from: vi.fn(() => ({ delete: () => ({ eq }) })) } as unknown as Db;
  // readToken 故意给别的会话：传了 prior 时不该用它
  return { signOut, eq, api: createAuthApi(async () => db, () => tok('s-now')) };
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('signOutHere(prior)（K6-signout-lib）', () => {
  it('没换：删行用 prior.sid，再 signOut local', async () => {
    put('s1');
    const f = fakeDb();
    expect(await f.api.signOutHere({ sid: 's1', token: tok('s1'), budgetMs: 4000 })).toEqual({ ok: true, value: undefined });
    expect(f.eq).toHaveBeenCalledWith('session_id', 's1');
    expect(f.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('删行那段时间里别的标签页登录了 s2：不调 signOut，用旧令牌直接 logout 一次；204 = ok；s2 的键还在', async () => {
    put('s1');
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchFn);
    const f = fakeDb(() => put('s2'));
    expect(await f.api.signOutHere({ sid: 's1', token: tok('s1'), budgetMs: 4000 })).toEqual({ ok: true, value: undefined });
    expect(f.eq).toHaveBeenCalledWith('session_id', 's1');
    expect(f.signOut).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${tok('s1')}`);
    expect(localStorage.getItem(KEY)).toContain(tok('s2'));
  });

  it('旧令牌过期（401）：回错（调用方按没退成），不调 signOut', async () => {
    put('s1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const f = fakeDb(() => put('s2'));
    expect((await f.api.signOutHere({ sid: 's1', token: tok('s1'), budgetMs: 4000 })).ok).toBe(false);
    expect(f.signOut).not.toHaveBeenCalled();
  });

  it('重读为 null（本机已没有会话）：照常调 signOut', async () => {
    const f = fakeDb();
    await f.api.signOutHere({ sid: 's1', token: tok('s1'), budgetMs: 4000 });
    expect(f.signOut).toHaveBeenCalledTimes(1);
  });

  it('不传 prior：照旧从本机令牌现读删行的 sid，不做换没换的判断', async () => {
    put('s2');
    const f = fakeDb();
    await f.api.signOutHere();
    expect(f.eq).toHaveBeenCalledWith('session_id', 's-now');
    expect(f.signOut).toHaveBeenCalledTimes(1);
  });

  it('复审建议 ①：删行之前会话已换成 s2：删行这次请求定死旧令牌；没有旧令牌就不删', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    for (const token of [tok('s1'), null]) {
      put('s2');
      const headers: [string, string][] = [];
      const eq = vi.fn((_c: string, _v: string) => ({
        setHeader: (n: string, v: string) => headers.push([n, v]),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
      }));
      const db = { auth: { signOut: vi.fn() }, from: vi.fn(() => ({ delete: () => ({ eq }) })) } as unknown as Db;
      await createAuthApi(async () => db, () => null).signOutHere({ sid: 's1', token, budgetMs: 4000 });
      if (token) {
        expect(eq).toHaveBeenCalledWith('session_id', 's1');
        expect(headers).toEqual([['Authorization', `Bearer ${token}`]]);
      } else expect(eq).not.toHaveBeenCalled();
    }
  });

  it('复审建议 ②：删行用掉的时间从预算里扣掉——预算已用完时 logout 马上放弃，不再等满 budgetMs', async () => {
    put('s1');
    vi.stubGlobal('fetch', vi.fn((_u: RequestInfo | URL, i?: RequestInit) => new Promise<Response>((_r, rej) => {
      i?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })));
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fakeDb(() => {
      put('s2');
      now += 3_000;   // 删行花了 3 秒，预算 3 秒已用完
    });
    const t0 = performance.now();
    expect((await f.api.signOutHere({ sid: 's1', token: tok('s1'), budgetMs: 3_000 })).ok).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1_000);
    vi.mocked(Date.now).mockRestore();
  });
});
