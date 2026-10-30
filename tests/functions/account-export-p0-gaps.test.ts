// account export 的 E 组 P0 补测之二（B1 QA 报告 6.2 节列的后端单测缺口；架构 0.47 第 14～19 条）：
//   TC-B1-132 ⑦ 五种 410 的响应体、响应头（除 Date）逐字节相同；133 ③⑤⑦ part 的调用顺序（先扣再看游标）、跨 UTC 0 点、预检两个常量；
//   138 ②④⑥ 挂起到超时两档、export_id 撞键；144 ④⑤ 超时、忙、出错三种回应一字不差，start 整条调用顺序。
//   130 ①④⑤ 在 account-export-p0-auth.test.ts。用 account-fakes.ts 的内存库，只经 core.ts 的 handle 调。
import { describe, expect, it } from 'vitest';
import { type AccountStore, EXPORT_LIMITS, keys } from '../../supabase/functions/account/core.ts';
import { A, accountSetup as setup, B, DAY, H } from './account-fakes.ts';
import { NEXT, part, start, uid } from './account-export-harness.ts';
import { E1, S1, SMALL, type Snapshot, snapshot, startId, todos, tracing } from './account-export-p0-harness.ts';

// ---------------- 132 ⑦：五种 410 一字不差 ----------------
describe('TC-B1-132 ⑦：②～⑥ 五种 410 的状态码、响应体、响应头（除 Date）逐字节相同', () => {
  it('别的会话、别的用户、模式不符、过期、不存在：五个响应完全一样；任务行 count 不变，每次都扣了当天分片数；S1 之后照常取', async () => {
    const { db, box, clock } = setup();
    db.tables.set('todos', todos(60));
    const tokOver = { verifyVaultToken: async (u: string, t: string) => (u === A && t === 'tok' ? ('ok' as const) : ('vault_locked' as const)) };
    const id = await startId(db, box, SMALL);
    const r1 = await part(db, box, id, null, SMALL);   // ① S1 第 1 片
    expect(r1.status).toBe(200);
    const cur = r1.headers.get(NEXT);
    const job = () => db.count(keys.exportJob(A, id, 'omitted', S1));
    const partsA = () => db.count(keys.exportPart(A, clock.ms));
    const shots: Snapshot[] = [];

    const before = { job: job(), parts: partsA(), partsB: db.count(keys.exportPart(B, clock.ms)) };
    shots.push(await snapshot(await part(db, box, id, cur, { ...SMALL, session: 'aaaaaaaa-s2' })));                       // ② S2
    shots.push(await snapshot(await part(db, box, id, cur, { ...SMALL, user: B })));                                     // ③ B
    shots.push(await snapshot(await part(db, box, id, cur, { ...SMALL, ...tokOver }, { 'x-vault-token': 'tok' })));      // ④ 模式不符
    shots.push(await snapshot(await part(db, box, uid('99999999', 1), cur, SMALL)));                                    // ⑥ 不存在
    expect(job()).toBe(before.job);
    expect(partsA()).toBe(before.parts + 3);   // ②④⑥ 是 A 发的
    expect(db.count(keys.exportPart(B, clock.ms))).toBe(before.partsB + 1);
    // S1 之后仍能接着取
    const r2 = await part(db, box, id, cur, SMALL);
    expect(r2.status).toBe(200);
    // ⑤ 开始满 3600 秒
    clock.advance(H);
    const jobBefore5 = job();
    shots.push(await snapshot(await part(db, box, id, r2.headers.get(NEXT), SMALL)));
    expect(job()).toBe(jobBefore5);

    expect(shots).toHaveLength(5);
    expect(shots[0]).toMatchObject({ status: 410, body: Buffer.from('{"error":"export_expired"}').toString('hex') });
    for (const s of shots.slice(1)) expect(s).toEqual(shots[0]);
  });
});

// ---------------- 133 ③⑤⑦ ----------------
describe('TC-B1-133 ③：part 的第一个数据库动作就是扣每天分片总数', () => {
  it('正常一片：authenticate → takeRate(export-part) → exportJobTake → readPage…；坏游标、坏 export_id 只扣了这一下', async () => {
    const { db, box } = setup();
    const id = await startId(db, box);
    const seq: string[] = [];
    expect((await part(db, box, id, null, tracing(db, box, seq))).status).toBe(200);
    expect(seq.slice(0, 3)).toEqual(['authenticate', 'takeRate:export-part', 'exportJobTake']);
    expect(seq.slice(3).every((s) => s === 'readPage' || s === 'exportDoneLogged' || s === 'insertLog:export_done')).toBe(true);
    expect(seq).toContain('readPage');
    for (const [eid, cursor] of [[id, 'bad!'], [id, 'A'.repeat(600)], ['not-a-uuid', null]] as const) {
      seq.length = 0;
      expect((await part(db, box, eid, cursor, tracing(db, box, seq))).status).toBe(400);
      expect(seq).toEqual(['authenticate', 'takeRate:export-part']);
    }
  });

  it('带令牌：模式（验令牌）在扣数之后、export_job_take 之前；410、413 之前都已扣数', async () => {
    const { db, box } = setup();
    db.tables.set('todos', todos(60));
    const seq: string[] = [];
    const id = await startId(db, box, { ...SMALL, verifyVaultToken: async () => 'ok' }, { 'x-vault-token': 'tok' });
    expect((await part(db, box, id, null, { ...SMALL, ...tracing(db, box, seq, true) }, { 'x-vault-token': 'tok' })).status).toBe(200);
    expect(seq.slice(0, 4)).toEqual(['authenticate', 'takeRate:export-part', 'verifyVaultToken', 'exportJobTake']);
    seq.length = 0;
    expect((await part(db, box, uid('99999999', 1), null, tracing(db, box, seq))).status).toBe(410);
    expect(seq).toEqual(['authenticate', 'takeRate:export-part', 'exportJobTake']);
    seq.length = 0;
    const r = await part(db, box, id, null, { exportLimits: { ...SMALL.exportLimits, maxParts: 1 }, ...tracing(db, box, seq, true) }, { 'x-vault-token': 'tok' });
    expect(r.status).toBe(413);
    expect(seq).toEqual(['authenticate', 'takeRate:export-part', 'verifyVaultToken', 'exportJobTake']);
  });

  it('超了每天分片总数：429，不碰任务行、不读数据（第二个动作都没有）', async () => {
    const { db, box } = setup();
    const id = await startId(db, box);
    const seq: string[] = [];
    const over = { exportLimits: { partDailyLimit: 1 } };
    expect((await part(db, box, id, null, over)).status).toBe(200);
    expect((await part(db, box, id, null, { ...over, ...tracing(db, box, seq) })).status).toBe(429);
    expect(seq).toEqual(['authenticate', 'takeRate:export-part']);
  });
});

describe('TC-B1-133 ⑤：跨 UTC 0 点', () => {
  it('新的一天 export-part 从 0 开始；旧任务没满 3600 秒照常取，分片数接着加', async () => {
    const { db, box, clock } = setup();
    clock.ms = Date.parse('2026-10-29T23:59:00Z');
    const day1 = clock.ms;
    db.tables.set('todos', todos(60));
    const over = { exportLimits: { ...SMALL.exportLimits, partDailyLimit: 3 } };
    const id = await startId(db, box, over);
    let cur: string | null = null;
    for (let i = 0; i < 3; i++) {
      const r = await part(db, box, id, cur, over);
      expect(r.status).toBe(200);
      cur = r.headers.get(NEXT);
    }
    expect((await part(db, box, id, cur, over)).status).toBe(429);
    expect(db.count(keys.exportPart(A, day1))).toBe(4);
    const jobBefore = db.count(keys.exportJob(A, id, 'omitted', S1));
    clock.advance(2 * 60_000);   // 00:01 UTC，新的一天；任务开始才 2 分钟
    expect(keys.exportPart(A, clock.ms)).not.toBe(keys.exportPart(A, day1));
    const r = await part(db, box, id, cur, over);
    expect(r.status).toBe(200);
    expect(db.count(keys.exportPart(A, clock.ms))).toBe(1);
    expect(db.count(keys.exportPart(A, day1))).toBe(4);   // 旧的一天不动
    expect(db.count(keys.exportJob(A, id, 'omitted', S1))).toBe(jobBefore + 1);
    // 同一个任务满 3600 秒后照样过期（新的一天不续命）
    clock.ms = day1 + H;
    expect((await part(db, box, id, r.headers.get(NEXT), over)).status).toBe(410);
    expect(DAY).toBe(86_400_000);
  });
});

describe('TC-B1-133 ⑦：预检的两个常量（0.47 第 19 条）', () => {
  it('EXPORT_SIZE_CHECK_DAILY_LIMIT = 6、EXPORT_SIZE_CHECK_BUDGET_MS = 15000；start 调预检时原样传 480 MB 和 15000', async () => {
    expect(EXPORT_LIMITS.sizeCheckDailyLimit).toBe(6);
    expect(EXPORT_LIMITS.sizeCheckBudgetMs).toBe(15000);
    const { db, box } = setup();
    const args: unknown[][] = [];
    const store = db.accountStore();
    expect((await start(db, box, {}, { store: { ...store, exportSizeOver: async (...a) => { args.push(a); return 0; } } })).status).toBe(200);
    expect(args).toEqual([[A, 'omitted', 480 * 1024 * 1024, 15000]]);
    // 预检限流的键按 6 次限：第 7 次 429
    db.sizeResult = EXPORT_LIMITS.maxTotalRawBytes + 1;
    for (let i = 0; i < 5; i++) expect((await start(db, box)).status).toBe(413);
    expect((await start(db, box)).status).toBe(429);
  });
});

// ---------------- 138 ②④⑥ ----------------
/** 挂起：等一会儿再按超时报错（PostgREST 语句超时、网络超时最后都是 rpc 报错） */
const hangThenTimeout = () => new Promise<never>((_, rej) => { setTimeout(() => rej(new Error('57014 canceling statement due to statement timeout')), 30); });

describe('TC-B1-138 ②④：建任务、写 logs 挂起到超时，结果和报错相同', () => {
  async function runStart(which: 'exportJobStart' | 'insertLog', how: 'fail' | 'hang') {
    const w = setup();
    const store = w.db.accountStore();
    const logs: string[] = [];
    const over: AccountStore = which === 'exportJobStart'
      ? { ...store, exportJobStart: how === 'fail' ? async () => { throw new Error('fake'); } : hangThenTimeout }
      : { ...store, insertLog: async (u, row) => (row.act === 'export' ? (how === 'fail' ? Promise.reject(new Error('fake')) : hangThenTimeout()) : store.insertLog(u, row)) };
    const r = await start(w.db, w.box, {}, { store: over, newId: () => E1, log: (c) => logs.push(c) });
    const shot = await snapshot(r);
    const counters = [...w.db.counters].sort();
    const p = await part(w.db, w.box, E1, null);   // 拿 start 生成的 export_id 去取
    return { shot, counters, logs, mails: w.box.length, dbLogs: w.db.logs.length, partStatus: p.status };
  }

  for (const which of ['exportJobStart', 'insertLog'] as const) {
    it(`${which}：挂起到超时 = 报错（try_later、退回、没有任务行、不发信、取片 410）`, async () => {
      const failed = await runStart(which, 'fail');
      const hung = await runStart(which, 'hang');
      expect(hung).toEqual(failed);
      expect(failed.shot).toMatchObject({ status: 503, body: Buffer.from('{"error":"try_later"}').toString('hex') });
      expect(failed.counters.filter(([k]) => k.startsWith('export-job:'))).toEqual([]);
      expect(failed.counters.find(([k]) => k.startsWith('account:'))?.[1]).toBe(0);
      expect(failed.counters.find(([k]) => k.startsWith('export-refund:'))?.[1]).toBe(1);
      expect(failed.mails).toBe(0);
      expect(failed.dbLogs).toBe(0);
      expect(failed.partStatus).toBe(410);
      expect(failed.logs).toEqual([which === 'exportJobStart' ? 'export_job_failed' : 'export_log_failed']);
    });
  }
});

describe('TC-B1-138 ⑥：生成的 export_id 撞上已有的 export-job 键（同一用户、模式、会话）', () => {
  /** 先正常开始一次（E1）、取 1 片；10 秒后再开始一次，newId 又给 E1 */
  async function collide() {
    const w = setup();
    w.db.tables.set('todos', todos(60));
    expect(await startId(w.db, w.box, { ...SMALL, newId: () => E1 })).toBe(E1);
    const r1 = await part(w.db, w.box, E1, null, SMALL);
    expect(r1.status).toBe(200);
    const jobKey = keys.exportJob(A, E1, 'omitted', S1);
    const before = [...w.db.counters].filter(([k]) => k.startsWith(`${jobKey}|`));
    w.clock.advance(10_000);
    const logs: string[] = [];
    const r = await start(w.db, w.box, {}, { ...SMALL, newId: () => E1, log: (c) => logs.push(c) });
    return { ...w, r, jobKey, before, logs, next: r1.headers.get(NEXT) };
  }

  it('start 报错 try_later、退回这一次、不写 logs、不发信（N1）', async () => {
    const c = await collide();
    expect(c.r.status).toBe(503);
    expect(await c.r.json()).toEqual({ error: 'try_later' });
    expect(c.db.count(keys.account(A, c.clock.ms))).toBe(1);   // 第一次那一次还在，第二次退回了
    expect(c.db.count(keys.exportRefund(A, c.clock.ms))).toBe(1);
    expect(c.db.logs.filter((l) => l.act === 'export')).toHaveLength(1);
    expect(c.box).toHaveLength(1);
    expect(c.logs[0]).toBe('export_job_failed');
  });

  // 10-31 补测时发现 export.ts 的 fail() 撞键时会删掉原有那一行（原来那次导出接着取片回 410），后端已修；这条守住“原有那一行不被改动”
  it('原有那一行不被改动（window_start、count 不变），原来那次导出还能接着取', async () => {
    const c = await collide();
    expect([...c.db.counters].filter(([k]) => k.startsWith(`${c.jobKey}|`))).toEqual(c.before);
    expect((await part(c.db, c.box, E1, c.next, SMALL)).status).toBe(200);
  });
});

// ---------------- 144 ④⑤ ----------------
describe('TC-B1-144 ④：预检超时（-1）、忙（-2）、出错三种回应一字不差', () => {
  it('状态码、响应体、响应头（除 Date）完全相同；都不带估算值；三种都不扣导出次数、不建任务、不写 logs、不发信', async () => {
    const shots: Snapshot[] = [];
    for (const how of [-1, -2, 'error'] as const) {
      const { db, box } = setup();
      if (how === 'error') db.fail.add('exportSizeOver'); else db.sizeResult = how;
      shots.push(await snapshot(await start(db, box)));
      expect(db.count(keys.account(A, db.clock.ms))).toBe(0);
      expect([...db.counters.keys()].some((k) => k.startsWith('export-job:'))).toBe(false);
      expect(db.logs).toEqual([]);
      expect(box).toEqual([]);
    }
    expect(shots[0]).toMatchObject({ status: 503, body: Buffer.from('{"error":"try_later"}').toString('hex') });
    expect(shots[1]).toEqual(shots[0]);
    expect(shots[2]).toEqual(shots[0]);
  });
});

describe('TC-B1-144 ⑤：start 整条调用顺序', () => {
  it('requireActiveUser → device_id → 定模式 → 只读查次数 → 扣 export-size → 预检 → 扣次数 → 建任务 → 写 logs', async () => {
    const { db, box } = setup();
    const seq: string[] = [];
    const r = await start(db, box, { device_id: 'dddddddd-0000-4000-8000-000000000001' }, { ...tracing(db, box, seq, true), newId: () => E1 }, { 'x-vault-token': 'tok' });
    expect(r.status).toBe(200);
    const upToLog = seq.slice(0, seq.indexOf('insertLog:export') + 1);
    expect(upToLog).toEqual([
      'authenticate', 'verifyVaultToken', 'peekRate:account', 'takeRate:export-size', 'exportSizeOver', 'takeRate:account', 'exportJobStart', 'insertLog:export',
    ]);
    // 之后只剩发通知要用的只读查询（响应之后）
    expect(seq.slice(upToLog.length).every((s) => s === 'profile' || s === 'deviceLabel')).toBe(true);
  });

  it('device_id 不对：鉴权之后、定模式之前就 400（一次 store、一次验令牌都没有）；令牌不对：401，只验了令牌', async () => {
    const { db, box } = setup();
    const seq: string[] = [];
    expect((await start(db, box, { device_id: 'x' }, tracing(db, box, seq, true), { 'x-vault-token': 'tok' })).status).toBe(400);
    expect(seq).toEqual(['authenticate']);
    seq.length = 0;
    expect((await start(db, box, {}, tracing(db, box, seq, true), { 'x-vault-token': 'bad' })).status).toBe(401);
    expect(seq).toEqual(['authenticate', 'verifyVaultToken']);
  });

  it('当天次数已满：只读查一次就 429，不扣 export-size、不预检（顺序里第一道闸）', async () => {
    const { db, box } = setup();
    for (let i = 0; i < 3; i++) expect((await start(db, box)).status).toBe(200);
    const seq: string[] = [];
    expect((await start(db, box, {}, tracing(db, box, seq))).status).toBe(429);
    expect(seq).toEqual(['authenticate', 'peekRate:account']);
  });

  it('预检被拒（413）、超时、忙：停在预检，不扣次数、不建任务；忙时多一步退回 export-size', async () => {
    const cases = [[EXPORT_LIMITS.maxTotalRawBytes + 1, []], [-1, []], [-2, ['refundRate:export-size']]] as const;
    for (const [size, tail] of cases) {
      const { db, box } = setup();
      db.sizeResult = size;
      const seq: string[] = [];
      await start(db, box, {}, tracing(db, box, seq));
      expect(seq).toEqual(['authenticate', 'peekRate:account', 'takeRate:export-size', 'exportSizeOver', ...tail]);
    }
  });
});
