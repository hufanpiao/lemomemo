// 入队严格校验的代码（shared/schema/rows.ts，带 zod）下载不下来时（B2 FA-6 ③ 审查 M2、L3）：
// • outbox.enqueue 拒收：抛 OutboxCodeUnavailableError，不写本机、不入队（失败即关，不能“加载不了就放行”）
// • write.* 不抛错，返回 { ok: false, reason: 'local_unavailable' }；编辑页保存得到 local_unavailable（提示“没保存上”、保留输入，不卡在保存中）
// • 下一次入队再试着加载；加载成功以后照常校验（非法行照样拒收）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../boot.ts';
import { saveInsert } from '../edit-save.ts';
import { OutboxCodeUnavailableError } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { write } from '../write.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { clock, setup, todo, uid } from './outbox-fixtures.ts';

const rowsLoad = vi.hoisted(() => ({ fail: true, tries: 0 }));
vi.mock('../../../shared/schema/rows.ts', async (orig) => {
  rowsLoad.tries += 1;
  if (rowsLoad.fail) throw new Error('chunk_load_failed');
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

describe('严格校验的代码下载不下来（③ 审查 M2、L3）', () => {
  it('outbox.enqueue 拒收：抛 OutboxCodeUnavailableError，本机没有这一行，队列里没有', async () => {
    rowsLoad.fail = true;
    const { cache, outbox } = await setup();
    const err = await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboxCodeUnavailableError);
    expect(await cache.getRow('todos', uid(1))).toBeFalsy();
    expect(outbox.getStatus().pending).toBe(0);
    expect(await outbox.list()).toEqual([]);
  });

  it('write.insert、write.patch 不抛错，回 local_unavailable；编辑页保存得到 local_unavailable', async () => {
    rowsLoad.fail = true;
    const { factory } = fakeIndexedDB();
    const b = await coldStart(opts(factory));
    expect(b.status).toBe('ready');
    await expect(write.insert('todos', { ...todo(1), id: uid(1) })).resolves.toEqual({ ok: false, reason: 'local_unavailable' });
    await expect(write.patch('todos', uid(1), { title: 'x' })).resolves.toEqual({ ok: false, reason: 'local_unavailable' });
    await expect(saveInsert('todos', { ...todo(2), id: uid(2) }, false)).resolves.toBe('local_unavailable');
    expect(b.outbox?.getStatus().pending).toBe(0);
  });

  it('下一次入队再试着加载：加载成功以后照常入队，非法行照样拒收', async () => {
    rowsLoad.fail = true;
    const { cache, outbox } = await setup();
    const before = rowsLoad.tries;
    await expect(outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) })).rejects.toBeInstanceOf(OutboxCodeUnavailableError);
    expect(rowsLoad.tries).toBeGreaterThan(before);
    rowsLoad.fail = false;
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    expect((await cache.getRow('todos', uid(1)))?.view?.['title']).toBe('待办1');
    await expect(outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: { ...todo(2), title: 5 } })).rejects.toMatchObject({ name: 'OutboxRejectError' });
  });
});
