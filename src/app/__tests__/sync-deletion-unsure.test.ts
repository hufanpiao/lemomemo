// 代码复查必改（安全审查 H1 后续）：注销其实已办成时，同步常先收到 session_revoked，由 wireSync 走 wipeOnRemoved 设闸；
// 设置页随后的 leave('deletion_unsure') 要记下这条原因，同步一路清完记 removed 时不覆盖，登录页显示 auth.exit.deletionUnsure。
// 边界规则不许 app 引 features：这里只测同步这一半（标 sessionGone、不覆盖已记的原因），leave 见到 sessionGone 就记 deletion_unsure
// 那一半在 src/features/settings/__tests__/deletion-unsure.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootResult } from '../../core/boot.ts';
import { clearAllCollections } from '../../core/store.ts';
import type { Sync, SyncOptions } from '../../core/sync/engine.ts';
import { fakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { clearExitNotice, readExitNotice, setExitNotice } from '../../platform/session.ts';
import { wireSync } from '../sync-wiring.ts';

async function boot(): Promise<BootResult> {
  return coldStart({
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory: fakeIndexedDB().factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
}

function spySync() {
  let onRemoved: SyncOptions['onRemoved'] = () => undefined;
  const sync = { start: vi.fn(), stop: vi.fn(), drain: vi.fn(() => Promise.resolve()), subscribe: () => () => undefined, onEvent: () => () => undefined } as unknown as Sync;
  const create = vi.fn((_b: BootResult, o: SyncOptions) => {
    onRemoved = o.onRemoved;
    return sync;
  });
  return { create, removed: (code: string, sid: string | null) => onRemoved(code, sid) };
}

beforeEach(() => {
  clearAllCollections();
  clearExitNotice();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
  clearExitNotice();
});

describe('闸由 wipeOnRemoved（同步收到 session_revoked）设：leave(deletion_unsure) 仍记下原因，登录页显示 deletionUnsure', () => {
  it('同步先走：标上 sessionGone；设置页 leave 随后记下 deletion_unsure（boot.sessionGone 时它只做这一件）；同步清完记 removed 时不覆盖', async () => {
    const b = await boot();
    const s = spySync();
    const d = {
      transport: fakeTransport(),
      clearCacheStorage: vi.fn(() => Promise.resolve()),
      clearLocalSessionIf: vi.fn(),
      goToAuth: vi.fn(),
      setExitNotice: vi.fn((n: Parameters<typeof setExitNotice>[0], sid?: string | null) => setExitNotice(n, undefined, { sid: sid ?? null })),
      create: s.create,
    };
    wireSync(b, d);
    s.removed('session_revoked', 's1');
    // wipeOnRemoved 同步设闸并标上“会话没了”
    expect(b.switching).toBe(true);
    expect(b.sessionGone).toBe(true);
    // 设置页 leave 在已设闸且 sessionGone 时做的事（createLeaveAccount 的 setNotice）
    setExitNotice('deletion_unsure', undefined, { sid: 's1' });
    await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
    expect(d.setExitNotice).not.toHaveBeenCalledWith('removed', 's1');
    expect(readExitNotice()).toBe('deletion_unsure');
  });

  it('对照：没有先记下的原因时，同步一路照旧记 removed', async () => {
    const b = await boot();
    const s = spySync();
    const d = {
      transport: fakeTransport(),
      clearCacheStorage: vi.fn(() => Promise.resolve()),
      clearLocalSessionIf: vi.fn(),
      goToAuth: vi.fn(),
      setExitNotice: vi.fn((n: Parameters<typeof setExitNotice>[0], sid?: string | null) => setExitNotice(n, undefined, { sid: sid ?? null })),
      create: s.create,
    };
    wireSync(b, d);
    s.removed('session_revoked', 's1');
    await vi.waitFor(() => expect(d.goToAuth).toHaveBeenCalledTimes(1));
    expect(readExitNotice()).toBe('removed');
  });
});
