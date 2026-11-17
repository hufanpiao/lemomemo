// 待办行的动作组装（主持人 11-17 评审去重）：待办页和日历日清单的待办组（R-443）原来各自拼一遍 useHoldView、kit useListActions、useDoneFlow、
// 优先级换档、读屏名字和页底提示条的文案，这里合成一份；行本身画在 ui/TodoRow.tsx
// • 调用顺序：页面先 useLinger（列表要按 linger.ids 留住刚勾的那几条），拿到列表数据 view 再交给这里（useHoldView 留住的就是 view）
// • 打勾、删除、撤销、只读拦截、出错条在 kit useListActions；勾完的停留、收起、撤销条在 useDoneFlow；写入在 useTodoList.ts 的 useTodoWrites
// • prio：H / M / L 换档（kit PrioCycle 点哪格设哪档、键盘读屏换下一档），只读行拦下出“要新版本”，写入结果照打勾一样报（出错条）
import type { ActionResult } from '../../../core/action-result.ts';
import type { ListToastsProps } from '../../../kit/components/ListToasts.tsx';
import { useListActions } from '../../../kit/hooks/useListActions.ts';
import { useHoldView } from '../../../motion/components.ts';
import { nextPriority, type Priority } from '../../../../shared/logic/todo-row.ts';
import { useDoneFlow, type DoneToast, type Linger } from './useDoneFlow.ts';
import { useListT } from './useTodoList.ts';

/** 这一行要的三样写入（useTodoList.ts 的 useTodoWrites） */
export interface TodoWrites {
  toggleDone(id: string, done: boolean): Promise<ActionResult>;
  remove(id: string, deleted: boolean): Promise<ActionResult>;
  setPriority(id: string, p: Priority): Promise<ActionResult>;
}

/** prefix：测试 id 前缀、行上 data-row 的值（todos、cal-todos） */
export function useTodoRowActions<T>(view: T, lg: Linger, w: TodoWrites, prefix: string) {
  const t = useListT();
  const hv = useHoldView(view);
  const a = useListActions<DoneToast>('todos', { toggle: w.toggleDone, remove: w.remove }, hv);
  const flow = useDoneFlow(a, lg, hv.hold, { done: t('list.doneToast', {}) }, prefix);
  const prioName = (p: Priority) => t(`list.prio.${p}`, {});
  const toasts: ListToastsProps<DoneToast> = {
    g: a.g,
    onUndo: a.undo,
    text: { deleted: t('list.deleted', {}), undo: t('list.undo', {}), error: t('list.err.save', {}), readonly: t('list.err.readonly', {}) },
    prefix,
    extra: flow.undoOf,
  };
  return {
    t,
    prefix,
    view: hv.view,
    a,
    flow,
    prio: (id: string, p: Priority) => (a.isRo(id) ? a.g.block() : void w.setPriority(id, p).then(a.report)),
    /** 读屏名字：“优先级：中，按一下换成低” */
    prioLabel: (p: Priority) => t('list.prio', { p: prioName(p), next: prioName(nextPriority(p)) }),
    /** 页底提示条（kit ListToasts）的全部参数 */
    toasts,
  };
}
export type TodoRowActions = ReturnType<typeof useTodoRowActions>;
