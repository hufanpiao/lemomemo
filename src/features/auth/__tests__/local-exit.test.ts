// 登录页“退出并换账号”的本机一半：读本机令牌；库名和 core 一致（删库、清缓存、兜底删会话已并到 platform/sign-out.ts，测试在 src/platform/__tests__/sign-out.test.ts）
import { describe, expect, it } from 'vitest';
import { DB_NAME } from '../../../core/cache.ts';
import { LOCAL_DB_NAME } from '../../../platform/sign-out.ts';
import { readStoredAccessToken } from '../data/local-exit.ts';

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

describe('本机库', () => {
  it('platform/sign-out.ts 的库名和 core/cache.ts 的 DB_NAME 一致（登录页、platform 都不 import core，免得带进 zod）', () => {
    expect(LOCAL_DB_NAME).toBe(DB_NAME);
  });
});

describe('本机会话', () => {
  it('读本机令牌：只读 localStorage；没有会话、格式不对回 null', () => {
    expect(readStoredAccessToken(memStorage({ 'sb-127-auth-token': JSON.stringify({ access_token: 'a.b.c' }) }))).toBe('a.b.c');
    expect(readStoredAccessToken(memStorage({ 'sb-127-auth-token': 'not json' }))).toBeNull();
    expect(readStoredAccessToken(memStorage({ other: JSON.stringify({ access_token: 'x' }) }))).toBeNull();
  });
});
