// “自己退出”的标记：时间戳 + 退出前的 session_id（K6-signedout-sugg ①）。K6-sugg5 ⑤ 从 session.test.ts 按主题拆出来；
// 同一组 SIGNED_OUT 的事件分发和 goToAuth 在 session-signedout.test.ts
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
  authEventHandler, forgetSelfSignOut, isSelfSignOut, markSelfSignOut, markSelfSignOutThisTab, resetSelfSignOutForTest, SELF_SIGN_OUT_TTL_MS,
} from '../session.ts';

const A = '00000000-0000-4000-8000-00000000000a';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetSelfSignOutForTest();
  ready.fns.clear();
  vi.unstubAllGlobals();
});

/** 造一个 payload 里带 session_id 的假 access token（只有 payload 段有意义） */
const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
const KEY = 'sb-lemomemo-auth-token';
const seed = (sid: string, user = A): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: user } }));

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
