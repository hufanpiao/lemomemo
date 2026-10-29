// 本页的 SIGNED_OUT（K6-signedout，TC-B1-61 ②、TC-B1-83；审查 M1、建议 4、5）：同一个 onAuthStateChange 分发、
// INITIAL_SESSION 为 null 的兜底、“自己退出”标记、客户端一建好就挂订阅、goToAuth('removed')；全 src 只有 session.ts 监听
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** 客户端建好时的回调（真实实现见 supabase/client.ts；这里由测试手动触发 ready.fire(db)） */
const ready = vi.hoisted(() => {
  const fns = new Set<(db: unknown) => void>();
  return { fns, fire: (db: unknown) => [...fns].forEach((f) => f(db)) };
});
vi.mock('../supabase/client.ts', () => ({
  getSupabase: () => Promise.reject(new Error('no env')),
  onClientReady: (f: (db: unknown) => void) => {
    ready.fns.add(f);
    return () => void ready.fns.delete(f);
  },
}));

import {
  authEventHandler, goToAuth, isSelfSignOut, markSelfSignOut, markSelfSignOutThisTab, onAuthUser, readExitNotice, readSessionUserId,
  resetSelfSignOutForTest, SELF_SIGN_OUT_TTL_MS,
} from '../session.ts';

const A = '00000000-0000-4000-8000-00000000000a';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetSelfSignOutForTest();
  vi.unstubAllGlobals();
});

describe('本页的 SIGNED_OUT（K6-signedout，TC-B1-61 ②、TC-B1-83）', () => {
  const U = { user: { id: A } };

  it('同一个回调分发：SIGNED_IN、TOKEN_REFRESHED 回 user_id；SIGNED_OUT 回 onSignedOut；别的事件不管', () => {
    const fn = vi.fn();
    const out = vi.fn();
    const h = authEventHandler(fn, out, () => false);
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

  it('自己点“退出登录”（退出流程先打了标记）：SIGNED_OUT 不往上报', () => {
    const out = vi.fn();
    const h = authEventHandler(vi.fn(), out);
    markSelfSignOut();
    h('SIGNED_OUT', null);
    expect(out).not.toHaveBeenCalled();
  });

  it('没传 onSignedOut（只关心换账号的调用方）：SIGNED_OUT 什么也不做', () => {
    expect(() => authEventHandler(vi.fn())('SIGNED_OUT', null)).not.toThrow();
  });

  it('标记存在 localStorage（别的标签页打的也认），只存时间戳；过了有效期不认并删掉', () => {
    const t0 = 1_000_000;
    markSelfSignOut(localStorage, t0);
    expect(localStorage.getItem('lemo.self_signout')).toBe(String(t0));
    resetSelfSignOutForTest();   // 模拟别的标签页：本页内存里没有
    expect(isSelfSignOut(localStorage, t0 + 1000)).toBe(true);
    expect(isSelfSignOut(localStorage, t0 + SELF_SIGN_OUT_TTL_MS)).toBe(false);
    expect(localStorage.getItem('lemo.self_signout')).toBeNull();
    expect(isSelfSignOut(localStorage, t0)).toBe(false);
  });

  it('坏值、未来的时间戳不认', () => {
    localStorage.setItem('lemo.self_signout', 'abc');
    expect(isSelfSignOut(localStorage, 5)).toBe(false);
    localStorage.setItem('lemo.self_signout', '100');
    expect(isSelfSignOut(localStorage, 50)).toBe(false);
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
    authEventHandler(vi.fn(), out, () => false, () => true)('INITIAL_SESSION', null);
    expect(out).toHaveBeenCalledTimes(1);
    authEventHandler(vi.fn(), out, () => true, () => true)('INITIAL_SESSION', null);
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
    localStorage.setItem('sb-lemomemo-auth-token', JSON.stringify({ user: { id: A } }));
    authEventHandler(vi.fn(), out, () => false, () => readSessionUserId(localStorage, 'https://lemomemo.com/sb') === null)('INITIAL_SESSION', null);
    authEventHandler(vi.fn(), out, () => false, () => true)('INITIAL_SESSION', U);
    expect(out).not.toHaveBeenCalled();
  });

  it('只打本页的标记（设置页自己处理被移除）：本页认，不写 localStorage，别的标签页仍按被移除提示', () => {
    markSelfSignOutThisTab(100);
    expect(localStorage.getItem('lemo.self_signout')).toBeNull();
    expect(isSelfSignOut(localStorage, 200)).toBe(true);
    resetSelfSignOutForTest();   // 别的标签页
    expect(isSelfSignOut(localStorage, 200)).toBe(false);
  });

  it('goToAuth 带 removed：先删本机会话、记下退出原因（登录页提示“已在别的设备上被移除”），再跳登录页；不带参数不记', () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { replace });
    goToAuth();
    expect(readExitNotice()).toBeNull();
    localStorage.setItem('sb-lemomemo-auth-token', JSON.stringify({ user: { id: A } }));
    goToAuth('removed');
    expect(readExitNotice()).toBe('removed');
    // 先删本机会话（审查建议 5）：登录页不会同时出现“当前已登录”和“被移除”
    expect(readSessionUserId(localStorage, '')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/app/auth/');
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it('全 src 只有 platform/session.ts 订阅 onAuthStateChange、认 SIGNED_OUT（K8、各功能页不各自监听）', () => {
    const root = join(import.meta.dirname, '..', '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') walk(full);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const text = readFileSync(full, 'utf8');
          if (/onAuthStateChange\s*\(|['"`]SIGNED_OUT['"`]/.test(text)) hits.push(relative(root, full).split(sep).join('/'));
        }
      }
    };
    walk(root);
    expect(hits).toEqual(['platform/session.ts']);
  });
});
