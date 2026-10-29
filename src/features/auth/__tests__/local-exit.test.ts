// 登录页“退出并换账号”的本机一半（架构 4.1、0.38 第 35 条）：删本机库、兜底删会话键、读本机令牌、清理顺序
import { describe, expect, it, vi } from 'vitest';
import { DB_NAME } from '../../../core/cache.ts';
import * as session from '../../../platform/session.ts';
import { defaultLocalExitDeps, deleteLocalDb, LOCAL_DB_NAME, readStoredAccessToken, wipeLocal } from '../data/local-exit.ts';

function memStorage(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

/** 假 IDBFactory：deleteDatabase 按 how 触发 success、error、只 blocked 不完成、或直接抛错 */
function fakeFactory(how: 'success' | 'error' | 'blocked' | 'throw') {
  const names: string[] = [];
  const factory = {
    deleteDatabase(name: string) {
      names.push(name);
      if (how === 'throw') throw new Error('SecurityError');
      const req: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
      setTimeout(() => {
        if (how === 'success') req.onsuccess?.();
        else if (how === 'error') req.onerror?.();
        else req.onblocked?.();
      }, 0);
      return req;
    },
  } as unknown as IDBFactory;
  return { factory, names };
}

describe('本机库', () => {
  it('库名和 core/cache.ts 的 DB_NAME 一致（登录页不 import core，免得带进 zod）', () => {
    expect(LOCAL_DB_NAME).toBe(DB_NAME);
  });

  it('删库：成功、出错、抛错、没有 IndexedDB 各回各的结果，删的是 planner-v4', async () => {
    const ok = fakeFactory('success');
    expect(await deleteLocalDb(ok.factory)).toBe('deleted');
    expect(ok.names).toEqual(['planner-v4']);
    expect(await deleteLocalDb(fakeFactory('error').factory)).toBe('error');
    expect(await deleteLocalDb(fakeFactory('throw').factory)).toBe('error');
    expect(await deleteLocalDb(undefined)).toBe('unavailable');
  });

  it('别的标签页没关库（blocked）：最多等 waitMs，就按 blocked 往下走', async () => {
    vi.useFakeTimers();
    try {
      const p = deleteLocalDb(fakeFactory('blocked').factory, 'planner-v4', 3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await p).toBe('blocked');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('本机会话', () => {
  it('兜底默认用 platform/session.ts 的 clearLocalSession（K6）', () => {
    const spy = vi.spyOn(session, 'clearLocalSession').mockImplementation(() => undefined);
    try {
      defaultLocalExitDeps.clearLocalSession();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('读本机令牌：只读 localStorage；没有会话、格式不对回 null', () => {
    expect(readStoredAccessToken(memStorage({ 'sb-127-auth-token': JSON.stringify({ access_token: 'a.b.c' }) }))).toBe('a.b.c');
    expect(readStoredAccessToken(memStorage({ 'sb-127-auth-token': 'not json' }))).toBeNull();
    expect(readStoredAccessToken(memStorage({ other: JSON.stringify({ access_token: 'x' }) }))).toBeNull();
  });
});

describe('清理顺序', () => {
  it('先删库再清 Cache Storage；某一步失败不挡后面', async () => {
    const log: string[] = [];
    await wipeLocal({
      clearLocalSession: () => log.push('clearLocalSession'),
      deleteDb: async () => {
        log.push('deleteDb');
        throw new Error('x');
      },
      clearCacheStorage: async () => void log.push('clearCacheStorage'),
    });
    expect(log).toEqual(['deleteDb', 'clearCacheStorage']);
  });
});
