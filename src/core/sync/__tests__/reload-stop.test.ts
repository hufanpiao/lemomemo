// reloadCollections 的换账号闸（FA6-r3-low N3）：逐表 await 的期间设了闸，就不再读下一张、也不把刚读到的那张写回内存
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cache } from '../../cache.ts';
import { clearAllCollections, collection } from '../../store.ts';
import { reloadCollections } from '../reload.ts';

/** 只有 reloadCollections 用到的几样：两张同步表，每张库里一行 */
function fakeCache(onRead: (table: string) => void = () => undefined) {
  const allRows = vi.fn(async (table: string) => {
    await Promise.resolve();
    onRead(table);
    return [{ id: `${table}-1`, view: { id: `${table}-1`, from: table } }];
  });
  return { cache: { syncTables: ['ta', 'tb'], isClosed: () => false, allRows } as unknown as Cache, allRows };
}

beforeEach(() => {
  clearAllCollections();
});

describe('reloadCollections 的 stop', () => {
  it('不传 stop 照旧：两张表都读、都写回内存', async () => {
    const { cache, allRows } = fakeCache();
    await reloadCollections(cache, null);
    expect(allRows).toHaveBeenCalledTimes(2);
    expect(collection('ta').get('ta-1')).toBeTruthy();
    expect(collection('tb').get('tb-1')).toBeTruthy();
  });

  it('第一张表读的期间设了闸：读完不写回内存，第二张不再读', async () => {
    let switching = false;
    const { cache, allRows } = fakeCache(() => {
      switching = true;
    });
    await reloadCollections(cache, null, () => switching);
    expect(allRows).toHaveBeenCalledTimes(1);
    expect(collection('ta').get('ta-1'), '设闸以后把旧账号的行灌回了内存').toBeUndefined();
    expect(collection('tb').get('tb-1')).toBeUndefined();
  });

  it('第一张写完、第二张开读之前设了闸：第二张不读', async () => {
    let switching = false;
    const { cache, allRows } = fakeCache();
    collection('ta').subscribe(() => {
      switching = true;
    });
    await reloadCollections(cache, null, () => switching);
    expect(collection('ta').get('ta-1')).toBeTruthy();
    expect(allRows).toHaveBeenCalledTimes(1);
  });

  it('开始前就设了闸：一张都不读', async () => {
    const { cache, allRows } = fakeCache();
    await reloadCollections(cache, null, () => true);
    expect(allRows).not.toHaveBeenCalled();
  });
});
