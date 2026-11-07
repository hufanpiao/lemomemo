// 会话失效、被移除时的兜底删库（core/account.ts 的 wipeOnRemoved 经 deleteCacheDb）：11-07 首屏瘦身 U7 起 deleteCacheDb 改从
// platform/exit-basics.ts 引 deleteLocalDb（从 sign-out.ts 原样搬来，逻辑没改）。这里钉住改引用以后照样按库名删、各种结果照旧
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteLocalDb } from '../../platform/exit-basics.ts';
import { DB_NAME, deleteCacheDb } from '../cache.ts';

function fakeFactory(how: 'success' | 'error' | 'blocked' | 'throw') {
  const names: string[] = [];
  const factory = {
    deleteDatabase(name: string) {
      names.push(name);
      if (how === 'throw') throw new Error('SecurityError');
      const req: { onsuccess?: () => void; onerror?: () => void } = {};
      setTimeout(() => {
        if (how === 'success') req.onsuccess?.();
        else if (how === 'error') req.onerror?.();
      }, 0);
      return req;
    },
  } as unknown as IDBFactory;
  return { factory, names };
}

describe('deleteCacheDb（会话失效、被移除时的兜底删库）', () => {
  it('删的是本机库 planner-v4（和 exit-basics.ts 的 LOCAL_DB_NAME 一致）；成功、出错、抛错各回各的结果', async () => {
    const ok = fakeFactory('success');
    expect(await deleteCacheDb({ factory: ok.factory })).toBe('deleted');
    expect(ok.names).toEqual([DB_NAME]);
    expect(DB_NAME).toBe('planner-v4');
    expect(await deleteCacheDb({ factory: fakeFactory('error').factory })).toBe('error');
    expect(await deleteCacheDb({ factory: fakeFactory('throw').factory })).toBe('error');
  });

  it('别的标签页没关库：最多等 waitMs，按 blocked 往下走，不卡住', async () => {
    expect(await deleteCacheDb({ factory: fakeFactory('blocked').factory, waitMs: 20 })).toBe('blocked');
  });

  it('cache.ts 的删库就是 exit-basics.ts 那一份（不是 sign-out.ts，后者不在首屏）', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'cache.ts'), 'utf8');
    expect(src).toContain("import { deleteLocalDb, type DeleteDbResult } from '../platform/exit-basics.ts';");
    expect(typeof deleteLocalDb).toBe('function');
  });
});
