// 待办行的动作组装：待办页、日历日清单的待办组、今天页拼的都是同一套 useHoldView、kit useListActions、useDoneFlow、优先级换档、页底提示条参数，
// 各页不同的只有两样数据：子任务卡片和行尾未同步小标记两个部件（parts，在别的功能包里、kit 引不到），和 data-row 前缀（prefix）。
// 词条是 kit 自己的（useTodoRowWords.ts）。一行画在 kit/components/TodoRow.tsx，它只认这里回来的 r
// • 调用顺序：页面先 useLinger（列表要按 linger.ids 留住刚勾的那几条），拿到列表数据 view 再交给这里（useHoldView 留住的就是 view）
// • 打勾、删除、撤销、只读拦截、出错条在 kit useListActions；勾完的停留、收起、撤销条在 useDoneFlow
// • prio：H / M / L 换档（kit PrioCycle 点哪格设哪档、键盘读屏换下一档），只读行拦下出“要新版本”，写入结果照打勾一样报（出错条）
// • later：过期没做完的行尾“推迟”：截止日改成明天，写成了页底出“已推迟到明天 · 撤销”（和完成的撤销条同一个位置、同时只一条），
//   撤销把原来的截止日写回去；只读行拦下出“要新版本”，没写进去照打勾一样报（出错条）
import { useRef, type ComponentType } from 'react';
import { useLive } from '../hooks/useLive.ts';
import type { ListToastsProps } from './ListToasts.tsx';
import type { ReadonlyPartProps } from './ReadonlyMark.tsx';
import { prioLabel, prioSet } from './Priority.tsx';
import { useListActions, type ActionResult } from '../hooks/useListActions.ts';
import { useHoldView } from '../../motion/components.ts';
import type { Priority } from '../../../shared/logic/todo-row.ts';
import { useDoneFlow, type DoneToast, type LaterToast, type Linger, type SubDone } from './useDoneFlow.ts';
import type { Postponed } from '../hooks/useTodoWrites.ts';
import { useTodoRowWords } from './useTodoRowWords.ts';

/** 这一行要的三样写入 */
export interface TodoWrites {
  toggleDone(id: string, done: boolean): Promise<ActionResult>;
  remove(id: string, deleted: boolean): Promise<ActionResult>;
  setPriority(id: string, p: Priority): Promise<ActionResult>;
  /** 推迟到明天（kit/hooks/useTodoWrites.ts） */
  postpone(id: string): Promise<Postponed>;
}

/** 页底撤销条的两种（完成、推迟），同一个位置 */
export type RowToast = DoneToast | LaterToast;

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

/** prefix：行上 data-row 的值、提示条测试 id 前缀（todos、cal-todos、today） */
export function useTodoRows<T>(view: T, lg: Linger, w: TodoWrites, prefix: string, parts: TodoRowParts) {
  const words = useTodoRowWords();
  const hv = useHoldView(view);
  const a = useListActions<RowToast>('todos', { toggle: w.toggleDone, remove: w.remove }, hv);
  const flow = useDoneFlow(a, lg, hv.hold, { done: words.doneToast }, prefix);
  const seq = useRef(0);
  const extra = (x: RowToast) =>
    x.kind === 'done'
      ? flow.undoOf(x)
      : { key: `later:${x.n}`, message: words.laterToast, onUndo: () => void x.undo().then(a.report), testId: `${prefix}-later-toast` };
  const toasts: ListToastsProps<RowToast> = { g: a.g, onUndo: a.undo, text: words.toasts, prefix, extra, undoRef: flow.undoRef };
  const prio = (id: string, p: Priority) => prioSet(a.isRo(id), () => a.g.block(), () => w.setPriority(id, p), a.report);
  /** 推迟到明天（见文件头 later） */
  const later = (id: string) => {
    if (a.isRo(id)) return a.g.block();
    void w.postpone(id).then(({ res, undo }) => {
      if (!undo) return a.report(res);
      seq.current += 1;
      a.g.show({ kind: 'later', id, undo, n: seq.current }, null);
    });
  };
  // 行里点下去调的几样，按“最新这一次渲染”的 a、flow、prio、later 走（kit TodoRow 是 memo 的，别的行变了它不重画，
  // 手里那份 r 可能是几次渲染以前的；事件一律走 act）。act 经 kit hooks/useLive.ts 从头到尾是同一个对象（TodoRow 的 memo 比 pr.act === nr.act）
  const act = useLive({
    check: (id: string, v: boolean) => flow.check(id, v),
    prio: (id: string, p: Priority) => prio(id, p),
    later: (id: string) => later(id),
    plan: (id: string, plan: boolean | null) => flow.plan(id, plan),
    result: (id: string, x: SubDone) => flow.result(id, x),
    block: () => a.g.block(),
  });
  return {
    words,
    parts,
    prefix,
    view: hv.view,
    hold: hv.hold,
    a,
    flow,
    prio,
    later,
    act,
    /** 读屏名字：“优先级：中，按一下换成低”（kit prioLabel） */
    prioLabel: (p: Priority) => prioLabel(p, words.prio, words.prioLine),
    /** 页底提示条（kit ListToasts）的全部参数 */
    toasts,
  };
}
export type TodoRows = ReturnType<typeof useTodoRows>;
