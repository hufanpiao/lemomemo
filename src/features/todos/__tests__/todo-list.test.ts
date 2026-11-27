// 待办列表的分组和截止标签（data/todo-list.ts）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { dueTagOf, groupTodos, itemOf, projectCounts, type Row } from '../data/todo-list.ts';
import { nextPriority, prioCols, PRIORITIES } from '../../../../shared/logic/todo-row.ts';

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
    expect(tag({ due: '2026-11-05', due_time: '12:00' })).toEqual({ kind: 'late', days: 0, due: '2026-11-05', dueTime: '12:00' });
    expect(tag({ due: '2026-11-04' })).toEqual({ kind: 'late', days: 1, due: '2026-11-04', dueTime: null });
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

  it('linger：撤销条开着期间勾过的几条（已完成）照截止日留在原组，别的已完成照旧进“已完成”组（负责人 11-15；审查 11-15 第 4 条改成集合）', () => {
    const rows = [
      td({ id: 'x', title: 'x', done: true, done_at: 2, due: '2026-11-05' }), td({ id: 'y', title: 'y', done: true, done_at: 1 }),
      td({ id: 'z', title: 'z', done: true, done_at: 3 }),
    ];
    const g = groupTodos(rows, NOW, TZ, null, new Set(['x', 'z']));
    expect(g.map((x) => [x.key, x.items.map((i) => i.todo.id)])).toEqual([['today', ['x']], ['nodate', ['z']], ['done', ['y']]]);
    expect(groupTodos(rows, NOW, TZ).map((x) => x.key)).toEqual(['done']);
  });

  it('linger：过期的勾上以后停留期间还在“过期”组、标签照旧是过期（负责人 11-19 录屏：原来当场换进截止那天的组，乙4 播到一半没了；同今天页 lateTodos）', () => {
    const rows = [td({ id: 'x', title: 'x', done: true, done_at: 2, due: '2026-11-03' }), td({ id: 'w', title: 'w', due: '2026-11-03' })];
    const g = groupTodos(rows, NOW, TZ, null, new Set(['x']));
    expect(g.map((x) => [x.key, x.items.map((i) => i.todo.id)])).toEqual([['late', ['w', 'x']]]);
    expect(g[0]?.items.find((i) => i.todo.id === 'x')?.tag.kind).toBe('late');
    expect(g[0]?.items.find((i) => i.todo.id === 'x')?.todo.done).toBe(true);
  });

  it('组内：同档按截止时刻（没时刻的在后）', () => {
    const rows = [td({ due: '2026-11-05', title: 'a' }), td({ due: '2026-11-05', due_time: '18:00', title: 'b' }), td({ due: '2026-11-05', due_time: '15:00', title: 'c' })];
    expect(groupTodos(rows, NOW, TZ)[0]?.items.map((i) => i.todo.title)).toEqual(['c', 'b', 'a']);
  });

  it('项目筛选：只留这个项目；筛选条的条数只数没做完的（负责人 11-22“划掉了3个标签还显示4”），删了的不算', () => {
    const rows = [td({ project: 'NEOX' }), td({ project: 'NEOX' }), td({ project: 'SignPlex' }), td({ project: 'SignPlex', done: true }), td({}), td({ project: 'SignPlex', deleted_at: 1 })];
    expect(groupTodos(rows, NOW, TZ, 'SignPlex').flatMap((g) => g.items.map((i) => i.todo.project))).toEqual(['SignPlex', 'SignPlex']);
    expect(projectCounts(rows)).toEqual([{ project: 'NEOX', count: 2 }, { project: 'SignPlex', count: 1 }]);
  });

  it('项目下全部勾完：这个分类不出；刚勾完还留在原位的（linger）照没完成算、收起以后才减（负责人 11-21“相关项目勾选完成以后分类自动消失”）', () => {
    const last = td({ project: '奥锐', done: true });
    const rows = [td({ project: 'NEOX' }), last, td({ project: '奥锐', done: true })];
    expect(projectCounts(rows)).toEqual([{ project: 'NEOX', count: 1 }]);
    expect(projectCounts(rows, 'zh-CN', new Set([last.id]))).toEqual([{ project: '奥锐', count: 1 }, { project: 'NEOX', count: 1 }]);
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

describe('组内先后（R-442：H → M → L，同档按截止时刻、没时刻的在后，再按创建时间；取代 R-429 拖动排序）', () => {
  const titlesOf = (g: ReturnType<typeof groupTodos>, key: string) => g.find((x) => x.key === key)?.items.map((i) => i.todo.title);

  it('优先级压过截止时刻：低档 09:00 排在高档 18:00 后面', () => {
    const rows = [
      td({ title: 'L 09:00', priority: 'low', due: '2026-11-08', due_time: '09:00' }),
      td({ title: 'H 18:00', priority: 'high', due: '2026-11-08', due_time: '18:00' }),
      td({ title: 'M 12:00', priority: 'mid', due: '2026-11-08', due_time: '12:00' }),
    ];
    expect(titlesOf(groupTodos(rows, NOW, TZ), 'day')).toEqual(['H 18:00', 'M 12:00', 'L 09:00']);
  });

  it('同档：有时刻的按时刻，没时刻的排在有时刻的后面；都没时刻按创建时间（早建的在前），不按标题', () => {
    const rows = [
      td({ title: 'b 无时刻 晚建', due: '2026-11-05', created_at: 30 }),
      td({ title: 'a 无时刻 早建', due: '2026-11-05', created_at: 10 }),
      td({ title: 'z 18:00', due: '2026-11-05', due_time: '18:00', created_at: 50 }),
      td({ title: 'y 15:00', due: '2026-11-05', due_time: '15:00', created_at: 60 }),
    ];
    expect(titlesOf(groupTodos(rows, NOW, TZ), 'today')).toEqual(['y 15:00', 'z 18:00', 'a 无时刻 早建', 'b 无时刻 晚建']);
  });

  it('没日期那组：H → M → L，同档按创建时间；拖过的排序值（sort_key）不再起作用', () => {
    const rows = [
      td({ title: 'M 晚建', priority: 'mid', created_at: 9, sort_key: 'zzzz' }),
      td({ title: 'L', priority: 'low', created_at: 1 }),
      td({ title: 'M 早建', priority: 'mid', created_at: 2 }),
      td({ title: 'H', priority: 'high', created_at: 5, sort_key: 'a0' }),
    ];
    expect(titlesOf(groupTodos(rows, NOW, TZ), 'nodate')).toEqual(['H', 'M 早建', 'M 晚建', 'L']);
  });

  it('“以后”组里日期不同：同档截止日早的在前', () => {
    const rows = [td({ title: '12/1', due: '2026-12-01' }), td({ title: '11/20 10:00', due: '2026-11-20', due_time: '10:00' }), td({ title: '11/20', due: '2026-11-20' })];
    expect(titlesOf(groupTodos(rows, NOW, TZ), 'later')).toEqual(['11/20 10:00', '11/20', '12/1']);
  });
});

describe('优先级三档（R-434）', () => {
  const titlesOf = (g: ReturnType<typeof groupTodos>, key: string) => g.find((x) => x.key === key)?.items.map((i) => i.todo.title);

  it('读一行：priority 是三档之一就用它；本机还没拉到 priority 的老行按 important 推（true 高，其余中）；不认识的值也按 important 推', () => {
    expect(itemOf(td({ priority: 'low' })).priority).toBe('low');
    expect(itemOf(td({ priority: 'high', important: false })).priority).toBe('high');
    expect(itemOf(td({ important: true })).priority).toBe('high');
    expect(itemOf(td({})).priority).toBe('mid');
    expect(itemOf(td({ priority: 'urgent', important: false })).priority).toBe('mid');
  });

  it('换档高 → 中 → 低 → 高；写入双写旧列 important（只有高是 true）', () => {
    expect([nextPriority('high'), nextPriority('mid'), nextPriority('low')]).toEqual(['mid', 'low', 'high']);
    expect(PRIORITIES.map(prioCols)).toEqual([
      { priority: 'high', important: true }, { priority: 'mid', important: false }, { priority: 'low', important: false },
    ]);
  });

  it('同一截止时刻、没日期那组：高在中前、中在低前，同档按创建时间', () => {
    const rows = [td({ title: 'a', priority: 'low', created_at: 1 }), td({ title: 'b', priority: 'mid', created_at: 2 }), td({ title: 'c', priority: 'high', created_at: 3 }), td({ title: 'd', priority: 'mid', created_at: 4 })];
    expect(titlesOf(groupTodos(rows, NOW, TZ), 'nodate')).toEqual(['c', 'b', 'd', 'a']);
    const due = rows.map((r) => ({ ...r, due: '2026-11-05', due_time: '18:00' }));
    expect(titlesOf(groupTodos(due, NOW, TZ), 'today')).toEqual(['c', 'b', 'd', 'a']);
  });
});
