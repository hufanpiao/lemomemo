// 待办完成以后先留在原位、页底出“已完成 · 撤销”的那一套（负责人 11-15 方案；审查 11-15 第 4 条收成一套）：待办页用，
// 原来写在 ui/TodosPage.tsx 里，R-442 重写待办页时挪到这里（页面文件只管画）
// • 打勾完成、勾完最后一个子任务自动完成走同一条路：这一条记进 linger（集合），页底出撤销条（DONE_LINGER_MS 约 3 秒，solo keep，后出的顶掉前一条；
//   鼠标停在条上时一起多留），两种只差文案和撤销做什么（打勾的撤销 = 再点一下方框，core/todo-done.ts 按撤销写回原来的 done_at；
//   自动完成的撤销调 InlineSubtasks 回来的 undo，刚勾的那项和主待办一起撤回，R-350 Q1）
// • 撤销条开着期间勾过的都留在原位，最后一条撤销条收起（到时、被删除的撤销条或出错条顶掉）时一起放走（分组、列表里归进“已完成”或消失）。
//   点了撤销、或自己把方框点回去：那一条等写入完成（promise 回来）才从 linger 里拿掉，不靠 useHoldView 停一拍的时机兜底
// • 勾子任务会改回未完成（Q2）：先留住按下之前的列表（hold）再挪回去，不出撤销条
// 页面先调 useLinger（列表按 linger.ids 留住那几条），再把 kit useListActions 的结果交给 useDoneFlow
import { useMemo, useRef, useState } from 'react';
import type { ActionResult } from '../../../core/action-result.ts';
import type { ExtraUndo } from '../../../kit/components/ListToasts.tsx';
import type { ListToast } from '../../../kit/hooks/useListActions.ts';
import type { ReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';
import type { SubTickResult } from './useSubtasks.ts';

/** 完成以后的撤销条：undo 是自动完成的撤销（打勾完成是 null，撤销 = 再点一下方框），message 是文案，n 每出一条加一（换一条重新计时） */
export type DoneToast = { kind: 'done'; id: string; undo: (() => Promise<ActionResult>) | null; message: string; n: number };

/** 撤销条开着期间勾过的在原位留多久（撤销条同样长；负责人 11-15 选的“约 3 秒”） */
export const DONE_LINGER_MS = 3000;
const NO_LINGER: ReadonlyMap<string, boolean> = new Map();

/**
 * 完成以后先留在原位的那几条（id → 有写入还没回来）：ids 给列表；put 记进来（pending 为 true：写入还没回来，撤销条收起也先不放）；drop 拿掉；
 * settle 撤销这一条，写完（promise 回来）才拿掉，这之前一直留在原位；sweep 撤销条都收起时调，没有写入在等的一起放走
 */
export function useLinger() {
  const [m, setM] = useState<ReadonlyMap<string, boolean>>(NO_LINGER);
  const ids = useMemo(() => new Set(m.keys()), [m]);
  const drop = (id: string) => setM((x) => (x.has(id) ? new Map([...x].filter(([k]) => k !== id)) : x));
  return {
    ids,
    put: (id: string, pending: boolean) => setM((x) => new Map(x).set(id, pending)),
    drop,
    settle(id: string, write: Promise<unknown>) {
      setM((x) => (x.has(id) ? new Map(x).set(id, true) : x));
      void write.then(() => drop(id));
    },
    sweep() {
      if ([...m.values()].some((pending) => !pending)) setM(new Map([...m].filter(([, pending]) => pending)));
    },
  };
}
export type Linger = ReturnType<typeof useLinger>;

/** kit useListActions 回来的那几样（页面的 a） */
interface Acts {
  g: ReadonlyGuard<ListToast | DoneToast>;
  isRo(id: string): boolean;
  tick(id: string, on: boolean): Promise<void>;
  report(r: ActionResult): void;
}

/** hold：页面 useHoldView 的 hold（改回未完成时先留住列表）；text.done 是打勾完成那条的文案；prefix 是测试 id 前缀（todos） */
export function useDoneFlow(a: Acts, lg: Linger, hold: () => void, text: { done: string }, prefix: string) {
  const doneToast = a.g.toast?.kind === 'done' ? a.g.toast : null;
  // 撤销条都收起了：留在原位的一起放走。画的时候就对上（React 的“画时调整状态”，不等 effect、不闪一帧）
  if (!doneToast) lg.sweep();
  const seq = useRef(0);
  const stay = (id: string, undo: DoneToast['undo'], message: string) => {
    lg.put(id, false);
    seq.current += 1;
    a.g.show({ kind: 'done', id, undo, message, n: seq.current });
  };
  return {
    /** 打勾；把留在原位的那一条自己点回去 = 撤销（撤销条是它的就一起收起；只读行 tick 里已拦下） */
    check(id: string, v: boolean) {
      const write = a.tick(id, v);
      if (a.isRo(id)) return;
      if (v) return stay(id, null, text.done);
      lg.settle(id, write);
      if (doneToast?.id === id) a.g.dismiss(doneToast);
    },
    /** 勾子任务写之前（InlineSubtasks 的 onPlan）：会自动完成就先记进 linger、标成写入还没回来；会改回未完成就先留住列表（Q2） */
    plan(id: string, plan: boolean | null) {
      if (plan === true) lg.put(id, true);
      else if (plan === false) hold();
    },
    /** 勾子任务写完（onResult）：自动完成了出撤销条；没自动完成（出错、被别处抢先改了）不留 */
    result(id: string, r: SubTickResult) {
      if (r.res === 'ok' && r.auto === true) return stay(id, r.undo, r.message);
      if (r.plan === true) lg.drop(id);
      a.report(r.res);
    },
    /** 撤销条的文案和撤销做什么（kit ListToasts 的 extra） */
    undoOf: (x: DoneToast): ExtraUndo => ({
      key: `done:${x.n}`,
      message: x.message,
      onUndo: () => lg.settle(x.id, x.undo ? x.undo().then(a.report) : a.tick(x.id, false)),
      ms: DONE_LINGER_MS,
      testId: `${prefix}-${x.undo ? 'auto' : 'done'}-toast`,
    }),
  };
}
