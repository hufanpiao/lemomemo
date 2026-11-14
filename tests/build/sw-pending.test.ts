// SW 写 pending_actions 的行为（K-sw-seal 三条，src/sw/pending.ts；B2 任务单 FA-1，第一天派工表第 9 行）
// 用 core 的假 IndexedDB（src/core/__tests__/idb-fake.ts）跑真实的开库、升级、删库流程：
//   ⑴ 库不存在不建库；owner 没记录、不一致一律不写；一致才写
//   ⑵ SW 开着连接时页面删库、升级不被挡住（onversionchange 立刻 close）；写完立刻关
//   常量和 core 一侧（cache.ts、cache-schema.ts、account.ts）是同一组值
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { claimCache } from '../../src/core/account.ts';
import { DB_NAME as CORE_DB_NAME, deleteCacheDb, openCache, type Cache } from '../../src/core/cache.ts';
import { OWNER, PENDING_ACTIONS } from '../../src/core/cache-schema.ts';
import { fakeIndexedDB, flush, nextDbVersion } from '../../src/core/__tests__/idb-fake.ts';
import { DB_NAME, OWNER_KEY, OWNER_STORE, PENDING_STORE, writePendingAction, type SwPendingAction } from '../../src/sw/pending.ts';

const UID_A = '11111111-1111-4111-8111-111111111111';
const UID_B = '22222222-2222-4222-8222-222222222222';
const ROW = '33333333-3333-4333-8333-333333333333';

const rec = (user_id = UID_A, id = 'p1'): SwPendingAction => ({
  id,
  user_id,
  row_table: 'events',
  row_id: ROW,
  action: { type: 'snooze', minutes: 10, due_at: 1_800_000_000_000 },
  created_at: 1_800_000_000_500,
});

async function cacheWithOwner(factory: IDBFactory, uid: string | null): Promise<Cache> {
  const r = await openCache({ factory });
  if (!r.ok) throw new Error(`openCache 失败：${r.reason}`);
  if (uid) await claimCache(r.cache, uid);
  return r.cache;
}

const pendingOf = (cache: Cache) => cache.tx([PENDING_ACTIONS], 'readonly', (t) => t.getAll<SwPendingAction>(PENDING_ACTIONS));

describe('常量和 core 一致（SW 不准引 core，A19，只能靠这里核对）', () => {
  it('库名、仓名、owner 的键', () => {
    expect(DB_NAME).toBe(CORE_DB_NAME);
    expect(PENDING_STORE).toBe(PENDING_ACTIONS);
    expect(OWNER_STORE).toBe(OWNER);
    // account.ts 的 OWNER_KEY 没导出：读源码核对
    expect(readFileSync('src/core/account.ts', 'utf8')).toContain(`const OWNER_KEY = '${OWNER_KEY}';`);
  });

  it('SwPendingAction 的字段和 core 的 PendingAction 对得上（0.29 续第 107 条②）', () => {
    const core = readFileSync('src/core/outbox-types.ts', 'utf8');
    for (const f of ['id', 'user_id', 'row_table', 'row_id', 'action', 'created_at']) expect(Object.keys(rec())).toContain(f);
    for (const f of ['user_id: string', 'row_table: string', 'row_id: string', 'created_at: number']) expect(core).toContain(f);
  });
});

describe('writePendingAction（K-sw-seal ⑴）', () => {
  it('本机没有库：返回 no_db，不留下新建的库', async () => {
    const { factory, fake } = fakeIndexedDB();
    expect(await writePendingAction(factory, rec())).toBe('no_db');
    await flush();
    const d = fake.dbs.get(DB_NAME);
    // 真浏览器里中止首次升级会把库删掉；替身留一个空壳（version 0、没有仓），两者都等于“没建库”
    expect(d === undefined || (d.version === 0 && d.stores.size === 0)).toBe(true);
    // 之后页面照常建库，不受影响
    const cache = await cacheWithOwner(factory, UID_A);
    expect(await pendingOf(cache)).toEqual([]);
    cache.close();
  });

  it('owner 没记录（建了库还没认领账号）：no_owner，不写', async () => {
    const { factory } = fakeIndexedDB();
    const cache = await cacheWithOwner(factory, null);
    expect(await writePendingAction(factory, rec())).toBe('no_owner');
    expect(await pendingOf(cache)).toEqual([]);
    cache.close();
  });

  it('库里没有 owner / pending_actions 仓（别的程序建的同名库）：no_owner', async () => {
    const { factory } = fakeIndexedDB();
    await new Promise<void>((resolve) => {
      const r = factory.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('meta', { keyPath: 'key' });
      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
    });
    expect(await writePendingAction(factory, rec())).toBe('no_owner');
  });

  it('推送的 user_id 和库的 owner 不一致：owner_mismatch，丢掉，不拿 owner 去填', async () => {
    const { factory } = fakeIndexedDB();
    const cache = await cacheWithOwner(factory, UID_B);
    expect(await writePendingAction(factory, rec(UID_A))).toBe('owner_mismatch');
    expect(await pendingOf(cache)).toEqual([]);
    cache.close();
  });

  it('一致：写进去，内容原样（不含标题、正文）', async () => {
    const { factory } = fakeIndexedDB();
    const cache = await cacheWithOwner(factory, UID_A);
    expect(await writePendingAction(factory, rec(UID_A, 'p1'))).toBe('ok');
    expect(await writePendingAction(factory, rec(UID_A, 'p2'))).toBe('ok');
    const rows = await pendingOf(cache);
    expect(rows.map((r) => r.id).sort()).toEqual(['p1', 'p2']);
    expect(rows[0]).toEqual(rec(UID_A, rows[0]!.id));
    cache.close();
  });
});

describe('不挡页面删库、升级（K-sw-seal ⑵）', () => {
  it('每次写完都关连接：之后删库不触发 blocked', async () => {
    const { factory, fake } = fakeIndexedDB();
    const cache = await cacheWithOwner(factory, UID_A);
    expect(await writePendingAction(factory, rec())).toBe('ok');
    cache.close();
    const data = fake.dbs.get(DB_NAME)!;
    expect([...data.connections].filter((c) => !c.closed)).toEqual([]);
    const r = await deleteCacheDb({ factory });
    expect(r).toBe('deleted');
    expect(fake.dbs.has(DB_NAME)).toBe(false);
  });

  it('SW 的连接还开着时页面删库：SW 收到 versionchange 立刻让开，删库照常完成', async () => {
    const { factory, fake } = fakeIndexedDB();
    const cache = await cacheWithOwner(factory, UID_A);
    cache.close();
    // 拦下 SW 开库：在它刚拿到连接、还没开始事务时插一个删库
    const realOpen = fake.open.bind(fake);
    type Conn = { closed: boolean; onversionchange: unknown; close(): void };
    let swDb: Conn | null = null;
    let handler: unknown = null;
    let del: Promise<unknown> | null = null;
    fake.open = (name: string, version?: number) => {
      const req = realOpen(name, version);
      const hook = (): void => {
        const orig = req.onsuccess;
        req.onsuccess = (e) => {
          swDb = req.result as unknown as Conn;
          del = deleteCacheDb({ factory });
          orig?.(e);
          // 开库成功的同一拍里就要挂上（⑵），不能等到事务开始以后
          handler = swDb.onversionchange;
        };
      };
      queueMicrotask(hook);
      return req;
    };
    const res = await writePendingAction(factory, rec());
    expect(await del).toBe('deleted');
    await flush();
    expect(['ok', 'failed', 'no_owner']).toContain(res);
    expect(swDb).not.toBeNull();
    expect(swDb!.closed).toBe(true);
    expect(fake.dbs.has(DB_NAME)).toBe(false);
    // 光靠 finally 里的 close 也能让删库最终完成；这里单独核对“收到 versionchange 就关”这一条本身
    expect(typeof handler).toBe('function');
    expect(String(handler)).toContain('.close()');
  });

  it('SW 的事务还没做完时页面删库：收到 versionchange 当场关连接，删库不报 blocked（代码审查 S3：去掉 onversionchange 这条会失败）', async () => {
    const { factory, fake } = fakeIndexedDB();
    const cache = await cacheWithOwner(factory, UID_A);
    cache.close();
    const realOpen = fake.open.bind(fake);
    const blocked = vi.fn();
    let del: Promise<string> | null = null;
    fake.open = (name: string, version?: number) => {
      const req = realOpen(name, version);
      queueMicrotask(() => {
        const orig = req.onsuccess;
        req.onsuccess = (e) => {
          orig?.(e);
          // SW 刚拿到连接、写事务正要开始：页面这时删库（同步发起，排在 SW 的读写前面）
          del = new Promise((resolve) => {
            const d = fake.deleteDatabase(name);
            d.onblocked = blocked;
            d.onsuccess = () => resolve('deleted');
            d.onerror = () => resolve('error');
          });
        };
      });
      return req;
    };
    const res = await writePendingAction(factory, rec());
    expect(await del).toBe('deleted');
    expect(blocked).not.toHaveBeenCalled();
    // 关连接要等进行中的事务做完（真浏览器同样如此），这一次照样写成；之后库被删掉
    expect(res).toBe('ok');
    expect(fake.dbs.has(DB_NAME)).toBe(false);
  });

  it('SW 开着连接时页面升级到新版本：升级不被挡住', async () => {
    const { factory } = fakeIndexedDB();
    const cache = await cacheWithOwner(factory, UID_A);
    cache.close();
    const write = writePendingAction(factory, rec());
    const up = openCache({ factory, ...nextDbVersion() });
    const [w, u] = await Promise.all([write, up]);
    expect(['ok', 'failed']).toContain(w);
    expect(u.ok).toBe(true);
    if (u.ok) u.cache.close();
  });
});

describe('“只打开、不新建”的开库只有一份（第三方审查第 11 条）', () => {
  it('SW 的 pending.ts 和登录页的 local-outbox.ts 都用 shared/idb-open-existing.ts，自己不再写升级中止', () => {
    for (const f of ['src/sw/pending.ts', 'src/platform/local-outbox.ts']) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
      expect(src, f).toContain("shared/idb-open-existing.ts';");
      expect(src, f).not.toContain('onupgradeneeded');
    }
  });

  it('开库 2 秒没回音（浏览器卡住）：SW 按没有库处理，不一直等', async () => {
    vi.useFakeTimers();
    try {
      const never = { open: () => ({}) } as unknown as IDBFactory;
      const p = writePendingAction(never, { id: 'x', user_id: 'u', row_table: 'todos', row_id: 'r', action: { type: 'done', due_at: 1 }, created_at: 1 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await p).toBe('no_db');
    } finally {
      vi.useRealTimers();
    }
  });
});
