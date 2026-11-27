// P-idb-tx（B1 接手清单第 77 行 ①～④）：真浏览器（chromium、webkit）里的 IndexedDB 事务行为。
// K6 的单元测试用自写替身（src/core/__tests__/idb-fake.ts），下面几件只在真浏览器里算数：
//   ① core/cache.ts 的 tx()：fn 里在两次本事务请求之间 await（含异步包装多出来的微任务），事务不提前自动提交；
//   ② TC-B1-46：升级时迁移抛错，同一个 versionchange 事务里删掉重建 rebuildable 的仓，outbox、drafts、vault_drafts、pending_actions（和 owner）还在；
//   ③ TC-B1-48：别的标签页以更高 DB_VERSION 打开：本页 onversionchange 先跑“关库前”回调写草稿再关库，这期间写 outbox 被拒；
//      没监听的旧页挡住升级，关掉以后升级继续；
//   ④ TC-B1-49：低版本打开高版本库报 VersionError → { reason: 'version_too_new' }，不删库。
// ⑤（换账号清库后 outbox 为空）不在本文件，见 b1-account-switch.spec.ts。
// 往下走真启动、真 App 的两件也不在本文件（10-30）：TC-B1-46 迁移失败后的整表重拉见 b1-idb-boot.spec.ts，
// TC-B1-48 真 App 的 A 页自动重新载入见 b1-idb-reload.spec.ts（那里也写了横幅、blocked 提示在真页面上测不了的原因）。
//
// 测的是真代码：idb-tx-helpers.ts 在 Node 侧用 esbuild 把 src/core/cache.ts 打包注入页面（window.__cache），
// 用例调真的 openCache、Cache.tx、onBeforeVersionClose、runUpgrade（经 openCache 的 migrations 选项）；src 不改。
import type { Page } from '@playwright/test';
import { DB_VERSION } from '../../src/core/cache-migrations.ts';
import { expect, test } from './csp-fixture.ts';
import { blank, dbName, KEEP, REBUILD, SYNC } from './idb-tx-helpers.ts';

test('前提：仓结构里有不可重建的 outbox、drafts、vault_drafts、pending_actions', () => {
  expect(KEEP).toEqual(expect.arrayContaining(['outbox', 'drafts', 'vault_drafts', 'pending_actions']));
  expect(REBUILD).toContain('meta');
});

test('① Cache.tx()：fn 里在两次本事务请求之间 await，不提前提交；抛错整体回滚；await 定时器才会提前提交（对照组）', async ({ page }) => {
  await blank(page);
  const name = dbName('tx');
  const r = await page.evaluate(
    async ({ name, sync }) => {
      const M = window.__cache;
      const u = window.__u;
      if (!M || !u) throw new Error('helpers_missing');
      const o = await M.openCache({ name });
      if (!o.ok) throw new Error(`open_failed:${o.error}`);
      const c = o.cache;
      const out: Record<string, unknown> = {};

      // a) 一个事务里 60 次 await t.put（cache.ts 的 put 是异步包装，每次比裸请求多两层微任务），最后 getAll
      out.a = await c.tx([sync], 'readwrite', async (t) => {
        for (let i = 0; i < 60; i++) await t.put(sync, { id: `r${i}`, server: null, view: { n: i } });
        return (await t.getAll(sync)).length;
      });
      // a2) 真的 putRows（for 里逐个 await）
      await c.putRows(sync, Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, server: null, view: null })));
      out.a2 = (await c.allRows(sync)).length;

      // b) 跨仓读改写：读 → 一串纯微任务（await null、Promise.all、嵌套 async）→ 再写、删
      out.b = await c.tx(['meta', 'outbox', sync], 'readwrite', async (t) => {
        const before = await t.get('meta', 'cursor:x');
        for (let i = 0; i < 20; i++) await null;
        await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
        await t.put('meta', { key: 'cursor:x', value: { cursor: null, fullSyncAt: 1 } });
        const nested = async (): Promise<unknown> => {
          await null;
          await Promise.resolve();
          return t.get('meta', 'cursor:x');
        };
        const again = await nested();
        await t.put('outbox', { op_id: 'op1', rec: `${sync}:r1` });
        await t.delete(sync, 'r0');
        await t.put('meta', { key: 'cursor:x', value: { cursor: 'z', fullSyncAt: 2 } });
        return { before: before ?? null, again: again !== undefined };
      });
      out.bAfter = {
        meta: await c.getMeta('cursor:x'),
        outbox: (await c.tx(['outbox'], 'readonly', (t) => t.getAll('outbox'))).length,
        r0: (await c.getRow(sync, 'r0')) ?? null,
      };

      // c) fn 写了几笔以后抛错：整个事务回滚
      try {
        await c.tx(['outbox', 'drafts'], 'readwrite', async (t) => {
          await t.put('outbox', { op_id: 'op2', rec: 'x' });
          await t.put('drafts', { id: 'd1', kind: 'k', data: 1, updated_at: 1 });
          throw new Error('fn_failed');
        });
        out.c = 'no_error';
      } catch (e) {
        out.c = (e as Error).message;
      }
      out.cAfter = await u.counts(c);

      // d) 对照组：中间 await 定时器（宏任务）→ 事务已自动提交，下一个请求报错；定时器之前的写入已经落盘
      try {
        await c.tx(['drafts'], 'readwrite', async (t) => {
          await t.put('drafts', { id: 'before-timer', kind: 'k', data: 1, updated_at: 1 });
          await u.sleep(0);
          await t.put('drafts', { id: 'after-timer', kind: 'k', data: 1, updated_at: 1 });
        });
        out.d = 'no_error';
      } catch (e) {
        out.d = (e as Error).name;
      }
      out.dAfter = { before: (await c.getDraft('before-timer')) !== undefined, after: (await c.getDraft('after-timer')) !== undefined };
      c.close();
      await u.del(name);
      return out;
    },
    { name, sync: SYNC },
  );

  expect(r.a, 'a：60 次 await put 以后 getAll 全在').toBe(60);
  expect(r.a2, 'a2：putRows 60 行以后共 120 行').toBe(120);
  expect(r.b, 'b：微任务链之后仍能在同一事务里读').toEqual({ before: null, again: true });
  expect(r.bAfter).toEqual({ meta: { cursor: 'z', fullSyncAt: 2 }, outbox: 1, r0: null });
  expect(r.c).toBe('fn_failed');
  expect((r.cAfter as Record<string, number>).outbox, 'c：回滚后 outbox 只有 b 写的一条').toBe(1);
  expect((r.cAfter as Record<string, number>).drafts, 'c：回滚后 drafts 为空').toBe(0);
  // 事务已结束时 objectStore() 抛 InvalidStateError（两边实测都是它），还没结束但不活跃时请求抛 TransactionInactiveError；两种都说明已提前提交
  expect(r.d, 'd（对照）：await 定时器后事务已提交').toMatch(/^(TransactionInactiveError|InvalidStateError)$/);
  test.info().annotations.push({ type: '① 对照组错误名', description: String(r.d) });
  expect(r.dAfter, 'd（对照）：定时器之前那笔已提交、之后那笔没写进去').toEqual({ before: true, after: false });
});

for (const mode of ['up-throws', 'transform-fn-throws', 'transform-put-throws'] as const) {
  test(`② TC-B1-46 迁移失败（${mode}）：同一个 versionchange 事务里重建可重拉的仓，outbox、drafts、vault_drafts、pending_actions 还在`, async ({ page }) => {
    await blank(page);
    const name = dbName('mig');
    const r = await page.evaluate(
      async ({ name, sync, version, mode }) => {
        const M = window.__cache;
        const u = window.__u;
        if (!M || !u) throw new Error('helpers_missing');
        const first = await M.openCache({ name, version });
        if (!first.ok) throw new Error(`open_failed:${first.error}`);
        await u.seed(first.cache);
        const seeded = await u.counts(first.cache);
        first.cache.close();

        const to = version + 1;
        const o = await M.openCache({
          name,
          version: to,
          migrations: [
            {
              to,
              up(ctx) {
                if (mode === 'up-throws') throw new Error('boom');
                if (mode === 'transform-fn-throws') {
                  // 第一行改写成功（put 已排队），第二行抛错 → 在 getAll 的回调里 fail()，删掉还有挂起 put 的仓
                  ctx.transform(sync, (v) => {
                    if ((v as { id: string }).id === 'b') throw new Error('bad_row');
                    return { ...(v as object), migrated: true };
                  });
                  return;
                }
                // 改写出的值没有主键 → put 同步抛 DataError → fail()
                ctx.transform(sync, () => ({ no_key: true }));
              },
            },
          ],
        });
        if (!o.ok) return { ok: false as const, error: o.error };
        const c = o.cache;
        const after = await u.counts(c);
        const byRec = (await c.tx(['outbox'], 'readonly', (t) => t.getAllByIndex('outbox', 'rec', 'outbox:a'))).length;
        const draft = await c.getDraft('a');
        // 重建后的仓能正常写
        await c.putRows(sync, [{ id: 'new', server: null, view: null }]);
        await c.setMeta('schema_v', 1);
        c.close();
        await u.del(name);
        return { ok: true as const, seeded, after, report: o.upgrade, byRec, draft };
      },
      { name, sync: SYNC, version: DB_VERSION, mode },
    );

    expect(r.ok, `升级后库能打开（versionchange 事务没有中止）${r.ok ? '' : r.error}`).toBe(true);
    if (!r.ok) return;
    expect(r.report.from).toBe(DB_VERSION);
    expect(r.report.failed?.at).toBe(DB_VERSION + 1);
    expect(r.report.failed?.error).toBe(mode === 'transform-put-throws' ? 'DataError' : 'Error');
    expect([...r.report.rebuilt].sort()).toEqual(REBUILD);
    for (const n of REBUILD) expect(r.after[n], `${n} 重建后为空`).toBe(0);
    for (const n of KEEP) {
      expect(r.seeded[n], `${n} 升级前写了 2 行`).toBe(2);
      expect(r.after[n], `${n} 原样保留`).toBe(2);
    }
    expect(r.byRec, 'outbox 的 rec 索引还能查').toBe(1);
    expect(r.draft).toEqual({ id: 'a', payload: 'drafts:a' });
  });
}

/** ③ 里 A 页：真 openCache，登记“关库前”回调（先试写 outbox，再写草稿）和 onClosed */
async function openCooperative(page: Page, name: string): Promise<void> {
  await page.evaluate(async (name) => {
    const M = window.__cache;
    const t0 = window.__t;
    if (!M || !t0) throw new Error('helpers_missing');
    const log: string[] = [];
    t0.log = log;
    const o = await M.openCache({ name });
    if (!o.ok) throw new Error(`open_failed:${o.error}`);
    const c = o.cache;
    c.onBeforeVersionClose(async () => {
      log.push(`closing:${String(c.isClosed())}`);
      try {
        await c.tx(['outbox'], 'readwrite', (t) => t.put('outbox', { op_id: 'late', rec: 'x' }));
        log.push('outbox-written');
      } catch (e) {
        log.push(`outbox-rejected:${(e as Error).name}`);
      }
      try {
        await c.putDraft({ id: 'editing', kind: 'note-edit', data: '编辑中的内容', updated_at: Date.now() });
        log.push('draft-written');
      } catch (e) {
        log.push(`draft-failed:${(e as Error).name}`);
      }
    });
    c.onClosed((reason) => log.push(`closed:${reason}`));
  }, name);
}

/** ③ 里 C 页：真 openCache 以更高版本打开，不 await；结果和 blocked 次数记在 window.__t */
async function startUpgrade(page: Page, name: string): Promise<void> {
  await page.evaluate(
    ({ name, version }) => {
      const M = window.__cache;
      const t0 = window.__t;
      if (!M || !t0) throw new Error('helpers_missing');
      t0.blocked = 0;
      t0.result = null;
      void M.openCache({
        name,
        version: version + 1,
        onBlocked: () => {
          t0.blocked = (t0.blocked as number) + 1;
        },
      }).then(async (o) => {
        if (!o.ok) {
          t0.result = { ok: false, error: o.error };
          return;
        }
        const draft = await o.cache.getDraft('editing');
        const late = await o.cache.tx(['outbox'], 'readonly', (t) => t.get('outbox', 'late'));
        t0.result = { ok: true, version: o.cache.version, draft: draft?.data ?? null, lateOutbox: late !== undefined };
        o.cache.close();
      });
    },
    { name, version: DB_VERSION },
  );
}

const readT = (page: Page, key: string): Promise<unknown> => page.evaluate((k) => window.__t?.[k] ?? null, key);
const A_LOG = ['closing:true', 'outbox-rejected:CacheClosedError', 'draft-written', 'closed:versionchange'];
const UPGRADED = { ok: true, version: DB_VERSION + 1, draft: '编辑中的内容', lateOutbox: false };

test('③a TC-B1-48：只有监听的页时，关库前写 outbox 被拒、写草稿成功，再关库；升级方打开成功、读得到草稿（记录 blocked 次数）', async ({ page, context }) => {
  await blank(page);
  const name = dbName('vc1');
  await openCooperative(page, name);
  const c = await context.newPage();
  await blank(c);
  await startUpgrade(c, name);

  await expect.poll(() => readT(c, 'result'), { timeout: 10_000 }).not.toBeNull();
  expect(await readT(c, 'result')).toEqual(UPGRADED);
  expect(await readT(page, 'log')).toEqual(A_LOG);
  // 已知现象（报告给前端 A）：A 页关库在异步写草稿之后，升级方照样收到 blocked
  test.info().annotations.push({ type: '③a blocked 次数', description: String(await readT(c, 'blocked')) });
  await c.evaluate((n) => window.__u?.del(n), name);
});

test('③b TC-B1-48：再加一个没监听的旧页 → A 页关库后升级仍挂着；旧页关掉以后升级继续，草稿还在', async ({ page, context }) => {
  await blank(page);
  const name = dbName('vc2');
  await openCooperative(page, name);

  const old = await context.newPage();
  await blank(old);
  // 旧页：原生打开、不设 onversionchange（模拟没有这段监听的旧版本页面）
  await old.evaluate(
    (name) =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => {
          if (window.__t) window.__t.db = r.result;
          resolve();
        };
        r.onerror = () => reject(new Error(String(r.error)));
      }),
    name,
  );

  const c = await context.newPage();
  await blank(c);
  await startUpgrade(c, name);

  // A 页照样先写草稿再关库
  await expect.poll(() => readT(page, 'log'), { timeout: 10_000 }).toEqual(A_LOG);
  // A 页已关，只剩旧页开着：升级一直挂着，说明挡住它的是旧页
  await c.waitForTimeout(800);
  expect(await readT(c, 'result')).toBeNull();
  test.info().annotations.push({ type: '③b blocked 次数', description: String(await readT(c, 'blocked')) });

  await old.close();   // 用户关掉旧标签页
  await expect.poll(() => readT(c, 'result'), { timeout: 10_000 }).not.toBeNull();
  expect(await readT(c, 'result')).toEqual(UPGRADED);
  await c.evaluate((n) => window.__u?.del(n), name);
});

test('④ TC-B1-49：低版本打开高版本库 → VersionError 映射成 version_too_new，不删库、数据原样', async ({ page }) => {
  await blank(page);
  const name = dbName('ver');
  const r = await page.evaluate(
    async ({ name, version }) => {
      const M = window.__cache;
      const u = window.__u;
      if (!M || !u) throw new Error('helpers_missing');
      const high = version + 98;
      const h = await M.openCache({ name, version: high });
      if (!h.ok) throw new Error(`open_failed:${h.error}`);
      await u.seed(h.cache);
      const seeded = await u.counts(h.cache);
      h.cache.close();

      let blocked = false;
      const low = await M.openCache({
        name,
        onBlocked: () => {
          blocked = true;
        },
      });
      if (low.ok) low.cache.close();
      const res = low.ok ? { ok: true } : { ok: false, reason: low.reason, error: low.error };

      const v = await new Promise<number>((resolve, reject) => {
        const rq = indexedDB.open(name);
        rq.onsuccess = () => {
          resolve(rq.result.version);
          rq.result.close();
        };
        rq.onerror = () => reject(new Error(String(rq.error)));
      });
      const again = await M.openCache({ name, version: high });
      if (!again.ok) throw new Error(`reopen_failed:${again.error}`);
      const after = await u.counts(again.cache);
      again.cache.close();
      const listed = typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).some((d) => d.name === name) : 'unsupported';
      await u.del(name);
      return { res, blocked, seeded, after, v, high, listed };
    },
    { name, version: DB_VERSION },
  );

  expect(r.res).toEqual({ ok: false, reason: 'version_too_new', error: 'VersionError' });
  expect(r.blocked).toBe(false);
  expect(r.v).toBe(r.high);
  expect(r.after).toEqual(r.seeded);
  expect(r.listed).not.toBe(false);
});
