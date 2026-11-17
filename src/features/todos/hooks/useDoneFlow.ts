// 待办勾完以后的那一秒（负责人 11-17 定的勾选特效分镜；原来负责人 11-15 方案是“留在原位约 3 秒、撤销条收起才走”，这次按分镜改）：待办页和日历日清单的待办组（R-443）共用，
// 原来写在 ui/TodosPage.tsx 里，R-442 重写待办页时挪到这里（页面文件只管画）
// • 打勾完成、勾完最后一个子任务自动完成走同一条路（stay）：
//   ① 按下、② 勾上加划线在方框和标题自己的 CSS 里（kit CheckCircle、TodosPage.module.css）；
//   ③ 这一条记进 linger 留在原位、停留到 DONE_HOLD_MS（700ms，让人看清“做完了”）；
//   ④ 到点打上 out（页面给这一行 data-out，高度 280ms 收到 0 同时淡出，--ease-drawer），⑤ 同时页底升起撤销条（kit UndoToast，8 秒倒计时色带）；
//   收完（DONE_HOLD_MS + DONE_OUT_MS）从 linger 拿掉，这一条归进“已完成”组（收着就不见了）
// • 减弱动态效果（:root[data-rm='1']）：不收高度，只淡出 110ms（--dur-ui 的一半），然后直接移走（DONE_OUT_RM_MS）
// • 撤销：点撤销条（打勾的撤销 = 再点一下方框，core/todo-done.ts 按撤销写回原来的 done_at；自动完成的撤销调 InlineSubtasks 回来的 undo，
//   刚勾的那项和主待办一起撤回，R-350 Q1）；收起之前自己把方框点回去也算撤销：计时取消，这一条等写入完成（promise 回来）才从 linger 拿掉
// • 勾子任务会改回未完成（Q2）：先留住按下之前的列表（hold）再挪回去，不出撤销条
// 页面先调 useLinger（列表按 linger.ids 留住那几条），再把 kit useListActions 的结果交给 useDoneFlow
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionResult } from '../../../core/action-result.ts';
import type { ExtraUndo } from '../../../kit/components/ListToasts.tsx';
import type { ListToast } from '../../../kit/hooks/useListActions.ts';
import type { ReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';
import { prefersReducedMotion } from '../../../motion/index.ts';
import type { SubTickResult } from './useSubtasks.ts';

/** 完成以后的撤销条：undo 是自动完成的撤销（打勾完成是 null，撤销 = 再点一下方框），message 是文案，n 每出一条加一（换一条重新计时） */
export type DoneToast = { kind: 'done'; id: string; undo: (() => Promise<ActionResult>) | null; message: string; n: number };

/** 勾上以后停多久才开始收这一行、升起撤销条（分镜第 ③ 段止于 700ms） */
export const DONE_HOLD_MS = 700;
/** 这一行收起的时长（分镜第 ④ 段，令牌 --dur-collapse，同 TodosPage.module.css 的 .item[data-out]） */
export const DONE_OUT_MS = 280;
/** 减弱动态效果时只淡出的时长（calc(var(--dur-ui) / 2)） */
export const DONE_OUT_RM_MS = 110;
const NO_LINGER: ReadonlyMap<string, boolean> = new Map();

/**
 * 勾完先留在原位的那几条（id → 有写入还没回来）：ids 给列表；put 记进来（pending 为 true：写入还没回来）；drop 拿掉；
 * settle 撤销这一条，写完（promise 回来）才拿掉，这之前一直留在原位
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

/** hold：页面 useHoldView 的 hold（改回未完成时先留住列表）；text.done 是打勾完成那条的文案；prefix 是测试 id 前缀（todos、cal） */
export function useDoneFlow(a: Acts, lg: Linger, hold: () => void, text: { done: string }, prefix: string) {
  // 计时到点时用最新一次渲染的 a、lg（不用闭包里旧的那份）
  const cur = useRef({ a, lg });
  cur.current = { a, lg };
  const seq = useRef(0);
  const timers = useRef(new Map<string, number[]>());
  /** 正在收起的那几条（页面给它们打 data-out） */
  const [out, setOut] = useState<ReadonlySet<string>>(() => new Set());
  const setOutOf = (id: string, on: boolean) =>
    setOut((x) => (x.has(id) === on ? x : on ? new Set(x).add(id) : new Set([...x].filter((k) => k !== id))));
  const cancel = (id: string) => {
    for (const h of timers.current.get(id) ?? []) clearTimeout(h);
    timers.current.delete(id);
    setOutOf(id, false);
  };
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const hs of all.values()) for (const h of hs) clearTimeout(h);
      all.clear();
    };
  }, []);

  const stay = (id: string, undo: DoneToast['undo'], message: string) => {
    cancel(id);
    lg.put(id, false);
    const gone = DONE_HOLD_MS + (prefersReducedMotion() ? DONE_OUT_RM_MS : DONE_OUT_MS);
    const t1 = window.setTimeout(() => {
      setOutOf(id, true);
      seq.current += 1;
      cur.current.a.g.show({ kind: 'done', id, undo, message, n: seq.current });
    }, DONE_HOLD_MS);
    const t2 = window.setTimeout(() => {
      // 两件同一拍：这一行离开原来的组（离场那一份还带着 data-out），在“已完成”组里重新出现时不带
      timers.current.delete(id);
      setOutOf(id, false);
      cur.current.lg.drop(id);
    }, gone);
    timers.current.set(id, [t1, t2]);
  };
  return {
    out,
    /** 打勾；收起之前把方框自己点回去 = 撤销（撤销条是它的就一起收起；只读行 tick 里已拦下） */
    check(id: string, v: boolean) {
      const write = a.tick(id, v);
      if (a.isRo(id)) return;
      if (v) return stay(id, null, text.done);
      cancel(id);
      lg.settle(id, write);
      const toast = a.g.toast;
      if (toast?.kind === 'done' && toast.id === id) a.g.dismiss(toast);
    },
    /** 勾子任务写之前（InlineSubtasks 的 onPlan）：会自动完成就先记进 linger、标成写入还没回来；会改回未完成就先留住列表（Q2） */
    plan(id: string, plan: boolean | null) {
      if (plan === true) lg.put(id, true);
      else if (plan === false) hold();
    },
    /** 勾子任务写完（onResult）：自动完成了照打勾一样停留、收起、出撤销条；没自动完成（出错、被别处抢先改了）不留 */
    result(id: string, r: SubTickResult) {
      if (r.res === 'ok' && r.auto === true) return stay(id, r.undo, r.message);
      if (r.plan === true) lg.drop(id);
      a.report(r.res);
    },
    /** 撤销条的文案和撤销做什么（kit ListToasts 的 extra）；时长用 kit 默认的 8 秒（UNDO_TOAST_MS，倒计时色带同一时长） */
    undoOf: (x: DoneToast): ExtraUndo => ({
      key: `done:${x.n}`,
      message: x.message,
      onUndo: () => {
        cancel(x.id);
        lg.settle(x.id, x.undo ? x.undo().then(a.report) : a.tick(x.id, false));
      },
      testId: `${prefix}-${x.undo ? 'auto' : 'done'}-toast`,
    }),
  };
}
