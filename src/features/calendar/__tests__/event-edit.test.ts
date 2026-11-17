// 日程编辑页的规则（data/event-edit.ts；架构 4.6 时区规则、D7 时区白名单）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { eventsWrite } from '../../../../shared/schema/rows.ts';
import { placeEvent } from '../../../../shared/logic/calendar/event-span.ts';
import {
  allDayDurationOf, allDayDurationTo, allDayLastOf, durationTo, emptyForm, endAtOf, EVENT_TIMING_COLS, timedDurationOf, formOf, hasRemind, localOf, newEventRow, normalize, patchOf, prevRemindAtOf, tzAllowed, tzChoices,
  type EventForm,
} from '../data/event-edit.ts';
import type { EventRemindRow } from '../../../../shared/logic/remind.ts';

const ID = '00000000-0000-4000-8000-000000000002';
const SEOUL = 'Asia/Seoul';
const SH = 'Asia/Shanghai';
const NY = 'America/New_York';
const base = (over: Partial<EventForm> = {}): EventForm => ({ ...emptyForm('2026-11-05', SEOUL), title: '客户反馈会', ...over });

describe('normalize：全天 / 有时刻', () => {
  it('改成全天：不存时区；改回有时刻：没有时区就用本机的', () => {
    expect(normalize(base({ time: null }), SH)).toMatchObject({ time: null, tz: null });
    expect(normalize({ ...base(), time: '10:00', tz: null }, SH)).toMatchObject({ time: '10:00', tz: SH });
    expect(normalize(base({ time: '10:00' }), SH).tz).toBe(SEOUL);
  });
});

describe('时长、结束日期和时刻（R-444 跨天）', () => {
  it('同一天只改结束时刻：晚于开始是差值；不晚于开始照旧算到第二天', () => {
    const f = base({ time: '15:30' });
    expect(durationTo(f, '2026-11-05', '16:30', SH)).toBe(60);
    expect(durationTo(base({ time: '23:00' }), '2026-11-05', '01:00', SH)).toBe(120);
    expect(durationTo(base({ time: '09:00' }), '2026-11-05', '09:00', SH)).toBe(1440);
  });

  it('选了别的结束日期：按日程自己的时区算真实分钟；早于开始日期按开始那天；最多 31 天', () => {
    const f = base({ time: '09:00', tz: SEOUL });
    expect(durationTo(f, '2026-11-07', '18:00', SH)).toBe(2 * 1440 + 9 * 60);
    expect(durationTo(f, '2026-11-01', '10:00', SH)).toBe(60);
    // 第二轮评审建议 4：超过上限（31 天）不悄悄截短，原样返回，由写入校验拒掉、编辑页提示
    expect(durationTo(f, '2027-01-01', '09:00', SH)).toBe(57 * 1440);
  });

  it('夏令时那天按墙上时间算（评审第 3 条）：洛杉矶 3-08 拨快 1 小时', () => {
    const LA = 'America/Los_Angeles';
    // 3-08 01:00 开始、结束时刻选 00:30（不晚于开始，算到第二天）：真实只过了 22.5 小时，原来 −30 + 1440 = 1410 多算 1 小时
    expect(durationTo(base({ date: '2026-03-08', time: '01:00', tz: LA }), '2026-03-08', '00:30', LA)).toBe(22 * 60 + 30);
    expect(durationTo(base({ date: '2026-03-07', time: '09:00', tz: LA }), '2026-03-08', '09:00', LA)).toBe(23 * 60);
  });

  it('endAtOf：结束在日程自己时区的哪天几点（跨午夜、跨多天）；全天为 null', () => {
    expect(endAtOf(base({ time: '23:30', duration_min: 90 }), SH)).toEqual({ date: '2026-11-06', time: '01:00' });
    expect(endAtOf(base({ time: '15:30', duration_min: 60 }), SH)).toEqual({ date: '2026-11-05', time: '16:30' });
    expect(endAtOf(base({ time: '09:00', duration_min: 2 * 1440 + 540 }), SH)).toEqual({ date: '2026-11-07', time: '18:00' });
    expect(endAtOf(base({ time: null }), SH)).toBeNull();
  });

  it('endAtOf 出错返回 null、不抛（评审第 10 条）：日期坏了、时刻坏了、时区算不出来', () => {
    expect(endAtOf(base({ date: '' }), SH)).toBeNull();
    expect(endAtOf(base({ time: '9点' }), SH)).toBeNull();
    expect(() => endAtOf(base({ tz: null }), 'Bad/Zone')).not.toThrow();
    expect(endAtOf(base({ tz: null }), 'Bad/Zone')).toBeNull();
  });

  it('全天：最后一天 ↔ 天数 × 1440；旧行（60）是一天；最多 31 天', () => {
    expect(allDayLastOf(base({ time: null, duration_min: 60 }))).toBe('2026-11-05');
    expect(allDayLastOf(base({ time: null, duration_min: 3 * 1440 }))).toBe('2026-11-07');
    expect(allDayDurationTo('2026-11-05', '2026-11-07')).toBe(3 * 1440);
    // 只选一天写默认 1 小时，不写 1440（评审第 1 条）
    expect(allDayDurationTo('2026-11-05', '2026-11-05')).toBe(60);
    expect(allDayDurationTo('2026-11-05', '2026-11-01')).toBe(60);
    expect(allDayDurationTo('2026-11-05', '2027-03-01')).toBe(31 * 1440);
  });

  it('全天 ↔ 有时刻切换：不超过一天的算一天、时长不动；超过一天的按占几天记；切回有时刻到最后一天同一时刻再过 1 小时', () => {
    expect(allDayDurationOf(base({ time: '09:00', duration_min: 60 }), SH)).toBe(60);
    // 评审第 2 条：23:00 开始 90 分钟、22:00 开始 1440 分钟都只是一天，不变成 2880；第二轮建议 2：一天一律记 allDayDuration(1)（默认 60）
    expect(allDayDurationOf(base({ time: '23:00', duration_min: 90 }), SH)).toBe(60);
    expect(allDayDurationOf(base({ time: '22:00', duration_min: 1440 }), SH)).toBe(60);
    expect(allDayDurationOf(base({ time: null, duration_min: 3 * 1440 }), SH)).toBe(3 * 1440);
    expect(allDayDurationOf(base({ time: '22:00', duration_min: 1500 }), SH)).toBe(2 * 1440);
    expect(allDayDurationOf(base({ time: '09:00', duration_min: 2 * 1440 + 540 }), SH)).toBe(3 * 1440);
    const nine = base({ time: '09:00' });
    expect(timedDurationOf(nine, 60, SH)).toBe(60);
    // 评审第 1 条：只占一天的（含旧的全天行 1440）一律回默认 1 小时
    expect(timedDurationOf(nine, 1440, SH)).toBe(60);
    expect(timedDurationOf(nine, 90, SH)).toBe(60);
    expect(timedDurationOf(nine, 3 * 1440, SH)).toBe(2 * 1440 + 60);
    // 第三轮复审建议 2：23:30 开始、3 天：最后一天同一时刻再过 1 小时会落到第 4 天，截到第 3 天的 24:00
    const late = base({ time: '23:30' });
    const d = timedDurationOf(late, 3 * 1440, SH);
    expect(d).toBe(2 * 1440 + 30);
    expect(placeEvent({ ...late, duration_min: d }, SH)).toMatchObject({ date: '2026-11-05', lastDate: '2026-11-07' });
  });

  it('全天 → 有时刻按墙上时间算（第二轮建议 1）：纽约 11-01 夏令时结束那天多 1 小时，结束照样落在最后一天 10:00', () => {
    const f = base({ date: '2026-10-31', time: '09:00', tz: NY });
    const dur = timedDurationOf(f, 3 * 1440, NY);
    expect(dur).toBe(2 * 1440 + 60 + 60);
    expect(endAtOf({ ...f, duration_min: dur }, NY)).toEqual({ date: '2026-11-02', time: '10:00' });
  });

  it('formOf：超过 1 天的时长照原值读出来（原来超过 1440 会变回 60）；超过 31 天的坏值按 60', () => {
    expect(formOf({ date: '2026-11-05', time: '09:00', tz: SEOUL, duration_min: 4320 }).duration_min).toBe(4320);
    expect(formOf({ date: '2026-11-05', time: '09:00', tz: SEOUL, duration_min: 44641 }).duration_min).toBe(60);
  });
});

describe('时区（D7）', () => {
  const list = () => ['Asia/Seoul', 'Asia/Shanghai', 'America/Los_Angeles'];

  it('只让选 Intl 支持的；原来存的值不在表里也照样列出、照样能留着', () => {
    expect(tzChoices(['Etc/Legacy', null], list)).toEqual(['America/Los_Angeles', 'Asia/Seoul', 'Asia/Shanghai', 'Etc/Legacy']);
    expect(tzAllowed('Asia/Shanghai', null, list)).toBe(true);
    expect(tzAllowed('Mars/Base', null, list)).toBe(false);
    expect(tzAllowed('Europe/Paris', null, list)).toBe(false);
    expect(tzAllowed('Etc/Legacy', 'Etc/Legacy', list)).toBe(true);
    // 本机时区放在 keep 里：Intl 表里没有（例如 'UTC'）也能写
    expect(tzAllowed('UTC', null, list)).toBe(false);
    expect(tzAllowed('UTC', [null, 'UTC'], list)).toBe(true);
  });

  it('真实的 Intl 表里有首尔和上海', () => {
    expect(tzChoices()).toContain(SEOUL);
    expect(tzChoices()).toContain(SH);
  });
});

describe('localOf：和当前时区不同时写出“在你这里是几点”', () => {
  it('首尔 15:00 的会，人在上海：同一天 14:00', () => {
    expect(localOf(base({ time: '15:00', tz: SEOUL }), SH)).toEqual({ date: '2026-11-05', time: '14:00' });
  });

  it('跨日：首尔 00:30 在上海是前一天 23:30', () => {
    expect(localOf(base({ time: '00:30', tz: SEOUL }), SH)).toEqual({ date: '2026-11-04', time: '23:30' });
  });

  it('同一个时区、全天：不写', () => {
    expect(localOf(base({ time: '15:00', tz: SEOUL }), SEOUL)).toBeNull();
    expect(localOf(base({ time: null, tz: null }), SH)).toBeNull();
  });
});

describe('patchOf', () => {
  const row = { id: ID, short_by: null };

  it('改了时刻：tz 一起带上（库的约束：有时刻必须有时区）', () => {
    const prev = base({ time: null, tz: null });
    const next = normalize({ ...prev, time: '09:00' }, SEOUL);
    // 全天 → 有时刻：和服务器触发器同一口径，同时清掉 notified_for、snooze_at（审查 M1）
    expect(patchOf(row, prev, next, 5)).toEqual({ time: '09:00', tz: SEOUL, notified_for: null, snooze_at: null, updated_at: 5 });
  });

  it('改标题：AI 起的简称清掉', () => {
    const f = base();
    expect(patchOf({ id: ID, short_by: 'ai' }, f, { ...f, title: 'x' }, 5)).toEqual({ title: 'x', short: null, short_by: null, updated_at: 5 });
  });

  it('没变：null', () => {
    expect(patchOf(row, base(), base(), 5)).toBeNull();
  });

  it('换了一次提醒（日期或当天 / 前一天变了）：同一次写入清掉 notified_for、snooze_at（审查 M1）', () => {
    const allDayForm = normalize(base({ time: null, remind_days: 0 }), SEOUL);
    expect(patchOf(row, allDayForm, { ...allDayForm, date: '2026-11-06', remind_days: 1 }, 5)).toMatchObject({ date: '2026-11-06', remind_days: 1, notified_for: null, snooze_at: null });
    expect(patchOf(row, allDayForm, { ...allDayForm, remind_days: 1 }, 5)).toMatchObject({ remind_days: 1, notified_for: null, snooze_at: null });
    expect(patchOf(row, allDayForm, { ...allDayForm, date: '2026-11-04' }, 5)).toMatchObject({ date: '2026-11-04', notified_for: null, snooze_at: null });
    // time 在空和非空之间切换（和服务器触发器同一口径）
    expect(patchOf(row, allDayForm, normalize({ ...allDayForm, time: '09:00' }, SEOUL), 5)).toMatchObject({ time: '09:00', notified_for: null, snooze_at: null });
    const timed = base({ time: '10:00', tz: SEOUL });
    expect(patchOf(row, timed, normalize({ ...timed, time: null }, SEOUL), 5)).toMatchObject({ time: null, notified_for: null, snooze_at: null });
    const moved = patchOf(row, timed, { ...timed, time: '11:00' }, 5);
    expect(moved && 'notified_for' in moved).toBe(false);
    const titleOnly = patchOf(row, allDayForm, { ...allDayForm, title: 'x' }, 5);
    expect(titleOnly && 'notified_for' in titleOnly).toBe(false);
  });
});

describe('newEventRow：过得了校验；formOf 回到同一份', () => {
  it('有时刻、全天都合格', () => {
    for (const f of [base(), normalize(base({ time: null, remind_days: 1 }), SEOUL)]) {
      const r = newEventRow(ID, f, 1_800_000_000_000);
      expect(eventsWrite.safeParse({ ...r, deleted_at: null, undone: false }).success).toBe(true);
      expect(formOf(r)).toEqual(f);
    }
  });

  it('坏值按默认：时长越界回 60、提醒值不认识回 null', () => {
    expect(formOf({ id: ID, title: 't', date: '2026-11-05', time: '10:00', tz: SEOUL, duration_min: 0, remind_min: 45 })).toMatchObject({
      duration_min: 60, remind_min: null,
    });
  });
});

describe('hasRemind：固定时刻按日程自己的时区（shared 的 remindAtOf）', () => {
  const now = msAt('2026-11-01', 0, SEOUL);
  const timed = base({ time: '15:00', tz: SEOUL, remind_min: 15 });
  const remindAt = msAt('2026-11-05', 15 * 60 - 15, SEOUL);
  const rowOf = (form: EventForm, extra: Record<string, unknown> = {}) => ({ ...newEventRow(ID, form, 1), deleted_at: null, ...extra });
  const save = (row: Record<string, unknown>, next: EventForm, at: number) => {
    const prev = formOf(row);
    const n = normalize(next, SEOUL);
    const data = patchOf(row, prev, n, at);
    return { data, flag: hasRemind({ row, data, prev, next: n, tz: SH, now: at }) };
  };

  it('新建：有时刻、设了提醒 → 响；不提醒 → 不响；全天日程设了 remind_days → 响，remind_days 为 null → 不响', () => {
    const ins = (form: EventForm) => hasRemind({ row: undefined, data: null, prev: null, next: form, tz: SH, now });
    expect(ins(timed)).toBe(true);
    expect(ins(base({ remind_min: null }))).toBe(false);
    expect(ins(normalize(base({ time: null, remind_days: 0 }), SEOUL))).toBe(true);
    expect(ins(normalize(base({ time: null, remind_days: 1 }), SEOUL))).toBe(true);
    expect(ins(normalize(base({ time: null, remind_days: null }), SEOUL))).toBe(false);
  });

  it('全天日程的当天提醒：拿不到 remind.default_time，当天结束前都算会响（用户设 21:00 时上午改也带标记；代码审查 L1）', () => {
    const allDay = normalize(base({ time: null, remind_days: 0 }), SEOUL);
    const ins = (at: number) => hasRemind({ row: undefined, data: null, prev: null, next: allDay, tz: SH, now: at });
    expect(ins(msAt('2026-11-05', 10 * 60, SH))).toBe(true);         // 09:00 已过，用户的 21:00 还没到
    expect(ins(msAt('2026-11-05', 23 * 60 + 50, SH))).toBe(true);
    expect(ins(msAt('2026-11-06', 5, SH))).toBe(false);              // 日程那天已过（超过 2 分钟宽限）
  });

  it('prevRemindAtOf：新建、改 date / time / tz / remind_min / remind_days 不传，其余传 remind_at（没有就 null）', () => {
    const row = rowOf(timed, { remind_at: remindAt });
    expect(prevRemindAtOf(row, null)).toBeUndefined();
    for (const data of [{ date: '2026-11-06' }, { time: '16:00' }, { tz: SH }, { remind_min: 30 }, { remind_days: 1 }, { time: null, tz: null }, { title: 'x', date: '2026-11-06' }]) {
      expect(prevRemindAtOf(row, { ...data, updated_at: 5 })).toBeUndefined();
    }
    for (const data of [{ title: 'x' }, { duration_min: 90 }, { location: 'L' }, { project: 'P' }, { note: 'n' }, { deleted_at: 5 }, { deleted_at: null }]) {
      expect(prevRemindAtOf(row, { ...data, updated_at: 5 })).toBe(remindAt);
    }
    expect(prevRemindAtOf(rowOf(timed), { note: 'n', updated_at: 5 })).toBeNull();
  });

  it('改备注、改时刻：照常带标记；撤掉还没到的提醒（改成不提醒、改成全天）也带（S2）', () => {
    const row = rowOf(timed, { remind_at: remindAt });
    expect(save(row, { ...timed, note: 'x' }, now).flag).toBe(true);
    expect(save(row, { ...timed, time: '16:00' }, now).flag).toBe(true);
    expect(save(row, { ...timed, remind_min: null }, now).flag).toBe(true);
    expect(save(row, { ...timed, time: null }, now).flag).toBe(true);
    // 已经过了的日程：撤掉提醒不用提前发
    const after = msAt('2026-11-06', 0, SEOUL);
    expect(save(row, { ...timed, remind_min: null }, after).flag).toBe(false);
    // 本来就不响：改备注不带
    const quiet = rowOf(base({ remind_min: null }));
    expect(save(quiet, { ...base({ remind_min: null }), note: 'x' }, now).flag).toBe(false);
  });

  it('删除 / 撤销删除也算标记（补审改法 ④）', () => {
    expect(hasRemind({ row: rowOf(timed), data: { deleted_at: now }, prev: timed, next: timed, tz: SH, now })).toBe(true);
    expect(hasRemind({ row: rowOf(timed, { deleted_at: 3 }), data: { deleted_at: null }, prev: timed, next: timed, tz: SH, now })).toBe(true);
    const after = msAt('2026-11-06', 0, SEOUL);
    expect(hasRemind({ row: rowOf(timed), data: { deleted_at: after }, prev: timed, next: timed, tz: SH, now: after })).toBe(false);
  });

  it('EVENT_TIMING_COLS 和 EventRemindRow 里决定提醒时刻的字段一致（shared 加字段时这里编译不过）', () => {
    const decides: Record<keyof EventRemindRow, boolean> = { date: true, time: true, tz: true, remind_min: true, remind_days: true, deleted_at: false };
    expect([...EVENT_TIMING_COLS].sort()).toEqual(Object.entries(decides).filter(([, v]) => v).map(([k]) => k).sort());
  });
});

