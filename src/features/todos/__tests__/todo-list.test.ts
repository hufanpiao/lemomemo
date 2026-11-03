// 待办列表的分组和截止标签（data/todo-list.ts）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { dueTagOf, groupTodos, itemOf, projectCounts, type Row } from '../data/todo-list.ts';

const TZ = 'Asia/Seoul';
const NOW = msAt('2026-11-05', 14 * 60 + 17, TZ);
let n = 0;
const td = (over: Record<string, unknown>): Row => ({
  id: `t${++n}`, title: `t${n}`, project: '', done: false, important: false, due: null, due_time: null, done_at: 0, deleted_at: null, undone: false, ...over,
});

describe('截止标签', () => {
  const tag = (over: Record<string, unknown>) => dueTagOf(itemOf(td(over)), NOW, TZ);

  it('今天 17:00 截止；今天 12:00 已过 → 过期（逾 0 天）；昨天 → 逾 1 天；明天；后天写日期；没日期', () => {
    expect(tag({ due: '2026-11-05', due_time: '17:00' })).toEqual({ kind: 'today', dueTime: '17:00' });
    expect(tag({ due: '2026-11-05', due_time: '12:00' })).toEqual({ kind: 'late', days: 0, dueTime: '12:00' });
    expect(tag({ due: '2026-11-04' })).toEqual({ kind: 'late', days: 1, dueTime: null });
    expect(tag({ due: '2026-11-06' })).toEqual({ kind: 'tomorrow', dueTime: null });
    expect(tag({ due: '2026-11-07', due_time: '09:00' })).toEqual({ kind: 'date', date: '2026-11-07', dueTime: '09:00' });
    expect(tag({})).toEqual({ kind: 'none' });
  });

  it('完成了的不算过期：照日期写', () => {
    expect(tag({ due: '2026-11-04', done: true })).toEqual({ kind: 'date', date: '2026-11-04', dueTime: null });
    expect(tag({ due: '2026-11-05', due_time: '12:00', done: true })).toEqual({ kind: 'today', dueTime: '12:00' });
  });

  it('没日期时截止时刻不算（坏数据）', () => {
    expect(itemOf(td({ due_time: '10:00' })).dueTime).toBeNull();
  });
});

describe('分组', () => {
  it('过期 → 今天 → 明天 → 7 天内按日期 → 以后 → 没日期 → 已完成；空组不出现；删了的、撤销的不算', () => {
    const rows = [
      td({ due: '2026-11-20', title: 'later' }), td({ title: 'nodate' }), td({ due: '2026-11-08', title: 'd8' }), td({ due: '2026-11-07', title: 'd7' }),
      td({ due: '2026-11-06', title: 'tmr' }), td({ due: '2026-11-05', title: 'today' }), td({ due: '2026-11-01', title: 'late' }),
      td({ due: '2026-11-11', title: 'd11' }), td({ due: '2026-11-12', title: 'd12later' }),
      td({ done: true, done_at: 5, title: 'done5' }), td({ done: true, done_at: 9, title: 'done9' }), td({ due: '2026-11-05', deleted_at: 1 }), td({ undone: true }),
    ];
    const g = groupTodos(rows, NOW, TZ);
    expect(g.map((x) => [x.key, x.date, x.items.map((i) => i.todo.title)])).toEqual([
      ['late', null, ['late']], ['today', null, ['today']], ['tomorrow', null, ['tmr']], ['day', '2026-11-07', ['d7']], ['day', '2026-11-08', ['d8']],
      ['day', '2026-11-11', ['d11']], ['later', null, ['d12later', 'later']], ['nodate', null, ['nodate']], ['done', null, ['done9', 'done5']],
    ]);
  });

  it('组内：按截止日、截止时刻（没时刻的在后）、重要的在前', () => {
    const rows = [td({ due: '2026-11-05', title: 'a' }), td({ due: '2026-11-05', due_time: '18:00', title: 'b' }), td({ due: '2026-11-05', due_time: '15:00', title: 'c' })];
    expect(groupTodos(rows, NOW, TZ)[0]?.items.map((i) => i.todo.title)).toEqual(['c', 'b', 'a']);
  });

  it('项目筛选：只留这个项目；筛选条按没完成的条数', () => {
    const rows = [td({ project: 'NEOX' }), td({ project: 'NEOX' }), td({ project: 'SignPlex' }), td({ project: 'SignPlex', done: true }), td({})];
    expect(groupTodos(rows, NOW, TZ, 'SignPlex').flatMap((g) => g.items.map((i) => i.todo.project))).toEqual(['SignPlex', 'SignPlex']);
    expect(projectCounts(rows)).toEqual([{ project: 'NEOX', count: 2 }, { project: 'SignPlex', count: 1 }]);
  });
});
