// 日历页点“＋”新建日程时带上选中的那天（B2 FA-7 第 5 项）。
// “＋”在 App 外壳的底栏里，外壳不知道日历选中了哪天，首屏余量也不够再往外壳里加代码，所以由日历页自己记：
// • 日历页挂着时在 document 上按捕获阶段听“＋”（底栏的 data-testid="tabbar-add"）的点击，点下那一刻记下选中的日期（watchAddClick）；
// • 新建日程的表单初始化时读它当默认日期（pendingNewDate），表单挂上以后清掉（clearNewDate）——
//   第一次进编辑页要等分包，读的时候日历页已经卸掉了，所以不能在日历页卸载时清；
// • 从今天页点“＋”时日历页不在，不会记，新建日程照旧是今天
import type { DateStr } from '../../../../shared/core/date.ts';

let pending: DateStr | null = null;

export const pendingNewDate = (): DateStr | null => pending;

export function clearNewDate(): void {
  pending = null;
}

/** 日历页挂着时调：点“＋”那一刻记下 selected()；返回取消函数 */
export function watchAddClick(selected: () => DateStr | null, doc: Document = document): () => void {
  const onClick = (e: Event): void => {
    if (e.target instanceof Element && e.target.closest('[data-testid="tabbar-add"]')) pending = selected();
  };
  doc.addEventListener('click', onClick, true);
  return () => doc.removeEventListener('click', onClick, true);
}
