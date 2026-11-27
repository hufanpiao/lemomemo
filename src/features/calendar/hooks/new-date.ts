// 日历页点“＋”、按 Ctrl+N 时带上选中的那天（交给打字条）。
// “＋”和 Ctrl+N 在 App 外壳里，外壳不知道日历选中了哪天：日历页挂着时把“选中的是哪天”登记进 kit/state/new-item.ts 的 calendarSel（useNewDateSource），
// App 打开打字条时主动读一次（不靠 document 捕获阶段的点击监听抢先记下）
// • 打字条“展开编辑”时 App 把这一天放进 new-item：新建日程的表单初始化时读它当默认日期（pendingNewDate），表单挂上以后清掉（clearNewDate）
// • 从别的页点“＋”时 App 不读，新建日程照旧是今天
import { useEffect, useRef } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { calendarSel, clearNewItemDay, newItemDay } from '../../../kit/state/new-item.ts';

export const pendingNewDate = (): DateStr | null => newItemDay();

export function clearNewDate(): void {
  clearNewItemDay();
}

/** 日历页挂着时调：登记选中的那天，卸掉时撤 */
export function useNewDateSource(selected: DateStr | null): void {
  const sel = useRef(selected);
  sel.current = selected;
  useEffect(() => {
    const day = (): DateStr | null => sel.current;
    calendarSel.day = day;
    return () => {
      if (calendarSel.day === day) calendarSel.day = undefined;
    };
  }, []);
}
