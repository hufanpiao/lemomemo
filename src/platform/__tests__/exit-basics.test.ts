// 首屏瘦身 U7（11-07，主持人定 A）：withTimeout、deleteLocalDb 等从 sign-out.ts 搬到 exit-basics.ts，只改加载方式、退出逻辑一行不改。
// 这里补三条主持人点名要保住的：① 离线退出照样能退（清本机、删本机会话）；② 会话失效时的兜底（core/account.ts 删库走的 deleteCacheDb）照样走到；
// ②（core/cache.ts 的 deleteCacheDb）在 core/__tests__/cache-delete-db.test.ts（platform 的测试不引 core）；③ sign-out.ts 没有改成 import()：设置页、登录页照旧静态引它，它跟着那两页的分包一起到，没有“下载失败卡在半路”的新路径
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as basics from '../exit-basics.ts';
import * as signOut from '../sign-out.ts';
import { signOutThisDevice, type ExitSteps } from '../sign-out.ts';

const SRC = join(import.meta.dirname, '..', '..');

/** src 下全部源码文件（不含 __tests__） */
function srcFiles(): string[] {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        if (n !== '__tests__') walk(p);
      } else if (/\.(ts|tsx)$/.test(n)) files.push(p);
    }
  };
  walk(SRC);
  return files;
}

function steps(log: string[]): ExitSteps {
  return {
    deleteDb: vi.fn(async () => void log.push('deleteDb')),
    clearCacheStorage: vi.fn(async () => void log.push('caches')),
    clearLocalSessionIf: vi.fn(async (_sid: string | null) => {
      log.push('session');
      return true;
    }),
    readSessionId: vi.fn((): string | null => 's1'),
  } as never;
}

describe('sign-out.ts 转出的就是 exit-basics.ts 的同一份（原有 import 不用改）', () => {
  it('withTimeout、deleteLocalDb、LOCAL_DB_NAME、DELETE_WAIT_MS 同一个引用', () => {
    expect(signOut.withTimeout).toBe(basics.withTimeout);
    expect(signOut.deleteLocalDb).toBe(basics.deleteLocalDb);
    expect(signOut.LOCAL_DB_NAME).toBe(basics.LOCAL_DB_NAME);
    expect(signOut.DELETE_WAIT_MS).toBe(basics.DELETE_WAIT_MS);
  });
});

describe('forgetLook：退出、换账号时删掉本机外观缓存（皮肤整块评审 11-14 第 13 条）', () => {
  it('删掉 pv-look；本机存储用不了也不抛', () => {
    localStorage.setItem(basics.LOOK_CACHE_KEY, '{"skin":"glass"}');
    basics.forgetLook();
    expect(localStorage.getItem('pv-look')).toBeNull();
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => basics.forgetLook()).not.toThrow();
    spy.mockRestore();
  });
});

describe('① 离线退出照样能退', () => {
  it('删行、signOut 都是断网错误：照样清库、清缓存，最后兜底删本机会话，localDone = true', async () => {
    const log: string[] = [];
    const offline = (): Promise<never> => Promise.reject(new TypeError('Failed to fetch'));
    const r = await signOutThisDevice({ server: { deleteOwnDevice: offline, signOut: offline }, steps: steps(log), readUserId: () => 'u1' });
    expect(r).toEqual({ serverDone: false, localDone: true });
    expect(log).toEqual(['deleteDb', 'caches', 'session', 'deleteDb']);
  });
});

describe('③ sign-out.ts 没有改成按需下载', () => {
  it('src 里没有一处 import(…sign-out.ts)；首屏三处（cache.ts、account-status.ts、consent-api.ts）改从 exit-basics.ts 引', () => {
    const files = srcFiles();
    const dyn = files.filter((f) => /import\(\s*['"][^'"]*sign-out\.ts['"]\s*\)/.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
    expect(dyn).toEqual([]);
    for (const f of ['core/cache.ts', 'platform/account-status.ts', 'features/onboarding/data/consent-api.ts']) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, f).toContain("exit-basics.ts';");
      expect(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), f).not.toMatch(/from '[^']*sign-out\.ts'/);
    }
  });
});

describe('超时工具只有一份（第三方审查第 14 条）', () => {
  it('“到点给退路值”的超时只在 platform/exit-basics.ts 定义（withTimeout）；别处不再各写一份 withTimeout、capped', () => {
    const own = srcFiles()
      .filter((f) => /function (withTimeout|capped)\b|const (withTimeout|capped) = (async )?\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'));
    expect(own).toEqual(['platform/exit-basics.ts']);
  });
});
