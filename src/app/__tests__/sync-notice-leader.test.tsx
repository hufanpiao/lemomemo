// 冲突提示跟着真 facade 走一遍“放锁 → 重新抢锁”（代码审查 K8 界面批 S4，守 M1 的回归）：
// 真 wireSync、真 createSync、真 createTabLeader（假 locks、假可见性）、真 gate 和宿主。主页隐藏时放锁、引擎 drain 后 stopped，
// gate 不能跟着卸；回到前台重新抢锁、换了新引擎以后，新引擎发出去回 gone，照样出 gone 卡
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../../core/boot.ts';
import { clearAllCollections } from '../../core/store.ts';
import { createSync, type SyncOptions } from '../../core/sync/engine.ts';
import { fakeLife, fakeTransport, FakeServer } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
import { createTabLeader, type TabLeaderOptions } from '../../platform/tab-leader.ts';
import { fakeBus, fakeLocks, fakeVisibility } from '../../platform/__tests__/tab-fakes.ts';
import { wireSync } from '../sync-wiring.ts';

function bootOpts(): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory: fakeIndexedDB().factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: () => undefined, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
  document.body.replaceChildren();
});

describe('冲突提示 × 选主（S4）', () => {
  it('隐藏放锁（引擎 stopped）不卸提示；回到前台重新抢锁后，新引擎回 gone 照样出卡', async () => {
    const boot = await coldStart(bootOpts());
    const server = new FakeServer();
    const r1 = server.insert('todos', todo(1));
    await boot.cache?.putRows('todos', [{ id: uid(1), server: r1 as never, view: r1 as never }]);   // 本机已有这一行（同服务器）
    const t = fakeTransport(server);
    const vis = fakeVisibility(true);
    const life = fakeLife(true);
    let leads = 0;
    let released = 0;
    const sync = wireSync(boot, {
      transport: t,
      clearCacheStorage: () => Promise.resolve(),
      clearLocalSessionIf: () => Promise.resolve(true),
      goToAuth: () => undefined,
      setExitNotice: () => undefined,
      create: (b, o: SyncOptions) => createSync(b, { ...o, skipConfig: true, lifecycle: life }),
      leader: (o: TabLeaderOptions) =>
        createTabLeader({
          ...o, locks: fakeLocks(), channel: fakeBus(), visibility: vis,
          lead: () => {
            leads += 1;
            const stop = o.lead();
            return async () => {
              await stop();
              released += 1;
            };
          },
        }),
      lifecycle: life,
      onActivity: () => () => undefined,
    });
    await vi.waitFor(() => expect(t.calls).toContain('pull:todos'), { timeout: 2000 });
    expect(document.querySelector('[data-sync-notice]')).not.toBeNull();

    expect(leads).toBe(1);
    // 隐藏：放锁、drain（引擎停下）
    vis.set(false);
    await vi.waitFor(() => expect(released).toBe(1), { timeout: 2000 });
    expect(document.querySelector('[data-sync-notice]')).not.toBeNull();   // M1：不跟着卸

    // 回到前台：重新抢锁，新引擎起来（又拉了一遍）
    t.calls.length = 0;
    vis.set(true);
    await vi.waitFor(() => expect(t.calls).toContain('pull:todos'), { timeout: 2000 });
    expect(leads).toBe(2);
    await sync?.idle();

    // 另一台设备删了这一条，本机再改 → 新引擎发出去回 gone → 出 gone 卡
    server.edit('todos', uid(1), { deleted_at: 5 });
    await boot.outbox?.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: '本机改的' } });
    await vi.waitFor(() => expect(screen.getByTestId('sync-notice-card').textContent).toContain('本机改的'), { timeout: 4000 });
    sync?.stop();
  });
});
