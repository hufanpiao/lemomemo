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
import { clearLocalSessionIf, readSessionUserId, takeLocalSession } from '../../platform/session.ts';
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
    takeLocalSession: vi.fn((): string | null => 's1'),
    clearLocalSessionIf: vi.fn(),
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
    expect(d.takeLocalSession).toHaveBeenCalledTimes(1);
    expect(d.clearLocalSessionIf).toHaveBeenCalledTimes(1);
    expect(d.clearLocalSessionIf).toHaveBeenCalledWith('s1');   // 只在会话还是开头删掉的那一个时再删
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
      expect(d.takeLocalSession).toHaveBeenCalledTimes(1);
      expect(d.clearLocalSessionIf).toHaveBeenCalledWith('s1');
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

// K6-sugg3 ①：被移除、停用时，本机会话在收到事件的同一个同步段里就删；清库那几秒里别的标签页刚登录的新会话，回登录页前不再被删
describe('被移除、停用时删本机会话的时机（K6-sugg3 ①，真的 takeLocalSession / clearLocalSessionIf）', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  /** 测试环境没配 supabaseUrl：session.ts 按 `sb-*-auth-token` 格式找 */
  const KEY = 'sb-lemotest-auth-token';
  const tok = (sid: string): string => `h.${btoa(JSON.stringify({ session_id: sid })).replace(/=+$/, '')}.s`;
  const seed = (sid: string, user = A): void => localStorage.setItem(KEY, JSON.stringify({ access_token: tok(sid), user: { id: user } }));

  afterEach(() => localStorage.clear());

  /** 清运行时缓存卡在 gate 上（= 清库那几秒）；会话层用真的 */
  async function setup() {
    seed('s1');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const boot = await coldStart(opts(fakeIndexedDB().factory));
    const s = spySync();
    const d = {
      ...deps(s.create),
      clearCacheStorage: vi.fn(() => gate),
      takeLocalSession: () => takeLocalSession(),
      clearLocalSessionIf: (sid: string | null) => clearLocalSessionIf(sid),
    };
    wireSync(boot, d);
    return { boot, s, d, release };
  }

  for (const via of ['同步引擎（刷新令牌失败）', 'outbox 的 disabled 事件'] as const) {
    it(`${via}：收到的同一刻就删；清库期间别的标签页登录的新会话（别的账号、同一账号的新会话）回登录页时都不删`, async () => {
      for (const [sid, user] of [['s2', B], ['s2', A]] as const) {
        resetBootForTest();
        localStorage.clear();
        const t = await setup();
        if (via === '同步引擎（刷新令牌失败）') t.s.removed('session_not_found');
        else {
          const ob = t.boot.outbox;
          if (!ob) throw new Error('outbox');
          await ob.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
          const a = await ob.next();
          await ob.fail(a?.op_id ?? '', { status: 403, code: 'account_disabled' });
        }
        expect(readSessionUserId()).toBeNull();   // 删掉了，清库还没完
        seed(sid, user);   // 清库那几秒：别的标签页登录了
        t.release();
        await vi.waitFor(() => expect(t.d.goToAuth).toHaveBeenCalledTimes(1));
        expect(readSessionUserId()).toBe(user);   // 新会话还在
      }
    });
  }

  it('旧会话被晚到的令牌刷新写回（还是 s1）：回登录页前再删一次', async () => {
    const t = await setup();
    t.s.removed('session_not_found');
    seed('s1');
    t.release();
    await vi.waitFor(() => expect(t.d.goToAuth).toHaveBeenCalledTimes(1));
    expect(readSessionUserId()).toBeNull();
  });
});
