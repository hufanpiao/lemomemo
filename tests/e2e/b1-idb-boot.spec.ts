// P-idb-tx 余项（B1 接手清单 P-idb-tx“还没测”的第一件，10-30）：TC-B1-46 迁移失败之后的整表重拉，真浏览器（chromium、webkit）。
// b1-idb-tx.spec.ts 的 ② 只验证到“可重拉的仓重建、不可重建的仓还在”这一层；这里接着往下走真的启动和同步：
//   ① 先按当前 DB_VERSION 建库：owner 记好账号、meta 记好 schema_v 和每张同步表的游标（刚整表同步过）——正常启动只该增量拉；
//   ② 真 coldStart（src/core/boot.ts）以 DB_VERSION + 1 打开，经 cacheOptions 传一个会抛错的迁移 → upgradeReport.failed、
//      boot.fullResync = 全部同步表；outbox 里那一条还在；
//   ③ 真 createSync（src/core/sync/engine.ts）配一个只记请求的假传输层跑 syncNow：每张同步表的 pullRows 都是 since = null（整表）。
// 对照组：同样建库、不升级（没有迁移）→ fullResync 为空，pullRows 带着游标增量拉（since 不为空）——说明上面的整表是迁移失败引起的。
// 测的是真代码：idb-tx-helpers.ts 的 bootBlank 在 Node 侧用 esbuild 把 boot.ts、engine.ts 打包注入同源空白页；src 不改。
// 不碰真实的 planner-v4：每条用例自己的库名，结束删库。
import type { Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { bootBlank, dbName } from './idb-tx-helpers.ts';

interface Outcome {
  status: string;
  failed: boolean;
  fullResync: string[];
  syncTables: string[];
  pulls: { table: string; since: string | null }[];
  outboxKept: number;
}

/** 在页面里：建库 → （可选）带抛错的迁移重开 → 冷启动 → 同步一轮；回结果 */
async function run(page: Page, name: string, failMigration: boolean): Promise<Outcome> {
  return page.evaluate(
    async ({ name, failMigration }) => {
      const B = window.__boot;
      if (!B) throw new Error('boot_missing');
      const USER = 'u-e2e-idb-boot';
      const CURSOR = '2026-10-01T00:00:00.000Z';

      // ① 建库（当前版本）：owner、schema_v、各表游标；outbox 放一条（不可重建，迁移失败后要还在）
      const first = await B.openCache({ name });
      if (!first.ok) throw new Error(`open_failed:${first.error}`);
      const c0 = first.cache;
      await c0.tx([B.OWNER], 'readwrite', (t) => t.put(B.OWNER, { key: 'user_id', value: USER }));
      await c0.setMeta('schema_v', B.SCHEMA_V);
      for (const table of c0.syncTables) await c0.setMeta(`cursor:${table}`, { cursor: CURSOR, fullSyncAt: Date.now() });
      await c0.tx(['outbox'], 'readwrite', (t) =>
        t.put('outbox', {
          op_id: 'op-keep', table: c0.syncTables[0], id: 'r1', rec: `${c0.syncTables[0]}:r1`, op: 'patch', data: { title: 'x' },
          base_rev: 1, own_revs: [], client_ts: 0, tries: 0, next_at: Number.MAX_SAFE_INTEGER, state: 'pending', v: 1, app: '0.0.0-e2e',
          seq: 1, remind: false, deps: [], error: null,
        }),
      );
      const syncTables = [...c0.syncTables];
      c0.close();

      // ② 真 coldStart：迁移失败组以 DB_VERSION + 1 打开、迁移抛错；对照组照常打开
      const to = B.DB_VERSION + 1;
      const boot = await B.coldStart({
        userId: USER,
        listen426: false,
        clearCacheStorage: async () => undefined,
        cacheOptions: failMigration
          ? { name, version: to, migrations: [{ to, up() { throw new Error('boom'); } }] }
          : { name },
      });

      // ③ 真同步引擎 + 只记请求的假传输层（不联网）；同步一轮
      const pulls: { table: string; since: string | null }[] = [];
      const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
      const sync = B.createSync(boot, {
        skipConfig: true,
        onRemoved: () => undefined,
        transport: {
          ensureSession: () => Promise.resolve('ok' as const),
          refreshSession: () => Promise.resolve('ok' as const),
          sessionId: () => 'sid-e2e',
          insertRow: () => ok({ rev: 1 }),
          applyPatch: () => Promise.resolve({ ok: false as const, error: { network: true } as never }),
          pullRows: (table, q) => {
            pulls.push({ table, since: q.since });
            return ok([]);
          },
          fetchByIds: () => ok([]),
          pullTombstones: () => ok([]),
          subscribe: () => () => undefined,
          fetchConfig: () => Promise.resolve({ ok: false as const, error: { network: true } as never }),
          reportTz: () => Promise.resolve({ ok: false as const, error: { network: true } as never }),
        },
      });
      await sync.syncNow();
      await sync.idle();
      sync.stop();

      const outboxKept = boot.cache
        ? (await boot.cache.tx(['outbox'], 'readonly', (t) => t.getAll('outbox'))).filter((i) => (i as { op_id?: string }).op_id === 'op-keep').length
        : -1;
      const out = {
        status: boot.status,
        failed: boot.upgradeReport?.failed != null,
        fullResync: [...boot.fullResync].sort(),
        syncTables: syncTables.sort(),
        pulls,
        outboxKept,
      };
      boot.cache?.close();
      await new Promise<void>((res) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = () => res();
      });
      return out;
    },
    { name, failMigration },
  );
}

test('TC-B1-46 整表重拉：迁移抛错 → boot.fullResync 是全部同步表，同步引擎对每张表都整表拉（since = null）；outbox 那一条还在', async ({ page }) => {
  await bootBlank(page);
  const r = await run(page, dbName('boot-mig'), true);
  expect(r.status).toBe('ready');
  expect(r.failed, 'upgradeReport.failed').toBe(true);
  expect(r.syncTables.length).toBeGreaterThan(0);
  expect(r.fullResync).toEqual(r.syncTables);
  expect(r.outboxKept, '不可重建的 outbox 里那一条还在').toBe(1);
  // 每张同步表都拉过，而且都是整表（游标在迁移失败时随 meta 一起重建掉了，boot 也把它们放进 fullResync）
  const pulled = [...new Set(r.pulls.map((p) => p.table))].sort();
  expect(pulled).toEqual(r.syncTables);
  expect(r.pulls.filter((p) => p.since !== null), '不该有增量拉取').toEqual([]);
});

test('TC-B1-46 对照：不升级、没有迁移 → fullResync 为空，同步引擎按游标增量拉（since 不为空）', async ({ page }) => {
  await bootBlank(page);
  const r = await run(page, dbName('boot-ok'), false);
  expect(r.status).toBe('ready');
  expect(r.failed).toBe(false);
  expect(r.fullResync).toEqual([]);
  expect(r.outboxKept).toBe(1);
  const pulled = [...new Set(r.pulls.map((p) => p.table))].sort();
  expect(pulled).toEqual(r.syncTables);
  expect(r.pulls.filter((p) => p.since === null), '对照组不该整表拉').toEqual([]);
});
