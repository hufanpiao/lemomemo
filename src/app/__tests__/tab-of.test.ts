// 底栏显示在哪些页、选中哪个页签、“＋”新建什么（B2 FA-7；代码审查 L1）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_NAMES } from '../router.ts';
import { NOTES_INPUT_ID, tabBarFor } from '../tab-of.ts';

describe('tabBarFor', () => {
  it('四页：今天、日历、待办、随手记；“＋”今天和日历新建日程、待办新建待办、随手记聚焦输入行', () => {
    expect(tabBarFor('today')).toEqual({ tab: 'today', add: 'event' });
    expect(tabBarFor('calendar')).toEqual({ tab: 'calendar', add: 'event' });
    expect(tabBarFor('todos')).toEqual({ tab: 'todos', add: 'todo' });
    expect(tabBarFor('notes')).toEqual({ tab: 'notes', add: 'note' }); // R-380：随手记页的“＋”聚焦输入行
  });

  it('日历月份子页 #/cal/…：选中“日历”，“＋”同样新建日程', () => {
    expect(tabBarFor('cal')).toEqual({ tab: 'calendar', add: 'event' });
  });

  it('别的页一律没有底栏（编辑、设置、提醒、回收站……）', () => {
    const shown = new Set(['today', 'calendar', 'cal', 'todos', 'notes']);
    for (const r of ROUTE_NAMES) if (!shown.has(r)) expect(tabBarFor(r), r).toBeNull();
  });
});

describe('随手记页的“＋”聚焦输入行（R-380）', () => {
  it('随手记页里输入框的 id 和 NOTES_INPUT_ID 是同一个值（功能不能引 app 的文件，各写一份，这里核对）', () => {
    const src = readFileSync(resolve(import.meta.dirname, '..', '..', 'features/notes/ui/NotesPage.tsx'), 'utf8');
    expect(src).toContain(`const NOTES_INPUT_ID = '${NOTES_INPUT_ID}';`);
  });
});
