// supabase-js 会话存储的保护（接手清单 K6-signout-lib）：supabase/auth-storage.ts + session.ts 的 mayRemoveSessionKey + sign-out.ts 挂保护
// • 平时：读写、删除都直接透传到 localStorage，键名不变
// • 退出期间（signOutThisDevice）：别的标签页已写入新 sid 时，supabase-js 删会话键不删新会话；正常退出照常删
// • 最后一组用真的 supabase-js（auth-js 2.118）走一遍 signOut({scope:'local'})，/logout 回来之前模拟别的标签页登录
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mayRemoveSessionKey, readSessionId } from '../session.ts';
import { defaultGuardRemoval, signOutThisDevice, type ExitSteps } from '../sign-out.ts';
import { authStorage, guardedLocalStorage, guardSessionRemoval, isRemovalGuarded } from '../supabase/auth-storage.ts';
import { clientOptions } from '../supabase/client.ts';

const KEY = 'sb-lemotest-auth-token';
const URL_ = 'https://lemotest.supabase.co';
const b64url = (o: unknown): string => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = (sid: string): string => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ session_id: sid, sub: UID, exp: 4102444800 })}.sig`;
const UID = '00000000-0000-4000-8000-000000000001';
const session = (sid: string): string =>
  JSON.stringify({
    access_token: token(sid),
    refresh_token: `r-${sid}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4102444800,
    user: { id: UID, aud: 'authenticated', email: 'a@example.com' },
  });
const put = (sid: string): void => localStorage.setItem(KEY, session(sid));
/** auth-js 的 _removeSession 删的几个键 */
const removeLikeAuthJs = (): void => {
  guardedLocalStorage.removeItem(KEY);
  guardedLocalStorage.removeItem(`${KEY}-code-verifier`);
  guardedLocalStorage.removeItem(`${KEY}-user`);
};
const fakeSteps = (): ExitSteps => ({
  deleteDb: async () => undefined,
  clearCacheStorage: async () => undefined,
  clearLocalSessionIf: () => undefined,
  readSessionId: () => readSessionId(),
});

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('平时直接透传（K6-signout-lib）', () => {
  it('clientOptions 给 auth 传的就是这个适配器；键名用 supabase-js 默认的（不传 storageKey）', () => {
    const o = clientOptions('4.1.0');
    expect(authStorage()).toBe(guardedLocalStorage);
    expect(o.auth).toMatchObject({ storage: guardedLocalStorage, persistSession: true });
    expect('storageKey' in o.auth).toBe(false);
  });

  it('没挂保护：读写、删除都直接落到 localStorage（会话键也照删）', () => {
    expect(isRemovalGuarded()).toBe(false);
    guardedLocalStorage.setItem(KEY, session('s1'));
    expect(localStorage.getItem(KEY)).toBe(session('s1'));
    expect(guardedLocalStorage.getItem(KEY)).toBe(session('s1'));
    expect(guardedLocalStorage.getItem('nope')).toBeNull();
    localStorage.setItem(`${KEY}-user`, 'u');
    removeLikeAuthJs();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(`${KEY}-user`)).toBeNull();
  });

  it('挂着保护时删键先问判断（这里用全否的判断）；撤掉以后恢复直接删；过期自动失效', () => {
    put('s1');
    localStorage.setItem('other', '1');
    const release = guardSessionRemoval(() => false, 60_000);
    guardedLocalStorage.removeItem('other');
    expect(localStorage.getItem('other')).toBe('1');
    release();
    guardedLocalStorage.removeItem('other');
    expect(localStorage.getItem('other')).toBeNull();
    const r2 = guardSessionRemoval(() => false, 1000, Date.now() - 2000);
    expect(isRemovalGuarded()).toBe(false);
    r2();
  });

  it('后挂的顶替先挂的；先挂的撤销函数不撤后挂的', () => {
    const r1 = guardSessionRemoval(() => true, 60_000);
    const r2 = guardSessionRemoval(() => true, 60_000);
    r1();
    expect(isRemovalGuarded()).toBe(true);
    r2();
    expect(isRemovalGuarded()).toBe(false);
  });

  it('判断本身抛错：按原来的行为删', () => {
    put('s1');
    const release = guardSessionRemoval(() => {
      throw new Error('x');
    }, 60_000);
    guardedLocalStorage.removeItem(KEY);
    release();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('mayRemoveSessionKey：按 readSessionId 的口径核对', () => {
  it('会话以外的键：能删', () => {
    put('s2');
    expect(mayRemoveSessionKey('lemo.self_signout', 's1', undefined, URL_)).toBe(true);
    expect(mayRemoveSessionKey('sb-other-auth-token', 's1', undefined, URL_)).toBe(true);
  });

  it('本机会话还是 sid：会话键和附属键都能删；已换成别的 sid：都不删；没有会话键：能删', () => {
    put('s1');
    for (const k of [KEY, `${KEY}-code-verifier`, `${KEY}-user`]) expect(mayRemoveSessionKey(k, 's1', undefined, URL_)).toBe(true);
    put('s2');
    for (const k of [KEY, `${KEY}-code-verifier`, `${KEY}-user`]) expect(mayRemoveSessionKey(k, 's1', undefined, URL_)).toBe(false);
    localStorage.removeItem(KEY);
    expect(mayRemoveSessionKey(`${KEY}-user`, 's1', undefined, URL_)).toBe(true);
  });

  it('sid 为 null（退出前没有会话）：别的标签页写进来的会话不删；supabaseUrl 解析不出来时按格式认', () => {
    put('s2');
    expect(mayRemoveSessionKey(KEY, null, undefined, URL_)).toBe(false);
    expect(mayRemoveSessionKey(KEY, null, undefined, '')).toBe(false);
    expect(mayRemoveSessionKey(KEY, 's2', undefined, '')).toBe(true);
    expect(mayRemoveSessionKey('lemo.x', null, undefined, '')).toBe(true);
  });
});

describe('signOutThisDevice 期间挂保护（④ 用 auth-js 的删法模拟）', () => {
  it('退出时别的标签页已写入新 sid：新会话的键保留', async () => {
    put('s1');
    const server = {
      signOut: async () => {
        put('s2');   // /logout 回来之前，别的标签页登录了新会话
        localStorage.setItem(`${KEY}-user`, 'new-user');
        removeLikeAuthJs();
        return { serverDone: true };
      },
    };
    const r = await signOutThisDevice({ server, steps: fakeSteps(), markSelf: () => undefined });
    expect(r.serverDone).toBe(true);
    expect(readSessionId()).toBe('s2');
    expect(localStorage.getItem(`${KEY}-user`)).toBe('new-user');
    expect(isRemovalGuarded()).toBe(false);
  });

  it('正常退出：照常删掉；结束后撤掉保护', async () => {
    put('s1');
    localStorage.setItem(`${KEY}-code-verifier`, 'v');
    const seen: boolean[] = [];
    const server = {
      signOut: async () => {
        seen.push(isRemovalGuarded());
        removeLikeAuthJs();
        return { serverDone: true };
      },
    };
    await signOutThisDevice({ server, steps: fakeSteps(), markSelf: () => undefined });
    expect(seen).toEqual([true]);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(`${KEY}-code-verifier`)).toBeNull();
    expect(isRemovalGuarded()).toBe(false);
  });

  it('④ 超时：保护挂到请求晚到为止，晚到时删键也照样核对', async () => {
    vi.useFakeTimers();
    put('s1');
    let finish!: () => void;
    const server = {
      signOut: () =>
        new Promise<{ serverDone: boolean }>((resolve) => {
          finish = () => {
            removeLikeAuthJs();
            resolve({ serverDone: true });
          };
        }),
    };
    const steps = { ...fakeSteps(), clearLocalSessionIf: vi.fn() };
    const p = signOutThisDevice({ server, steps, markSelf: () => undefined, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ serverDone: false });
    expect(isRemovalGuarded()).toBe(true);
    put('s2');
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(readSessionId()).toBe('s2');
    expect(isRemovalGuarded()).toBe(false);
  });

  it('可以换掉保护：传入的 guardRemoval 拿到退出前的 sid，结束时撤掉', async () => {
    put('s1');
    const release = vi.fn();
    const guard = vi.fn((_sid: string | null) => release);
    await signOutThisDevice({ server: { signOut: async () => ({ serverDone: true }) }, steps: fakeSteps(), markSelf: () => undefined, guardRemoval: guard });
    await Promise.resolve();
    expect(guard.mock.calls).toEqual([['s1']]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(defaultGuardRemoval).toBeTypeOf('function');
  });
});

describe('真的 supabase-js：signOut({scope: local}) 最后删会话键', () => {
  const client = (onLogout: () => void) =>
    createClient(URL_, 'anon', {
      global: {
        fetch: (async (input: RequestInfo | URL) => {
          if (String(input).includes('/logout')) onLogout();
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      },
      auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage: guardedLocalStorage },
    });

  it('/logout 回来之前别的标签页写入新 sid：auth-js 的 _removeSession 不删新会话', async () => {
    put('s1');
    const db = client(() => put('s2'));
    const r = await signOutThisDevice({
      server: { signOut: async () => ({ serverDone: !(await db.auth.signOut({ scope: 'local' })).error }) },
      steps: fakeSteps(),
      markSelf: () => undefined,
    });
    expect(r.serverDone).toBe(true);
    expect(readSessionId()).toBe('s2');
  });

  it('正常退出：auth-js 照常删掉会话键', async () => {
    put('s1');
    const db = client(() => undefined);
    await signOutThisDevice({
      server: { signOut: async () => ({ serverDone: !(await db.auth.signOut({ scope: 'local' })).error }) },
      steps: fakeSteps(),
      markSelf: () => undefined,
    });
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
