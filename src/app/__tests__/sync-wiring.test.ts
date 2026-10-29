// 入口接同步（K8 接法）：boot 正常时 createSync(...).start()；不正常不启动；被移除（引擎、outbox 事件）只处理一次，
// 已在走别的退出流程时不再清第二遍；清库关库不触发 versionchange → 重新载入
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealForExit } from '../../core/account.ts';
import { coldStart, getBoot, resetBootForTest, type BootOptions, type BootResult } from '../../core/boot.ts';
import { openCache } from '../../core/cache.ts';
import { clearAllCollections } from '../../core/store.ts';
import { createSync, type Sync, type SyncOptions } from '../../core/sync/engine.ts';
import { fakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import { wireSync } from '../sync-wiring.ts';

const reload = vi.fn();

function opts(factory: IDBFactory): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

function spySync() {
  let onRemoved: SyncOptions['onRemoved'] = () => undefined;
  const sync = { start: vi.fn(), stop: vi.fn(), drain: vi.fn(() => Promise.resolve()), subscribe: () => () => undefined, onEvent: () => () => undefined } as unknown as Sync & { start: ReturnType<typeof vi.fn> };
  const create = vi.fn((_b: BootResult, o: SyncOptions) => {
    onRemoved = o.onRemoved;
    return sync;
  });
  return { sync, create, removed: (code: string) => onRemoved(code) };
}

function deps(create?: (b: BootResult, o: SyncOptions) => Sync) {
  return {
    transport: fakeTransport(),
    clearCacheStorage: vi.fn(() => Promise.resolve()),
    clearLocalSession: vi.fn(),
    goToAuth: vi.fn(),
    setExitNotice: vi.fn(),
    ...(create ? { create } : {}),
  };
}

beforeEach(() => {
  clearAllCollections();
  reload.mockClear();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('wireSync', () => {
  it('boot 正常：真的 createSync 已启动（state.stopped 为 false）', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const sync = wireSync(boot, deps((b, o) => createSync(b, { ...o, skipConfig: true })));
    expect(sync).not.toBeNull();
    expect(sync?.getState().stopped).toBe(false);
    await sync?.idle();
    sync?.stop();
  });

  it('version_too_new、没登录：不启动', async () => {
    const { factory } = fakeIndexedDB();
    const hi = await openCache({ factory, version: 2, migrations: [{ to: 2, up: () => undefined }] });
    if (hi.ok) hi.cache.close();
    const tooNew = await coldStart(opts(factory));
    expect(tooNew.status).toBe('version_too_new');
    const s1 = spySync();
    expect(wireSync(tooNew, deps(s1.create))).toBeNull();
    expect(s1.create).not.toHaveBeenCalled();

    resetBootForTest();
    const out = await coldStart({ ...opts(fakeIndexedDB().factory), userId: null });
    const s2 = spySync();
    expect(wireSync(out, deps(s2.create))).toBeNull();
  });

  it('被移除：引擎连报两次，只清一次、只跳一次登录页；不触发重新载入', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    const d = deps(s.create);
    wireSync(boot, d);
    expect(s.sync.start).toHaveBeenCalledTimes(1);
    s.removed('session_not_found');
    s.removed('auth_failed');
    await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
    expect(d.clearLocalSession).toHaveBeenCalledTimes(1);
    expect(d.clearCacheStorage).toHaveBeenCalledTimes(1);
    expect(boot.cache?.isClosed()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it('已经在走别的退出流程（boot.switching）：被移除不再清第二遍', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    const d = deps(s.create);
    wireSync(boot, d);
    sealForExit(boot);
    s.removed('session_not_found');
    await Promise.resolve();
    expect(d.clearCacheStorage).not.toHaveBeenCalled();
    expect(d.goToAuth).not.toHaveBeenCalled();
  });

  it('被停用、注销冷静期（outbox 的 disabled 事件）：和被移除一样清本机、删会话、回登录页，并记下退出原因；页面跳走，不会静默丢写入', async () => {
    for (const [code, notice] of [['account_disabled', 'disabled'], ['account_pending_deletion', 'pending_deletion']] as const) {
      resetBootForTest();
      const boot = await coldStart(opts(fakeIndexedDB().factory));
      const s = spySync();
      const d = deps(s.create);
      wireSync(boot, d);
      const ob = boot.outbox;
      if (!ob) throw new Error('outbox');
      await ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
      const a = await ob.next();
      expect(await ob.fail(a?.op_id ?? '', { status: 403, code })).toBe('disabled');
      await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
      expect(d.setExitNotice).toHaveBeenCalledWith(notice);
      expect(d.setExitNotice.mock.invocationCallOrder[0]).toBeLessThan(d.goToAuth.mock.invocationCallOrder[0] ?? 0);
      expect(d.clearLocalSession).toHaveBeenCalledTimes(1);
      expect(d.clearCacheStorage).toHaveBeenCalledTimes(1);
      expect(boot.switching).toBe(true);
      expect(boot.cache?.isClosed()).toBe(true);
      expect(reload).not.toHaveBeenCalled();
    }
  });

  it('同步引擎报被移除（刷新令牌失败）：退出原因记 removed', async () => {
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    const d = deps(s.create);
    wireSync(boot, d);
    s.removed('session_not_found');
    await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
    expect(d.setExitNotice).toHaveBeenCalledWith('removed');
  });
});
