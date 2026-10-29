// ④ 前再读一次 sid（接手清单 K6-signout-lib 收窄，架构师 10-30 更正；auth-storage.test.ts 已二百多行，单独放）
// • 会话在 ④ 前被别的标签页换掉：不调 supabase-js，用一开头记下的旧令牌经 appFetch 直接 POST /auth/v1/logout?scope=local，新会话的键还在
// • 旧令牌过期（401）、断网、超时：serverDone = false，不刷新令牌，新会话不受影响
// • 重读为 null（本机已没有会话）或还是那一个：照旧调 supabase-js
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION_HEADER } from '../http.ts';
import { readSessionId } from '../session.ts';
import { logoutReplaced, logoutWithToken, sessionReplaced, signOutThisDevice, type ExitSteps, type PriorSession } from '../sign-out.ts';

const KEY = 'sb-lemotest-auth-token';
const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
const put = (sid: string): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: '00000000-0000-4000-8000-000000000001' } }));

/** ②③ 清本机那几秒里别的标签页登录了新会话 s2（swap 为 null 时不换） */
const steps = (swap: string | null = 's2'): ExitSteps => ({
  deleteDb: async () => undefined,
  clearCacheStorage: async () => {
    if (swap) put(swap);
  },
  clearLocalSessionIf: () => undefined,
  readSessionId: () => readSessionId(),
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('会话在 ④ 前被换掉：不调 supabase-js，用旧令牌直接 logout', () => {
  it('发出一次 POST /auth/v1/logout?scope=local（带旧令牌、版本头）；204 = serverDone；新会话的键还在', async () => {
    put('s1');
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchFn);
    const signOut = vi.fn(async () => ({ serverDone: true }));
    const r = await signOutThisDevice({ server: { signOut }, steps: steps(), markSelf: () => undefined });
    expect(r).toEqual({ serverDone: true });
    expect(signOut).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe('/auth/v1/logout?scope=local');   // 测试环境 supabaseUrl 为空
    expect(init?.method).toBe('POST');
    const h = new Headers(init?.headers);
    expect(h.get('Authorization')).toBe(`Bearer ${tok('s1')}`);
    expect(h.get(APP_VERSION_HEADER)).toBe('4.0.0');
    expect(readSessionId()).toBe('s2');
  });

  it('旧令牌过期（401）：serverDone = false，不刷新令牌（只发这一次），新会话不受影响', async () => {
    put('s1');
    const fetchFn = vi.fn(async () => new Response('{"code":"bad_jwt"}', { status: 401, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchFn);
    const signOut = vi.fn(async () => ({ serverDone: true }));
    const clearLocalSessionIf = vi.fn();
    const r = await signOutThisDevice({ server: { signOut }, steps: { ...steps(), clearLocalSessionIf }, markSelf: () => undefined });
    expect(r).toEqual({ serverDone: false });
    expect(signOut).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(clearLocalSessionIf.mock.calls).toEqual([['s1']]);   // 兜底只按旧 sid 删：本机是 s2，删不到
    expect(readSessionId()).toBe('s2');
  });

  it('断网：serverDone = false；超时：用 ④ 剩下的预算，到点按没退成', async () => {
    put('s1');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await signOutThisDevice({ server: { signOut: vi.fn() }, steps: steps(), markSelf: () => undefined })).toEqual({ serverDone: false });

    vi.useFakeTimers();
    put('s1');
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const p = signOutThisDevice({ server: { signOut: vi.fn() }, steps: steps(), markSelf: () => undefined, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ serverDone: false });
    expect(readSessionId()).toBe('s2');
  });

  it('退出前本来就没有会话、这时别的标签页登录了：没什么可吊销，不发请求、不调 supabase-js', async () => {
    const logout = vi.fn(async () => ({ serverDone: true }));
    const signOut = vi.fn(async () => ({ serverDone: true }));
    const r = await signOutThisDevice({ server: { signOut }, steps: steps(), markSelf: () => undefined, logoutWithToken: logout });
    expect(r).toEqual({ serverDone: true });
    expect(logout).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(readSessionId()).toBe('s2');
  });
});

describe('没被换掉：照旧调 supabase-js', () => {
  it('还是那一个：调 server.signOut，不直接发 logout', async () => {
    put('s1');
    const logout = vi.fn(async () => ({ serverDone: true }));
    const signOut = vi.fn(async () => ({ serverDone: true }));
    await signOutThisDevice({ server: { signOut }, steps: steps(null), markSelf: () => undefined, logoutWithToken: logout });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
  });

  it('重读为 null（退出前有会话、④ 前键已被删）：照常调', async () => {
    put('s1');
    const signOut = vi.fn(async () => ({ serverDone: true }));
    const logout = vi.fn(async () => ({ serverDone: true }));
    const s: ExitSteps = { ...steps(null), clearCacheStorage: async () => localStorage.removeItem(KEY) };
    await signOutThisDevice({ server: { signOut }, steps: s, markSelf: () => undefined, logoutWithToken: logout });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
  });
});

describe('logoutWithToken', () => {
  it('地址去掉末尾斜杠；带 apikey；2xx 为 true，其余为 false；不抛错', async () => {
    const fetchFn = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchFn);
    expect(await logoutWithToken('t', 1000, 'https://lemomemo.com/sb/', 'anon')).toEqual({ serverDone: true });
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('https://lemomemo.com/sb/auth/v1/logout?scope=local');
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('apikey')).toBe('anon');
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await logoutWithToken('t', 1000, 'https://lemomemo.com/sb', 'anon')).toEqual({ serverDone: false });
  });

  it('到 timeoutMs 还没回来就 abort，按没退成（复审建议 2）', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: RequestInfo | URL, i?: RequestInit) =>
          new Promise<Response>((_r, reject) => {
            signal = i?.signal ?? undefined;
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );
    const p = logoutWithToken('t', 500, 'https://lemomemo.com/sb', 'anon');
    await vi.advanceTimersByTimeAsync(499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await p).toEqual({ serverDone: false });
  });
});

describe('封装里用的判断：sessionReplaced、logoutReplaced', () => {
  it('重读非 null 且不是 sid 才算换了；读不出、抛错都不算', () => {
    expect(sessionReplaced('s1', () => 's2')).toBe(true);
    expect(sessionReplaced(null, () => 's2')).toBe(true);
    expect(sessionReplaced('s1', () => 's1')).toBe(false);
    expect(sessionReplaced('s1', () => null)).toBe(false);
    expect(
      sessionReplaced('s1', () => {
        throw new Error('x');
      }),
    ).toBe(false);
  });

  it('logoutReplaced：有旧令牌按预算调 logout；没有旧令牌有意算退成、不发请求', async () => {
    const logout = vi.fn(async () => ({ serverDone: false }));
    expect(await logoutReplaced('t', 700, logout)).toEqual({ serverDone: false });
    expect(logout.mock.calls).toEqual([['t', 700]]);
    expect(await logoutReplaced(null, 700, logout)).toEqual({ serverDone: true });
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

describe('④ 把 prior 交给 server.signOut', () => {
  it('没被换掉：server.signOut 拿到退出前的 sid、令牌和 ④ 剩下的预算', async () => {
    put('s1');
    const signOut = vi.fn(async (_p: PriorSession) => ({ serverDone: true }));
    await signOutThisDevice({ server: { signOut }, steps: steps(null), markSelf: () => undefined, timeoutMs: 8000 });
    const prior = signOut.mock.calls[0]?.[0];
    expect(prior?.sid).toBe('s1');
    expect(prior?.token).toBe(tok('s1'));
    expect(prior?.budgetMs).toBeGreaterThan(7000);
    expect(prior?.budgetMs).toBeLessThanOrEqual(8000);
  });
});
