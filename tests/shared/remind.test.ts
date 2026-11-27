// shared/logic/remind.ts（TC-B2-72；架构 0.29 续第 124 条②⑥（R-183）、4.6 时区规则、5.3 第 2 步免打扰）。
// 函数只认传进来的 tz 和 now，不看进程时区：Node（vitest，test:tz 在 UTC、首尔、洛杉矶三个进程时区各跑一遍）和 Deno（deno task test）结果一样。
// 用例里的 tz 参数也覆盖 UTC、Asia/Seoul、America/Los_Angeles 三种（含洛杉矶夏令时切换当天）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../shared/core/date.ts';
import {
  applyDnd, DEFAULT_REMIND_BEFORE_MIN, dndDeferUntil, eventRemindAt, remindAtOf, remindBeforeOnSetDueTime, REMIND_BEFORE_CHOICES, todoRemindAt,
  type TodoRemindRow,
} from '../../shared/logic/remind.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
const UTC = 'UTC';
const TODAY = '2026-11-03';
const at = (date: string, hm: string, tz: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return msAt(date, (h ?? 0) * 60 + (m ?? 0), tz);
};
const todo = (over: Partial<TodoRemindRow>): TodoRemindRow => ({
  due: TODAY, due_time: null, remind_before_min: null, remind_days: 0, remind_time: '09:00', done: false, deleted_at: null, ...over,
});

describe('TC-B2-72：有截止时刻的待办（current_tz = 首尔，现在 09:00）', () => {
  const now = at(TODAY, '09:00', SEOUL);
  it('① 新建时设 due_time 17:00、不动提前量：remind_before_min 默认 60，提醒 16:00', () => {
    expect(DEFAULT_REMIND_BEFORE_MIN).toBe(60);
    const before = remindBeforeOnSetDueTime(null, null);
    expect(before).toBe(60);
    expect(todoRemindAt(todo({ due_time: '17:00', remind_before_min: before }), SEOUL, now)).toBe(at(TODAY, '16:00', SEOUL));
  });
  it('② 提前量改成 10 分钟、2 小时、1 天、准时、不提醒：16:50、15:00、截止时刻 17:00（昨天 17:00 已过）、17:00、null', () => {
    const r = (b: number | null) => todoRemindAt(todo({ due_time: '17:00', remind_before_min: b }), SEOUL, now);
    expect(r(10)).toBe(at(TODAY, '16:50', SEOUL));
    expect(r(30)).toBe(at(TODAY, '16:30', SEOUL));
    expect(r(120)).toBe(at(TODAY, '15:00', SEOUL));
    expect(r(1440)).toBe(at(TODAY, '17:00', SEOUL));
    expect(r(0)).toBe(at(TODAY, '17:00', SEOUL));
    expect(r(null)).toBeNull();
    expect([...REMIND_BEFORE_CHOICES]).toEqual([0, 10, 30, 60, 120, 1440]);
  });
  it('③ 16:30 新建 due_time 17:00（提前 1 小时已过）：在截止时刻 17:00 提醒', () => {
    expect(todoRemindAt(todo({ due_time: '17:00', remind_before_min: 60 }), SEOUL, at(TODAY, '16:30', SEOUL))).toBe(at(TODAY, '17:00', SEOUL));
  });
  it('④ 17:05 新建 due_time 17:00：不提醒（截止也过了）；正好 17:00 时在截止时刻提醒', () => {
    expect(todoRemindAt(todo({ due_time: '17:00', remind_before_min: 60 }), SEOUL, at(TODAY, '17:05', SEOUL))).toBeNull();
    expect(todoRemindAt(todo({ due_time: '17:00', remind_before_min: 60 }), SEOUL, at(TODAY, '17:00', SEOUL))).toBe(at(TODAY, '17:00', SEOUL));
  });
  it('⑤ due_time 23:00、提前 1 小时：算出 22:00；免打扰 22:00～07:00 推迟到次日 07:00（晚于截止，接受）', () => {
    const raw = todoRemindAt(todo({ due_time: '23:00', remind_before_min: 60 }), SEOUL, now);
    expect(raw).toBe(at(TODAY, '22:00', SEOUL));
    const dnd = { start: '22:00', end: '07:00' };
    expect(dndDeferUntil(raw ?? 0, SEOUL, dnd)).toBe(at('2026-11-04', '07:00', SEOUL));
    expect(applyDnd(raw ?? 0, SEOUL, dnd)).toBe(at('2026-11-04', '07:00', SEOUL));
  });
  it('⑥ 清掉 due_time：回到 remind_days + remind_time（当天 / 前一天 + 时刻）', () => {
    expect(todoRemindAt(todo({ due_time: null, remind_before_min: 60, remind_days: 0, remind_time: '09:00' }), SEOUL, now)).toBe(at(TODAY, '09:00', SEOUL));
    expect(todoRemindAt(todo({ due_time: null, remind_days: 1, remind_time: '20:30' }), SEOUL, now)).toBe(at('2026-11-02', '20:30', SEOUL));
    expect(todoRemindAt(todo({ due_time: null, remind_days: 0, remind_time: null }), SEOUL, now)).toBe(at(TODAY, '09:00', SEOUL));
    expect(todoRemindAt(todo({ due_time: null, remind_days: null }), SEOUL, now)).toBeNull();
  });
  it('⑦ 客户端、服务器同一份：remindAtOf 按 kind 分派，结果和 todoRemindAt 一样', () => {
    const row = todo({ due_time: '17:00', remind_before_min: 60 });
    expect(remindAtOf('todo', row, SEOUL, now)).toBe(todoRemindAt(row, SEOUL, now));
  });
  it('没有截止日、已完成、已删除：不提醒', () => {
    expect(todoRemindAt(todo({ due: null, due_time: null }), SEOUL, now)).toBeNull();
    expect(todoRemindAt(todo({ due_time: '17:00', remind_before_min: 60, done: true }), SEOUL, now)).toBeNull();
    expect(todoRemindAt(todo({ due_time: '17:00', remind_before_min: 60, deleted_at: 1 }), SEOUL, now)).toBeNull();
  });
  it('第一次设 due_time 才默认 60；已经有 due_time 时改时刻，保留原来的提前量（含“不提醒”）', () => {
    expect(remindBeforeOnSetDueTime(null, 10)).toBe(60);
    expect(remindBeforeOnSetDueTime('17:00', 10)).toBe(10);
    expect(remindBeforeOnSetDueTime('17:00', null)).toBeNull();
  });
});

describe('浮动时刻按 current_tz（4.6）：同一行在三个时区各按当地墙上时间算', () => {
  for (const tz of [UTC, SEOUL, LA]) {
    it(`${tz}：due_time 17:00 提前 2 小时 → 当地 15:00；已过提醒时刻、未过截止 → 当地 17:00`, () => {
      const row = todo({ due_time: '17:00', remind_before_min: 120 });
      expect(todoRemindAt(row, tz, at(TODAY, '09:00', tz))).toBe(at(TODAY, '15:00', tz));
      expect(todoRemindAt(row, tz, at(TODAY, '16:00', tz))).toBe(at(TODAY, '17:00', tz));
      expect(todoRemindAt(row, tz, at(TODAY, '17:01', tz))).toBeNull();
    });
  }
  it('due_time 00:30 提前 1 小时：落到前一天 23:30', () => {
    expect(todoRemindAt(todo({ due_time: '00:30', remind_before_min: 60 }), SEOUL, at('2026-11-02', '12:00', SEOUL))).toBe(at('2026-11-02', '23:30', SEOUL));
  });
  it('洛杉矶夏令时切换：“1 天”按墙上时间退一天（同一时刻），其余按实际经过的分钟', () => {
    // 2026-03-08 02:00 拨快到 03:00
    const row = todo({ due: '2026-03-09', due_time: '09:00', remind_before_min: 1440 });
    expect(todoRemindAt(row, LA, at('2026-03-01', '00:00', LA))).toBe(at('2026-03-08', '09:00', LA));
    const r2 = todo({ due: '2026-03-08', due_time: '03:30', remind_before_min: 120 });
    expect(todoRemindAt(r2, LA, at('2026-03-01', '00:00', LA))).toBe(at('2026-03-08', '03:30', LA) - 120 * 60_000);
    // 11-01 01:00～02:00 重复：截止 01:30 取先出现的一次（msAt 的规则）
    const r3 = todo({ due: '2026-11-01', due_time: '01:30', remind_before_min: 0 });
    expect(todoRemindAt(r3, LA, at('2026-10-31', '00:00', LA))).toBe(at('2026-11-01', '01:30', LA));
  });
});

describe('代码审查 BE-1 M2：只在新建、改了截止或提前量时回落到截止时刻；其余重算传 prevRemindAt，不回落', () => {
  for (const tz of [UTC, SEOUL, LA]) {
    const row = todo({ due_time: '17:00', remind_before_min: 60 });
    const due = (r: number | null, snoozeAt: number | null) => Math.max(r ?? 0, snoozeAt ?? 0);   // 5.3 第 1 步 due_at = greatest(remind_at, snooze_at)
    it(`${tz}：审查员的场景——09:00 保存得 16:00；16:00 推过，16:01 按“稍后”写 snooze_at = 16:11，16:02 第 0 步重算仍是 16:00，16:11 照常响`, () => {
      const saved = todoRemindAt(row, tz, at(TODAY, '09:00', tz));
      expect(saved).toBe(at(TODAY, '16:00', tz));
      const r = todoRemindAt(row, tz, at(TODAY, '16:02', tz), saved);
      expect(r).toBe(at(TODAY, '16:00', tz));
      expect(due(r, at(TODAY, '16:11', tz))).toBe(at(TODAY, '16:11', tz));
      // 同一份算法经 remindAtOf 分派结果一样；改前的写法（不传 prevRemindAt）会得 17:00，16:11 那次被吞
      expect(remindAtOf('todo', row, tz, at(TODAY, '16:02', tz), saved)).toBe(r);
      expect(todoRemindAt(row, tz, at(TODAY, '16:02', tz))).toBe(at(TODAY, '17:00', tz));
    });
    it(`${tz}：16:30 新建（不传）→ 回落到 17:00；之后每次重算（传 17:00）保持 17:00，截止过了也不变成 null`, () => {
      const created = todoRemindAt(row, tz, at(TODAY, '16:30', tz));
      expect(created).toBe(at(TODAY, '17:00', tz));
      expect(todoRemindAt(row, tz, at(TODAY, '16:40', tz), created)).toBe(at(TODAY, '17:00', tz));
      expect(todoRemindAt(row, tz, at(TODAY, '17:03', tz), created)).toBe(at(TODAY, '17:00', tz));
    });
    it(`${tz}：打勾后又取消——打勾得 null；16:30 取消打勾（传 null）不回落，不会多出一次 17:00 的提醒`, () => {
      const checked = todoRemindAt({ ...row, done: true }, tz, at(TODAY, '16:20', tz), at(TODAY, '16:00', tz));
      expect(checked).toBeNull();
      const unchecked = todoRemindAt({ ...row, done: false }, tz, at(TODAY, '16:30', tz), checked);
      expect(unchecked).toBe(at(TODAY, '16:00', tz));   // 已过的原时刻：pushed_for 已经等于它的不会再推
      expect(unchecked).not.toBe(at(TODAY, '17:00', tz));
      // 还没到提醒时刻就取消打勾：照常算出 16:00
      expect(todoRemindAt(row, tz, at(TODAY, '10:00', tz), null)).toBe(at(TODAY, '16:00', tz));
    });
    it(`${tz}：改了别的触发列（remind_days、remind_time、snooze_at 之类）重算传原值，不回落；改了截止时刻或提前量（不传）才回落`, () => {
      const prev = at(TODAY, '16:00', tz);
      expect(todoRemindAt({ ...row, remind_days: 1, remind_time: '20:30' }, tz, at(TODAY, '16:05', tz), prev)).toBe(prev);
      // 改截止时刻到 16:30（提前 60 → 15:30 已过）：按“改了时刻”不传 → 回落到 16:30
      expect(todoRemindAt({ ...row, due_time: '16:30' }, tz, at(TODAY, '16:05', tz))).toBe(at(TODAY, '16:30', tz));
      // 改提前量到 10 分钟（16:50 未过）：照常 16:50，传不传一样
      expect(todoRemindAt({ ...row, remind_before_min: 10 }, tz, at(TODAY, '16:05', tz))).toBe(at(TODAY, '16:50', tz));
      expect(todoRemindAt({ ...row, remind_before_min: 10 }, tz, at(TODAY, '16:05', tz), prev)).toBe(at(TODAY, '16:50', tz));
    });
  }
  it('日程是固定时刻，没有回落：传不传 prevRemindAt 一样', () => {
    const ev = { date: TODAY, time: '17:00', tz: SEOUL, remind_min: 60, deleted_at: null };
    expect(remindAtOf('event', ev, SEOUL, at(TODAY, '16:30', SEOUL), 123)).toBe(remindAtOf('event', ev, SEOUL, at(TODAY, '16:30', SEOUL)));
  });
});

describe('免打扰（按 current_tz）', () => {
  const night = { start: '22:00', end: '07:00' };
  const noon = { start: '12:00', end: '14:00' };
  it('跨午夜的时段：22:00 起算进、07:00 整不算；结束时刻是当晚的次日 07:00，或当天凌晨的当天 07:00', () => {
    expect(dndDeferUntil(at(TODAY, '21:59', SEOUL), SEOUL, night)).toBeNull();
    expect(dndDeferUntil(at(TODAY, '22:00', SEOUL), SEOUL, night)).toBe(at('2026-11-04', '07:00', SEOUL));
    expect(dndDeferUntil(at(TODAY, '03:00', SEOUL), SEOUL, night)).toBe(at(TODAY, '07:00', SEOUL));
    expect(dndDeferUntil(at(TODAY, '07:00', SEOUL), SEOUL, night)).toBeNull();
  });
  it('不跨午夜的时段；没设或开始等于结束时不推迟；applyDnd 不在时段里原样返回', () => {
    expect(dndDeferUntil(at(TODAY, '13:00', LA), LA, noon)).toBe(at(TODAY, '14:00', LA));
    expect(dndDeferUntil(at(TODAY, '14:00', LA), LA, noon)).toBeNull();
    expect(dndDeferUntil(at(TODAY, '23:00', UTC), UTC, null)).toBeNull();
    expect(dndDeferUntil(at(TODAY, '23:00', UTC), UTC, { start: '07:00', end: '07:00' })).toBeNull();
    expect(applyDnd(at(TODAY, '10:00', UTC), UTC, night)).toBe(at(TODAY, '10:00', UTC));
  });
});

describe('日程（固定时刻，4.6）：msAt(date, time − remind_min, 日程自己的 tz)，换了地方也不变', () => {
  it('首尔记的 15:00、提前 15 分钟：14:45 首尔时间；current_tz 换成洛杉矶结果不变', () => {
    const ev = { date: TODAY, time: '15:00', tz: SEOUL, remind_min: 15, deleted_at: null };
    expect(eventRemindAt(ev)).toBe(at(TODAY, '14:45', SEOUL));
    expect(remindAtOf('event', ev, LA, 0)).toBe(at(TODAY, '14:45', SEOUL));
    expect(eventRemindAt({ ...ev, time: '00:10', remind_min: 30 })).toBe(at('2026-11-02', '23:40', SEOUL));
  });
  it('remind_min 为 null、缺 tz、已删除返回 null；全天日程（time 为空）不传 tz 时返回 null（全天的算法见 remind-all-day.test.ts）', () => {
    const ev = { date: TODAY, time: '15:00', tz: SEOUL, remind_min: 15, deleted_at: null };
    expect(eventRemindAt({ ...ev, remind_min: null })).toBeNull();
    expect(eventRemindAt({ ...ev, time: null })).toBeNull();
    expect(eventRemindAt({ ...ev, tz: null })).toBeNull();
    expect(eventRemindAt({ ...ev, deleted_at: 5 })).toBeNull();
  });
});
