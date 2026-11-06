// 全天日程接进 FA-4（TC-B2-66 全天那一半；架构 4.6、0.29 续第 45、47、57 条、5.3 第 4 步）：
// 未来 7 天清单列出全天日程、时刻和 shared 的 remindAtOf 一致、提醒方式“当天 {default_time} / 前一天 20:00”；本机通知到点能弹、文案按 5.3。
// 函数只认传进来的 tz 和 now（三个进程时区各跑一遍结果一样）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindAtOf } from '../../../../shared/logic/remind.ts';
import { localDue, localText, shouldCloseShown, shownKey, staleShown } from '../data/local-notify.ts';
import { allReminders, missed, modeOf, occurrenceKey, ringing, upcoming, type Rang, type Row } from '../data/reminder-model.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
const DAY = '2026-11-03';
const at = (date: string, hm: string, tz = SEOUL): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), tz);
};
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const allDay = (n: number, over: Record<string, unknown> = {}): Row => ({
  id: uuid(n), title: `全天${n}`, date: DAY, time: null, tz: null, remind_min: null, remind_days: 0, duration_min: 60, source: 'app',
  deleted_at: null, undone: false, notified_for: null, snooze_at: null, defer_until: null, ...over,
});

describe('TC-B2-66 全天那一半：未来 7 天的提醒', () => {
  const now = at(DAY, '08:00');
  const events = [
    allDay(1),                                                // 当天 default_time
    allDay(2, { date: '2026-11-06', remind_days: 1 }),        // 前一天 20:00 → 11-05
    allDay(3, { date: '2026-11-10', remind_days: 1 }),        // 前一天是 11-09（第 7 天），列
    allDay(4, { date: '2026-11-11' }),                        // 第 9 天，不列
    allDay(5, { remind_days: null }),                         // 关了提醒
    allDay(6, { date: '2026-11-04', deleted_at: 1 }),         // 已删
  ];
  it('按天分组：当天、前一天的都按提醒那一天归组；第 8 天以后的、关了提醒的、删了的不在里面', () => {
    const days = upcoming(allReminders(events, [], now, SEOUL, null, '08:30'), now, SEOUL);
    expect(days.map((d) => d.date)).toEqual([DAY, '2026-11-05', '2026-11-09']);
    expect(days.flatMap((d) => d.items.map((r) => r.title))).toEqual(['全天1', '全天2', '全天3']);
  });
  it('时刻和 shared 的 remindAtOf 一致（remind.default_time 08:30）', () => {
    const all = upcoming(allReminders(events, [], now, SEOUL, null, '08:30'), now, SEOUL).flatMap((d) => d.items);
    const one = all.find((r) => r.title === '全天1');
    expect(one?.dueAt).toBe(at(DAY, '08:30'));
    expect(one?.dueAt).toBe(remindAtOf('event', { date: DAY, time: null, tz: null, remind_min: null, remind_days: 0 }, SEOUL, now, undefined, '08:30'));
    expect(all.find((r) => r.title === '全天2')?.dueAt).toBe(at('2026-11-05', '20:00'));
  });
  it('remind.default_time 没设：按 09:00', () => {
    const r = allReminders([allDay(1)], [], now, SEOUL);
    expect(r[0]?.dueAt).toBe(at(DAY, '09:00'));
  });
  it('提醒方式：当天写 default_time，前一天写 20:00', () => {
    const all = allReminders(events, [], now, SEOUL, null, '08:30');
    const m = (title: string) => {
      const r = all.find((x) => x.title === title);
      if (!r) throw new Error(title);
      return modeOf(r, '08:30');
    };
    expect(m('全天1')).toEqual({ key: 'remind.mode.sameDay', params: { time: '08:30' } });
    expect(m('全天2')).toEqual({ key: 'remind.mode.dayBefore', params: { time: '20:00' } });
  });
  it('浮动：current_tz 换成洛杉矶，提醒跟着变成洛杉矶的 09:00', () => {
    const r = allReminders([allDay(1)], [], at(DAY, '00:00', LA), LA);
    expect(r[0]?.dueAt).toBe(at(DAY, '09:00', LA));
  });
  it('免打扰照推迟：前一天 20:00 落进 19:00–07:00，推迟到当天 07:00；tag 仍用原来的 20:00（和服务器推送一致）', () => {
    const r = allReminders([allDay(2, { date: '2026-11-04', remind_days: 1 })], [], now, SEOUL, { start: '19:00', end: '07:00' })[0];
    expect(r?.dueAt).toBe(at('2026-11-04', '07:00'));
    expect(r?.tagDue).toBe(at(DAY, '20:00'));
  });
});

describe('本机通知（exe）：全天日程到点能弹', () => {
  const list = (now: number) => allReminders([allDay(1)], [], now, SEOUL, null, '09:00');
  it('到点后 60 分钟内弹一次，弹过的不重弹；没到点、超过 60 分钟不弹', () => {
    expect(localDue(list(at(DAY, '08:59')), at(DAY, '08:59'), new Set())).toEqual([]);
    const due = localDue(list(at(DAY, '09:00')), at(DAY, '09:00'), new Set());
    expect(due.map((r) => r.title)).toEqual(['全天1']);
    const key = due[0] ? shownKey(due[0]) : '';
    expect(localDue(list(at(DAY, '09:10')), at(DAY, '09:10'), new Set([key]))).toEqual([]);
    expect(localDue(list(at(DAY, '10:01')), at(DAY, '10:01'), new Set())).toEqual([]);
  });
  it('文案（R-333、R-334）：当天“今天 · 名称”、前一天“明天 · 名称”，中韩；只显示有几项时“今天 / 明天有 1 项日程”', () => {
    const r = localDue(list(at(DAY, '09:00')), at(DAY, '09:00'), new Set())[0];
    if (!r) throw new Error('没弹');
    expect(localText(r, { showTitle: true, tz: SEOUL, locale: 'zh-CN', defaultTime: '09:00' }).title).toBe('今天 · 全天1');
    expect(localText(r, { showTitle: true, tz: SEOUL, locale: 'ko-KR', defaultTime: '09:00' }).title).toBe('오늘 · 全天1');
    expect(localText(r, { showTitle: false, tz: SEOUL, locale: 'zh-CN', defaultTime: '09:00' }).title).toBe('今天有 1 项日程');
    expect(localText(r, { showTitle: false, tz: SEOUL, locale: 'ko-KR', defaultTime: '09:00' }).title).toBe('오늘 일정 1개');
    const eveNow = at('2026-11-04', '20:00');
    const eve = localDue(allReminders([allDay(2, { date: '2026-11-05', remind_days: 1 })], [], eveNow, SEOUL), eveNow, new Set())[0];
    if (!eve) throw new Error('前一天没弹');
    expect(localText(eve, { showTitle: true, tz: SEOUL, locale: 'zh-CN', defaultTime: '09:00' }).title).toBe('明天 · 全天2');
    expect(localText(eve, { showTitle: true, tz: SEOUL, locale: 'ko-KR', defaultTime: '09:00' }).title).toBe('내일 · 全天2');
    expect(localText(eve, { showTitle: false, tz: SEOUL, locale: 'zh-CN', defaultTime: '09:00' }).title).toBe('明天有 1 项日程');
    expect(localText(eve, { showTitle: false, tz: SEOUL, locale: 'ko-KR', defaultTime: '09:00' }).title).toBe('내일 일정 1개');
  });
});

describe('漏测补充（全天日程代码审查）', () => {
  it('当天提醒被免打扰推到第二天：本机文案只写名称（不写今天 / 明天），只显示有几项时写“有 1 项日程”', () => {
    const dnd = { start: '23:00', end: '07:00' };
    const next = at('2026-11-04', '07:00');
    const r = allReminders([allDay(1)], [], next, SEOUL, dnd, '23:30')[0];
    if (!r) throw new Error('没有提醒');
    expect(r.dueAt).toBe(next);
    expect(localDue([r], next, new Set()).map((x) => x.title)).toEqual(['全天1']);
    expect(localText(r, { showTitle: true, tz: SEOUL, locale: 'zh-CN', defaultTime: '23:30' }).title).toBe('全天1');
    expect(localText(r, { showTitle: false, tz: SEOUL, locale: 'zh-CN', defaultTime: '23:30' }).title).toBe('有 1 项日程');
    expect(localText(r, { showTitle: false, tz: SEOUL, locale: 'ko-KR', defaultTime: '23:30' }).title).toBe('일정 1개');
  });
  it('按了“稍后”：提醒方式写“稍后再提醒”，到点时刻是 snooze_at；稍后落在当天，文案仍写“今天 · 名称”', () => {
    const snooze = at(DAY, '09:10');
    const r = allReminders([allDay(1, { snooze_at: snooze })], [], at(DAY, '09:05'), SEOUL, null, '09:00')[0];
    if (!r) throw new Error('没有提醒');
    expect(r.snoozed).toBe(true);
    expect(r.dueAt).toBe(snooze);
    expect(modeOf(r, '09:00')).toEqual({ key: 'remind.mode.snoozed', params: {} });
    expect(localText(r, { showTitle: true, tz: SEOUL, locale: 'zh-CN', defaultTime: '09:00' }).title).toBe('今天 · 全天1');
  });
});

describe('R-336：当天已经弹过，再改 remind.default_time 不再弹第二次', () => {
  it('07:00 弹过；07:10 改成 07:20、再改成 21:00，到点都不再弹，原来那条通知也不撤回', () => {
    const shown = new Map<string, string>();
    const rows = [allDay(1)];
    const first = localDue(allReminders(rows, [], at(DAY, '07:00'), SEOUL, null, '07:00'), at(DAY, '07:00'), shown);
    expect(first.map((r) => r.title)).toEqual(['全天1']);
    for (const r of first) shown.set(shownKey(r), r.tag);
    for (const [hm, setTo] of [['07:20', '07:20'], ['21:00', '21:00'], ['21:30', '21:00']] as const) {
      const l = allReminders(rows, [], at(DAY, hm), SEOUL, null, setTo);
      expect(l[0]?.dueAt).toBe(at(DAY, setTo));
      expect(localDue(l, at(DAY, hm), shown)).toEqual([]);
      expect(staleShown(shown, l)).toEqual([]);
    }
  });
  it('新时刻对还没响的照常生效：07:00 之前就改成 07:20，07:20 弹；别的日子、按了“稍后”的照样弹', () => {
    const l = allReminders([allDay(1)], [], at(DAY, '07:20'), SEOUL, null, '07:20');
    expect(localDue(l, at(DAY, '07:20'), new Map()).length).toBe(1);
    const shown = new Map<string, string>();
    const today = allReminders([allDay(1)], [], at(DAY, '07:00'), SEOUL, null, '07:00');
    for (const r of localDue(today, at(DAY, '07:00'), shown)) shown.set(shownKey(r), r.tag);
    const tomorrow = allReminders([allDay(1, { date: '2026-11-04' })], [], at('2026-11-04', '07:00'), SEOUL, null, '07:00');
    expect(localDue(tomorrow, at('2026-11-04', '07:00'), shown).length).toBe(1);
    const snoozed = allReminders([allDay(1, { snooze_at: at(DAY, '07:10') })], [], at(DAY, '07:10'), SEOUL, null, '07:00');
    expect(localDue(snoozed, at(DAY, '07:10'), shown).length).toBe(1);
  });
  it('有时刻的日程、待办照旧按 tag：改了时间算新的一次', () => {
    const timed = { ...allDay(3), time: '15:00', tz: SEOUL, remind_min: 15 };
    const r = allReminders([timed], [], at(DAY, '14:45'), SEOUL)[0];
    if (!r) throw new Error('没有提醒');
    expect(shownKey(r)).toBe(r.tag);
  });
});

describe('R-335：过了提醒时刻 60 分钟以内照响，超过不响', () => {
  it('当天 09:00 的全天日程：09:30 新建会弹，10:30 新建不弹', () => {
    const at930 = at(DAY, '09:30');
    expect(localDue(allReminders([allDay(1)], [], at930, SEOUL, null, '09:00'), at930, new Map()).map((r) => r.title)).toEqual(['全天1']);
    const at1030 = at(DAY, '10:30');
    expect(localDue(allReminders([allDay(1)], [], at1030, SEOUL, null, '09:00'), at1030, new Map())).toEqual([]);
  });
});


describe('R-336：App 里的横幅和“错过的提醒”同一口径（同一条当天推过就不再响）', () => {
  it('07:00 按过“知道了”以后改成 07:20：算已处理，横幅不再出来、也不进错过的提醒；第二天的照常', () => {
    const acked = allDay(1, { notified_for: at(DAY, '07:00') });
    const l = allReminders([acked], [], at(DAY, '07:20'), SEOUL, null, '07:20');
    expect(l[0]?.remindAt).toBe(at(DAY, '07:20'));
    expect(l[0]?.handled).toBe(true);
    expect(ringing(l, at(DAY, '07:20'), at(DAY, '06:00'))).toEqual([]);
    expect(missed(l, at(DAY, '08:00'))).toEqual([]);
    const moved = allReminders([{ ...acked, date: '2026-11-04' }], [], at('2026-11-04', '07:20'), SEOUL, null, '07:20');
    expect(moved[0]?.handled).toBe(false);
  });
  it('没按“知道了”、只是响过：改成 07:20 / 21:00 以后不再进横幅（rang 记着本次打开响过的）', () => {
    const rang = new Map<string, string>();
    const first = ringing(allReminders([allDay(1)], [], at(DAY, '07:00'), SEOUL, null, '07:00'), at(DAY, '07:00'), at(DAY, '06:00'), new Set(), rang);
    expect(first.length).toBe(1);
    for (const r of first) rang.set(occurrenceKey(r), r.tag);
    // 同一个 tag 还在响：照常留在横幅里
    expect(ringing(allReminders([allDay(1)], [], at(DAY, '07:05'), SEOUL, null, '07:00'), at(DAY, '07:05'), at(DAY, '06:00'), new Set(), rang).length).toBe(1);
    for (const [hm, setTo] of [['07:20', '07:20'], ['21:00', '21:00']] as const) {
      const l = allReminders([allDay(1)], [], at(DAY, hm), SEOUL, null, setTo);
      expect(ringing(l, at(DAY, hm), at(DAY, '06:00'), new Set(), rang)).toEqual([]);
    }
  });
  it('按了“稍后”的照样响；本机通知的 shownKey 和横幅用同一个标识', () => {
    const rang = new Map<string, string>([['event:' + allDay(1).id + ':allday:' + DAY + ':0', 'x']]);
    const l = allReminders([allDay(1, { snooze_at: at(DAY, '07:10') })], [], at(DAY, '07:10'), SEOUL, null, '07:00');
    expect(ringing(l, at(DAY, '07:10'), at(DAY, '06:00'), new Set(), rang).length).toBe(1);
    const r = allReminders([allDay(1)], [], at(DAY, '07:00'), SEOUL, null, '07:00')[0];
    if (!r) throw new Error('没有提醒');
    expect(shownKey(r)).toBe(occurrenceKey(r));
  });
});

describe('R-336 同一次提醒：这一条、这个日期、当天 / 前一天（审查 M1）', () => {
  const keyOf = (over: Record<string, unknown>, now: number, def = '09:00') => {
    const r = allReminders([allDay(1, over)], [], now, SEOUL, null, def)[0];
    if (!r) throw new Error('没有提醒');
    return occurrenceKey(r);
  };
  const one = (over: Record<string, unknown>, now: number, def: string, tz = SEOUL) => {
    const r = allReminders([allDay(1, over)], [], now, tz, null, def)[0];
    if (!r) throw new Error('没有提醒');
    return r;
  };
  it('前一天 20:00 推过以后改成当天提醒：算另一次，照样响', () => {
    const eve = keyOf({ date: '2026-11-05', remind_days: 1 }, at('2026-11-04', '20:00'));
    const sameDay = keyOf({ date: '2026-11-05', remind_days: 0 }, at('2026-11-05', '09:00'));
    expect(eve).not.toBe(sameDay);
    const shown = new Map([[eve, 'x']]);
    const l = allReminders([allDay(1, { date: '2026-11-05', remind_days: 0 })], [], at('2026-11-05', '09:00'), SEOUL, null, '09:00');
    expect(localDue(l, at('2026-11-05', '09:00'), shown).length).toBe(1);
    expect(ringing(l, at('2026-11-05', '09:00'), at('2026-11-04', '00:00'), new Set(), shown).length).toBe(1);
  });
  it('都落在 11-05 也是两次：11-05 当天提醒 和 挪到 11-06 改成前一天提醒', () => {
    expect(keyOf({ date: '2026-11-05', remind_days: 0 }, at('2026-11-05', '09:00'))).not.toBe(keyOf({ date: '2026-11-06', remind_days: 1 }, at('2026-11-05', '20:00')));
  });
  it('复现 M1 ①：11-05 当天 09:00 按过“知道了”，挪到 11-06、改成前一天提醒（当晚 20:00）——日历编辑清掉了 notified_for，照样响，不漏', () => {
    // 11-05 起前一天提醒也按“同一天”比（方案第 5 节，和服务器同口径）：不清的话 11-05 09:00 和 11-05 20:00 同一天会算处理过；
    // 挡住它的是换次清空（event-edit 的 patchOf、服务器 events_occ_reset 都清 notified_for），这里按清过的写
    const r = one({ date: '2026-11-06', remind_days: 1, notified_for: null }, at('2026-11-05', '20:00'), '09:00');
    expect(r.remindAt).toBe(at('2026-11-05', '20:00'));
    expect(r.handled).toBe(false);
    expect(ringing([r], at('2026-11-05', '20:00'), at('2026-11-05', '10:00')).length).toBe(1);
  });
  it('前一天提醒按过“知道了”，再改成另一天的当天提醒：照样响', () => {
    expect(one({ date: '2026-11-06', remind_days: 0, notified_for: at('2026-11-04', '20:00') }, at('2026-11-06', '09:00'), '09:00').handled).toBe(false);
    expect(one({ date: '2026-11-05', remind_days: 0, notified_for: at('2026-11-04', '20:00') }, at('2026-11-05', '09:00'), '09:00').handled).toBe(false);
  });
  it('复现 M1 ②：前一天 11-04 20:00 按过，改成 11-04 的当天提醒（21:00）——日历编辑清掉了 notified_for，照样响', () => {
    // 编辑写入时 date、remind_days 变了就清 notified_for、snooze_at（event-edit.test.ts 查写入那一半）
    expect(one({ date: '2026-11-04', remind_days: 0, notified_for: null }, at('2026-11-04', '21:00'), '21:00').handled).toBe(false);
  });
  it('只改默认时刻仍算已处理；前一天提醒也按同一天比（方案第 5 节，主持人 11-05 定，和服务器 sameRemindDay 同口径）', () => {
    expect(one({ notified_for: at(DAY, '07:00') }, at(DAY, '07:20'), '07:20').handled).toBe(true);
    expect(one({ date: '2026-11-04', remind_days: 1, notified_for: at(DAY, '20:00') }, at(DAY, '20:00'), '09:00').handled).toBe(true);
    // 同一天的别的时刻（例如换时区以后前一天 20:00 换算成了别的时刻）也算处理过，不多响
    expect(one({ date: '2026-11-04', remind_days: 1, notified_for: at(DAY, '09:00') }, at(DAY, '20:00'), '09:00').handled).toBe(true);
    // 不同一天的不算
    expect(one({ date: '2026-11-04', remind_days: 1, notified_for: at('2026-11-02', '20:00') }, at(DAY, '20:00'), '09:00').handled).toBe(false);
  });
  it('③ current_tz 变了：occurrenceKey 不变；“知道了”按新的 current_tz 算日期（首尔 11-03 09:00 = 洛杉矶 11-02，换到洛杉矶算没处理）', () => {
    const seoul = one({ notified_for: at(DAY, '09:00') }, at(DAY, '09:00'), '09:00');
    const la = one({ notified_for: at(DAY, '09:00') }, at(DAY, '09:00', LA), '09:00', LA);
    expect(occurrenceKey(seoul)).toBe(occurrenceKey(la));
    expect(seoul.handled).toBe(true);
    expect(la.handled).toBe(false);
  });
});

describe('R-336 ②：响过没按“知道了”，改了默认时刻 → 进“错过的提醒”，显示当时实际响的时刻', () => {
  it('07:00 响过，改成 07:20 或 21:00：马上进错过的提醒，时刻是 07:00；横幅不出', () => {
    const rang = new Map<string, Rang>();
    const first = ringing(allReminders([allDay(1)], [], at(DAY, '07:00'), SEOUL, null, '07:00'), at(DAY, '07:00'), at(DAY, '06:00'), new Set(), rang);
    for (const r of first) rang.set(occurrenceKey(r), { tag: r.tag, dueAt: r.dueAt });
    for (const setTo of ['07:20', '21:00']) {
      const l = allReminders([allDay(1)], [], at(DAY, '07:10'), SEOUL, null, setTo);
      expect(ringing(l, at(DAY, '07:10'), at(DAY, '06:00'), new Set(), rang)).toEqual([]);
      const m = missed(l, at(DAY, '07:10'), new Set(), rang);
      expect(m.map((r) => r.dueAt)).toEqual([at(DAY, '07:00')]);
    }
    // 按过“知道了”的不进
    const acked = allReminders([allDay(1, { notified_for: at(DAY, '07:00') })], [], at(DAY, '07:10'), SEOUL, null, '07:20');
    expect(missed(acked, at(DAY, '07:10'), new Set(), rang)).toEqual([]);
    // 没改默认时刻：还在横幅里，不进错过的提醒
    const same = allReminders([allDay(1)], [], at(DAY, '07:10'), SEOUL, null, '07:00');
    expect(missed(same, at(DAY, '07:10'), new Set(first.map((r) => r.tag)), rang)).toEqual([]);
  });
});

describe('R-336 ①：改了默认时刻，已经弹出的通知不撤回（手机、网页和 exe 一致）', () => {
  const id = allDay(1).id;
  const shownAt = { kind: 'event', id, dueAt: at(DAY, '07:00') };
  it('同一次、没处理：不撤；按过“知道了”、挪了日期：撤', () => {
    const l = allReminders([allDay(1)], [], at(DAY, '07:10'), SEOUL, null, '07:20');
    expect(shouldCloseShown(shownAt, l, true, SEOUL)).toBe(false);
    const acked = allReminders([allDay(1, { notified_for: at(DAY, '07:20') })], [], at(DAY, '07:10'), SEOUL, null, '07:20');
    expect(shouldCloseShown(shownAt, acked, true, SEOUL)).toBe(true);
    const moved = allReminders([allDay(1, { date: '2026-11-04' })], [], at(DAY, '07:10'), SEOUL, null, '07:20');
    expect(shouldCloseShown(shownAt, moved, true, SEOUL)).toBe(true);
  });
  it('审查 L7：11-05 当天 09:00 弹过“今天 · X”，挪到 11-06 改成前一天提醒（11-05 20:00）：提醒日同是 11-05，也要撤旧的', () => {
    const old = { kind: 'event', id, dueAt: at('2026-11-05', '09:00') };
    const l = allReminders([allDay(1, { date: '2026-11-06', remind_days: 1 })], [], at('2026-11-05', '10:00'), SEOUL, null, '09:00');
    expect(shouldCloseShown(old, l, true, SEOUL)).toBe(true);
    // 同一次的前一天提醒（tag 对得上）不撤
    expect(shouldCloseShown({ kind: 'event', id, dueAt: at('2026-11-05', '20:00') }, l, true, SEOUL)).toBe(false);
  });
  it('有时刻的日程照旧：tag 对不上就撤', () => {
    const timed = { ...allDay(2), time: '15:00', tz: SEOUL, remind_min: 15 };
    const l = allReminders([timed], [], at(DAY, '14:00'), SEOUL);
    expect(shouldCloseShown({ kind: 'event', id: timed.id, dueAt: at(DAY, '14:30') }, l, true, SEOUL)).toBe(true);
  });
});
