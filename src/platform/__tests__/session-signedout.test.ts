// 本页的 SIGNED_OUT（K6-signedout，TC-B1-61 ②、TC-B1-83）的会话层部分（原 session-signedout.test.ts，复查建议 ④ 并进 session.test.ts，
// K6-sugg5 ⑤ 又按主题拆回来）：同一个 onAuthStateChange 分发、INITIAL_SESSION 为 null 的兜底、客户端一建好就挂订阅、
// goToAuth('removed')（核对 session_id 再删，K6-signedout-sugg2 ①；不覆盖已记下的原因，K6-signedout-sugg ⑤）。
// “自己退出”的标记在 session-self-signout.test.ts
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
  authEventHandler, clearLocalSessionIf, goToAuth, markSelfSignOut, onAuthUser, readExitNotice, readSessionUserId, resetSelfSignOutForTest,
  setExitNotice, takeLocalSession,
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

  it('K6-sugg5 ④(a)：别的标签页退出 s1、登录 s2，转来的 SIGNED_IN(s2) 先到、SIGNED_OUT 后到：不上报、s2 不删', () => {
    const out = vi.fn();
    const h = authEventHandler(vi.fn(), out, { initialSessionId: 's1', selfSignOut: () => false, onSignedIn: () => undefined });
    seed('s2');   // 别的标签页已写进新会话
    h('SIGNED_IN', { user: { id: A }, access_token: tok('s2') });
    h('SIGNED_OUT', null);
    expect(out).not.toHaveBeenCalled();
    expect(readSessionUserId()).toBe(A);
    // 对照：顺序正常（SIGNED_OUT 先到，本机已是 s2）也不上报
    const out2 = vi.fn();
    authEventHandler(vi.fn(), out2, { initialSessionId: 's1', selfSignOut: () => false })('SIGNED_OUT', null);
    expect(out2).not.toHaveBeenCalled();
  });
});

describe('goToAuth、删本机会话（K6-signedout-sugg2 ①、sugg ⑤）', () => {
  it('takeLocalSession：同步读出 session_id 再删三个键；没有会话返回 null', () => {
    seed('s1');
    localStorage.setItem(`${KEY}-code-verifier`, 'v');
    localStorage.setItem(`${KEY}-user`, '{}');
    expect(takeLocalSession(localStorage, URL_)).toBe('s1');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(`${KEY}-code-verifier`)).toBeNull();
    expect(localStorage.getItem(`${KEY}-user`)).toBeNull();
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
    goToAuth('removed', null);   // 令牌里读不出 session_id：按 null 比，对得上
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
    goToAuth('removed', null);
    expect(readExitNotice()).toBe('disabled');
    sessionStorage.clear();
    goToAuth('removed', null);
    expect(readExitNotice()).toBe('removed');
    goToAuth('pending_deletion');
    expect(readExitNotice()).toBe('pending_deletion');
  });
});
