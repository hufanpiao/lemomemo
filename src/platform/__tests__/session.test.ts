// 本机会话的轻量读取（架构 4.1、0.38 第 17 条）：只取 user.id；键名和 supabase-js 默认一致；storage 事件；Cache Storage 清理
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getSupabase = vi.hoisted(() => vi.fn(() => Promise.reject(new Error('no env'))));
vi.mock('../supabase/client.ts', () => ({ getSupabase }));

import {
  clearCacheStorage, clearLocalSession, onAuthUser, onSessionStorageChange, PRECACHE_PREFIX, readSessionUserId, sessionStorageKey, userIdOfSession,
} from '../session.ts';

const A = '00000000-0000-4000-8000-00000000000a';

afterEach(() => {
  localStorage.clear();
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
