// “这一次提醒响过没有”的本机记录和服务器推导（REMIND-shown-persist；方案 docs/03-评审/B2/B2-方案-提醒响过持久化.md 第 3、4 节，第 9 节第 2、3、4、5 条）
// • 本机记录：meta 的 remind_seen；同一个 key 只记第一次、local 只会从 false 变 true；7 天、500 条；两个标签页各写各的按 key 合并不丢；
//   读失败、坏数据当空的；换账号（新库）读不到上一个账号的
// • 服务器推导：pushed_for 和这一次的 remind_at 同一天才算响过；只对全天日程；outbox 里有换“哪一次”的改动（pending、inflight、failed、发没发都算）不采信
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { openCache, type Cache } from '../../../core/cache.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { allReminders, occurrenceKey } from '../data/reminder-model.ts';
import type { OutboxLikeItem } from '../data/remind-write.ts';
import { mergeSeen, occurrencePending, parseSeen, pruneSeen, pushedSeen, rangView, readSeen, SEEN_KEY, writeSeen, type SeenItem } from '../data/remind-seen.ts';

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (d: string, t: string): number => msAt(d, Number(t.slice(0, 2)) * 60 + Number(t.slice(3)), SEOUL);
const ID = '11111111-1111-4111-8111-111111111111';
const it1 = (tag: string, dueAt: number, local = false): SeenItem => ({ tag, dueAt, local });

async function freshCache(factory: IDBFactory = fakeIndexedDB().factory): Promise<Cache> {
  const r = await openCache({ factory });
  if (!r.ok) throw new Error('open');
  return r.cache;
}

describe('本机记录的纯函数', () => {
  it('parseSeen：形状不对整份当空，单条不对的丢掉', () => {
    expect(parseSeen(undefined)).toEqual({});
    expect(parseSeen({ v: 2, items: { a: it1('t', 1) } })).toEqual({});
    expect(parseSeen({ v: 1, items: { a: it1('t', 1), b: { tag: 1, dueAt: 2, local: false }, c: { tag: 'x', dueAt: Number.NaN, local: true } } })).toEqual({ a: it1('t', 1) });
  });

  it('mergeSeen：已有的 key 保留原来那一次；local 只会从 false 变 true；新 key 加进来', () => {
    const base = { a: it1('a1', 100), b: it1('b1', 200, true) };
    const out = mergeSeen(base, { a: it1('a2', 150, true), b: it1('b2', 250, false), c: it1('c1', 300) });
    expect(out).toEqual({ a: it1('a1', 100, true), b: it1('b1', 200, true), c: it1('c1', 300) });
  });

  it('pruneSeen：dueAt ≤ now − 7 天的剪掉；超过上限按 dueAt 从旧往新删', () => {
    const now = at(DAY, '12:00');
    const week = 7 * 86_400_000;
    const items = { old: it1('o', now - week), edge: it1('e', now - week + 1), x: it1('x', now - 10), y: it1('y', now - 5) };
    expect(Object.keys(pruneSeen(items, now)).sort()).toEqual(['edge', 'x', 'y']);
    expect(Object.keys(pruneSeen(items, now, 2)).sort()).toEqual(['x', 'y']);
  });
});

describe('本机库读写（meta 的 remind_seen）', () => {
  it('没有库、读失败：当空的；写不进去返回 false、不抛错', async () => {
    expect(await readSeen(null)).toEqual({});
    const broken = { tx: () => Promise.reject(new Error('closed')) } as unknown as Cache;
    expect(await readSeen(broken)).toEqual({});
    expect(await writeSeen(broken, { a: it1('a', 1) }, 1)).toBe(false);
  });

  it('两个标签页各写各的（同一个库开两次）：按 key 合并，谁都不丢；写的时候剪掉 7 天前的', async () => {
    const { factory } = fakeIndexedDB();
    const tabA = await freshCache(factory);
    const tabB = await freshCache(factory);
    const now = at(DAY, '12:00');
    expect(await writeSeen(tabA, { a: it1('a', now - 1000), old: it1('o', now - 8 * 86_400_000) }, now)).toBe(true);
    expect(await writeSeen(tabB, { b: it1('b', now - 500, true) }, now)).toBe(true);
    expect(await writeSeen(tabA, { a: it1('a-later', now), c: it1('c', now) }, now)).toBe(true);
    expect(await readSeen(tabB)).toEqual({ a: it1('a', now - 1000), b: it1('b', now - 500, true), c: it1('c', now) });
    expect((await tabA.getMeta(SEEN_KEY))?.v).toBe(1);
  });

  it('换账号（另一个库）读不到上一个账号的；库里是坏数据当空的', async () => {
    const a = await freshCache();
    await writeSeen(a, { a: it1('a', at(DAY, '07:00')) }, at(DAY, '08:00'));
    const b = await freshCache();
    expect(await readSeen(b)).toEqual({});
    await b.tx(['meta'], 'readwrite', (t) => t.put('meta', { key: SEEN_KEY, value: 'garbage' }));
    expect(await readSeen(b)).toEqual({});
  });
});

describe('服务器推导（pushed_for）', () => {
  const allDay = (extra: Record<string, unknown> = {}) => ({ id: ID, title: '体检', date: DAY, time: null, tz: null, remind_days: 0, deleted_at: null, ...extra });
  const one = (row: Record<string, unknown>, now: number, defaultTime: string) => {
    const [r] = allReminders([row as { id: string }], [], now, SEOUL, null, defaultTime);
    if (!r) throw new Error('no reminder');
    return r;
  };
  const patch = (data: Record<string, unknown>, state: OutboxLikeItem['state'] = 'pending', sent = false): OutboxLikeItem => ({ rec: `events:${ID}`, op: 'patch', state, sent, data });

  it('pushed_for 当天 07:00、默认时刻改成 07:20：算响过，tag 是当时那一次的；不同一天的不算', () => {
    const r = one(allDay({ pushed_for: at(DAY, '07:00') }), at(DAY, '07:30'), '07:20');
    expect(pushedSeen(r, [], SEOUL)).toEqual({ tag: `event:${ID}:${at(DAY, '07:00')}`, dueAt: at(DAY, '07:00'), local: false });
    const other = one(allDay({ pushed_for: at('2026-11-02', '07:00') }), at(DAY, '07:30'), '07:20');
    expect(pushedSeen(other, [], SEOUL)).toBeUndefined();
  });

  it('只对全天日程：有时刻的日程（key 就是 tag）不推导', () => {
    const r = one(allDay({ time: '15:00', tz: SEOUL, remind_min: 15, pushed_for: at(DAY, '14:45') }), at(DAY, '14:50'), '09:00');
    expect(occurrenceKey(r)).toBe(r.tag);
    expect(pushedSeen(r, [], SEOUL)).toBeUndefined();
  });

  it('outbox 里有换“哪一次”的改动（pending、inflight、failed，发没发出去都算）：不采信；只改标题的不影响', () => {
    const r = one(allDay({ pushed_for: at(DAY, '07:00') }), at(DAY, '07:30'), '07:20');
    for (const it of [patch({ date: '2026-11-04' }), patch({ remind_days: 1 }, 'inflight', true), patch({ date: '2026-11-04' }, 'failed'), patch({ time: null, notified_for: null })]) {
      expect(occurrencePending(r, [it])).toBe(true);
      expect(pushedSeen(r, [it], SEOUL)).toBeUndefined();
    }
    expect(occurrencePending(r, [patch({ title: '体检（改）' })])).toBe(false);
    expect(pushedSeen(r, [patch({ title: '体检（改）' })], SEOUL)).toBeDefined();
  });

  it('rangView：本机记录优先，没有的再看服务器推导', () => {
    const r = one(allDay({ pushed_for: at(DAY, '07:00') }), at(DAY, '07:30'), '07:20');
    const mine = it1('mine', at(DAY, '06:59'), true);
    expect(rangView([r], new Map([[occurrenceKey(r), mine]]), [], SEOUL).get(occurrenceKey(r))).toBe(mine);
    expect(rangView([r], new Map(), [], SEOUL).get(occurrenceKey(r))?.dueAt).toBe(at(DAY, '07:00'));
  });
});
