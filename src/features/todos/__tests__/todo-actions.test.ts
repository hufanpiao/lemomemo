// 待办列表上打勾、删除的 remind 标记（data/todo-actions.ts；代码审查 S2、补审改法 ④）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { remindAfterDelete, remindAfterDone } from '../data/todo-actions.ts';

const TZ = 'Asia/Seoul';
const at = (h: number, m = 0) => msAt('2026-11-05', h * 60 + m, TZ);
const row = (over: Record<string, unknown> = {}) => ({
  id: 't1', title: '交报告', due: '2026-11-05', due_time: '17:00', remind_before_min: 60, remind_days: null, remind_time: null,
  done: false, deleted_at: null, remind_at: at(16), ...over,
});

describe('remindAfterDone', () => {
  it('取消打勾后会响 → true；打勾撤掉还没到的提醒 → true（S2）；提醒早就过了再打勾 → false', () => {
    expect(remindAfterDone(row({ done: true }), false, at(15), TZ)).toBe(true);
    expect(remindAfterDone(row(), true, at(15), TZ)).toBe(true);
    expect(remindAfterDone(row({ remind_at: at(17) }), true, at(17, 30), TZ)).toBe(false);
  });

  it('提前时刻、截止都过了（remind_at = 截止时刻）：取消打勾按“其余重算”传 remind_at，算出的截止时刻早过了 2 分钟 → false（S16）；2 分钟内 → true', () => {
    expect(remindAfterDone(row({ done: true, remind_at: at(17) }), false, at(17, 30), TZ)).toBe(false);
    expect(remindAfterDone(row({ done: true, remind_at: at(17) }), false, at(17, 1), TZ)).toBe(true);
  });

  it('按过“稍后”（S14）：服务器上的 snooze_at 或 remind_at 还没到，按字段重算已过 → 打勾也带标记', () => {
    expect(remindAfterDone(row({ remind_at: at(17), snooze_at: at(17, 40) }), true, at(17, 30), TZ)).toBe(true);
    expect(remindAfterDone(row({ remind_at: at(17, 40) }), true, at(17, 30), TZ)).toBe(true);
  });

  it('没截止日：不带', () => {
    expect(remindAfterDone(row({ due: null, due_time: null, remind_before_min: null, remind_at: null }), true, at(15), TZ)).toBe(false);
  });
});

describe('remindAfterDelete（补审改法 ④）', () => {
  it('删一条提醒还没到的 → true；删一条早就过了的、本来就不响的 → false', () => {
    expect(remindAfterDelete(row(), true, at(15), TZ)).toBe(true);
    expect(remindAfterDelete(row({ remind_at: at(17) }), true, at(17, 30), TZ)).toBe(false);
    expect(remindAfterDelete(row({ remind_before_min: null, remind_at: null }), true, at(15), TZ)).toBe(false);
    // 本机刚改成不提醒、还没同步：服务器上的 remind_at 还没到，删除要尽快送到（S14）
    expect(remindAfterDelete(row({ remind_before_min: null }), true, at(15), TZ)).toBe(true);
  });

  it('撤销删除：恢复后会响 → true；已完成的 → false', () => {
    expect(remindAfterDelete(row({ deleted_at: at(14) }), false, at(15), TZ)).toBe(true);
    expect(remindAfterDelete(row({ deleted_at: at(14), done: true }), false, at(15), TZ)).toBe(false);
  });
});
