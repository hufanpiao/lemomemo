// 本机会话的轻量读取（架构 4.1、0.38 第 17 条）：只取 user.id；键名和 supabase-js 默认一致；storage 事件；Cache Storage 清理。
// 本页的 SIGNED_OUT（K6-signedout，TC-B1-61 ②、TC-B1-83）的会话层部分也在这里（原 session-signedout.test.ts，复查建议 ④ 合并）：
// 同一个 onAuthStateChange 分发、INITIAL_SESSION 为 null 的兜底、“自己退出”标记（带 session_id，K6-signedout-sugg ①）、
// 客户端一建好就挂订阅、goToAuth('removed')（核对 session_id 再删，K6-signedout-sugg2 ①；不覆盖已记下的原因，K6-signedout-sugg ⑤）。
// “全 src 只有 session.ts 监听”原来在这里扫文件，现在是 ESLint 规则 lemo/auth-events-in-session（架构 2.3 A30）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getSupabase = vi.hoisted(() => vi.fn(() => Promise.reject(new Error('no env'))));
/** 客户端建好时的回调（真实实现见 supabase/client.ts；这里由测试手动触发 ready.fire(db)） */
const ready = vi.hoisted(() => {
  const fns = new Set<(db: unknown) => void>();
  return { fns, fire: (db: unknown) => [...fns].forEach((f) => f(db)) };
});
vi.mock('../supabase/client.ts', () => ({
  getSupabase,
  onClientReady: (f: (db: unknown) => void) => {
    ready.fns.add(f);
    return () => void ready.fns.delete(f);
  },
}));

import {
  authEventHandler, clearCacheStorage, clearLocalSession, clearLocalSessionIf, forgetSelfSignOut, goToAuth, isSelfSignOut, markSelfSignOut,
  markSelfSignOutThisTab, onAuthUser, onSessionStorageChange, PRECACHE_PREFIX, readExitNotice, readSessionEmail, readSessionUserId,
  resetSelfSignOutForTest, SELF_SIGN_OUT_TTL_MS, sessionStorageKey, setExitNotice, takeLocalSession, userIdOfSession,
} from '../session.ts';

const A = '00000000-0000-4000-8000-00000000000a';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetSelfSignOutForTest();
  ready.fns.clear();
  vi.unstubAllGlobals();
});

describe('readSessionUserId', () => {
  it('键名：sb-<主机名第一段>-auth-token（和 supabase-js、官网首页、E2E 一致）', () => {
    expect(sessionStorageKey('https://lemomemo.com/sb')).toBe('sb-lemomemo-auth-token');
    expect(sessionStorageKey('')).toBeNull();
  });

  it('只认格式正确的 user.id；空、坏 JSON、{} 都算没登录', () => {
    expect(userIdOfSession(JSON.stringify({ access_token: 'x', user: { id: A } }))).toBe(A);
    expect(userIdOfSession('{}')).toBeNull();
    expect(userIdOfSession('not json')).toBeNull();
    expect(userIdOfSession(JSON.stringify({ user: { id: '../x' } }))).toBeNull();
    expect(userIdOfSession(null)).toBeNull();
  });

  it('按默认键读；读不出主机名时按格式找', () => {
    localStorage.setItem('sb-lemomemo-auth-token', JSON.stringify({ user: { id: A } }));
    expect(readSessionUserId(localStorage, 'https://lemomemo.com/sb')).toBe(A);
    expect(readSessionUserId(localStorage, '')).toBe(A);
    localStorage.clear();
    expect(readSessionUserId(localStorage, 'https://lemomemo.com/sb')).toBeNull();
  });

  it('L8：supabaseUrl 能解析时只认那一个键，别的 sb-*-auth-token（例如另一个项目留下的）不算', () => {
    localStorage.setItem('sb-other-auth-token', JSON.stringify({ user: { id: A } }));
    expect(readSessionUserId(localStorage, 'https://lemomemo.com/sb')).toBeNull();
    expect(readSessionUserId(localStorage, '')).toBe(A);
  });
});

describe('readSessionEmail（登录页“当前已登录 <邮箱>”，0.38 第 35 条）', () => {
  it('读会话里的 user.email；键名同 readSessionUserId，别的项目留下的键不算', () => {
    localStorage.setItem('sb-lemomemo-auth-token', JSON.stringify({ user: { id: A, email: 'a@example.com' } }));
    expect(readSessionEmail(localStorage, 'https://lemomemo.com/sb')).toBe('a@example.com');
    localStorage.clear();
    localStorage.setItem('sb-other-auth-token', JSON.stringify({ user: { id: A, email: 'a@example.com' } }));
    expect(readSessionEmail(localStorage, 'https://lemomemo.com/sb')).toBeNull();
    expect(readSessionEmail(localStorage, '')).toBe('a@example.com');
  });

  it('没有会话、坏 JSON、没有 email、不像邮箱、超长都返回 null', () => {
    const k = 'sb-lemomemo-auth-token';
    const url = 'https://lemomemo.com/sb';
    expect(readSessionEmail(localStorage, url)).toBeNull();
    for (const v of ['not json', '{}', JSON.stringify({ user: { id: A } }), JSON.stringify({ user: { email: 'no-at' } }),
      JSON.stringify({ user: { email: 'a b@c.d' } }), JSON.stringify({ user: { email: `${'x'.repeat(250)}@a.bc` } }), JSON.stringify({ user: { email: 42 } })]) {
      localStorage.setItem(k, v);
      expect(readSessionEmail(localStorage, url)).toBeNull();
    }
  });

  it('localStorage 抛错（隐私模式等）返回 null', () => {
    const bad = { get length() { throw new Error('denied'); }, getItem() { throw new Error('denied'); } } as unknown as Storage;
    expect(readSessionEmail(bad, 'https://lemomemo.com/sb')).toBeNull();
  });
});

describe('别的标签页（storage 事件）', () => {
  it('会话键变了就回调新的 user_id；别的键不管；取消后不再回调', () => {
    const fn = vi.fn();
    const off = onSessionStorageChange(fn);
    localStorage.setItem('sb-x-auth-token', JSON.stringify({ user: { id: A } }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'sb-x-auth-token' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'pv-locale' }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(A);
    off();
    window.dispatchEvent(new StorageEvent('storage', { key: 'sb-x-auth-token' }));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('clearCacheStorage（0.38 第 36 条）', () => {
  it('只删运行时缓存（图片、附件、接口响应）；SW 预缓存保留；没有 caches 时不报错', async () => {
    const store = new Set([`${PRECACHE_PREFIX}-v2-https://lemomemo.com/app/`, 'lemo-nav', 'lemo-holidays', 'lemo-fonts', 'lemo-images']);
    vi.stubGlobal('caches', {
      keys: () => Promise.resolve([...store]),
      delete: (k: string) => Promise.resolve(store.delete(k)),
    });
    await clearCacheStorage();
    expect([...store]).toEqual([`${PRECACHE_PREFIX}-v2-https://lemomemo.com/app/`]);
    vi.unstubAllGlobals();
    await expect(clearCacheStorage()).resolves.toBeUndefined();
  });

  it('旧写法的对照：keys 里只有运行时缓存时全删', async () => {
    const deleted: string[] = [];
    vi.stubGlobal('caches', {
      keys: () => Promise.resolve(['a', 'b']),
      delete: (k: string) => {
        deleted.push(k);
        return Promise.resolve(true);
      },
    });
    await clearCacheStorage();
    expect(deleted).toEqual(['a', 'b']);
    vi.unstubAllGlobals();
    await expect(clearCacheStorage()).resolves.toBeUndefined();
  });
});

describe('clearLocalSession（signOut 失败的兜底）', () => {
  it('同步删掉本机会话的两个键（auth-token、auth-token-code-verifier），别的键不动', () => {
    localStorage.setItem('sb-lemomemo-auth-token', JSON.stringify({ user: { id: A }, access_token: 'secret' }));
    localStorage.setItem('sb-lemomemo-auth-token-code-verifier', 'v');
    localStorage.setItem('pv-locale', 'ko');
    localStorage.setItem('install_id', 'i');
    clearLocalSession(localStorage, 'https://lemomemo.com/sb');
    expect(localStorage.getItem('sb-lemomemo-auth-token')).toBeNull();
    expect(localStorage.getItem('sb-lemomemo-auth-token-code-verifier')).toBeNull();
    expect(localStorage.getItem('pv-locale')).toBe('ko');
    expect(localStorage.getItem('install_id')).toBe('i');
    expect(readSessionUserId(localStorage, 'https://lemomemo.com/sb')).toBeNull();
  });

  it('supabaseUrl 解析不出来：按格式删所有 sb-*-auth-token（及 code-verifier）', () => {
    localStorage.setItem('sb-x-auth-token', '{}');
    localStorage.setItem('sb-x-auth-token-code-verifier', 'v');
    clearLocalSession(localStorage, '');
    expect(localStorage.getItem('sb-x-auth-token')).toBeNull();
    expect(localStorage.getItem('sb-x-auth-token-code-verifier')).toBeNull();
  });

  it('localStorage 抛错（隐私模式等）也不抛', () => {
    const bad = {
      get length(): number {
        throw new Error('denied');
      },
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error('denied');
      },
      clear: () => undefined,
    } as unknown as Storage;
    expect(() => clearLocalSession(bad, 'https://lemomemo.com/sb')).not.toThrow();
    expect(() => clearLocalSession(bad, '')).not.toThrow();
  });
});

describe('onAuthUser（L6）', () => {
  it('不当场加载 supabase-js：等浏览器空闲（首屏画完）才加载；取消以后不再加载', async () => {
    getSupabase.mockClear();
    const off = onAuthUser(() => undefined);
    expect(getSupabase).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(getSupabase).toHaveBeenCalledTimes(1));
    off();
    getSupabase.mockClear();
    const off2 = onAuthUser(() => undefined);
    off2();
    await new Promise((r) => setTimeout(r, 50));
    expect(getSupabase).not.toHaveBeenCalled();
  });
});

describe('PRECACHE_PREFIX 和 SW 实际的缓存名对得上', () => {
  it('src/sw/sw.ts 没改 Workbox 的缓存名（不出现 setCacheNameDetails），预缓存名就是 workbox-precache-v2-<scope>', () => {
    const sw = readFileSync(join(import.meta.dirname, '..', '..', 'sw', 'sw.ts'), 'utf8');
    expect(sw).not.toMatch(/setCacheNameDetails/);
    expect(sw).toMatch(/precacheAndRoute/);
    expect(PRECACHE_PREFIX).toBe('workbox-precache');
  });
});

// ───────── 本页的 SIGNED_OUT（原 session-signedout.test.ts）─────────

/** 造一个 payload 里带 session_id 的假 access token（只有 payload 段有意义） */
const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
const KEY = 'sb-lemomemo-auth-token';
const URL_ = 'https://lemomemo.com/sb';
const seed = (sid: string, user = A): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: user } }));

describe('本页的 SIGNED_OUT：事件分发（K6-signedout，TC-B1-61 ②、TC-B1-83）', () => {
  const U = { user: { id: A } };
  const never = { selfSignOut: () => false };

  it('同一个回调分发：SIGNED_IN、TOKEN_REFRESHED 回 user_id；SIGNED_OUT 回 onSignedOut；别的事件不管', () => {
    const fn = vi.fn();
    const out = vi.fn();
    const h = authEventHandler(fn, out, never);
    h('SIGNED_IN', U);
    h('TOKEN_REFRESHED', U);
    h('INITIAL_SESSION', U);
    h('USER_UPDATED', U);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(out).not.toHaveBeenCalled();
    h('SIGNED_OUT', null);
    expect(out).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('自己点“退出登录”（退出流程先打了标记）：SIGNED_OUT 不往上报；没传 onSignedOut 时什么也不做', () => {
    const out = vi.fn();
    const h = authEventHandler(vi.fn(), out);
    markSelfSignOut();
    h('SIGNED_OUT', null);
    expect(out).not.toHaveBeenCalled();
    expect(() => authEventHandler(vi.fn())('SIGNED_OUT', null)).not.toThrow();
  });

  it('只订阅一次 onAuthStateChange，且在客户端一建好时同步挂上（不等 whenIdle，审查 M1）；取消时退订', () => {
    let cb: ((e: string, s: unknown) => void) | null = null;
    const unsubscribe = vi.fn();
    const onAuthStateChange = vi.fn((f: (e: string, s: unknown) => void) => {
      cb = f;
      return { data: { subscription: { unsubscribe } } };
    });
    const fn = vi.fn();
    const out = vi.fn();
    const off = onAuthUser(fn, out);
    ready.fire({ auth: { onAuthStateChange } });   // 比如同步的 ensureSession 先调了 getSupabase()
    expect(onAuthStateChange).toHaveBeenCalledTimes(1);
    const fire = (e: string, s: unknown): void => (cb as unknown as (e: string, s: unknown) => void)(e, s);
    fire('SIGNED_IN', U);
    fire('SIGNED_OUT', null);
    expect(fn).toHaveBeenCalledWith(A);
    expect(out).toHaveBeenCalledTimes(1);
    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(ready.fns.size).toBe(0);
  });

  it('INITIAL_SESSION 为 null 且本机会话键已没了：当 SIGNED_OUT（订阅晚于 initialize 时只收得到它）；带标记时不回调', () => {
    const out = vi.fn();
    authEventHandler(vi.fn(), out, { ...never, sessionGone: () => true })('INITIAL_SESSION', null);
    expect(out).toHaveBeenCalledTimes(1);
    authEventHandler(vi.fn(), out, { selfSignOut: () => true, sessionGone: () => true })('INITIAL_SESSION', null);
    expect(out).toHaveBeenCalledTimes(1);
    // 默认：读 localStorage 的会话键、读标记
    const h = authEventHandler(vi.fn(), out);
    h('INITIAL_SESSION', null);
    expect(out).toHaveBeenCalledTimes(2);
    markSelfSignOut();
    h('INITIAL_SESSION', null);
    expect(out).toHaveBeenCalledTimes(2);
  });

  it('INITIAL_SESSION 为 null 但本机会话键还在（离线冷启动、令牌过期刷新不了）：不当被移除；有会话的 INITIAL_SESSION 也不管', () => {
    const out = vi.fn();
    localStorage.setItem(KEY, JSON.stringify({ user: { id: A } }));
    authEventHandler(vi.fn(), out, { ...never, sessionGone: () => readSessionUserId(localStorage, URL_) === null })('INITIAL_SESSION', null);
    authEventHandler(vi.fn(), out, { ...never, sessionGone: () => true })('INITIAL_SESSION', U);
    expect(out).not.toHaveBeenCalled();
  });

  it('记住本页最后见到的 session_id：挂上时读一次，带会话的事件更新；SIGNED_OUT 拿它去核对标记', () => {
    const asked: (string | null)[] = [];
    const h = authEventHandler(vi.fn(), vi.fn(), { initialSessionId: 's1', selfSignOut: (sid) => (asked.push(sid), false), onSignedIn: () => undefined });
    h('SIGNED_OUT', null);
    h('TOKEN_REFRESHED', { user: { id: A }, access_token: tok('s2') });
    h('SIGNED_OUT', null);
    expect(asked).toEqual(['s1', 's2']);
    // 默认：挂上时同步读本机会话
    seed('s9');
    const asked2: (string | null)[] = [];
    authEventHandler(vi.fn(), vi.fn(), { selfSignOut: (sid) => (asked2.push(sid), false) })('SIGNED_OUT', null);
    expect(asked2).toEqual(['s9']);
  });
});

describe('“自己退出”的标记：时间戳 + 退出前的 session_id（K6-signedout-sugg ①）', () => {
  it('存在 localStorage（别的标签页打的也认），存时间戳和 session_id、不存账号；过了有效期不认并删掉', () => {
    const t0 = 1_000_000;
    markSelfSignOut(localStorage, t0, 's1');
    expect(JSON.parse(localStorage.getItem('lemo.self_signout') ?? 'null')).toEqual({ at: t0, sid: 's1' });
    resetSelfSignOutForTest();   // 模拟别的标签页：本页内存里没有
    expect(isSelfSignOut(localStorage, t0 + 1000)).toBe(true);
    expect(isSelfSignOut(localStorage, t0 + 1000, 's1')).toBe(true);
    expect(isSelfSignOut(localStorage, t0 + SELF_SIGN_OUT_TTL_MS)).toBe(false);
    expect(localStorage.getItem('lemo.self_signout')).toBeNull();
    expect(isSelfSignOut(localStorage, t0)).toBe(false);
  });

  it('只滤标记里那个会话：别的会话（退出后在别处登录的新会话）的 SIGNED_OUT 照样按被移除；标记不删', () => {
    const t = Date.now();
    markSelfSignOut(localStorage, t, 's-old');
    resetSelfSignOutForTest();
    expect(isSelfSignOut(localStorage, t + 1, 's-new')).toBe(false);
    expect(localStorage.getItem('lemo.self_signout')).not.toBeNull();
    const out = vi.fn();
    authEventHandler(vi.fn(), out, { initialSessionId: 's-new' })('SIGNED_OUT', null);
    expect(out).toHaveBeenCalledTimes(1);
    authEventHandler(vi.fn(), out, { initialSessionId: 's-old' })('SIGNED_OUT', null);
    expect(out).toHaveBeenCalledTimes(1);
  });

  it('默认取退出前本机会话的 session_id；标记不知道 session_id（旧格式纯时间戳）时只看时间', () => {
    seed('s1');
    markSelfSignOut(localStorage, 100);
    resetSelfSignOutForTest();
    expect(isSelfSignOut(localStorage, 200, 's1')).toBe(true);
    expect(isSelfSignOut(localStorage, 200, 's2')).toBe(false);
    localStorage.setItem('lemo.self_signout', '100');   // 上一版写的纯时间戳
    expect(isSelfSignOut(localStorage, 200, 's2')).toBe(true);
    // 不核对会话（不给 sessionId）：只看时间
    markSelfSignOut(localStorage, 100, 's1');
    resetSelfSignOutForTest();
    expect(isSelfSignOut(localStorage, 200)).toBe(true);
  });

  it('本页的 sid 未知（null，K6-sugg3 ③）：不认带 sid 的新格式标记，只认旧格式（以及同样不知道 sid 的）', () => {
    markSelfSignOut(localStorage, 100, 's1');
    resetSelfSignOutForTest();
    expect(isSelfSignOut(localStorage, 200, null)).toBe(false);
    expect(localStorage.getItem('lemo.self_signout')).not.toBeNull();   // 不归这个会话管：不删
    localStorage.setItem('lemo.self_signout', '100');   // 旧格式纯时间戳
    expect(isSelfSignOut(localStorage, 200, null)).toBe(true);
    markSelfSignOut(localStorage, 100, null);   // 退出时也读不出 sid
    resetSelfSignOutForTest();
    expect(isSelfSignOut(localStorage, 200, null)).toBe(true);
    // 本页内存里那份同一规则
    markSelfSignOutThisTab(100, 's1');
    localStorage.clear();
    expect(isSelfSignOut(localStorage, 200, null)).toBe(false);
    expect(isSelfSignOut(localStorage, 200, 's1')).toBe(true);
    // 会话层：挂监听时已没有会话（initialSessionId null），收到 SIGNED_OUT 时有一个带 sid 的标记 → 按被移除上报
    resetSelfSignOutForTest();
    markSelfSignOut(localStorage, Date.now(), 's1');
    resetSelfSignOutForTest();
    const out = vi.fn();
    authEventHandler(vi.fn(), out, { initialSessionId: null })('SIGNED_OUT', null);
    expect(out).toHaveBeenCalledTimes(1);
  });

  it('坏值、未来的时间戳不认', () => {
    localStorage.setItem('lemo.self_signout', 'abc');
    expect(isSelfSignOut(localStorage, 5)).toBe(false);
    localStorage.setItem('lemo.self_signout', JSON.stringify({ at: 'x', sid: 's' }));
    expect(isSelfSignOut(localStorage, 5)).toBe(false);
    localStorage.setItem('lemo.self_signout', '100');
    expect(isSelfSignOut(localStorage, 50)).toBe(false);
  });

  it('SIGNED_IN 一个别的会话：清掉标记（内存和 localStorage）；同一个会话（initialize 恢复出旧会话）不清', () => {
    markSelfSignOut(localStorage, Date.now(), 's1');
    const h = authEventHandler(vi.fn(), vi.fn(), { initialSessionId: 's1' });
    h('SIGNED_IN', { user: { id: A }, access_token: tok('s1') });
    expect(localStorage.getItem('lemo.self_signout')).not.toBeNull();
    expect(isSelfSignOut(undefined, undefined, 's1')).toBe(true);
    h('SIGNED_IN', { user: { id: A }, access_token: tok('s2') });
    expect(localStorage.getItem('lemo.self_signout')).toBeNull();
    expect(isSelfSignOut()).toBe(false);
    // 新会话读不出 session_id：分不清，不清
    markSelfSignOut(localStorage, Date.now(), 's1');
    forgetSelfSignOut(null);
    expect(isSelfSignOut()).toBe(true);
  });

  it('localStorage 写不进、读不到：本页内存里那份照样管用，不抛错', () => {
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    } as unknown as Storage;
    expect(isSelfSignOut(bad, 10)).toBe(false);
    expect(() => markSelfSignOut(bad, 10)).not.toThrow();
    expect(isSelfSignOut(bad, 20)).toBe(true);
    expect(isSelfSignOut(bad, 10 + SELF_SIGN_OUT_TTL_MS)).toBe(false);
    expect(() => forgetSelfSignOut('s', bad)).not.toThrow();
  });

  it('只打本页的标记（设置页自己处理被移除）：本页认，不写 localStorage，别的标签页仍按被移除提示', () => {
    markSelfSignOutThisTab(100, 's1');
    expect(localStorage.getItem('lemo.self_signout')).toBeNull();
    expect(isSelfSignOut(localStorage, 200, 's1')).toBe(true);
    expect(isSelfSignOut(localStorage, 200, 's2')).toBe(false);
    resetSelfSignOutForTest();   // 别的标签页
    expect(isSelfSignOut(localStorage, 200)).toBe(false);
  });
});

describe('goToAuth、删本机会话（K6-signedout-sugg2 ①、sugg ⑤）', () => {
  it('takeLocalSession：同步读出 session_id 再删两个键；没有会话返回 null', () => {
    seed('s1');
    localStorage.setItem(`${KEY}-code-verifier`, 'v');
    expect(takeLocalSession(localStorage, URL_)).toBe('s1');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(`${KEY}-code-verifier`)).toBeNull();
    expect(takeLocalSession(localStorage, URL_)).toBeNull();
  });

  it('clearLocalSessionIf：本机会话还是那一个才删；别的会话（别的标签页刚登录的）不动', () => {
    seed('s-new', '00000000-0000-4000-8000-00000000000b');
    clearLocalSessionIf('s-old', localStorage, URL_);
    expect(readSessionUserId(localStorage, URL_)).not.toBeNull();
    clearLocalSessionIf('s-new', localStorage, URL_);
    expect(readSessionUserId(localStorage, URL_)).toBeNull();
    expect(() => clearLocalSessionIf(null, localStorage, URL_)).not.toThrow();
  });

  it('goToAuth 带 removed：先删本机会话、记下退出原因（登录页提示“已在别的设备上被移除”），再跳登录页；不带参数不记', () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { replace });
    goToAuth();
    expect(readExitNotice()).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ user: { id: A } }));
    goToAuth('removed');
    expect(readExitNotice()).toBe('removed');
    // 先删本机会话（审查建议 5）：登录页不会同时出现“当前已登录”和“被移除”
    expect(readSessionUserId(localStorage, '')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/app/auth/');
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it('goToAuth(removed, 已删掉的 session_id)：会话已换成别的（清库那几秒里别的标签页登录了）就不删；还是那个（写回来了）才删', () => {
    vi.stubGlobal('location', { replace: vi.fn() });
    seed('s-new');
    goToAuth('removed', 's-dead');
    expect(readSessionUserId()).toBe(A);
    seed('s-dead');
    goToAuth('removed', 's-dead');
    expect(readSessionUserId()).toBeNull();
    seed('s-new');
    goToAuth('removed', null);   // 删的时候本来就没有会话：新登录的不动
    expect(readSessionUserId()).toBe(A);
  });

  it('已经记下退出原因（disabled 等）：removed 不覆盖；没有时照常记 removed', () => {
    vi.stubGlobal('location', { replace: vi.fn() });
    setExitNotice('disabled');
    goToAuth('removed');
    expect(readExitNotice()).toBe('disabled');
    sessionStorage.clear();
    goToAuth('removed');
    expect(readExitNotice()).toBe('removed');
    goToAuth('pending_deletion');
    expect(readExitNotice()).toBe('pending_deletion');
  });
});
