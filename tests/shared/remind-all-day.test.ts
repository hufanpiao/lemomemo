// 全天日程的提醒时刻（shared/logic/remind.ts 的 allDayRemindAt / remindAtOf('event', …)）：
// 架构 4.6（全天日程是浮动时刻，按 current_tz）、数据字典 4.8 remind_days in (0, 1)、架构 0.29 续第 45、47、57 条（当天 = remind.default_time，
// 前一天 20:00）、TC-B2-63④。函数只认传进来的 tz 和 now：Node（test:tz 三个进程时区）和 Deno（deno task test）结果一样。
// 期望值一律用 Date.UTC 直接写出（不经 msAt），夏令时切换日的偏移量写死核对
import { describe, expect, it } from 'vitest';
import {
  ALL_DAY_EVE_TIME, allDayRemindAt, allDayTimeOf, applyDnd, DEFAULT_REMIND_TIME, eventRemindAt, remindAtOf, type EventRemindRow,
} from '../../shared/logic/remind.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
const UTC = 'UTC';
const H = 3_600_000;
/** 某天 UTC 的 hh:mm */
const utc = (y: number, mo: number, d: number, h: number, m = 0): number => Date.UTC(y, mo - 1, d, h, m);
const ev = (over: Partial<EventRemindRow>): EventRemindRow => ({ date: '2026-11-05', time: null, tz: null, remind_min: null, remind_days: 0, deleted_at: null, ...over });

describe('全天日程：当天（remind_days = 0）在 remind.default_time 提醒，按 current_tz', () => {
  it('default_time 08:30：首尔 08:30 = UTC 前一天 23:30；洛杉矶（11-05 已是 PST，−8）08:30 = UTC 16:30；UTC 08:30', () => {
    expect(allDayRemindAt(ev({}), SEOUL, '08:30')).toBe(utc(2026, 11, 4, 23, 30));
    expect(allDayRemindAt(ev({}), LA, '08:30')).toBe(utc(2026, 11, 5, 16, 30));
    expect(allDayRemindAt(ev({}), UTC, '08:30')).toBe(utc(2026, 11, 5, 8, 30));
  });
  it('default_time 没设或认不出：回落出厂 09:00（undefined、null、空串、"9:00"、"24:00"、数字、对象都按 09:00）', () => {
    expect(DEFAULT_REMIND_TIME).toBe('09:00');
    const nine = utc(2026, 11, 5, 0);   // 首尔 09:00
    for (const v of [undefined, null, '', '9:00', '24:00', 540, { hm: '08:00' }]) {
      expect(allDayTimeOf(v)).toBe('09:00');
      expect(allDayRemindAt(ev({}), SEOUL, v)).toBe(nine);
    }
    expect(allDayRemindAt(ev({}), SEOUL)).toBe(nine);
  });
  it('浮动：同一条在三个时区算出各自的墙上时间，换了地方提醒跟着人走', () => {
    const xs = [SEOUL, LA, UTC].map((tz) => allDayRemindAt(ev({}), tz, '09:00'));
    expect(xs).toEqual([utc(2026, 11, 5, 0), utc(2026, 11, 5, 17), utc(2026, 11, 5, 9)]);
  });
});

describe('全天日程：前一天（remind_days = 1）20:00，跨月、跨年', () => {
  it('前一天 20:00 不跟 default_time 走（v3 已定、架构 0.29 续第 45、47 条和 TC-B2-63④ 沿用）', () => {
    expect(ALL_DAY_EVE_TIME).toBe('20:00');
    expect(allDayRemindAt(ev({ remind_days: 1 }), SEOUL, '08:30')).toBe(utc(2026, 11, 4, 11));
  });
  it('跨月：12-01 的全天日程 → 11-30 20:00（首尔 = UTC 11:00）', () => {
    expect(allDayRemindAt(ev({ date: '2026-12-01', remind_days: 1 }), SEOUL)).toBe(utc(2026, 11, 30, 11));
  });
  it('跨年：2027-01-01 → 2026-12-31 20:00；洛杉矶（PST）= UTC 2027-01-01 04:00；当天提醒 2027-01-01 09:00 UTC', () => {
    expect(allDayRemindAt(ev({ date: '2027-01-01', remind_days: 1 }), LA)).toBe(utc(2027, 1, 1, 4));
    expect(allDayRemindAt(ev({ date: '2027-01-01', remind_days: 1 }), UTC)).toBe(utc(2026, 12, 31, 20));
    expect(allDayRemindAt(ev({ date: '2027-01-01', remind_days: 0 }), UTC)).toBe(utc(2027, 1, 1, 9));
  });
  it('闰年 2028-03-01 的前一天是 02-29', () => {
    expect(allDayRemindAt(ev({ date: '2028-03-01', remind_days: 1 }), UTC)).toBe(utc(2028, 2, 29, 20));
  });
  it('提前多天：数据字典约束 remind_days in (0, 1)，2、7、−1 这类不合约束的值不提醒（null），不自己外推', () => {
    expect(allDayRemindAt(ev({ remind_days: 2 }), SEOUL)).toBeNull();
    expect(allDayRemindAt(ev({ remind_days: 7 }), SEOUL)).toBeNull();
    expect(allDayRemindAt(ev({ remind_days: -1 }), SEOUL)).toBeNull();
  });
});

describe('洛杉矶夏令时切换日', () => {
  it('2026-03-08 拨快（02:00 → 03:00）：当天 09:00 已是 PDT（−7）= UTC 16:00；前一天（03-07，PST）20:00 = UTC 03-08 04:00', () => {
    expect(allDayRemindAt(ev({ date: '2026-03-08' }), LA)).toBe(utc(2026, 3, 8, 16));
    expect(allDayRemindAt(ev({ date: '2026-03-08', remind_days: 1 }), LA)).toBe(utc(2026, 3, 8, 4));
  });
  it('2026-03-09 的前一天提醒落在切换日 03-08 20:00（PDT）= UTC 03-09 03:00，和前一天的提醒只差 23 小时', () => {
    const r = allDayRemindAt(ev({ date: '2026-03-09', remind_days: 1 }), LA);
    expect(r).toBe(utc(2026, 3, 9, 3));
    expect((r ?? 0) - (allDayRemindAt(ev({ date: '2026-03-08', remind_days: 1 }), LA) ?? 0)).toBe(23 * H);
  });
  it('default_time 落进拨快跳过的那段（02:30）：按 msAt 的规则算拨快后的 03:30 PDT = UTC 10:30', () => {
    expect(allDayRemindAt(ev({ date: '2026-03-08' }), LA, '02:30')).toBe(utc(2026, 3, 8, 10, 30));
  });
  it('2026-11-01 拨慢（02:00 → 01:00）：01:30 出现两次取先出现的一次（PDT）= UTC 08:30；当天 09:00 已是 PST = UTC 17:00', () => {
    expect(allDayRemindAt(ev({ date: '2026-11-01' }), LA, '01:30')).toBe(utc(2026, 11, 1, 8, 30));
    expect(allDayRemindAt(ev({ date: '2026-11-01' }), LA)).toBe(utc(2026, 11, 1, 17));
    expect(allDayRemindAt(ev({ date: '2026-11-02', remind_days: 1 }), LA)).toBe(utc(2026, 11, 2, 4));
  });
});

describe('已过时：不回落，传不传 prevRemindAt 都原样返回算出的时刻（签名约定：prevRemindAt 只对待办有意义）', () => {
  const row = ev({ remind_days: 0 });
  const nine = utc(2026, 11, 5, 0);
  const now = utc(2026, 11, 5, 3);   // 首尔 12:00，当天 09:00 已过
  it('① 新建（不传 prevRemindAt）：返回已过的 09:00，不改到别的时刻', () => {
    expect(remindAtOf('event', row, SEOUL, now)).toBe(nine);
  });
  it('② 其余重算（传这一行现在的 remind_at，含 null）：同样返回 09:00', () => {
    expect(remindAtOf('event', row, SEOUL, now, nine)).toBe(nine);
    expect(remindAtOf('event', row, SEOUL, now, null)).toBe(nine);
    expect(remindAtOf('event', row, SEOUL, now, 123)).toBe(nine);
  });
  it('日程整天都过了（第二天）也一样返回算出的时刻，还推不推由调用方的窗口决定', () => {
    expect(remindAtOf('event', row, SEOUL, utc(2026, 11, 7, 0))).toBe(nine);
  });
});

describe('remindAtOf 分派和兼容', () => {
  it('第 6 个参数传 remind.default_time；不传（5 个参数的调用）时按出厂 09:00', () => {
    expect(remindAtOf('event', ev({}), SEOUL, 0, null, '07:15')).toBe(utc(2026, 11, 4, 22, 15));
    expect(remindAtOf('event', ev({}), SEOUL, 0, null)).toBe(utc(2026, 11, 5, 0));
  });
  it('remind_days 为 null 或缺这一列、已删除：不提醒；只传一行不传 tz 的旧调用仍返回 null', () => {
    expect(remindAtOf('event', ev({ remind_days: null }), SEOUL, 0)).toBeNull();
    const { remind_days: _drop, ...noDays } = ev({});
    expect(remindAtOf('event', noDays, SEOUL, 0)).toBeNull();
    expect(remindAtOf('event', ev({ deleted_at: 5 }), SEOUL, 0)).toBeNull();
    expect(eventRemindAt(ev({}))).toBeNull();
  });
  it('有时刻的日程不看 remind_days 和 default_time', () => {
    const fixed = ev({ time: '15:00', tz: SEOUL, remind_min: 15, remind_days: 1 });
    expect(remindAtOf('event', fixed, LA, 0, null, '07:00')).toBe(utc(2026, 11, 5, 5, 45));
  });
});

describe('免打扰照推迟（按 current_tz）', () => {
  it('前一天 20:00 落进 19:00–07:00 的免打扰：推迟到日程当天 07:00', () => {
    const r = allDayRemindAt(ev({ remind_days: 1 }), SEOUL);
    expect(r).toBe(utc(2026, 11, 4, 11));
    expect(applyDnd(r ?? 0, SEOUL, { start: '19:00', end: '07:00' })).toBe(utc(2026, 11, 4, 22));
  });
  it('当天 09:00 不在 23:00–08:00 里：不推迟；default_time 07:30 在里面：推迟到 08:00', () => {
    const r = allDayRemindAt(ev({}), SEOUL) ?? 0;
    expect(applyDnd(r, SEOUL, { start: '23:00', end: '08:00' })).toBe(r);
    const early = allDayRemindAt(ev({}), SEOUL, '07:30') ?? 0;
    expect(applyDnd(early, SEOUL, { start: '23:00', end: '08:00' })).toBe(utc(2026, 11, 4, 23));
  });
});
