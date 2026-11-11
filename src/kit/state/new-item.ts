// 新建一条时带过去的东西（B2 FA-7 第 5 项；B3 R-353）：“＋”在 App 外壳的底栏里，选中的日子在日历页、打的字在打字条（plus），
// 新建页在 calendar / todos，几方互相不能 import，所以放在 kit 里一份模块级的值：
// • 日子：日历页挂着时，点“＋”那一刻记下日历上选中的那天（calendar/hooks/new-date.ts 的 watchAddClick 写）；
//   App 在“＋”点下时取走交给打字条（别的页点“＋”时清掉，不沿用上次日历页的）；“展开编辑”时再放回来，新建日程页拿它当默认日期
// • 打的字：打字条“展开编辑”时放进来，新建页挂上以后取走填进标题（当成用户打的，照常保存，不丢字）
// 纯 TS，很小，进首屏
import type { DateStr } from '../../../shared/core/date.ts';

/** 随手记页底部输入框的 id：底栏 / 侧栏的“＋”在随手记页按它聚焦（R-380；App 和随手记页都从这里引） */
export const NOTES_INPUT_ID = 'notes-input';

let day: DateStr | null = null;
let title: string | null = null;

/** 记下（或清掉）新建要用的日子 */
export function setNewItemDay(d: DateStr | null): void {
  day = d;
}

/** 看一眼新建要用的日子（不清） */
export function newItemDay(): DateStr | null {
  return day;
}

/** 取走新建要用的日子 */
export function takeNewItemDay(): DateStr | null {
  const d = day;
  day = null;
  return d;
}

/** 打字条“展开编辑”带过去的字 */
export function setNewItemTitle(t: string | null): void {
  title = t;
}

/** 新建页取走带过来的字（取一次就清） */
export function takeNewItemTitle(): string | null {
  const t = title;
  title = null;
  return t;
}
