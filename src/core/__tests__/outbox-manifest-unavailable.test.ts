// 入队校验要的完整清单（core/manifest-source.ts → manifests.gen.ts）下载不下来时（11-05 manifests 拆分，代码审查 L5）：
// 它和 rows.ts 在 loadRowSchemas 的同一个 Promise.all 里，行为必须和 rows.ts 下载失败一样（outbox-code-unavailable.test.ts）：
// • outbox.enqueue 抛 OutboxCodeUnavailableError，不写本机、不入队；write.* 回 local_unavailable
// • 下一次入队再试着加载；加载成功以后照常校验（非法行照样拒收）
// 单独一个文件：loadRowSchemas 成功一次就缓存，和 rows.ts 那组放一起会互相影响
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../boot.ts';
import { OutboxCodeUnavailableError } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { write } from '../write.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { clock, setup, todo, uid } from './outbox-fixtures.ts';

const srcLoad = vi.hoisted(() => ({ fail: true, tries: 0 }));
vi.mock('../manifest-source.ts', async (orig) => {
  srcLoad.tries += 1;
  if (srcLoad.fail) throw new Error('chunk_load_failed');
  return orig();
});

function opts(factory: IDBFactory): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('完整清单下载不下来（manifests 拆分审查 L5）', () => {
  it('启动照常（首屏建本机仓不用完整清单）；write.insert、write.patch 回 local_unavailable，不入队', async () => {
    srcLoad.fail = true;
    const { factory } = fakeIndexedDB();
    const b = await coldStart(opts(factory));
    expect(b.status).toBe('ready');
    await expect(write.insert('todos', { ...todo(1), id: uid(1) })).resolves.toEqual({ ok: false, reason: 'local_unavailable' });
    await expect(write.patch('todos', uid(1), { title: 'x' })).resolves.toEqual({ ok: false, reason: 'local_unavailable' });
    expect(b.outbox?.getStatus().pending).toBe(0);
  });

  it('outbox.enqueue 拒收：本机没有这一行；下一次入队再加载，成功以后照常入队，非法行照样拒收', async () => {
    srcLoad.fail = true;
    const { cache, outbox } = await setup();
    const before = srcLoad.tries;
    const err = await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboxCodeUnavailableError);
    expect(srcLoad.tries).toBeGreaterThan(before);
    expect(await cache.getRow('todos', uid(1))).toBeFalsy();
    expect(await outbox.list()).toEqual([]);
    srcLoad.fail = false;
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('待办1');
    await expect(outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: { ...todo(2), title: 5 } })).rejects.toMatchObject({ name: 'OutboxRejectError' });
  });
});
