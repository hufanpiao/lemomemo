// 日志上传队列（架构 0.38 第 68 条；10-29 审查必改和建议）：数据错误二分重传、交接主页等在途上传、close、核对会话主人（guardOwner）、
// 一行的列（item_id 只给 outbox_vault_shell_drop 和 row_unknown、t 超 ±1 天改成现在、截断后去掉落单代理字符、fields 上限）
import { describe, expect, it, vi } from 'vitest';
import { clampFields, createLogQueue, guardOwner, ITEM_ID_ACTS, LOG_T_SKEW_MS, toLogRow, type LogRow, type LogUploadResult } from '../queue.ts';
import { memStore, settle, setup } from './queue-fake.ts';

describe('数据错误（bad）：二分重传，只丢出错的那一条', () => {
  /** 批里有 act = bad 的行就回 bad，否则 ok */
  function bisectSetup(result: (rows: readonly LogRow[]) => LogUploadResult) {
    const st = memStore();
    const sent: string[][] = [];
    const warn = vi.fn();
    const q = createLogQueue({
      store: st.store, isOnline: () => true, onOnline: () => () => undefined, every: () => () => undefined, warn,
      upload: (rows) => {
        sent.push(rows.map((r) => r.act));
        return Promise.resolve(result(rows));
      },
    });
    return { q, sent, warn };
  }

  it('8 条里有 1 条坏的：其余 7 条都传上去，只丢那一条', async () => {
    const w = bisectSetup((rows) => (rows.some((r) => r.act === 'bad') ? 'bad' : 'ok'));
    for (let i = 0; i < 8; i++) w.q.add({ act: i === 5 ? 'bad' : `a${i}`, t: Date.now() });
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.sent[0]).toHaveLength(8);
    const ok = w.sent.filter((b) => !b.includes('bad')).flat();
    expect(ok.sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a6', 'a7']);
    expect(w.sent.filter((b) => b.length === 1 && b[0] === 'bad')).toHaveLength(1);
    expect(w.q.peek().items).toEqual([]);
    expect(w.warn).toHaveBeenCalledWith('[logs] upload rejected, dropped 1');
  });

  it('二分途中遇到 retry：停下，没传的留着下次传', async () => {
    let calls = 0;
    const w = bisectSetup(() => {
      calls++;
      if (calls === 1) return 'bad';
      return calls === 2 ? 'ok' : 'retry';
    });
    for (let i = 0; i < 4; i++) w.q.add({ act: `a${i}`, t: Date.now() });
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.sent).toEqual([['a0', 'a1', 'a2', 'a3'], ['a0', 'a1'], ['a2', 'a3']]);
    expect(w.q.peek().items.map((x) => x.act)).toEqual(['a2', 'a3']);
    expect(w.warn).not.toHaveBeenCalled();
  });

  it('二分途中遇到 drop（quota）：丢掉那一半，剩下的不再传', async () => {
    let calls = 0;
    const w = bisectSetup(() => (++calls === 1 ? 'bad' : 'drop'));
    for (let i = 0; i < 4; i++) w.q.add({ act: `a${i}`, t: Date.now() });
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.sent).toHaveLength(2);
    expect(w.q.peek().items.map((x) => x.act)).toEqual(['a2', 'a3']);
    expect(w.warn).toHaveBeenCalledWith('[logs] upload rejected, dropped 2');
  });
});

describe('交接主页、关闭、会话主人', () => {
  it('setLeader(false) 返回正在进行的那次上传，等它传完才 resolve', async () => {
    let done: (r: LogUploadResult) => void = () => undefined;
    const st = memStore();
    const q = createLogQueue({
      store: st.store, isOnline: () => true, onOnline: () => () => undefined, every: () => () => undefined,
      upload: () => new Promise((r) => (done = r)),
    });
    q.add({ act: 'x', t: Date.now() });
    q.setLeader(true);
    void q.flush();
    let released = false;
    const p = q.setLeader(false).then(() => (released = true));
    await settle();
    expect(released).toBe(false);
    done('ok');
    await p;
    expect(q.peek().items).toEqual([]);
  });

  it('close：停止上传，之后 add 什么也不做', async () => {
    const w = setup();
    w.q.setLeader(true);
    await w.q.close();
    expect(w.hasTimer() || w.hasOnline()).toBe(false);
    w.q.add({ act: 'x', t: 1 });
    expect(w.st.s.text).toBeNull();
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.sent).toEqual([]);
  });

  it('guardOwner：会话主人还是这个账号才传；换成别的账号、退出了按 retry 留着', async () => {
    let who: string | null = 'A';
    const upload = vi.fn(() => Promise.resolve<LogUploadResult>('ok'));
    const g = guardOwner('A', () => who, upload);
    expect(await g([{ t: 1, act: 'x' }])).toBe('ok');
    who = 'B';
    expect(await g([{ t: 1, act: 'x' }])).toBe('retry');
    who = null;
    expect(await g([{ t: 1, act: 'x' }])).toBe('retry');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('接上 guardOwner 的队列：别的标签页换成 B 后，A 的日志不传、留在 A 的队列里', async () => {
    let who: string | null = 'A';
    const sent: LogRow[][] = [];
    const st = memStore();
    const q = createLogQueue({
      store: st.store, isOnline: () => true, onOnline: () => () => undefined, every: () => () => undefined,
      upload: guardOwner('A', () => who, (rows) => (sent.push([...rows]), Promise.resolve('ok'))),
    });
    q.add({ act: 'x', t: Date.now() });
    q.setLeader(true);
    who = 'B';
    await q.flush();
    expect(sent).toEqual([]);
    expect(q.peek().items).toHaveLength(1);
  });
});

describe('一行写哪些列（数据字典 4.6 的上限）', () => {
  const NOW = 1_000_000_000;

  it('act、coll ≤ 32，code ≤ 64；t 取整', () => {
    const r = toLogRow({ act: 'a'.repeat(40), coll: 'c'.repeat(40), code: 'x'.repeat(70), t: NOW + 0.7 }, NOW);
    expect(r).toEqual({ t: NOW, act: 'a'.repeat(32), coll: 'c'.repeat(32), code: 'x'.repeat(64) });
  });

  it('item_id 只有 outbox_vault_shell_drop、row_unknown 才带，且必须是 uuid', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(toLogRow({ act: 'outbox_vault_shell_drop', t: NOW, itemId: id }, NOW).item_id).toBe(id);
    expect(toLogRow({ act: 'outbox_vault_shell_drop', t: NOW, itemId: 'not-a-uuid' }, NOW).item_id).toBeUndefined();
    expect(toLogRow({ act: 'sync_conflict', t: NOW, itemId: id }, NOW).item_id).toBeUndefined();
    expect(toLogRow({ act: 'row_unknown', t: NOW, itemId: id }, NOW).item_id).toBe(id);
    expect(toLogRow({ act: 'row_unknown', t: NOW, itemId: 'not-a-uuid' }, NOW).item_id).toBeUndefined();
    expect(toLogRow({ act: 'sync_gone', t: NOW, itemId: id }, NOW).item_id).toBeUndefined();
    expect([...ITEM_ID_ACTS].sort()).toEqual(['outbox_vault_shell_drop', 'row_unknown']);
  });

  it('t 离现在超过 ±1 天、不是有限数：改成现在', () => {
    expect(toLogRow({ act: 'a', t: NOW - LOG_T_SKEW_MS }, NOW).t).toBe(NOW - LOG_T_SKEW_MS);
    expect(toLogRow({ act: 'a', t: NOW - LOG_T_SKEW_MS - 1 }, NOW).t).toBe(NOW);
    expect(toLogRow({ act: 'a', t: NOW + LOG_T_SKEW_MS + 1 }, NOW).t).toBe(NOW);
    expect(toLogRow({ act: 'a', t: Number.NaN }, NOW).t).toBe(NOW);
  });

  it('截断处落单的代理字符去掉', () => {
    const emoji = '\u{1F34B}';   // 两个 UTF-16 单元
    const code = 'x'.repeat(63) + emoji;   // 第 64 个单元是高位代理
    expect(toLogRow({ act: 'a', t: NOW, code }, NOW).code).toBe('x'.repeat(63));
    expect(toLogRow({ act: 'a'.repeat(30) + emoji, t: NOW }, NOW).act).toBe('a'.repeat(30) + emoji);
    const f = clampFields(['y'.repeat(639) + emoji]);
    expect(f).toEqual(['y'.repeat(639)]);
  });

  it('fields：最多 20 个，拼起来 ≤ 640 字；空数组不写', () => {
    expect(clampFields([])).toBeUndefined();
    expect(clampFields(Array.from({ length: 25 }, (_, i) => `f${i}`))).toHaveLength(20);
    const big = clampFields(['a'.repeat(400), 'b'.repeat(400), 'c']);
    expect(big?.join(',').length).toBe(640);
    expect(big).toEqual(['a'.repeat(400), 'b'.repeat(239)]);
    expect(toLogRow({ act: 'a', t: NOW, fields: [] }, NOW).fields).toBeUndefined();
  });
});

describe('第四轮复核：重试上限、二分途中停下、close 后不写回', () => {
  /** 按调用次序回结果的队列；upload 可以挂起，由测试放行 */
  function seq(results: readonly (LogUploadResult | 'hold')[]) {
    const st = memStore();
    const sent: string[][] = [];
    let i = 0;
    let release: (r: LogUploadResult) => void = () => undefined;
    const warn = vi.fn();
    const q = createLogQueue({
      store: st.store, isOnline: () => true, onOnline: () => () => undefined, every: () => () => undefined, warn,
      upload: (rows) => {
        sent.push(rows.map((r) => r.act));
        const r = results[Math.min(i++, results.length - 1)] ?? 'ok';
        return r === 'hold' ? new Promise((res) => (release = res)) : Promise.resolve(r);
      },
    });
    return { q, st, sent, warn, release: (r: LogUploadResult) => release(r) };
  }
  const add4 = (q: ReturnType<typeof seq>['q']): void => {
    for (let i = 0; i < 4; i++) q.add({ act: `a${i}`, t: Date.now() });
  };

  it('二分时前一半成功、后一半 retry：前一半删掉，后一半留着、重试次数记 1', async () => {
    const w = seq(['bad', 'ok', 'retry']);
    add4(w.q);
    w.q.setLeader(true);
    await w.q.flush();
    expect(w.sent).toEqual([['a0', 'a1', 'a2', 'a3'], ['a0', 'a1'], ['a2', 'a3']]);
    expect(w.q.peek().items.map((x) => x.act)).toEqual(['a2', 'a3']);
    const saved = JSON.parse(w.st.s.text ?? '') as { items: { act: string; n?: number }[] };
    expect(saved.items.map((x) => x.n)).toEqual([1, 1]);
  });

  it('连续 retry 超过 5 次：丢掉，算进 log_dropped，下次成功时附上', async () => {
    const w = seq(['retry']);
    w.q.add({ act: 'x', t: Date.now() });
    w.q.setLeader(true);
    for (let i = 0; i < 5; i++) await w.q.flush();
    expect(w.q.peek()).toMatchObject({ dropped: 0 });
    expect(w.q.peek().items).toHaveLength(1);
    await w.q.flush();   // 第 6 次 retry
    expect(w.q.peek()).toEqual({ items: [], dropped: 1 });
    expect(w.sent).toHaveLength(6);
  });

  it('重试次数只算回了 retry 的那几条；新记的从 0 算', async () => {
    const w = seq(['retry', 'retry', 'ok']);
    w.q.add({ act: 'old', t: Date.now() });
    w.q.setLeader(true);
    await w.q.flush();
    await w.q.flush();
    w.q.add({ act: 'new', t: Date.now() });
    const saved = JSON.parse(w.st.s.text ?? '') as { items: { act: string; n?: number }[] };
    expect(saved.items.map((x) => [x.act, x.n ?? 0])).toEqual([['old', 2], ['new', 0]]);
    await w.q.flush();
    expect(w.q.peek().items).toEqual([]);
  });

  it('close 以后在途那一批传完：不写存储（清掉的键不会被写回来）', async () => {
    const w = seq(['hold']);
    w.q.add({ act: 'x', t: Date.now() });
    w.q.setLeader(true);
    const f = w.q.flush();
    await settle();
    const closing = w.q.close();
    w.st.s.text = null;   // 模拟 clearLogQueue
    w.release('ok');
    await f;
    await closing;
    expect(w.st.s.text).toBeNull();
  });

  it('二分途中放了锁：剩下的小请求不再发，留到下次；没发的不记重试次数', async () => {
    const w = seq(['bad', 'hold']);
    add4(w.q);
    w.q.setLeader(true);
    const f = w.q.flush();
    await settle();
    expect(w.sent).toHaveLength(2);   // 整批 bad，前一半挂着
    const released = w.q.setLeader(false);
    w.release('ok');
    await f;
    await released;
    expect(w.sent).toHaveLength(2);   // 后一半没发
    expect(w.q.peek().items.map((x) => x.act)).toEqual(['a2', 'a3']);
    const saved = JSON.parse(w.st.s.text ?? '') as { items: { n?: number }[] };
    expect(saved.items.map((x) => x.n)).toEqual([undefined, undefined]);
  });

  it('二分途中 close：同样停下，也不写存储', async () => {
    const w = seq(['bad', 'hold']);
    add4(w.q);
    w.q.setLeader(true);
    const f = w.q.flush();
    await settle();
    const before = w.st.s.text;
    const closing = w.q.close();
    w.release('ok');
    await f;
    await closing;
    expect(w.sent).toHaveLength(2);
    expect(w.st.s.text).toBe(before);
  });
});
