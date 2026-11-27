// 服务器只写系统列（pushed_for、remind_at、defer_until）时 rev 不加（真库语义在 supabase/tests/rls/37_system_col_sync.test.sql），
// 本机合并（outbox.applyServer → outbox-rows.ts 的 applyServerRows）要照收同 rev 的新值：只跳过 rev 比本机旧的行。
// REMIND-shown-persist 方案第 3 节靠本机看得到服务器写的 pushed_for（11-05 后端补的钉子）；没确认的本机改动照旧叠在 view 上。
import { beforeEach, describe, expect, it } from 'vitest';
import { openCache, type ServerRow } from '../cache.ts';
import { createOutbox } from '../outbox.ts';
import { clearAllCollections } from '../store.ts';
import { fakeIndexedDB } from './idb-fake.ts';
import { clock, seed, uid } from './outbox-fixtures.ts';

const ev = { title: '全天', date: '2026-11-05', time: null, tz: null, remind_days: 0, remind_at: 1000, pushed_for: null, notified_for: null, defer_until: null };

async function setup() {
  const { factory } = fakeIndexedDB();
  const r = await openCache({ factory });
  if (!r.ok) throw new Error('open');
  let seq = 0;
  const outbox = createOutbox(r.cache, { appVersion: '4.0.0', now: () => clock.t, newOpId: () => `op-${++seq}` });
  await outbox.boot();
  return { cache: r.cache, outbox };
}

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});

describe('只改系统列的服务器行：同 rev 照收', () => {
  it('pushed_for、remind_at、defer_until 变了、rev 没变：server、view 都换成新值，不进 skipped', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'events', uid(1), ev, 5);
    const next = { ...ev, id: uid(1), rev: 5, pushed_for: 1000, remind_at: 2000, defer_until: 3000 } as ServerRow;
    expect(await outbox.applyServer('events', [{ row: next }])).toEqual({ skipped: [] });
    const row = await cache.getRow('events', uid(1));
    expect(row?.server).toMatchObject({ pushed_for: 1000, remind_at: 2000, defer_until: 3000, rev: 5 });
    expect(row?.view).toMatchObject({ pushed_for: 1000, remind_at: 2000, defer_until: 3000 });
  });

  it('resolve 把 pushed_for 置空（同 rev）：本机也变回空', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'events', uid(2), { ...ev, pushed_for: 1000 }, 5);
    await outbox.applyServer('events', [{ row: { ...ev, id: uid(2), rev: 5, pushed_for: null } as ServerRow }]);
    expect((await cache.getRow('events', uid(2)))?.view).toMatchObject({ pushed_for: null });
  });

  it('对照：rev 比本机旧的（晚到的 Realtime）照旧跳过，不拿旧 pushed_for 盖掉新的', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'events', uid(3), { ...ev, pushed_for: 1000 }, 5);
    expect(await outbox.applyServer('events', [{ row: { ...ev, id: uid(3), rev: 4, pushed_for: 999 } as ServerRow }])).toEqual({ skipped: [uid(3)] });
    expect((await cache.getRow('events', uid(3)))?.view).toMatchObject({ pushed_for: 1000 });
  });

  it('本机还有没确认的改动（改了标题）：系统列收下，view 照旧叠着本机的标题', async () => {
    const { cache, outbox } = await setup();
    await seed(cache, 'events', uid(4), ev, 5);
    await outbox.enqueue({ table: 'events', id: uid(4), op: 'patch', data: { title: '本机改的' } });
    await outbox.applyServer('events', [{ row: { ...ev, id: uid(4), rev: 5, pushed_for: 1000 } as ServerRow }]);
    const row = await cache.getRow('events', uid(4));
    expect(row?.server).toMatchObject({ pushed_for: 1000, title: '全天' });
    expect(row?.view).toMatchObject({ pushed_for: 1000, title: '本机改的' });
  });
});
