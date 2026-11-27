// account 的 store 调用超时（架构 0.47 第 22 条；安全复核 T1～T3；TC-B1-138 ②④）。
// 桩 store 在指定的方法上永不返回（可选“先做完再不返回”，模拟语句已提交、回应丢了），外面套和 index.ts 一样的 withStoreTimeouts，
// 只把超时档换成几十毫秒。另有 T2：part 取片前查 logs 的发起记录。
import { describe, expect, it, vi } from 'vitest';
import {
  type AccountStore, encodeCursor, EXPORT_LIMITS, keys, STORE_SIZE_TIMEOUT_MS, STORE_TIMEOUT_MS, StoreTimeout, withStoreTimeouts,
} from '../../supabase/functions/account/core.ts';
import { A, accountSetup, callAccount, type FakeDb } from './account-fakes.ts';
import { part, start, TABLES } from './account-export-harness.ts';

const EID = 'eeeeeeee-0000-4000-8000-0000000000e1';
const SESSION = `${A.slice(0, 8)}-s1`;
const MS = 20;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** hang 返回 'before'：不调底下直接永不返回；'after'：底下照做（写进库）再永不返回；false：照常 */
type Hang = (m: string, args: unknown[]) => 'before' | 'after' | false;

function hangingStore(db: FakeDb, hang: Hang, calls: string[] = []): AccountStore {
  const base = db.accountStore() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return Object.fromEntries(Object.entries(base).map(([m, fn]) => [m, async (...a: unknown[]) => {
    calls.push(m);
    const h = hang(m, a);
    if (h === 'after') await fn(...a);
    if (h) return new Promise(() => {});
    return fn(...a);
  }])) as unknown as AccountStore;
}

/** 和 index.ts 一样套超时，只是档位换小；log 收集函数日志 */
function setup(hang: Hang) {
  const { db, box } = accountSetup();
  const logs: string[] = [];
  const calls: string[] = [];
  const store = withStoreTimeouts(() => hangingStore(db, hang, calls), { ms: MS, sizeMs: MS * 3, log: (c) => logs.push(c) });
  const over = { store, log: (c: string) => logs.push(c), newId: () => EID };
  return { db, box, logs, calls, over };
}

const jobRows = (db: FakeDb) => [...db.counters.keys()].filter((k) => k.startsWith('export-job:'));
const exportLogs = (db: FakeDb) => db.logs.filter((l) => l.act === 'export');
const isAct = (act: string) => (m: string, a: unknown[]) => m === 'insertLog' && (a[1] as { act?: string }).act === act;
const keyStarts = (p: string) => (m: string, a: unknown[]) => m === 'takeRate' && String(a[0]).startsWith(p);

describe('withStoreTimeouts（0.47 第 22 条）', () => {
  it('档位：默认 10 秒，export_size_over 20 秒（大于它自己的 15 秒预算）；包住 AccountStore 的全部方法', () => {
    expect(STORE_TIMEOUT_MS).toBe(10_000);
    expect(STORE_SIZE_TIMEOUT_MS).toBe(20_000);
    expect(STORE_SIZE_TIMEOUT_MS).toBeGreaterThan(EXPORT_LIMITS.sizeCheckBudgetMs);
    const { db } = accountSetup();
    expect(Object.keys(withStoreTimeouts(() => db.accountStore())).sort()).toEqual(Object.keys(db.accountStore()).sort());
  });

  it('永不返回：到点抛 StoreTimeout、abort 交下去的 signal；日志只有 store_timeout:<方法名>，不带参数（T3）', async () => {
    const signals: AbortSignal[] = [];
    const logs: string[] = [];
    const { db } = accountSetup();
    const s = withStoreTimeouts((sig) => { signals.push(sig); return hangingStore(db, () => 'before'); }, { ms: MS, log: (c) => logs.push(c) });
    const e = await s.takeRate(keys.account(A, 0), 3, 86400).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreTimeout);
    expect((e as StoreTimeout).method).toBe('takeRate');
    expect((e as Error).message).toBe('store_timeout');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(logs).toEqual(['store_timeout:takeRate']);
    expect(logs.join(' ')).not.toMatch(UUID_ANY);
  });

  it('成功、出错路径都清掉计时器（代码审查：不留挂着的 setTimeout）', async () => {
    vi.useFakeTimers();
    try {
      const { db } = accountSetup();
      const s = withStoreTimeouts(() => ({ ...db.accountStore(), isAdmin: async () => { throw new Error('boom'); } }), { ms: MS });
      expect(await s.peekRate(keys.account(A, 0))).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(s.isAdmin(A)).rejects.toThrow('boom');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('按时返回的结果、抛的错原样交出；export_size_over 走慢档（比默认档慢也不超时）', async () => {
    const { db } = accountSetup();
    const slowly = (ms: number, v: unknown) => new Promise((r) => setTimeout(() => r(v), ms));
    const s = withStoreTimeouts(() => ({
      ...db.accountStore(),
      exportSizeOver: async () => slowly(MS * 2, 123) as Promise<number>,
      peekRate: async () => slowly(MS * 2, 1) as Promise<number>,
      isAdmin: async () => { throw new Error('boom'); },
    }), { ms: MS, sizeMs: MS * 5 });
    expect(await s.exportSizeOver(A, 'omitted', 1, 1)).toBe(123);
    await expect(s.peekRate('k')).rejects.toBeInstanceOf(StoreTimeout);
    await expect(s.isAdmin(A)).rejects.toThrow('boom');
  });
});

describe('start 超时（TC-B1-138 ②④；0.47 第 22 条、T1）', () => {
  it.each([
    ['② export_job_start 挂起（语句没落库）', (m: string) => (m === 'exportJobStart' ? 'before' : false)],
    ['② export_job_start 挂起（语句已落库、回应丢了）', (m: string) => (m === 'exportJobStart' ? 'after' : false)],
    ['④ 写 logs export 挂起', (m: string, a: unknown[]) => (isAct('export')(m, a) ? 'before' : false)],
  ] as const)('%s：try_later；export-refund +1、account 回到原值；不留任务行、没有 export 记录、不发信；拿这个 id 取片 410', async (_n, hang) => {
    const t = setup(hang as Hang);
    const r = await start(t.db, t.box, {}, t.over);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'try_later' });
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(0);
    expect(t.db.count(keys.exportRefund(A, t.db.clock.ms))).toBe(1);
    expect(jobRows(t.db)).toEqual([]);
    expect(exportLogs(t.db)).toEqual([]);
    expect(t.box).toEqual([]);
    expect(t.logs.some((c) => /^store_timeout:(exportJobStart|insertLog)$/.test(c))).toBe(true);
    expect(t.logs.join(' ')).not.toMatch(UUID_ANY);
    const p = await part(t.db, t.box, EID, null, { log: () => {} });
    expect(p.status).toBe(410);
    expect(t.db.pageReads).toEqual([]);
  });

  it('挂起超时和直接报错，回应一字不差（TC-B1-138“挂起超时的两档结果和报错相同”）', async () => {
    const hung = setup((m) => (m === 'exportJobStart' ? 'before' : false));
    const a = await start(hung.db, hung.box, {}, hung.over);
    const failed = setup(() => false);
    failed.db.fail.add('exportJobStart');
    const b = await start(failed.db, failed.box, {}, failed.over);
    expect([a.status, await a.text(), a.headers.get('cache-control')]).toEqual([b.status, await b.text(), b.headers.get('cache-control')]);
  });

  it('T1：扣当天次数那一步卡住（已扣上、回应丢了）：try_later，不调退回、不扣 export-refund，也不建任务', async () => {
    const t = setup((m, a) => (keyStarts('account:')(m, a) ? 'after' : false));
    const r = await start(t.db, t.box, {}, t.over);
    expect(r.status).toBe(503);
    expect(t.calls).not.toContain('refundRate');
    expect(t.calls).not.toContain('exportJobStart');
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(1);   // 白占一次，接受（T1）
    expect(t.db.count(keys.exportRefund(A, t.db.clock.ms))).toBe(0);
    expect(t.logs).toEqual(['store_timeout:takeRate']);   // 只有方法名，不另记 db_error
  });

  it('T1：退回前扣 export-refund 那一步卡住：当作“不退”，照样 try_later、删掉任务行', async () => {
    const t = setup((m, a) => (isAct('export')(m, a) ? 'before' : keyStarts('export-refund:')(m, a) ? 'after' : false));
    const r = await start(t.db, t.box, {}, t.over);
    expect(r.status).toBe(503);
    expect(t.calls).not.toContain('refundRate');
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(1);
    expect(jobRows(t.db)).toEqual([]);
    expect(t.logs).toContain('export_refund_failed');
  });

  it('退回本身卡住：只记日志，照样 try_later', async () => {
    const t = setup((m, a) => (isAct('export')(m, a) ? 'before' : m === 'refundRate' ? 'before' : false));
    const r = await start(t.db, t.box, {}, t.over);
    expect(r.status).toBe(503);
    expect(t.logs).toEqual(expect.arrayContaining(['store_timeout:insertLog', 'store_timeout:refundRate', 'export_refund_failed']));
  });

  it('扣次数之前卡住（只读查次数、预检限流、预检）：直接 try_later，不扣当天次数、不调退回', async () => {
    for (const hang of [
      (m: string) => (m === 'peekRate' ? 'before' : false),
      (m: string, a: unknown[]) => (keyStarts('export-size:')(m, a) ? 'after' : false),
      (m: string) => (m === 'exportSizeOver' ? 'before' : false),
    ] as Hang[]) {
      const t = setup(hang);
      const r = await start(t.db, t.box, {}, t.over);
      expect(r.status).toBe(503);
      expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(0);
      expect(t.calls).not.toContain('refundRate');
      expect(t.calls).not.toContain('exportJobStart');
    }
  });

  it('预检 -2（别人在预检）时退回 export-size 卡住：只记日志，回 try_later', async () => {
    const t = setup((m) => (m === 'refundRate' ? 'before' : false));
    t.db.sizeResult = -2;
    const r = await start(t.db, t.box, {}, t.over);
    expect(r.status).toBe(503);
    expect(t.logs).toEqual(expect.arrayContaining(['store_timeout:refundRate', 'export_size_refund_failed']));
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(0);
  });
});

describe('part 超时、发起记录（0.47 第 22 条、T2）', () => {
  /** 正常 start 一次，返回 export_id（用不卡的 store） */
  async function started(db: FakeDb, box: Parameters<typeof start>[1]) {
    const r = await start(db, box, {}, { newId: () => EID });
    expect(r.status).toBe(200);
    return EID;
  }

  it.each(['exportJobTake', 'readPage', 'exportStarted'])('%s 卡住：try_later，已扣的分片数、已占的片数都不退；放开后同一游标照常取到', async (m) => {
    const t = setup((x) => (x === m ? 'before' : false));
    await started(t.db, t.box);
    const r = await part(t.db, t.box, EID, null, t.over);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'try_later' });
    expect(t.db.count(keys.exportPart(A, t.db.clock.ms))).toBe(1);
    expect(t.logs).toEqual([`store_timeout:${m}`]);
    const again = await part(t.db, t.box, EID, null, { log: () => {} });
    expect(again.status).toBe(200);
    expect(t.db.count(keys.exportPart(A, t.db.clock.ms))).toBe(2);
  });

  it('T2：任务行在、logs 里没有发起记录（建任务语句晚到提交）：410，回应和过期的 410 一字不差，不读任何数据', async () => {
    const { db, box } = accountSetup();
    db.exportJobStart(A, EID, 'omitted', SESSION);   // 晚到提交的任务行；次数已退回、logs 没写
    const r = await part(db, box, EID, null);
    const expired = await part(db, box, 'eeeeeeee-0000-4000-8000-0000000000ff', null);
    expect(r.status).toBe(410);
    expect([await r.text(), [...r.headers]]).toEqual([await expired.text(), [...expired.headers]]);
    expect(db.pageReads).toEqual([]);
  });

  it('T2：每片都查——伪造游标跳过第一片同样被拒；客户端自己记的同名 act（src 不是 account）不算发起记录', async () => {
    const { db, box } = accountSetup();
    db.exportJobStart(A, EID, 'omitted', SESSION);
    db.logs.push({ id: 900, user_id: A, act: 'export', device: null, t: 1, src: 'app', code: EID });
    const forged = encodeCursor({ t: 1, after: null, n: 0, w: false, b: 0 });
    expect((await part(db, box, EID, forged)).status).toBe(410);
    expect((await part(db, box, EID, null)).status).toBe(410);
    expect(db.pageReads).toEqual([]);
    expect(TABLES.length).toBeGreaterThan(1);
  });

  it('T2：正常 start 之后照常取片（有发起记录）', async () => {
    const { db, box } = accountSetup();
    await started(db, box);
    expect((await part(db, box, EID, null)).status).toBe(200);
  });
});

describe('delete、restore 超时：try_later，不退次数（0.47 第 22 条）', () => {
  it('申请注销的 rpc 卡住（可能已经写进去）：try_later，account 当天次数不退', async () => {
    const t = setup((m) => (m === 'requestDeletion' ? 'after' : false));
    const r = await callAccount(t.db, t.box, { action: 'delete', confirm: '注销' }, t.over);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'try_later' });
    expect(t.db.count(keys.account(A, t.db.clock.ms))).toBe(1);
    expect(t.calls).not.toContain('refundRate');
    expect(t.logs).toEqual(['store_timeout:requestDeletion']);
  });

  it('恢复的 rpc 卡住：try_later，restore 当天次数不退', async () => {
    const t = setup((m) => (m === 'restore' ? 'before' : false));
    t.db.requestDeletion(A);
    t.db.revoked.delete(SESSION);   // 冷静期里重新登录（同名会话当作新会话）
    t.db.sessions.set(SESSION, A);
    const r = await callAccount(t.db, t.box, { action: 'restore' }, t.over);
    expect(r.status).toBe(503);
    expect(t.db.count(keys.restore(A, t.db.clock.ms))).toBe(1);
    expect(t.calls).not.toContain('refundRate');
    expect(t.logs).toEqual(['store_timeout:restore']);
  });
});
