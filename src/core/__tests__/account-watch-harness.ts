// account-watch*.test.ts 共用的搭台：冷启动一个 A 的本机库、挂上 watchAccount，把各个回调交给测试手动触发
// （K6-sugg5 ⑤ 从 account-watch.test.ts 拆文件时抽出来，内容没改）
import { vi } from 'vitest';
import { watchAccount, type WatchAccountDeps } from '../account.ts';
import { coldStart, type BootResult } from '../boot.ts';
import { deleteCacheDb } from '../cache.ts';
import { seedA } from './account-fixtures.ts';
import { fakeIndexedDB, type FakeIDBFactory } from './idb-fake.ts';


export type Fire<T> = (v: T) => void;

export interface Setup {
  boot: BootResult;
  factory: IDBFactory;
  deps: WatchAccountDeps;
  auth: Fire<string>;
  storage: Fire<string | null>;
  /** 本页的 SIGNED_OUT（onAuthUser 的第二个回调；platform 已滤掉自己退出的） */
  signedOut: () => void;
  /** coldStart 期间会话被改成了什么（挂上监听后再比一次时读到的值） */
  session: { id: string | null };
  fake: FakeIDBFactory;
  /** 升级中心的重新载入（versionchange → 重新载入；退出删库不能触发它） */
  reload: ReturnType<typeof vi.fn>;
}

export async function setup(opts: { sessionAfterBoot?: string | null; openFails?: boolean } = {}): Promise<Setup> {
  const { factory, fake } = fakeIndexedDB();
  const reload = vi.fn();
  const boot = await coldStart({
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: opts.openFails ? { factory: undefined as unknown as IDBFactory, name: 'x' } : { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  if (boot.cache) {
    await seedA(boot.cache);
    await boot.outbox?.refresh();
  }
  const session = { id: opts.sessionAfterBoot === undefined ? 'A' : opts.sessionAfterBoot };
  const handlers: { auth: Fire<string>; storage: Fire<string | null>; signedOut: () => void } = {
    auth: () => undefined, storage: () => undefined, signedOut: () => undefined,
  };
  const deps: WatchAccountDeps = {
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    onAuthUser: (fn, onSignedOut) => {
      handlers.auth = fn;
      if (onSignedOut) handlers.signedOut = onSignedOut;
      return () => undefined;
    },
    onStorageUser: (fn) => {
      handlers.storage = fn;
      return () => undefined;
    },
    currentUserId: () => session.id,
    dropSession: vi.fn((): string | null => null),
    onSignedOut: vi.fn(),
    clearLogs: vi.fn(),
    onSwitched: vi.fn(),
    onFailed: vi.fn(),
    deleteDb: () => deleteCacheDb({ factory, waitMs: 50 }),
  };
  watchAccount(boot, deps);
  return {
    boot, factory, deps, session, fake, reload,
    auth: (v) => handlers.auth(v), storage: (v) => handlers.storage(v), signedOut: () => handlers.signedOut(),
  };
}
