// 日历页点“＋”、按 Ctrl+N 时带上选中的那天（B2 FA-7 第 5 项；B3 R-353 起交给打字条）。
// “＋”和 Ctrl+N 在 App 外壳里，外壳不知道日历选中了哪天：日历页挂着时把“选中的是哪天”登记进 kit/state/new-item.ts 的 calendarSel（useNewDateSource），
// App 打开打字条时主动读一次（11-14 层栈整块评审第 11 条：原来靠 document 捕获阶段的点击监听、快捷键“后登记先问”的顺序抢先记下，删掉）
// • 打字条“展开编辑”时 App 把这一天放进 new-item：新建日程的表单初始化时读它当默认日期（pendingNewDate），表单挂上以后清掉（clearNewDate）
// • 从别的页点“＋”时 App 不读，新建日程照旧是今天
import { useEffect, useRef } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { calendarSel, newItemDay, setNewItemDay } from '../../../kit/state/new-item.ts';

export const pendingNewDate = (): DateStr | null => newItemDay();

export function clearNewDate(): void {
  setNewItemDay(null);
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
