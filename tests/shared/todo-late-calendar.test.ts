// 同一条待办，日历和待办页判“逾期”结论一致（改善报告 11-20 二-3）：
// 待办页分组（src/features/todos/data/todo-list.ts 的 groupTodos → 逾期组）、日历周视图（src/features/calendar/data/cal-data.ts 的 anyLate、dueMinOf）
// 和日历日清单的红字（useDayTodos 的 late）都经 shared/logic/todo-row.ts 的 isLate、todoOf。原来日历另写三套“当天第几分钟”的比法，截止时刻正则少结尾锚点
// 跨两个功能，按边界规则放在 tests/shared（功能自己的 __tests__ 引不到别的功能）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../shared/core/date.ts';
import { isLate, todoOf } from '../../shared/logic/todo-row.ts';
import { anyLate, calTodoFields, dueMinOf } from '../../src/features/calendar/data/cal-data.ts';
import { groupTodos } from '../../src/features/todos/data/todo-list.ts';

const TZ = 'Asia/Seoul';
const TODAY = '2026-11-20';
const YDAY = '2026-11-19';
const at = (date: string, hm: string): number => msAt(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), TZ);
const row = (over: Record<string, unknown>) => ({ id: 't', title: '待办', done: false, due: null, due_time: null, deleted_at: null, undone: false, ...over });

/** 三处的结论：待办页进不进逾期组、日历周视图这一天标不标逾期、日清单红字（同一个 isLate） */
function verdicts(r: ReturnType<typeof row>, now: number): { todos: boolean; week: boolean; day: boolean } {
  return {
    todos: groupTodos([r], now, TZ).some((g) => g.key === 'late'),
    week: anyLate([r.id], calTodoFields([r]), now, TZ),
    day: isLate(todoOf(r), now, TZ),
  };
}

describe('日历、待办页的逾期同一个结论', () => {
  const cases: [string, Record<string, unknown>, number, boolean][] = [
    ['带时刻：今天 09:00 截止，现在 10:00', { due: TODAY, due_time: '09:00' }, at(TODAY, '10:00'), true],
    ['带时刻：到截止那一分钟起算（<= now）', { due: TODAY, due_time: '10:00' }, at(TODAY, '10:00'), true],
    ['带时刻：今天 12:00 截止，还没到', { due: TODAY, due_time: '12:00' }, at(TODAY, '10:00'), false],
    ['跨午夜：昨天 23:30 截止，现在 00:10', { due: YDAY, due_time: '23:30' }, at(TODAY, '00:10'), true],
    ['跨午夜：今天 00:30 截止，现在 00:10', { due: TODAY, due_time: '00:30' }, at(TODAY, '00:10'), false],
    ['跨午夜：今天 23:59 截止，现在 23:58', { due: TODAY, due_time: '23:59' }, at(TODAY, '23:58'), false],
    ['全天：今天截止没有时刻，今天之内都不算', { due: TODAY }, at(TODAY, '23:59'), false],
    ['全天：昨天截止没有时刻，过了午夜就算', { due: YDAY }, at(TODAY, '00:00'), true],
    ['坏时刻 "09:00x" 当没有时刻（原来日历的正则没有 $，当成 09:00 标逾期）', { due: TODAY, due_time: '09:00x' }, at(TODAY, '10:00'), false],
    ['只有截止时刻、没有截止日：当没有截止', { due_time: '09:00' }, at(TODAY, '10:00'), false],
    ['做完了的不算', { due: YDAY, due_time: '09:00', done: true, done_at: 1 }, at(TODAY, '10:00'), false],
  ];
  for (const [name, over, now, late] of cases) {
    it(name, () => {
      expect(verdicts(row(over), now)).toEqual({ todos: late, week: late, day: late });
    });
  }
});

describe('周视图截止时刻（dueMinOf）和待办页读到的同一个', () => {
  it('“HH:MM” → 当天第几分钟；没截止日、格式不对（带秒、24:00、7:00、尾巴多字）的当没有，画在泳道末端', () => {
    const m = calTodoFields([
      row({ id: 'a', due: TODAY, due_time: '09:30' }),
      row({ id: 'b', due: TODAY, due_time: '23:59' }),
      row({ id: 'c', due: TODAY, due_time: '23:59:00' }),
      row({ id: 'd', due: TODAY, due_time: '24:00' }),
      row({ id: 'e', due: TODAY, due_time: '7:00' }),
      row({ id: 'f', due: TODAY, due_time: '09:00x' }),
      row({ id: 'g', due_time: '09:00' }),
    ]);
    expect(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => dueMinOf(m.get(id)))).toEqual([570, 1439, undefined, undefined, undefined, undefined, undefined]);
    expect(dueMinOf(undefined)).toBe(undefined);
  });
});
