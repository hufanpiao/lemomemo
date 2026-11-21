// 待办打勾、删除的 remind 标记（删除在 core/todo-writes.ts，三页和自动删除共用；代码审查 S2、补审改法 ④）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../shared/core/date.ts';
import { remindAtOf } from '../../../shared/logic/remind.ts';
import { remindAfterDelete, setTodoDue, todoDuePatch, tomorrowOf } from '../todo-writes.ts';
import { todoRemindFields } from '../remind-flag.ts';
import { todoDonePatch } from '../todo-done.ts';

/** 打勾的标记规则在 core/todo-done.ts（评审第 15 条：所有入口共用），这里照旧钉住 */
const remindAfterDone = (...a: Parameters<typeof todoDonePatch>): boolean => todoDonePatch(...a).remind;

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

describe('推迟到明天（负责人 11-21“没赶上的加一个推迟按钮，按一下把时间推迟到明天”）', () => {
  // 11-06 10:00（首尔）：11-05 17:00 截止的已经过期
  const now = msAt('2026-11-06', 10 * 60, TZ);

  it('明天按用户时区算：首尔 11-06 00:30 是 UTC 11-05 15:30，首尔的明天 11-07、UTC 的明天 11-06', () => {
    const t = msAt('2026-11-06', 30, TZ);
    expect(tomorrowOf(t, TZ)).toBe('2026-11-07');
    expect(tomorrowOf(t, 'UTC')).toBe('2026-11-06');
    expect(tomorrowOf(t, 'America/Los_Angeles')).toBe('2026-11-06');
    // 首尔 23:59 还是今天，明天是下一天
    expect(tomorrowOf(msAt('2026-11-06', 23 * 60 + 59, TZ), TZ)).toBe('2026-11-07');
  });

  it('只写截止日和 updated_at：截止时刻、提前量、当天 / 前一天提醒都不动（保留原来的时刻）', () => {
    const w = todoDuePatch(row(), '2026-11-07', now, TZ);
    expect(w.data).toEqual({ due: '2026-11-07', updated_at: now });
  });

  it('提醒跟着挪：提醒按截止算（截止 − 提前量），截止挪到明天 17:00，提醒就是明天 16:00；还会响所以带 remind 标记（整条提前发）', () => {
    const r = row({ remind_at: at(16) });
    const w = todoDuePatch(r, '2026-11-07', now, TZ);
    expect(remindAtOf('todo', { ...todoRemindFields(r), due: w.data.due }, TZ, now)).toBe(msAt('2026-11-07', 16 * 60, TZ));
    expect(w.remind).toBe(true);
  });

  it('没有截止时刻、按“当天 9:00”提醒的：挪到明天就是明天 9:00 提醒', () => {
    const r = row({ due_time: null, remind_before_min: null, remind_days: 0, remind_time: '09:00', remind_at: msAt('2026-11-05', 9 * 60, TZ) });
    const w = todoDuePatch(r, '2026-11-07', now, TZ);
    expect(remindAtOf('todo', { ...todoRemindFields(r), due: w.data.due }, TZ, now)).toBe(msAt('2026-11-07', 9 * 60, TZ));
    expect(w.remind).toBe(true);
  });

  it('不提醒的待办：挪了也不带 remind 标记', () => {
    const r = row({ remind_before_min: null, remind_at: null });
    expect(todoDuePatch(r, '2026-11-07', now, TZ).remind).toBe(false);
  });

  it('撤销：把原来的截止日写回去；明天的提醒还没到，撤掉它的写入也要尽快上服务器（带 remind 标记）', () => {
    const moved = row({ due: '2026-11-07', remind_at: msAt('2026-11-07', 16 * 60, TZ) });
    const w = todoDuePatch(moved, '2026-11-05', now + 5000, TZ);
    expect(w.data).toEqual({ due: '2026-11-05', updated_at: now + 5000 });
    expect(w.remind).toBe(true);
  });

  it('setTodoDue 经 savePatch 写 todos 一行（走 outbox，离线照样入队）', async () => {
    const calls: unknown[] = [];
    const out = await setTodoDue(row(), '2026-11-07', now, TZ, async (...a) => {
      calls.push(a);
      return 'saved';
    });
    expect(out).toBe('saved');
    expect(calls).toEqual([['todos', 't1', { due: '2026-11-07', updated_at: now }, true]]);
  });
});
