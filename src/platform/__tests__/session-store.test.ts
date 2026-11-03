// exe 的会话存储接线（B6-exe 安全审查 F5-2、复核 N1；B2 安全审查 FA2-3）：
// installDesktopSession → session.ts 的同步读删、client.ts 的 auth.storage 都走凭据管理器；真的 supabase-js 退出登录不抛错、-user 删掉、照发 SIGNED_OUT；
// 退出期间的删键保护照样管用；exe 里没装上时关着失败（不退回 localStorage）；exe 退出后先整页重新载入再开登录小窗口
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopSessionKeys, desktopSessionStorage, sessionStorageView } from '../desktop.ts';
import { authBackendStorage, installDesktopSession, resetSessionBackendForTest, sessionRemovalsSettled, sessionStore, type DesktopSessionModule } from '../session-store.ts';
import { clearLocalSessionIf, readSessionId, readSessionUserId } from '../session.ts';
import { guardedLocalStorage, guardSessionRemoval } from '../supabase/auth-storage.ts';
import { clientOptions } from '../supabase/client.ts';

const URL_ = 'https://lemomemo.com/sb';
const KEYS = desktopSessionKeys(URL_);
const KEY = KEYS[0] ?? '';
const UID = '00000000-0000-0000-0000-000000000001';
// payload：sub = UID、exp 2100 年、session_id = "s"
const JWT = 'h.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJleHAiOjQxMDI0NDQ4MDAsInNlc3Npb25faWQiOiJzIn0.s';
const user = { id: UID, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: JWT, refresh_token: 'r', expires_in: 3600, expires_at: 4102444800, token_type: 'bearer', user };

/** 假的 Rust 会话命令（同 desktop-session-signout.test.ts）；removeGate 给了就让 session_remove 等它 */
function fakeRust(opts: { removeGate?: Promise<void>; failRemove?: boolean } = {}) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const key = String(args?.key);
    calls.push(`${cmd} ${key}`);
    await Promise.resolve();
    if (!KEYS.includes(key)) throw 'key_not_allowed';
    if (cmd === 'session_get') return store.get(key) ?? null;
    if (cmd === 'session_set') store.set(key, String(args?.value));
    else if (cmd === 'session_remove') {
      if (opts.removeGate) await opts.removeGate;
      if (opts.failRemove) throw 'store_error';
      store.delete(key);
    } else throw new Error(`unexpected ${cmd}`);
    return null;
  };
  return { store, calls, invoke };
}

/** 换掉 installDesktopSession 的分包加载：真的 desktop.ts 存储 + 假 invoke */
function moduleOf(f: ReturnType<typeof fakeRust>, authDone: { cb?: () => void } = {}): DesktopSessionModule {
  return {
    createDesktopSessionStorage: () => desktopSessionStorage(f.invoke, KEYS),
    desktopSessionKeys: () => KEYS,
    sessionStorageView,
    onAuthDone: async (_s, cb) => {
      authDone.cb = () => void cb();
      return () => undefined;
    },
  };
}

async function installWith(f: ReturnType<typeof fakeRust>, authDone: { cb?: () => void } = {}, onDone?: () => void) {
  return installDesktopSession(onDone, async () => moduleOf(f, authDone), () => true);
}

beforeEach(() => {
  resetSessionBackendForTest();
  localStorage.clear();
});
afterEach(() => {
  resetSessionBackendForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('installDesktopSession', () => {
  it('不在 exe：什么也不做，会话照旧在 localStorage', async () => {
    expect(await installDesktopSession(undefined, async () => {
      throw new Error('不该加载 desktop.ts');
    }, () => false)).toBe(false);
    expect(sessionStore(() => false)).toBe(localStorage);
    expect(authBackendStorage(() => false)).toBeUndefined();
  });

  it('exe：先 preload 再注册，之后同步读得到凭据管理器里的会话、读不到 localStorage 里的', async () => {
    const f = fakeRust();
    f.store.set(KEY, JSON.stringify(session));
    localStorage.setItem(KEY, JSON.stringify({ ...session, user: { id: '00000000-0000-0000-0000-0000000000ff' } }));
    expect(await installWith(f)).toBe(true);
    expect(f.calls).toEqual([`session_get ${KEY}`, `session_get ${KEY}-user`]);
    expect(readSessionUserId(undefined, URL_)).toBe(UID);
    expect(readSessionId(undefined, URL_)).toBe('s');
  });

  it('auth:done 的回调就是传进去的那一个（main 窗口传 reloadPage，FA2-3）', async () => {
    const f = fakeRust();
    const reload = vi.fn();
    const authDone: { cb?: () => void } = {};
    await installWith(f, authDone, reload);
    authDone.cb?.();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('分包加载失败：返回 false，关着失败——同步读读不到、supabase-js 用本页内存，不落 localStorage', async () => {
    expect(await installDesktopSession(undefined, () => Promise.reject(new Error('chunk')), () => true)).toBe(false);
    localStorage.setItem(KEY, JSON.stringify(session));
    expect(sessionStore(() => true).getItem(KEY)).toBeNull();
    const mem = authBackendStorage(() => true);
    await mem?.setItem(KEY, 'x');
    expect(await mem?.getItem(KEY)).toBe('x');
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(session));
    expect(localStorage.length).toBe(1);
  });
});

describe('同步删（clearLocalSessionIf）也删凭据管理器里的', () => {
  it('删的那一刻同步读就读不到；Rust 回来后真的删掉了', async () => {
    let open!: () => void;
    const f = fakeRust({ removeGate: new Promise<void>((r) => (open = r)) });
    f.store.set(KEY, JSON.stringify(session));
    f.store.set(`${KEY}-user`, JSON.stringify({ user }));
    await installWith(f);
    const done = clearLocalSessionIf('s', undefined, URL_);
    expect(readSessionUserId(undefined, URL_)).toBeNull();
    expect(f.store.has(KEY)).toBe(true);
    open();
    expect(await done).toBe(true);
    await sessionRemovalsSettled();
    expect(f.store.has(KEY)).toBe(false);
    expect(f.store.has(`${KEY}-user`)).toBe(false);
    expect(readSessionUserId(undefined, URL_)).toBeNull();
  });

  it('Rust 删失败：会话照旧读得到（没删掉就不假装删掉了）', async () => {
    const f = fakeRust({ failRemove: true });
    f.store.set(KEY, JSON.stringify(session));
    await installWith(f);
    const done = clearLocalSessionIf('s', undefined, URL_);
    expect(readSessionUserId(undefined, URL_)).toBeNull();
    // 删失败要让调用方知道（F5-2 ③）
    expect(await done).toBe(false);
    await sessionRemovalsSettled();
    expect(readSessionUserId(undefined, URL_)).toBe(UID);
  });

  it('会话已经不是那一个：不删', async () => {
    const f = fakeRust();
    f.store.set(KEY, JSON.stringify(session));
    await installWith(f);
    expect(await clearLocalSessionIf('other', undefined, URL_)).toBe(true);
    await sessionRemovalsSettled();
    expect(f.calls.filter((c) => c.startsWith('session_remove'))).toEqual([]);
    expect(readSessionUserId(undefined, URL_)).toBe(UID);
  });
});

describe('真的 supabase-js（N1 接线；clientOptions 拿到的就是凭据管理器那一份）', () => {
  function client(f: ReturnType<typeof fakeRust>) {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('不许联网'))));
    const seen: string[] = [];
    const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      seen.push(`${init?.method ?? 'GET'} ${u.pathname}`);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const storage = clientOptions().auth.storage;
    expect(storage).toBeDefined();
    const db = createClient(URL_, 'anon', {
      global: { fetch: fetchStub as unknown as typeof fetch },
      auth: { ...(storage ? { storage } : {}), persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    });
    void f;
    return { db, seen };
  }

  it('signOut()：不抛错、会话和 -user 都从凭据管理器删掉、照发 SIGNED_OUT；同步读跟着读不到；localStorage 一个键都没写', async () => {
    const f = fakeRust();
    f.store.set(KEY, JSON.stringify(session));
    f.store.set(`${KEY}-user`, JSON.stringify({ user }));
    await installWith(f);
    const { db, seen } = client(f);
    const events: string[] = [];
    const { data } = db.auth.onAuthStateChange((e) => {
      events.push(e);
    });
    const got = await db.auth.getSession();
    expect(got.data.session?.user.id).toBe(UID);
    const res = await db.auth.signOut();
    data.subscription.unsubscribe();
    expect(res.error).toBeNull();
    expect([...f.store.keys()]).toEqual([]);
    expect(events).toContain('SIGNED_OUT');
    expect(f.calls).toContain(`session_remove ${KEY}`);
    expect(f.calls).toContain(`session_remove ${KEY}-user`);
    expect(f.calls.filter((c) => c.includes('code-verifier'))).toEqual([]);
    expect(seen).toEqual(['POST /sb/auth/v1/logout']);
    expect(readSessionUserId(undefined, URL_)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('退出期间的删键保护照样管用：判断说不能删，凭据管理器里的会话留着（K6-signout-lib）', async () => {
    const f = fakeRust();
    f.store.set(KEY, JSON.stringify(session));
    await installWith(f);
    const { db } = client(f);
    await db.auth.getSession();
    const off = guardSessionRemoval((k) => !k.startsWith(KEY), 60_000);
    try {
      expect((await db.auth.signOut({ scope: 'local' })).error).toBeNull();
    } finally {
      off();
    }
    expect(f.store.has(KEY)).toBe(true);
    expect(f.calls.filter((c) => c.startsWith('session_remove'))).toEqual([]);
  });

  it('登录写会话：写进凭据管理器，不写 localStorage', async () => {
    const f = fakeRust();
    await installWith(f);
    const storage = authBackendStorage();
    await storage?.setItem(KEY, JSON.stringify(session));
    expect(f.store.get(KEY)).toBe(JSON.stringify(session));
    expect(localStorage.length).toBe(0);
    expect(readSessionUserId(undefined, URL_)).toBe(UID);
  });
});

describe('exe 里 supabase 客户端不落 localStorage（F5-2 ④）、存储对象不挂到 window（安全审查建议 6）', () => {
  const w = window as unknown as Record<string, unknown>;
  afterEach(() => {
    delete w['__TAURI_INTERNALS__'];
  });

  it('exe、还没装上：clientOptions 的 storage 不是 localStorage 那一份（关着失败，用本页内存）', async () => {
    w['__TAURI_INTERNALS__'] = {};
    const storage = clientOptions().auth.storage;
    expect(storage).toBeDefined();
    expect(storage).not.toBe(guardedLocalStorage);
    await storage?.setItem(KEY, 'x');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('exe、装上以后：clientOptions 的 storage 直通凭据管理器', async () => {
    const f = fakeRust();
    await installWith(f);
    const storage = clientOptions().auth.storage;
    expect(storage).not.toBe(guardedLocalStorage);
    await storage?.setItem(KEY, 'y');
    expect(f.store.get(KEY)).toBe('y');
    expect(localStorage.length).toBe(0);
  });

  it('网页版：照旧是 localStorage 那一份', () => {
    expect(clientOptions().auth.storage).toBe(guardedLocalStorage);
  });

  it('装上以后 window / globalThis 上找不到存储对象（没有带 peek、preload 的东西）', async () => {
    const f = fakeRust();
    f.store.set(KEY, JSON.stringify(session));
    await installWith(f);
    for (const k of Object.getOwnPropertyNames(globalThis)) {
      let v: unknown;
      try {
        v = (globalThis as Record<string, unknown>)[k];
      } catch {
        continue;
      }
      if (typeof v === 'object' && v !== null) {
        expect('peek' in v && 'preload' in v, k).toBe(false);
      }
    }
  });
});
