// 提醒数据模型（B2 FA-4）：TC-B2-29（本机现算 remind_at）、TC-B2-26（错过的提醒）、TC-B2-66（未来 7 天）、5.9 的“正在响”
// 函数只认传进来的 tz 和 now（三个进程时区各跑一遍结果一样）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindAtOf } from '../../../../shared/logic/remind.ts';
import { allReminders, missed, modeOf, occurrenceKey, reminderOf, ringing, upcoming, type Row } from '../data/reminder-model.ts';
import { ackPatch, snoozePatch } from '../data/remind-write.ts';

const SEOUL = 'Asia/Seoul';
const DAY = '2026-11-03';
const at = (date: string, hm: string, tz = SEOUL): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), tz);
};
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ev = (n: number, over: Record<string, unknown> = {}): Row => ({
  id: uuid(n), title: `日程${n}`, date: DAY, time: '15:30', tz: SEOUL, remind_min: 15, duration_min: 60, source: 'app',
  deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null, ...over,
});
const todo = (n: number, over: Record<string, unknown> = {}): Row => ({
  id: uuid(100 + n), title: `待办${n}`, due: DAY, due_time: null, remind_before_min: null, remind_days: 0, remind_time: '09:00',
  done: false, deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null, ...over,
});

describe('TC-B2-29：本机用 remindAtOf 现算', () => {
  it('日程：remind_at = 开始 − 提前量，和 shared/logic 一致；patch 里没有 remind_at', () => {
    const now = at(DAY, '09:00');
    const r = reminderOf('event', ev(1), now, SEOUL);
    expect(r?.remindAt).toBe(at(DAY, '15:15'));
    expect(r?.remindAt).toBe(remindAtOf('event', { date: DAY, time: '15:30', tz: SEOUL, remind_min: 15 }, SEOUL, now));
    expect(r?.tag).toBe(`event:${uuid(1)}:${at(DAY, '15:15')}`);
    expect(Object.keys(ackPatch(r!, now))).not.toContain('remind_at');
    expect(Object.keys(snoozePatch(now + 600_000, now))).not.toContain('remind_at');
  });
  it('离线新建（本机还没有 remind_at 这一列）：走新建的回落；同步回来以后按“其余重算”', () => {
    const now = at(DAY, '16:30');
    const fresh: Row = { ...todo(1, { due_time: '17:00', remind_before_min: 60 }) };
    expect(reminderOf('todo', fresh, now, SEOUL)?.remindAt).toBe(at(DAY, '17:00'));
    const synced = { ...fresh, remind_at: at(DAY, '17:00') };
    expect(reminderOf('todo', synced, now, SEOUL)?.remindAt).toBe(at(DAY, '17:00'));
  });
  it('due_at = greatest(remind_at, snooze_at, defer_until)；按过“知道了”的算已处理', () => {
    const now = at(DAY, '15:20');
    const snoozed = reminderOf('event', ev(1, { snooze_at: at(DAY, '15:25') }), now, SEOUL);
    expect(snoozed?.dueAt).toBe(at(DAY, '15:25'));
    expect(snoozed?.snoozed).toBe(true);
    expect(reminderOf('event', ev(1, { notified_for: at(DAY, '15:15') }), now, SEOUL)?.handled).toBe(true);
  });
  it('删了、撤销、待办完成、没有提醒：不是提醒', () => {
    const now = at(DAY, '09:00');
    expect(reminderOf('event', ev(1, { deleted_at: 1 }), now, SEOUL)).toBeNull();
    expect(reminderOf('event', ev(1, { undone: true }), now, SEOUL)).toBeNull();
    expect(reminderOf('event', ev(1, { remind_min: null }), now, SEOUL)).toBeNull();
    expect(reminderOf('todo', todo(1, { done: true }), now, SEOUL)).toBeNull();
    expect(reminderOf('todo', todo(1, { remind_days: null }), now, SEOUL)).toBeNull();
  });
  it('坏数据（时刻格式不对）不让整张表算不下去', () => {
    expect(reminderOf('event', ev(1, { time: '25:99' }), at(DAY, '09:00'), SEOUL)).toBeNull();
  });
  it('免打扰：本机也推迟到免打扰结束（tag 仍是原到点时刻）', () => {
    const r = reminderOf('event', ev(1, { time: '23:30', remind_min: 0 }), at(DAY, '09:00'), SEOUL, { start: '23:00', end: '07:00' });
    expect(r?.dueAt).toBe(at('2026-11-04', '07:00'));
    expect(r?.tagDue).toBe(at(DAY, '23:30'));
  });
});

describe('正在响 / 错过的提醒（5.9；TC-B2-26）', () => {
  const list = (now: number) => allReminders([ev(1), ev(2, { time: '10:30' })], [todo(1)], now, SEOUL);
  it('打开 App 以后到点的进“正在响”；打开前就到点的进“错过的提醒”', () => {
    const now = at(DAY, '15:16');
    const since = at(DAY, '15:00');
    const l = list(now);
    expect(ringing(l, now, since).map((r) => r.title)).toEqual(['日程1']);
    const ring = new Set(ringing(l, now, since).map((r) => r.tag));
    expect(missed(l, now, ring).map((r) => r.title)).toEqual(['日程2', '待办1']);
  });
  it('注入时间跳过提醒时刻再打开：出现在“错过的提醒”里；按了知道了就不在了', () => {
    const now = at('2026-11-04', '08:00');
    const l = list(now);
    expect(missed(l, now).length).toBe(3);
    const acked = allReminders([ev(1, { notified_for: at(DAY, '15:15') })], [], now, SEOUL);
    expect(missed(acked, now)).toEqual([]);
  });
  it('超过 7 天的不算错过；收起的算错过', () => {
    const now = at('2026-11-11', '09:00');
    expect(missed(list(now), now).map((r) => r.title)).toEqual([]);
    const now2 = at(DAY, '15:16');
    const l2 = list(now2);
    const tag = l2.find((r) => r.title === '日程1')!.tag;
    expect(ringing(l2, now2, at(DAY, '15:00'), new Set([tag]))).toEqual([]);
    expect(missed(l2, now2).some((r) => r.tag === tag)).toBe(true);
  });
  it('since 的边界（REMIND-missed-flash；今天页待办 代码审查 L3）：早于 since 才算；正好等于 since、晚于 since 的不算，除非响过（rang 里有）', () => {
    const now = at(DAY, '15:20');
    const l = allReminders([ev(1)], [], now, SEOUL); // 15:30 开始、提前 15 分钟：15:15 到点
    const r = l[0]!;
    const key = occurrenceKey(r);
    expect(missed(l, now, new Set(), new Map(), r.dueAt).map((x) => x.title)).toEqual([]);
    expect(missed(l, now, new Set(), new Map(), r.dueAt + 1).map((x) => x.title)).toEqual(['日程1']);
    const rang = new Map([[key, { tag: r.tag, dueAt: r.dueAt }]]);
    expect(missed(l, now, new Set(), rang, r.dueAt).map((x) => x.title)).toEqual(['日程1']);
    expect(missed(l, now, new Set(), rang, r.dueAt - 60_000).map((x) => x.title)).toEqual(['日程1']);
    // 响过、正在响（还在队列里）的不算
    expect(missed(l, now, new Set([r.tag]), rang, r.dueAt - 60_000)).toEqual([]);
  });
});

describe('TC-B2-66：未来 7 天的提醒', () => {
  const now = at(DAY, '08:00');
  const events = [
    ev(1),
    ev(2, { date: '2026-11-09', time: '10:00', remind_min: 60 }),
    ev(3, { date: '2026-11-10', time: '10:00' }),   // 第 8 天
    ev(4, { remind_min: null }),   // 关了提醒
  ];
  const todos = [todo(1, { due: '2026-11-05', due_time: '17:00', remind_before_min: 60 }), todo(2, { due: '2026-11-04', remind_days: 1, remind_time: '20:00' })];
  const days = upcoming(allReminders(events, todos, now, SEOUL), now, SEOUL);
  it('按天分组，第 8 天的和关了提醒的不在里面', () => {
    expect(days.map((d) => d.date)).toEqual([DAY, '2026-11-05', '2026-11-09']);
    expect(days.flatMap((d) => d.items.map((r) => r.title))).toEqual(['日程1', '待办2', '待办1', '日程2']);
  });
  it('时刻和 remind_at 一致（同一份 shared/logic）', () => {
    const t1 = days[1]!.items.find((r) => r.title === '待办1')!;
    expect(t1.dueAt).toBe(remindAtOf('todo', { due: '2026-11-05', due_time: '17:00', remind_before_min: 60, remind_days: 0, remind_time: '09:00' }, SEOUL, now));
  });
  it('提醒方式', () => {
    const all = days.flatMap((d) => d.items);
    const m = (title: string) => modeOf(all.find((r) => r.title === title)!);
    expect(m('日程1')).toEqual({ key: 'remind.mode.beforeMin', params: { n: 15 } });
    expect(m('日程2')).toEqual({ key: 'remind.mode.beforeHour', params: { n: 1 } });
    expect(m('待办1')).toEqual({ key: 'remind.mode.dueBeforeHour', params: { n: 1 } });
    expect(m('待办2')).toEqual({ key: 'remind.mode.dayBefore', params: { time: '20:00' } });
  });
  it('已经过了的不列', () => {
    const later = at(DAY, '16:00');
    expect(upcoming(allReminders(events, [], later, SEOUL), later, SEOUL).flatMap((d) => d.items.map((r) => r.title))).toEqual(['日程2']);
  });
});
