// desktop.ts 会话存储的第二组用例（从 desktop-session.test.ts 按 W1 拆出来）：
// 会话键和 env.rs 的白名单是同一份、给同步读取用的只读视图（S3）、真的 supabase-js 退出登录不抛错（M1、F5-1 回归）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopSessionKeys, desktopSessionStorage, sessionStorageView } from '../desktop.ts';
import { readSessionUserId, sessionStorageKey } from '../session.ts';

const KEY = 'sb-lemomemo-auth-token';
const KEYS = [KEY, `${KEY}-user`];

/** 假的 Rust 会话命令：白名单 + 内存表；calls 记下每次调用（和 desktop-session.test.ts 的同一套写法） */
function fakeSessionInvoke(allowed: readonly string[] = KEYS) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const key = String(args?.key);
    calls.push(`${cmd} ${key}`);
    await Promise.resolve();
    if (!allowed.includes(key)) throw 'key_not_allowed';
    if (cmd === 'session_get') return store.get(key) ?? null;
    if (cmd === 'session_set') store.set(key, String(args?.value));
    else if (cmd === 'session_remove') store.delete(key);
    else throw new Error(`unexpected ${cmd}`);
    return null;
  };
  return { store, calls, invoke };
}

describe('会话键：JS 和 Rust 白名单是同一份', () => {
  const ENV_RS = readFileSync(join(import.meta.dirname, '..', '..', '..', 'desktop', 'src-tauri', 'src', 'env.rs'), 'utf8').replace(/\r\n/g, '\n');
  /** env.rs 里正式、预览两个 #[cfg] 块的 session_keys */
  function rustKeys(preview: boolean): string[] {
    const marker = preview ? '#[cfg(feature = "preview")]\npub const ENV' : '#[cfg(not(feature = "preview"))]\npub const ENV';
    const at = ENV_RS.indexOf(marker);
    expect(at).toBeGreaterThanOrEqual(0);
    const block = ENV_RS.slice(at, ENV_RS.indexOf('};', at));
    const m = /session_keys:\s*&\[([^\]]*)\]/.exec(block);
    if (!m?.[1]) throw new Error('env.rs 里没找到 session_keys');
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? '');
  }

  it.each([
    ['正式', 'https://lemomemo.com/sb', false],
    ['预览', 'https://preview.lemomemo.com/sb', true],
  ])('%s：desktopSessionKeys(接口地址) 和 env.rs 的 session_keys 相等，也和 session.ts 的 sessionStorageKey 对得上', (_n, url, preview) => {
    const keys = desktopSessionKeys(url);
    expect(keys).toEqual(rustKeys(preview));
    expect(keys[0]).toBe(sessionStorageKey(url));
  });

  it('地址解析不出来时是空名单：什么都存不进去', async () => {
    expect(desktopSessionKeys('not a url')).toEqual([]);
    const s = desktopSessionStorage(fakeSessionInvoke().invoke, desktopSessionKeys('not a url'));
    await expect(s.setItem(KEY, 'x')).rejects.toBe('key_not_allowed');
  });
});

describe('sessionStorageView：给同步读取用的只读 Storage（S3）', () => {
  const UID = '00000000-0000-0000-0000-000000000001';
  it('preload 以后 readSessionUserId(view) 同步读得到；写、删要走异步存储，视图只读', async () => {
    const f = fakeSessionInvoke();
    f.store.set(KEY, JSON.stringify({ user: { id: UID } }));
    const s = desktopSessionStorage(f.invoke, KEYS);
    const view = sessionStorageView(s);
    expect(view.length).toBe(0);
    expect(readSessionUserId(view, 'https://lemomemo.com/sb')).toBeNull();
    await s.preload(KEYS);
    expect(view.length).toBe(1);
    expect(view.key(0)).toBe(KEY);
    expect(view.key(1)).toBeNull();
    expect(readSessionUserId(view, 'https://lemomemo.com/sb')).toBe(UID);
    expect(readSessionUserId(view, '')).toBe(UID); // 地址没配时按格式扫 key(i) 也找得到
    expect(() => view.setItem(KEY, 'x')).toThrow('desktop_session_view_read_only');
    expect(() => view.removeItem(KEY)).toThrow('desktop_session_view_read_only');
    expect(() => view.clear()).toThrow('desktop_session_view_read_only');
    await s.removeItem(KEY);
    expect(view.length).toBe(0);
    expect(readSessionUserId(view, 'https://lemomemo.com/sb')).toBeNull();
  });
});

describe('真的 supabase-js 退出登录（M1、F5-1 回归）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signOut({ scope: "local" })：不抛错、两个键都删掉、照发 SIGNED_OUT；名单外的 PKCE 键一次也没去 Rust', async () => {
    // 不联网：auth-js 的 local 退出也会 POST 一次 /logout?scope=local，交给假 fetch 回 204；万一哪个库绕过传进去的 fetch，全局 fetch 直接抛错
    const globalFetch = vi.fn(() => Promise.reject(new Error('不许联网')));
    vi.stubGlobal('fetch', globalFetch);
    const keys = desktopSessionKeys('https://lemomemo.com/sb');
    const f = fakeSessionInvoke(keys);
    const user = { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
    const jwt = 'h.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJleHAiOjQxMDI0NDQ4MDAsInNlc3Npb25faWQiOiJzIn0.s';
    const session = { access_token: jwt, refresh_token: 'r', expires_in: 3600, expires_at: 4102444800, token_type: 'bearer', user };
    f.store.set(KEY, JSON.stringify(session));
    f.store.set(`${KEY}-user`, JSON.stringify({ user }));
    const storage = desktopSessionStorage(f.invoke, keys);
    const seen: string[] = [];
    const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      seen.push(`${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${u.pathname}${u.search}`);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const db = createClient('https://lemomemo.com/sb', 'anon', {
      global: { fetch: fetchStub as unknown as typeof fetch },
      auth: { storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const events: string[] = [];
    const { data } = db.auth.onAuthStateChange((e) => {
      events.push(e);
    });
    await db.auth.getSession();
    const res = await db.auth.signOut({ scope: 'local' });
    data.subscription.unsubscribe();
    expect(res.error).toBeNull();
    expect([...f.store.keys()]).toEqual([]);
    expect(events).toContain('SIGNED_OUT');
    expect(f.calls.filter((c) => c.includes('code-verifier'))).toEqual([]);
    expect(f.calls).toContain(`session_remove ${KEY}`);
    expect(f.calls).toContain(`session_remove ${KEY}-user`);
    expect(seen).toEqual(['POST /sb/auth/v1/logout?scope=local']);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
