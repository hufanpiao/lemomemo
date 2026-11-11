// R-382（架构 4.1a 第 1 点 ②、负责人 11-11 定）：同步层的“登录过期”和“已停用”只退出、不清本机——
// 设闸、写 lemo.reauth、只关库，删被拒的那个会话、记退出原因、回登录页；被移除照旧清库、删记号。
// 账号用 uuid（sync-wiring.test.ts 里的 'A' 不是 uuid，写不了记号，走的是“写不了就退回清库”）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions, type BootResult } from '../../core/boot.ts';
import { claimCache } from '../../core/account.ts';
import { clearAllCollections } from '../../core/store.ts';
import type { Sync, SyncOptions } from '../../core/sync/engine.ts';
import { fakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB, flush, type FakeIDBFactory } from '../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import { readReauth } from '../../platform/auth-loss-store.ts';
import { wireSync } from '../sync-wiring.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const S = '00000000-0000-4000-8000-0000000000c1';

function opts(factory: IDBFactory): BootOptions {
  return {
    userId: A, appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

async function start(resolve: 'expired' | 'removed' = 'expired') {
  const { factory, fake } = fakeIndexedDB();
  const boot = await coldStart(opts(factory));
  if (!boot.cache) throw new Error('no cache');
  await claimCache(boot.cache, A);
  let onRemoved: SyncOptions['onRemoved'] = () => undefined;
  const sync = { start: vi.fn(), stop: vi.fn(), drain: vi.fn(() => Promise.resolve()), subscribe: () => () => undefined, onEvent: () => () => undefined } as unknown as Sync;
  const d = {
    transport: fakeTransport(),
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    clearLocalSessionIf: vi.fn(),
    resolveAuthLoss: vi.fn(() => Promise.resolve(resolve)),
    goToAuth: vi.fn(),
    setExitNotice: vi.fn((_n: string, _sid?: string | null) => undefined),
    readExitNotice: vi.fn((): null => null),
    clearLogs: vi.fn(),
    log: vi.fn((..._a: unknown[]) => undefined),
    create: (_b: BootResult, o: SyncOptions) => {
      onRemoved = o.onRemoved;
      return sync;
    },
  };
  wireSync(boot, d);
  return { boot, fake, d, removed: (code: string) => onRemoved(code, S), failWith: (code: string) => failWith(boot, code) };
}

async function failWith(boot: BootResult, code: string, sid: string | null = S): Promise<void> {
  const ob = boot.outbox;
  if (!ob) throw new Error('outbox');
  await ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
  const a = await ob.next();
  await ob.fail(a?.op_id ?? '', { status: 403, code, sid });
}

const kept = (fake: FakeIDBFactory): boolean => (fake.dbs.get('planner-v4')?.stores.get('outbox')?.records.size ?? 0) > 0;

beforeEach(() => clearAllCollections());
afterEach(() => {
  localStorage.clear();
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('同步层：登录过期只关库不清', () => {
  it('引擎报刷新被拒、判 expired：写记号、关库不清、删 S、记 expired、回登录页，不清日志队列', async () => {
    const r = await start('expired');
    r.removed('refresh_rejected');
    expect(r.boot.switching).toBe(true);
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(readReauth()).toMatchObject({ user_id: A, session_id: S, reason: 'expired' });
    expect(r.boot.cache?.isClosed()).toBe(true);
    expect(r.fake.dbs.has('planner-v4')).toBe(true);
    expect(r.d.clearCacheStorage).not.toHaveBeenCalled();
    expect(r.d.clearLocalSessionIf).toHaveBeenCalledWith(S);
    expect(r.d.setExitNotice).toHaveBeenCalledWith('expired', S);
    expect(r.d.clearLogs).not.toHaveBeenCalled();
  });

  it('outbox 的 session_revoked、判 removed：照旧清库、删记号、记 removed', async () => {
    const r = await start('removed');
    await failWith(r.boot, 'session_revoked');
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(r.d.clearCacheStorage).toHaveBeenCalledTimes(1);
    expect(readReauth()).toBeNull();
    expect(r.d.setExitNotice.mock.calls.map((c) => c[0])).toContain('removed');
  });
});

describe('同步层：日志通道和已停用优先', () => {
  it('lemo.reauth 的 session_id、user_id 不进日志通道', async () => {
    const r = await start('expired');
    r.removed('refresh_rejected');
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    const all = JSON.stringify(r.d.log.mock.calls);
    expect(all).not.toContain(S);
    expect(all).not.toContain(A);
  });

  it('已停用优先：登录过期的退出已经在走，又收到这个会话的 account_disabled → 退出原因改记 disabled', async () => {
    let settle: (v: 'expired') => void = () => undefined;
    const r = await start();
    r.d.resolveAuthLoss.mockImplementation(() => new Promise((res) => (settle = res)));
    r.removed('refresh_rejected');
    expect(r.boot.sessionGone).toBe(true);
    r.removed('account_disabled');   // 在路上的那个请求回了停用（同一个会话）
    settle('expired');
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(r.d.setExitNotice).toHaveBeenCalledWith('disabled', S);
    expect(readReauth()?.reason).toBe('disabled');   // 记号也改成 disabled（登录页以记号为准，复核建议 ①）
  });
});

describe('同步层：已停用只退出、不清本机（负责人 11-11 定）', () => {
  it('outbox 的 account_disabled（不能探测时直接按停用）：写记号（session_id 为 null）、只关库，本机库和没发的修改都在；删 S、记 disabled、回登录页', async () => {
    const r = await start();
    await failWith(r.boot, 'account_disabled');
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    await flush();
    expect(r.boot.switching).toBe(true);
    expect(r.boot.cache?.isClosed()).toBe(true);
    expect(r.fake.dbs.has('planner-v4')).toBe(true);
    expect(kept(r.fake)).toBe(true);
    expect(r.d.clearCacheStorage).not.toHaveBeenCalled();
    expect(readReauth()).toMatchObject({ user_id: A, session_id: null, reason: 'disabled' });
    expect(r.d.clearLocalSessionIf).toHaveBeenCalledWith(S);
    expect(r.d.setExitNotice).toHaveBeenCalledWith('disabled', S);
    expect(r.d.resolveAuthLoss).not.toHaveBeenCalled();
  });

  it('本机已没有会话、被拒的请求 sid 为 null 的 account_disabled（R-263 那条路）：不探测，同样只关库不清，记号在；账号没停用，提示 expired（R-263 ③，复核必改）', async () => {
    const r = await start();
    const d = Object.assign(r.d, { readUserId: vi.fn((): null => null), probeAccount: vi.fn() });
    await failWith(r.boot, 'account_disabled', null);
    await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
    await flush();
    expect(d.probeAccount).not.toHaveBeenCalled();
    expect(r.boot.cache?.isClosed()).toBe(true);
    expect(r.fake.dbs.has('planner-v4')).toBe(true);
    expect(kept(r.fake)).toBe(true);
    expect(d.clearCacheStorage).not.toHaveBeenCalled();
    expect(d.clearLogs).not.toHaveBeenCalled();
    expect(readReauth()).toMatchObject({ user_id: A, session_id: null, reason: 'expired' });
    expect(d.setExitNotice).toHaveBeenCalledWith('expired', null);
    expect(d.setExitNotice).not.toHaveBeenCalledWith('disabled', null);
  });

  it('冷静期（account_pending_deletion）不变：照旧清库', async () => {
    const r = await start();
    await failWith(r.boot, 'account_pending_deletion');
    await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(r.d.clearCacheStorage).toHaveBeenCalledTimes(1);
    expect(readReauth()).toBeNull();
  });

  it('写不了记号（存储不可用）：退回原来的清库', async () => {
    const r = await start();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      await failWith(r.boot, 'account_disabled');
      await vi.waitFor(() => expect(r.d.goToAuth).toHaveBeenCalledTimes(1));
    } finally {
      spy.mockRestore();
    }
    expect(r.d.clearCacheStorage).toHaveBeenCalledTimes(1);
  });
});
