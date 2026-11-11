// account-watch*.test.ts 等共用的搭台：冷启动一个 A 的本机库、挂上 watchAccount，把各个回调交给测试手动触发。
// watchWithExit：会话没了那一路照 main.tsx 的接法接到 core/device-exit.ts 的 exitOnSessionLoss，测试照旧看 onSignedOut、clearLogs 这些桩
import { vi } from 'vitest';
import type { AuthLossSignal } from '../auth-loss.ts';
import { watchAccount, wipeLocal, type SessionLoss, type WatchAccountDeps } from '../account.ts';
import { defaultExitDeps, exitOnSessionLoss } from '../device-exit.ts';
import { coldStart, type BootResult } from '../boot.ts';
import { deleteCacheDb } from '../cache.ts';
import { seedA } from './account-fixtures.ts';
import { fakeIndexedDB, type FakeIDBFactory } from './idb-fake.ts';


export type Fire<T> = (v: T) => void;

/** 会话没了那一路的桩（改前 WatchAccountDeps 里的几项）：onSignedOut 收到的就是 goToAuth 的参数 */
export interface LossSpies {
  onSignedOut(...args: [] | [reason: 'removed' | 'expired', deadSessionId: string | null]): void;
  clearLogs?(): void;
  deleteDb?(): Promise<unknown>;
  resolve?(signal: AuthLossSignal): Promise<'expired' | 'removed'>;
  reauthGraceMs?: number;
  log?(act: string): void;
}

export type WatchSpies = Omit<WatchAccountDeps, 'onSessionLost'> & LossSpies;

/** 挂 watchAccount，会话没了接到退出出口（同 main.tsx：清库时按库名删库、不广播 reset）；桩在调用时才读，测试可以中途换 */
export function watchWithExit(boot: BootResult, d: WatchSpies): () => void {
  const ex = {
    ...defaultExitDeps,
    getBoot: () => boot,
    wipe: (b: BootResult) => wipeLocal(b, {
      clearCacheStorage: () => d.clearCacheStorage(),
      ...(d.disconnectPush ? { disconnectPush: d.disconnectPush } : {}),
      ...(d.deleteDb ? { deleteDb: d.deleteDb, dropDb: true } : {}),
      ...(d.log ? { log: d.log } : {}),
    }),
    clearLogs: () => d.clearLogs?.(),
    broadcastReset: () => undefined,
    goToAuth: (n: string | null, sid: string | null) => (n === 'removed' || n === 'expired' ? d.onSignedOut(n, sid) : d.onSignedOut()),
    resolveAuthLoss: (signal: AuthLossSignal) => (d.resolve ?? defaultExitDeps.resolveAuthLoss)(signal),
    log: (act: string) => d.log?.(act),
  };
  // 把 onSessionLost 挂在 d 本身上：测试挂上以后再换 d 的某个桩，watchAccount 照样用新的
  return watchAccount(boot, Object.assign(d, { onSessionLost: (loss: SessionLoss) => exitOnSessionLoss(loss, ex, d.reauthGraceMs ?? 0) }));
}

export interface Setup {
  boot: BootResult;
  factory: IDBFactory;
  deps: WatchSpies;
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
  const deps: WatchSpies = {
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
  watchWithExit(boot, deps);
  return {
    boot, factory, deps, session, fake, reload,
    auth: (v) => handlers.auth(v), storage: (v) => handlers.storage(v), signedOut: () => handlers.signedOut(),
  };
}
