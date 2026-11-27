// 新建一条时带过去的东西：“＋”在 App 外壳的底栏里，选中的日子在日历页、打的字在打字条（plus），
// 新建页在 calendar / todos，几方互相不能 import，所以放在 kit 里一份模块级的值：
// • 日历上选中的那天：日历页挂着时登记 calendarSel.day（calendar/hooks/new-date.ts 的 useNewDateSource）；
//   App 点“＋”、按 Ctrl+N 时主动读一次交给打字条（别的页不读）
// • 带去新建页的一份（setNewItem，一处存放）：
//   day 日子：打字条“展开编辑”时 App 放进来，新建日程页拿它当默认日期、挂上以后清掉（clearNewItemDay）；
//   title 打的字：打字条“展开编辑”时放进来；item 整条识别结果：AI 助手确认卡片“改一下”放进来（时长、重要、提醒、备注都在里面）。
//   新建页挂上以后 takeNewItem 取走（kit/hooks/useTypedTitle.ts），各页自己换成表单字段，当成用户填的、照常保存
// 纯 TS，很小，进首屏（CaptureItem 只引类型，不进包）
import type { DateStr } from '../../../shared/core/date.ts';
import type { CaptureItem } from '../../../shared/logic/capture-map.ts';

/**
 * 随手记页底部输入行的聚焦：底栏 / 侧栏的“＋”在随手记页调 focus，把光标放进输入行。随手记页挂着时登记、卸掉时清掉；
 * 由随手记页登记而不是 App 自己找输入框聚焦：要原地聚焦（platform/in-place-focus.ts 的 focusInPlace），它不在首屏，App 不能直接引
 */
export const notesInput: { focus?: (() => void) | undefined } = {};

/** 日历上选中的那天（日历页挂着时登记、卸掉时清掉） */
export const calendarSel: { day?: (() => DateStr | null) | undefined } = {};

export interface NewItem {
  day: DateStr | null;
  title: string | null;
  item: CaptureItem | null;
}

let cur: NewItem = { day: null, title: null, item: null };

/** 记下（或清掉）带去新建页的一份：没给的几样清掉 */
export function setNewItem(p: Partial<NewItem>): void {
  cur = { day: null, title: null, item: null, ...p };
}

/** 看一眼新建要用的日子（不清） */
export const newItemDay = (): DateStr | null => cur.day;

/** 新建日程的表单挂上以后清掉日子，下次从别处新建不再沿用 */
export function clearNewItemDay(): void {
  cur = { ...cur, day: null };
}

/** 新建页取走带过来的字和整条（取一次就清，日子不动） */
export function takeNewItem(): Pick<NewItem, 'title' | 'item'> {
  const { title, item } = cur;
  cur = { ...cur, title: null, item: null };
  return { title, item };
}
