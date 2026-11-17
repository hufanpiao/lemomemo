// 待办行的动作组装（主持人 11-17 评审去重；11-17 从 features/todos/hooks/useTodoRowActions.ts 挪进 kit，今天页也用这一份）：
// 待办页、日历日清单的待办组（R-443）、今天页拼的都是同一套 useHoldView、kit useListActions、useDoneFlow、优先级换档、页底提示条参数，
// 各页不同的只有三样数据：词条（words，各功能词典里的）、子任务卡片和行尾未同步小标记两个部件（parts，在别的功能包里、kit 引不到），
// 和测试 id 前缀（prefix）。一行画在 kit/components/TodoRow.tsx，它只认这里回来的 r
// • 调用顺序：页面先 useLinger（列表要按 linger.ids 留住刚勾的那几条），拿到列表数据 view 再交给这里（useHoldView 留住的就是 view）
// • 打勾、删除、撤销、只读拦截、出错条在 kit useListActions；勾完的停留、收起、撤销条在 useDoneFlow
// • prio：H / M / L 换档（kit PrioCycle 点哪格设哪档、键盘读屏换下一档），只读行拦下出“要新版本”，写入结果照打勾一样报（出错条）
import type { ComponentType } from 'react';
import type { ListToastsProps } from './ListToasts.tsx';
import type { ReadonlyPartProps } from './ReadonlyMark.tsx';
import { prioLabel, prioSet } from './Priority.tsx';
import { useListActions, type ActionResult } from '../hooks/useListActions.ts';
import { useHoldView } from '../../motion/components.ts';
import type { Priority } from '../../../shared/logic/todo-row.ts';
import { useDoneFlow, type DoneToast, type Linger, type SubDone } from './useDoneFlow.ts';

/** 这一行要的三样写入 */
export interface TodoWrites {
  toggleDone(id: string, done: boolean): Promise<ActionResult>;
  remove(id: string, deleted: boolean): Promise<ActionResult>;
  setPriority(id: string, p: Priority): Promise<ActionResult>;
}

/** 行里用到的词条（各功能词典里的同几句） */
export interface TodoRowWords {
  /** 方框的读屏名字：没勾“完成”，勾了“标成没完成” */
  done: string;
  undoDone: string;
  /** 打勾完成以后撤销条的“已完成” */
  doneToast: string;
  /** 高、中、低 */
  prio(p: Priority): string;
  /** “优先级：中，按一下换成低” */
  prioLine(v: { p: string; next: string }): string;
  /** 副行“起步 / 大半”小标签 */
  stage(s: 1 | 2): string;
  /** 页底提示条 */
  toasts: ListToastsProps<DoneToast>['text'];
}

/** 子任务卡片（features/todos 的 InlineSubtasks；今天页另包一层首屏画完才挂）要的参数 */
export interface SubsPartProps {
  prefix: string;
  id: string;
  title: string;
  readOnly: boolean;
  done: boolean;
  collapsed?: boolean | undefined;
  onCollapse?: ((v: boolean) => void) | undefined;
  onBlock(): void;
  onOpen(): void;
  onPlan?(plan: boolean | null): void;
  onResult(r: SubDone): void;
}

/** 页面给的三个部件：子任务卡片、行尾“未同步”小标记（reminders 的 UnsyncedRemindMark；没有时画空）、只读行的标记和方框
 *  （kit ReadonlyMark.tsx 的 ReadonlyPart；今天页按需下载那一份，只读词典不进首屏） */
export interface TodoRowParts {
  Subs: ComponentType<SubsPartProps>;
  Mark: ComponentType<{ id: string }>;
  Ro: ComponentType<ReadonlyPartProps>;
}

/** prefix：测试 id 前缀、行上 data-row 的值（todos、cal-todos、today） */
export function useTodoRows<T>(view: T, lg: Linger, w: TodoWrites, prefix: string, words: TodoRowWords, parts: TodoRowParts) {
  const hv = useHoldView(view);
  const a = useListActions<DoneToast>('todos', { toggle: w.toggleDone, remove: w.remove }, hv);
  const flow = useDoneFlow(a, lg, hv.hold, { done: words.doneToast }, prefix);
  const toasts: ListToastsProps<DoneToast> = { g: a.g, onUndo: a.undo, text: words.toasts, prefix, extra: flow.undoOf };
  return {
    words,
    parts,
    prefix,
    view: hv.view,
    hold: hv.hold,
    a,
    flow,
    prio: (id: string, p: Priority) => prioSet(a.isRo(id), () => a.g.block(), () => w.setPriority(id, p), a.report),
    /** 读屏名字：“优先级：中，按一下换成低”（kit prioLabel） */
    prioLabel: (p: Priority) => prioLabel(p, words.prio, words.prioLine),
    /** 页底提示条（kit ListToasts）的全部参数 */
    toasts,
  };
}
export type TodoRows = ReturnType<typeof useTodoRows>;
