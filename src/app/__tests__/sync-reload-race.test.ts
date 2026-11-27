// 频道建好后的那次补读（FA-6 推迟启动审查 M3）和读库期间的并发写入（代码复审 N1）：
// reloadCollections 要 await 一次 IndexedDB getAll，这期间本机写入（outbox.enqueue → 提交 → notify）可能先进内存。
// 补读只能删、只能覆盖读库期间没变过的行：新加的不删、改过的不改回旧值、读库期间删掉的不加回来。主页、非主页各一条
// （审查员的探针：todos 读完库以后停住，这时插入、修改，再放行补读）。补读的分支条件（主页不提醒、换账号闸）在 sync-tabs.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../../core/boot.ts';
import { clearAllCollections, collection } from '../../core/store.ts';
import { createSync, type SyncOptions } from '../../core/sync/engine.ts';
import { fakeLife, fakeTransport, FakeServer } from '../../core/sync/__tests__/fake-server.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { todo, uid } from '../../core/__tests__/outbox-fixtures.ts';
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

const flush = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

async function ready() {
  const boot = await coldStart(bootOpts());
  const { cache, outbox } = boot;
  if (!cache || !outbox) throw new Error('冷启动没拿到本机库');
  return { boot, cache, outbox };
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});
describe('补读期间的并发写入（FA-6 推迟启动代码复审 N1）', () => {
  function wire(boot: Awaited<ReturnType<typeof coldStart>>, isLeader: boolean) {
    return wireSync(boot, {
      transport: fakeTransport(new FakeServer()),
      clearCacheStorage: () => Promise.resolve(),
      clearLocalSessionIf: () => Promise.resolve(true),
      goToAuth: () => undefined,
      setExitNotice: () => undefined,
      create: (b, o: SyncOptions) => createSync(b, { ...o, skipConfig: true, lifecycle: fakeLife(true) }),
      // 不调 lead：引擎不起，只看补读本身
      leader: () => ({ isLeader: () => isLeader, post: () => undefined, close: () => Promise.resolve() }),
      lifecycle: fakeLife(true),
    });
  }

  for (const isLeader of [true, false]) {
    it(`${isLeader ? '主页' : '非主页'}：todos 读完库、还没写回内存时，本机新加一行、改一行、删一行；补读不删新行、不把改过的改回旧值、不把删掉的加回来`, async () => {
      const { boot, cache, outbox } = await ready();
      const keep = todo(1);
      const edit = todo(2);
      const drop = todo(3);
      await cache.putRows('todos', [keep, edit, drop].map((r) => ({ id: r['id'] as string, server: r as never, view: r as never })));
      const c = collection<Record<string, unknown> & { id: string }>('todos');
      // 第四行只在内存里、库里没有（例如本机刚写、还没落库的样子）：读库期间又被 notify 换成新对象，补读不能把它当“库里没了”删掉
      const memOnly = todo(4);
      c.upsert([keep, edit, drop, memOnly] as never);
      // 第一次读 todos：读完以后停住，等测试在这期间写入
      let release!: () => void;
      const paused = new Promise<void>((ok) => (release = ok));
      let reading!: () => void;
      const readDone = new Promise<void>((ok) => (reading = ok));
      const real = cache.allRows.bind(cache);
      let first = true;
      vi.spyOn(cache, 'allRows').mockImplementation(async (table: string) => {
        const rows = await real(table);
        if (table === 'todos' && first) {
          first = false;
          reading();
          await paused;
        }
        return rows as never;
      });
      const sync = wire(boot, isLeader);
      await readDone;
      // 读库期间：本机写入（outbox.enqueue 提交后 notify 进内存）
      await outbox.enqueue({ table: 'todos', id: uid(9), op: 'insert', data: todo(9) });
      await outbox.enqueue({ table: 'todos', id: uid(2), op: 'patch', data: { title: '改过了' } });
      expect(c.get(uid(9)), '新行已经在内存里').toBeTruthy();
      expect(c.get(uid(2))?.['title']).toBe('改过了');
      c.remove([uid(3)]);   // 读库期间被别处移出内存（例如引擎拉到服务器上已删）
      c.upsert([todo(4, { title: '读库期间换过' })] as never);
      release();
      await vi.waitFor(() => expect(cache.allRows).toHaveBeenCalledTimes(cache.syncTables.length));
      await flush(5);
      expect(c.get(uid(9)), '补读把刚加的一行从内存里删了').toBeTruthy();
      expect(c.get(uid(2))?.['title'], '补读把改过的一行改回了旧值').toBe('改过了');
      expect(c.get(uid(3)), '补读把读库期间删掉的一行加回来了').toBeUndefined();
      expect(c.get(uid(4))?.['title'], '补读把读库期间动过、库里没有的一行删了').toBe('读库期间换过');
      expect(c.get(uid(1)), '没动过的行照旧').toBeTruthy();
      await sync?.stop();
    });
  }

  it('没有并发写入时照旧：库里没有了的从内存去掉，库里改了的写回内存', async () => {
    const { boot, cache } = await ready();
    const c = collection<Record<string, unknown> & { id: string }>('todos');
    c.upsert([todo(1), todo(2, { title: '旧' })] as never);
    const fresh = todo(2, { title: '库里的新值' });
    await cache.putRows('todos', [{ id: uid(2), server: fresh as never, view: fresh as never }]);
    const sync = wire(boot, false);
    await vi.waitFor(() => expect(c.get(uid(2))?.['title']).toBe('库里的新值'));
    expect(c.get(uid(1))).toBeUndefined();
    await sync?.stop();
  });

  for (const isLeader of [true, false]) {
    it(`${isLeader ? '主页' : '非主页'}：补读逐表读的途中设了换账号闸（FA6-r3-low N3）：不再读后面的表，刚读到的也不写回内存`, async () => {
      const { boot, cache } = await ready();
      const row = todo(1);
      await cache.putRows('todos', [{ id: uid(1), server: row as never, view: row as never }]);
      const real = cache.allRows.bind(cache);
      vi.spyOn(cache, 'allRows').mockImplementation(async (table: string) => {
        const rows = await real(table);
        boot.switching = true;   // 读第一张表的期间 watchAccount 设了闸
        return rows as never;
      });
      const sync = wire(boot, isLeader);
      await vi.waitFor(() => expect(cache.allRows).toHaveBeenCalled());
      await flush(5);
      expect(cache.allRows).toHaveBeenCalledTimes(1);
      for (const t of cache.syncTables) expect(collection(t).getSnapshot(), `${t} 被灌回了旧账号的行`).toEqual([]);
      await sync?.stop();
    });
  }

  // 首屏判断放宽与推送认领核对审查 L1：另外两处补读（sync-wiring 收到别的标签页的消息、非主页回到前台整份重读）也带着闸
  for (const how of ['收到别的标签页“改了”的消息', '非主页回到前台整份重读'] as const) {
    it(`非主页：${how}，逐表读的途中设了换账号闸：不再读后面的表，刚读到的也不写回内存（L1）`, async () => {
      const { boot, cache } = await ready();
      const life = fakeLife(true);
      let onMessage!: (m: never) => void;
      const sync = wireSync(boot, {
        transport: fakeTransport(new FakeServer()),
        clearCacheStorage: () => Promise.resolve(),
        clearLocalSessionIf: () => Promise.resolve(true),
        goToAuth: () => undefined,
        setExitNotice: () => undefined,
        create: (b, o: SyncOptions) => createSync(b, { ...o, skipConfig: true, lifecycle: life }),
        leader: (o) => {
          onMessage = o.onMessage as never;
          return { isLeader: () => false, post: () => undefined, close: () => Promise.resolve() };
        },
        lifecycle: life,
      });
      // 先等启动那次补读读完
      const real = cache.allRows.bind(cache);
      const spy = vi.spyOn(cache, 'allRows');
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(cache.syncTables.length));
      await flush(5);
      // 库里多了一行（别的标签页写的）；这次补读读第一张表的期间 watchAccount 设了闸
      const row = todo(1);
      await cache.putRows('todos', [{ id: uid(1), server: row as never, view: row as never }]);
      spy.mockClear();
      spy.mockImplementation(async (table: string) => {
        const rows = await real(table);
        boot.switching = true;
        return rows as never;
      });
      if (how === '收到别的标签页“改了”的消息') onMessage({ type: 'changed', colls: null } as never);
      else {
        life.setVisible(false);
        life.setVisible(true);
      }
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      await flush(5);
      expect(spy, '设了闸以后还在读后面的表').toHaveBeenCalledTimes(1);
      expect(collection('todos').get(uid(1)), '设了闸以后还把读到的行写回了内存').toBeUndefined();
      await sync?.stop();
    });
  }
});
