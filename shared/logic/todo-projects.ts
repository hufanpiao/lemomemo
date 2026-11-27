// 待办的项目（分类）列表和各自条数（纯函数）：待办页的项目筛选条（features/todos 的 useTodoList）、“＋”面板的分类签（features/plus 的 useCaptureCtx）同一份
// （负责人 11-22“分类里面现在不存在的不要显示，分类列表跟待办里面一样”：原来“＋”面板从待办、日程全部行里收项目名，删掉的、全做完的也出）
import type { Locale } from '../i18n/i18n.ts';
import { titleCompare } from '../i18n/title-compare.ts';
import { isLiveRow } from './live-row.ts';
import { lingerView, todoOf } from './todo-row.ts';

/**
 * 项目筛选条：“全部”之外的项目和各自没做完的条数（负责人 11-22 截图“划掉了3个标签还显示4”，弹窗选“只数没完成的”；原来含已完成，照 R-436 确认图）
 * （按条数多的在前；条数一样按项目名，按当前语言、数字按数值，和标题同一个比较）。
 * 一条没做完的都没有的项目不出（负责人 11-21“相关项目勾选完成以后分类自动消失”）；刚勾完还留在原位的（linger）照没完成算，收起以后才减掉
 */
export function projectCounts(rows: readonly Readonly<{ id: string } & Record<string, unknown>>[], locale: Locale = 'zh-CN', linger: ReadonlySet<string> = new Set()): { project: string; count: number }[] {
  const byName = titleCompare(locale);
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!isOpenTodo(r, linger)) continue;
    const { project } = todoOf(r);
    if (project !== '') m.set(project, (m.get(project) ?? 0) + 1);
  }
  return [...m]
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count || byName(a.project, b.project));
}

/** 没删、没做完的待办（刚勾完还留在原位的 linger 也算）：项目胶囊和“全部”胶囊的条数同一个口径 */
export function isOpenTodo(r: Readonly<{ id: string } & Record<string, unknown>>, linger: ReadonlySet<string> = new Set()): boolean {
  return isLiveRow(r) && !lingerView(todoOf(r), linger).done;
}
