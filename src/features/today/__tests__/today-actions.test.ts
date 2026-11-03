// 今天页、“最近删除”页写入的 remind 标记（data/today-actions.ts；代码审查 S2、补审改法 ④）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindAfterDone, remindOnDelete } from '../data/today-actions.ts';

const TZ = 'Asia/Seoul';
const at = (h: number, m = 0) => msAt('2026-11-05', h * 60 + m, TZ);
const todo = (over: Record<string, unknown> = {}) => ({
  id: 't1', title: '交报告', due: '2026-11-05', due_time: '17:00', remind_before_min: 60, remind_days: null, remind_time: null,
  done: false, deleted_at: null, remind_at: at(16), ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  id: 'e1', title: '客户会', date: '2026-11-05', time: '15:00', tz: 'Asia/Shanghai', remind_min: 15, deleted_at: null, ...over,
});

describe('remindAfterDone（和 todos 那一份同一条规则）', () => {
  it('打勾撤掉还没到的提醒 → true；早就过了 → false；取消打勾后会响 → true', () => {
    expect(remindAfterDone(todo(), true, at(15), TZ)).toBe(true);
    expect(remindAfterDone(todo({ remind_at: at(17) }), true, at(17, 30), TZ)).toBe(false);
    expect(remindAfterDone(todo({ done: true }), false, at(15), TZ)).toBe(true);
  });
});

describe('remindOnDelete（补审改法 ④）', () => {
  it('待办：删一条还没到的 → true；恢复后会响 → true；删一条早就过了的 → false', () => {
    expect(remindOnDelete('todos', todo(), true, at(15), TZ)).toBe(true);
    expect(remindOnDelete('todos', todo({ deleted_at: 1 }), false, at(15), TZ)).toBe(true);
    expect(remindOnDelete('todos', todo({ remind_at: at(17) }), true, at(17, 30), TZ)).toBe(false);
  });

  it('日程：按日程自己的时区；删还没到的 → true，删过去的 → false；恢复有提醒的 → true；全天、不提醒 → false', () => {
    // 上海 15:00 = 首尔 16:00，提醒 15:45（首尔）
    expect(remindOnDelete('events', event(), true, at(15, 40), TZ)).toBe(true);
    expect(remindOnDelete('events', event(), true, at(15, 50), TZ)).toBe(false);
    // 恢复：提醒时刻早过了 2 分钟 → false（S16 同一口径）；2 分钟内、还没到 → true
    expect(remindOnDelete('events', event({ deleted_at: 1 }), false, at(15, 50), TZ)).toBe(false);
    expect(remindOnDelete('events', event({ deleted_at: 1 }), false, at(15, 46), TZ)).toBe(true);
    expect(remindOnDelete('events', event({ deleted_at: 1 }), false, at(15, 40), TZ)).toBe(true);
    // 删：按过“稍后”，snooze_at 还没到 → true（S14）
    expect(remindOnDelete('events', event({ snooze_at: at(16) }), true, at(15, 50), TZ)).toBe(true);
    expect(remindOnDelete('events', event({ time: null, tz: null }), true, at(9), TZ)).toBe(false);
    expect(remindOnDelete('events', event({ remind_min: null, deleted_at: 1 }), false, at(9), TZ)).toBe(false);
  });

  it('已经删了的再删：不带', () => {
    expect(remindOnDelete('todos', todo({ deleted_at: 1 }), true, at(15), TZ)).toBe(false);
    expect(remindOnDelete('events', event({ deleted_at: 1 }), true, at(9), TZ)).toBe(false);
  });
});
