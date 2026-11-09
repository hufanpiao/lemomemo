// 日历页点“＋”时带上选中的那天（B2 FA-7 第 5 项；B3 R-353 起交给打字条）。
// “＋”在 App 外壳的底栏里，外壳不知道日历选中了哪天，所以由日历页自己记，值放在 kit/state/new-item.ts（App、打字条、新建页都读得到）：
// • 日历页挂着时在 document 上按捕获阶段听“＋”（底栏的 data-testid="tabbar-add"）的点击，点下那一刻记下选中的日期（watchAddClick）；
//   捕获阶段先于“＋”自己的 onClick，App 在 onClick 里取走交给打字条（打字条里没说日子的记到这天，R-353）；
//   Ctrl+N（打字记一条，S24）同理：捕获阶段先记下，App 的 useKeys 在冒泡阶段取走
// • 打字条“展开编辑”时 App 把这一天放回去：新建日程的表单初始化时读它当默认日期（pendingNewDate），表单挂上以后清掉（clearNewDate）
// • 从今天页点“＋”时日历页不在，不会记，App 也会清掉旧的；新建日程照旧是今天
import type { DateStr } from '../../../../shared/core/date.ts';
import { keyName } from '../../../kit/hooks/useKeys.ts';
import { newItemDay, setNewItemDay } from '../../../kit/state/new-item.ts';

export const pendingNewDate = (): DateStr | null => newItemDay();

export function clearNewDate(): void {
  setNewItemDay(null);
}

/** 日历页挂着时调：点“＋”或按 Ctrl+N 那一刻记下 selected()；返回取消函数 */
export function watchAddClick(selected: () => DateStr | null, doc: Document = document): () => void {
  const onClick = (e: Event): void => {
    if (e.target instanceof Element && e.target.closest('[data-testid="tabbar-add"]')) setNewItemDay(selected());
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!e.isComposing && keyName(e) === 'mod+n') setNewItemDay(selected());
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
  };
}
