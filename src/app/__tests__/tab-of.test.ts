// 底栏显示在哪些页、选中哪个页签、“＋”新建什么（B2 FA-7；代码审查 L1）
import { describe, expect, it } from 'vitest';
import { ROUTE_NAMES } from '../router.ts';
import { tabBarFor } from '../tab-of.ts';

describe('tabBarFor', () => {
  it('四页：今天、日历、待办、随手记；“＋”今天和日历新建日程、待办新建待办、随手记聚焦输入行', () => {
    expect(tabBarFor('today')).toEqual({ tab: 'today', add: 'event' });
    expect(tabBarFor('calendar')).toEqual({ tab: 'calendar', add: 'event' });
    expect(tabBarFor('todos')).toEqual({ tab: 'todos', add: 'todo' });
    expect(tabBarFor('notes')).toEqual({ tab: 'notes', add: 'note' }); // R-380：随手记页的“＋”聚焦输入行
  });

  it('日历月份子页 #/cal/…：选中“日历”，“＋”同样新建日程', () => {
    expect(tabBarFor('cal')).toEqual({ tab: 'calendar', add: 'event' });
    // 纪念日页和日历同一层（周 / 月 / 纪念日分段，R-372 ②）：底栏照常、选中“日历”
    expect(tabBarFor('anniv')).toEqual({ tab: 'calendar', add: 'event' });
  });

  it('别的页一律没有底栏（编辑、设置、提醒、回收站……）', () => {
    const shown = new Set(['today', 'calendar', 'cal', 'anniv', 'todos', 'notes']);
    for (const r of ROUTE_NAMES) if (!shown.has(r)) expect(tabBarFor(r), r).toBeNull();
  });
});
