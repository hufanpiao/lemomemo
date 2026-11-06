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

  it('筛选条条数一样：按项目名，数字按数值、按当前语言（代码复审第三轮，和标题同一个比较）', () => {
    const names = ['项目 10', '项目 2', '项目 1', '项目 20'];
    const rows = names.map((project) => td({ project }));
    const want = ['项目 1', '项目 2', '项目 10', '项目 20'];
    expect(projectCounts(rows, 'zh-CN').map((p) => p.project)).toEqual(want);
    expect(projectCounts(rows, 'ko-KR').map((p) => p.project)).toEqual(want);
    const ko = ['프로젝트 10', '프로젝트 2', '프로젝트 1'].map((project) => td({ project }));
    expect(projectCounts(ko, 'ko-KR').map((p) => p.project)).toEqual(['프로젝트 1', '프로젝트 2', '프로젝트 10']);
    // 按传入的语言：中文里汉字在韩文前，韩文里韩文在汉字前（不传语言时按中文）
    const mixed = ['가나', '北京'].map((project) => td({ project }));
    expect(projectCounts(mixed, 'zh-CN').map((p) => p.project)).toEqual(['北京', '가나']);
    expect(projectCounts(mixed, 'ko-KR').map((p) => p.project)).toEqual(['가나', '北京']);
    expect(projectCounts(mixed).map((p) => p.project)).toEqual(['北京', '가나']);
  });
});

describe('同一截止时刻、没日期那组按标题排：数字按数值（设计审查：“第 1、10、11 … 2、20”；和今天页共用 shared/i18n/title-compare.ts）', () => {
  const mix = <T,>(a: T[]): T[] => [a[3], a[0], a[2], a[1]] as T[];
  const titlesOf = (g: ReturnType<typeof groupTodos>, key: string) => g.find((x) => x.key === key)?.items.map((i) => i.todo.title);

  it('没日期那组：中文 1、2、10、20；韩文 1、2、10、20', () => {
    const zh = ['第 1 条', '第 2 条', '第 10 条', '第 20 条'];
    expect(titlesOf(groupTodos(mix(zh).map((title) => td({ title })), NOW, TZ, null, 'zh-CN'), 'nodate')).toEqual(zh);
    const ko = ['할 일 1', '할 일 2', '할 일 10', '할 일 20'];
    expect(titlesOf(groupTodos(mix(ko).map((title) => td({ title })), NOW, TZ, null, 'ko-KR'), 'nodate')).toEqual(ko);
  });

  it('同一天同一截止时刻：中文、韩文都是 1、2、10、20', () => {
    const zh = ['报表 1', '报表 2', '报表 10', '报表 20'];
    const rowsZh = mix(zh).map((title) => td({ title, due: '2026-11-08', due_time: '10:00' }));
    expect(titlesOf(groupTodos(rowsZh, NOW, TZ, null, 'zh-CN'), 'day')).toEqual(zh);
    const ko = ['보고서 1', '보고서 2', '보고서 10', '보고서 20'];
    const rowsKo = mix(ko).map((title) => td({ title, due: '2026-11-08', due_time: '10:00' }));
    expect(titlesOf(groupTodos(rowsKo, NOW, TZ, null, 'ko-KR'), 'day')).toEqual(ko);
  });

  it('排序口径不变：重要的仍在前，截止时刻仍先比，标题只是最后一道', () => {
    const rows = [
      td({ title: '第 1 条' }),
      td({ title: '第 20 条', important: true }),
      td({ title: '第 2 条', due: '2026-11-08', due_time: '11:00' }),
      td({ title: '第 10 条', due: '2026-11-08', due_time: '09:00' }),
    ];
    const g = groupTodos(rows, NOW, TZ, null, 'zh-CN');
    expect(titlesOf(g, 'nodate')).toEqual(['第 20 条', '第 1 条']);
    expect(titlesOf(g, 'day')).toEqual(['第 10 条', '第 2 条']);
  });

  it('按传入的语言比：中文按拼音，“北京”在“上海”前（按码位会反过来）', () => {
    const rows = ['上海出差', '北京出差'].map((title) => td({ title }));
    expect(titlesOf(groupTodos(rows, NOW, TZ, null, 'zh-CN'), 'nodate')).toEqual(['北京出差', '上海出差']);
  });
});
