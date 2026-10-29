// 日志通道接上上传队列（架构 0.38 第 68 条；接手清单 K8-logs、K6-log）：setSink 之前记的按顺序交给队列；
// 只有拿到同步锁的页面上传（wireSync 的 onLeader），放手时等正在传的那一批传完再放锁；
// 被移除、停用、注销冷静期（wireSync 的 onRemoved）停止上传并清掉这个账号的队列
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../../core/boot.ts';
import { createLogQueue, type LogRow, type LogUploadResult } from '../../core/log/queue.ts';
import { clearAllCollections } from '../../core/store.ts';
import type { Sync, SyncOptions } from '../../core/sync/engine.ts';
import { fakeLife, fakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { clearLogQueue, logQueueStore } from '../../platform/log-store.ts';
import { createLogChannel } from '../log-channel.ts';
import { wireSync, type WireSyncDeps } from '../sync-wiring.ts';

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
  localStorage.clear();
});

/** 假选主：建时立刻拿锁；unlead() 模拟放手（tab-leader 等 stop 跑完才放锁） */
async function wire(extra: Partial<WireSyncDeps>) {
  const boot = await coldStart(bootOpts());
  let stop: (() => Promise<void>) | null = null;
  let leading = false;
  let onRemoved: SyncOptions['onRemoved'] = () => undefined;
  const create = (_b: unknown, o: SyncOptions): Sync => {
    onRemoved = o.onRemoved;
    return ({ start: () => undefined, stop: () => undefined, drain: () => Promise.resolve(), subscribe: () => () => undefined, onEvent: () => () => undefined }) as unknown as Sync;
  };
  wireSync(boot, {
    transport: fakeTransport(),
    clearCacheStorage: () => Promise.resolve(),
    takeLocalSession: () => null, clearLocalSessionIf: () => undefined,
    goToAuth: () => undefined,
    setExitNotice: () => undefined,
    platform: 'web',
    create,
    lifecycle: fakeLife(true),
    onActivity: () => () => undefined,
    leader: (o) => {
      stop = o.lead();
      leading = true;
      return { isLeader: () => leading, post: () => undefined, close: async () => void (await stop?.()) };
    },
    ...extra,
  });
  return {
    unlead: async (): Promise<void> => {
      leading = false;
      await stop?.();
    },
    removed: (code: string) => onRemoved(code),
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe('日志通道 → 上传队列 → 主页上传', () => {
  it('setSink 之前记的按顺序进队列；拿到锁才传，放手后不传', async () => {
    const sent: LogRow[][] = [];
    let text: string | null = null;
    const queue = createLogQueue({
      store: { read: () => text, write: (t) => ((text = t), true) },
      upload: (rows) => (sent.push([...rows]), Promise.resolve('ok')),
      isOnline: () => true,
      onOnline: () => () => undefined,
      every: () => () => undefined,
      now: () => 7,
    });
    const logs = createLogChannel({ now: () => 7 });
    logs.log('first', { coll: 'notes' });
    logs.log('second', { code: 'x' });
    logs.setSink((e) => queue.add(e));
    logs.log('third');
    expect(queue.peek().items.map((x) => x.act)).toEqual(['first', 'second', 'third']);

    const leaderFlags: boolean[] = [];
    const w = await wire({
      onLeader: (on) => {
        leaderFlags.push(on);
        return queue.setLeader(on);
      },
    });
    expect(leaderFlags).toEqual([true]);
    await queue.flush();
    expect(sent[0]).toEqual([{ t: 7, act: 'first', coll: 'notes' }, { t: 7, act: 'second', code: 'x' }, { t: 7, act: 'third' }]);

    await w.unlead();
    expect(leaderFlags).toEqual([true, false]);
    logs.log('after');
    await queue.flush();
    expect(sent).toHaveLength(1);
    expect(queue.peek().items.map((x) => x.act)).toEqual(['after']);
  });

  it('放手时有一批正在传：等它传完再放锁（新主页不会重传同一批）', async () => {
    let done: (r: LogUploadResult) => void = () => undefined;
    const queue = createLogQueue({
      store: logQueueStore('A'), isOnline: () => true, onOnline: () => () => undefined, every: () => () => undefined,
      upload: () => new Promise((r) => (done = r)),
    });
    queue.add({ act: 'x', t: Date.now() });
    const w = await wire({ onLeader: (on) => queue.setLeader(on) });
    void queue.flush();
    let released = false;
    const p = w.unlead().then(() => (released = true));
    await settle();
    expect(released).toBe(false);
    done('ok');
    await p;
    expect(released).toBe(true);
    expect(queue.peek().items).toEqual([]);
  });

  it('被移除、停用、注销冷静期：清掉这个账号的日志队列并停止上传，别的账号的不动', async () => {
    for (const code of ['session_not_found', 'account_disabled', 'account_pending_deletion']) {
      resetBootForTest();
      localStorage.setItem('lemo.logq.B', 'other');
      const sent: LogRow[][] = [];
      const queue = createLogQueue({
        store: logQueueStore('A'), isOnline: () => true, onOnline: () => () => undefined, every: () => () => undefined,
        upload: (rows) => (sent.push([...rows]), Promise.resolve('ok')),
      });
      queue.add({ act: 'x', t: Date.now() });
      expect(localStorage.getItem('lemo.logq.A')).not.toBeNull();
      const w = await wire({
        onLeader: (on) => queue.setLeader(on),
        clearLogs: () => {
          void queue.close();
          clearLogQueue('A');
        },
      });
      w.removed(code);
      expect(localStorage.getItem('lemo.logq.A')).toBeNull();
      expect(localStorage.getItem('lemo.logq.B')).toBe('other');
      queue.add({ act: 'late', t: Date.now() });
      await queue.flush();
      expect(sent).toEqual([]);
      expect(localStorage.getItem('lemo.logq.A')).toBeNull();
      getBoot()?.cache?.close();
    }
  });
});
