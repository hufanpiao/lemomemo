// 日程编辑页的规则（data/event-edit.ts；架构 4.6 时区规则、D7 时区白名单）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { eventsWrite } from '../../../../shared/schema/rows.ts';
import {
  durationOf, emptyForm, endOf, EVENT_TIMING_COLS, formOf, hasRemind, localOf, newEventRow, normalize, patchOf, prevRemindAtOf, tzAllowed, tzChoices,
  type EventForm,
} from '../data/event-edit.ts';
import type { EventRemindRow } from '../../../../shared/logic/remind.ts';

const ID = '00000000-0000-4000-8000-000000000002';
const SEOUL = 'Asia/Seoul';
const SH = 'Asia/Shanghai';
const base = (over: Partial<EventForm> = {}): EventForm => ({ ...emptyForm('2026-11-05', SEOUL), title: '客户反馈会', ...over });

describe('normalize：全天 / 有时刻', () => {
  it('改成全天：不存时区；改回有时刻：没有时区就用本机的', () => {
    expect(normalize(base({ time: null }), SH)).toMatchObject({ time: null, tz: null });
    expect(normalize({ ...base(), time: '10:00', tz: null }, SH)).toMatchObject({ time: '10:00', tz: SH });
    expect(normalize(base({ time: '10:00' }), SH).tz).toBe(SEOUL);
  });
});

describe('时长', () => {
  it('结束晚于开始：差值；不晚于开始：算到第二天；上限 1 天', () => {
    expect(durationOf('15:30', '16:30')).toBe(60);
    expect(durationOf('23:00', '01:00')).toBe(120);
    expect(durationOf('09:00', '09:00')).toBe(1440);
    expect(endOf('23:30', 90)).toBe('01:00');
    expect(endOf('15:30', 60)).toBe('16:30');
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
    expect(patchOf(row, prev, next, 5)).toEqual({ time: '09:00', tz: SEOUL, updated_at: 5 });
  });

  it('改标题：AI 起的简称清掉', () => {
    const f = base();
    expect(patchOf({ id: ID, short_by: 'ai' }, f, { ...f, title: 'x' }, 5)).toEqual({ title: 'x', short: null, short_by: null, updated_at: 5 });
  });

  it('没变：null', () => {
    expect(patchOf(row, base(), base(), 5)).toBeNull();
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

  it('新建：有时刻、设了提醒 → 响；不提醒、全天（shared 还没有这一支）→ 不响', () => {
    const ins = (form: EventForm) => hasRemind({ row: undefined, data: null, prev: null, next: form, tz: SH, now });
    expect(ins(timed)).toBe(true);
    expect(ins(base({ remind_min: null }))).toBe(false);
    expect(ins(normalize(base({ time: null, remind_days: 0 }), SEOUL))).toBe(false);
  });

  it('prevRemindAtOf：新建、改 date / time / tz / remind_min 不传，其余传 remind_at（没有就 null）', () => {
    const row = rowOf(timed, { remind_at: remindAt });
    expect(prevRemindAtOf(row, null)).toBeUndefined();
    for (const data of [{ date: '2026-11-06' }, { time: '16:00' }, { tz: SH }, { remind_min: 30 }, { time: null, tz: null }, { title: 'x', date: '2026-11-06' }]) {
      expect(prevRemindAtOf(row, { ...data, updated_at: 5 })).toBeUndefined();
    }
    for (const data of [{ title: 'x' }, { duration_min: 90 }, { remind_days: 1 }, { location: 'L' }, { project: 'P' }, { note: 'n' }, { deleted_at: 5 }, { deleted_at: null }]) {
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
    const decides: Record<keyof EventRemindRow, boolean> = { date: true, time: true, tz: true, remind_min: true, deleted_at: false };
    expect([...EVENT_TIMING_COLS].sort()).toEqual(Object.entries(decides).filter(([, v]) => v).map(([k]) => k).sort());
  });
});
