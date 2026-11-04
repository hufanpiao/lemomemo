// shared/logic/remind-actions.ts（TC-B2-21；架构 5.9“按类型区分的提醒按钮”、0.29 续第 47、57、122 条，R-181 按钮固定）
// 函数只认传进来的 tz 和 now，不看进程时区（test:tz 在 UTC、首尔、洛杉矶三个进程时区各跑一遍结果一样）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../shared/core/date.ts';
import { actionsFor, AT_START_MIN_LEAD_MS, startAtOf } from '../../shared/logic/remind-actions.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
const DAY = '2026-11-03';
const at = (date: string, hms: string, tz: string): number => {
  const [h, m, s] = hms.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), tz) + (s ?? 0) * 1000;
};
const keys = (xs: ReadonlyArray<{ key: string }>): string[] => xs.map((x) => x.key);

describe('TC-B2-21：待办按钮固定四个（按 current_tz）', () => {
  const dnd = { start: '22:00', end: '07:00' };
  for (const t of ['19:59:59', '20:00:00', '21:30:00', '21:49:59', '21:50:00']) {
    it(`${t} 都是“知道了 / 10 分钟后 / 1 小时后 / 明天再提醒”，没有“今晚 10 点”`, () => {
      const now = at(DAY, t, SEOUL);
      const a = actionsFor({}, 'todo', now, SEOUL, { dnd });
      expect(keys(a)).toEqual(['ack', 'snooze10', 'hour1', 'tomorrow']);
      expect(a[0]?.at).toBeNull();
      expect(a[1]?.at).toBe(now + 10 * 60_000);
      expect(a[3]?.at).toBe(at('2026-11-04', '09:00', SEOUL));
    });
  }
  it('“1 小时后”= 现在 + 60 分钟（没落进免打扰）', () => {
    const now = at(DAY, '19:59:59', SEOUL);
    expect(actionsFor({}, 'todo', now, SEOUL, { dnd })[2]?.at).toBe(now + 3_600_000);
  });
  it('21:30 点“1 小时后”（22:30 落进免打扰）推迟到免打扰结束：次日 07:00', () => {
    const now = at(DAY, '21:30:00', SEOUL);
    expect(actionsFor({}, 'todo', now, SEOUL, { dnd })[2]?.at).toBe(at('2026-11-04', '07:00', SEOUL));
  });
  it('没开免打扰：照常 + 60 分钟', () => {
    const now = at(DAY, '21:30:00', SEOUL);
    expect(actionsFor({}, 'todo', now, SEOUL)[2]?.at).toBe(now + 3_600_000);
  });
  it('“明天再提醒”按 current_tz（洛杉矶的明天 09:00）', () => {
    const now = at(DAY, '23:30:00', LA);
    expect(actionsFor({}, 'todo', now, LA)[3]?.at).toBe(at('2026-11-04', '09:00', LA));
  });
});

describe('TC-B2-21：日程“开始时再提醒”只在离开始 ≥ 60 秒时显示', () => {
  const ev = { date: DAY, time: '15:30', tz: SEOUL };
  const start = at(DAY, '15:30', SEOUL);
  it('差 60 秒：三个，开始时再提醒写 snooze_at = 开始时刻', () => {
    const a = actionsFor(ev, 'event', start - AT_START_MIN_LEAD_MS, SEOUL);
    expect(keys(a)).toEqual(['ack', 'snooze10', 'atStart']);
    expect(a[2]?.at).toBe(start);
  });
  it('差 59 秒：只剩两个，没有“5 分钟后”', () => {
    expect(keys(actionsFor(ev, 'event', start - 59_000, SEOUL))).toEqual(['ack', 'snooze10']);
  });
  it('已经开始：只剩两个', () => {
    expect(keys(actionsFor(ev, 'event', start + 60_000, SEOUL))).toEqual(['ack', 'snooze10']);
  });
});

describe('startAtOf（0.29 续第 47、57 条）', () => {
  it('固定时区：Asia/Tokyo 的日程在首尔设备上按东京时刻', () => {
    expect(startAtOf({ date: DAY, time: '10:00', tz: 'Asia/Tokyo' }, SEOUL)).toBe(at(DAY, '10:00', 'Asia/Tokyo'));
  });
  it('有时刻没 tz（浮动）：按 current_tz', () => {
    expect(startAtOf({ date: DAY, time: '10:00', tz: null }, LA)).toBe(at(DAY, '10:00', LA));
  });
  it('全天：当天的 remind.default_time（出厂 09:00，改了跟着改）', () => {
    expect(startAtOf({ date: DAY, time: null, tz: null }, SEOUL)).toBe(at(DAY, '09:00', SEOUL));
    expect(startAtOf({ date: DAY, time: null, tz: null }, SEOUL, '08:30')).toBe(at(DAY, '08:30', SEOUL));
  });
  it('全天日程：前一天 20:00 的提醒显示“开始时再提醒”（= 当天默认时刻）；当天 09:00 的提醒不显示', () => {
    const ev = { date: DAY, time: null, tz: null };
    const a = actionsFor(ev, 'event', at('2026-11-02', '20:00', SEOUL), SEOUL);
    expect(a[2]).toEqual({ key: 'atStart', at: at(DAY, '09:00', SEOUL) });
    expect(keys(actionsFor(ev, 'event', at(DAY, '09:00', SEOUL), SEOUL))).toEqual(['ack', 'snooze10']);
  });
});

describe('纪念日：知道了 / 明天再提醒 / 生成待办', () => {
  it('明天再提醒用纪念日的提醒时刻', () => {
    const now = at(DAY, '09:00', SEOUL);
    const a = actionsFor({}, 'anniv', now, SEOUL, { annivTime: '08:00' });
    expect(keys(a)).toEqual(['ack', 'tomorrow', 'genTodo']);
    expect(a[1]?.at).toBe(at('2026-11-04', '08:00', SEOUL));
  });
});
