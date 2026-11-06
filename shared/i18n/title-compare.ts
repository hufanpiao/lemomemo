// 标题比较（设计审查：长列表显示成“第 1、10、11 … 2、20”）：按当前语言，数字按数值比（Intl.Collator numeric），
// “第 2 条”排在“第 10 条”前面。今天页（features/today/data/today-model.ts）和待办页（features/todos/data/todo-list.ts）共用；
// 只换比较方法，各处的排序口径不变。Collator 按语言缓存，排序时不每次新建。纯函数，不碰 DOM
import type { Locale } from './i18n.ts';

const collators = new Map<Locale, Intl.Collator>();

/** 按 locale 比较两个标题的函数（可直接给 sort 用） */
export function titleCompare(locale: Locale): (a: string, b: string) => number {
  let c = collators.get(locale);
  if (!c) {
    c = new Intl.Collator(locale, { numeric: true });
    collators.set(locale, c);
  }
  return c.compare;
}
