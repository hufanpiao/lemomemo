// 待办勾完以后的那一秒的计时（勾选完成时间线，负责人 11-17 原话“动效太轻了，根本反应不过来”加参考视频 点击特效.mp4）：
// 待办页、日历日清单的待办组（R-443）、今天页（11-17 负责人“今天页待办带子任务的跟其他页面不一样”起）共用；一行画在 kit/components/TodoRow.tsx，
// 动作组装在 ./useTodoRows.ts，这里只管时序。11-17 从 features/todos/hooks 挪进 kit：今天页在首屏、只能引 kit，不能引待办那一包；
// 放在 kit/components 不放 kit/hooks：要读动效令牌、和 TodoRow 一起用，kit 的 hooks 按边界规则引不到 src/motion
// • 整条时间线的时刻、时长只在动效令牌（src/motion/tokens.ts 的“勾选完成时间线”一段）：按下缩小、放大过头、炸开、划线都是 CSS 自己按令牌播
//  （kit CheckCircle、kit List 的 .strike），这里只排两个计时——停到 --dur-done-pop + --dur-done-rest 开始收起，再过 --dur-collapse 收完
// • 打勾完成、勾完最后一个子任务自动完成走同一条路（stay）：
//   ① 这一条记进 linger 留在原位、方框按 linger 画成勾上（不等写入回来，也不调页面的 hold）；
//   ② 停到 HOLD_MS、而且写入回来是 ok，才打上 out（行上 data-out，高度收到 0 同时淡出），同时页底升起撤销条（kit UndoToast，5 秒倒计时色带）；
//      写入不是 ok（出错、只读）就不收、不出撤销条，从 linger 拿掉，出错条留着；
//   开始收起的同时，焦点在这一行里的（键盘、读屏勾的）移到下一行的方框，没有下一行就移到本页撤销条的按钮（画出来以后），焦点不丢；
//   ③ 收完（再过 OUT_MS）从 linger 拿掉，这一条归进“已完成”组 /“已过去”（收着就不见了）
// • 减弱动态效果：时长不变，只是 CSS 那边不收高度、只淡出（kit List 的 .fold），所以这里不分两种计时
// • 撤销：点撤销条（打勾的撤销 = 再点一下方框，core/todo-done.ts 按撤销写回原来的 done_at；自动完成的撤销调子任务卡片回来的 undo，
//   刚勾的那项和主待办一起撤回，R-350 Q1）；收起之前自己把方框点回去也算撤销：计时取消，这一条按“没勾上”画、等写入完成才从 linger 拿掉
// • 勾子任务会改回未完成（Q2）、方框点回未完成：先留住按下之前的列表（页面的 hold，kit useListActions 的 tick 默认就留）再挪回去，不出撤销条
// • linger 每一条带一个代号（gen，每记一次加一）：写入回来、计时到点时代号对不上（这期间又勾了、又撤了）就什么都不做，不会删掉新一轮的那一条；
//   勾子任务那条路同样：plan 在这一条已经有一轮在走时什么都不做，记进 linger 的代号留着，result 只按这个代号拿掉
// 页面先调 useLinger（列表按 linger.ids 留住那几条），再把 kit useListActions 的结果交给 useDoneFlow
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { dur } from '../../motion/index.ts';
import type { ActionResult, ListToast } from '../hooks/useListActions.ts';
import type { ReadonlyGuard } from '../hooks/useReadonly.ts';
import type { ExtraUndo } from './ListToasts.tsx';

/** 完成以后的撤销条：undo 是自动完成的撤销（打勾完成是 null，撤销 = 再点一下方框），message 是文案，n 每出一条加一（换一条重新计时） */
export type DoneToast = { kind: 'done'; id: string; undo: (() => Promise<ActionResult>) | null; message: string; n: number };

/** 勾一项子任务写完以后（子任务卡片的 onResult；字段同 features/todos 的 SubTickResult）：auto 为 true 是主待办跟着自动完成了 */
export interface SubDone {
  res: ActionResult;
  auto: boolean | null;
  undo(): Promise<ActionResult>;
  message: string;
}

/** 从勾上到开始收起：方框回弹播完（--dur-done-pop）再停一拍（--dur-done-rest），共 720ms（负责人 11-18 定稿乙4） */
export const HOLD_MS = Math.round((dur.donePop + dur.doneRest) * 1000);
/** 这一行收起的时长（--dur-collapse，同 kit List.module.css 的 .fold；减弱动态效果时是同样长的淡出） */
export const OUT_MS = Math.round(dur.collapse * 1000);
/** 到了 OUT_MS 这一行还没收完时，最多再等收起过渡多久（兜底：transitionend 没来也照样挪走） */
const COLLAPSE_LATE_MS = 500;

/** 留在原位的一条：shown 是方框画成什么（null：照数据画，勾子任务等自动完成的写入时），gen 是这一轮的代号 */
type Stay = Readonly<{ shown: boolean | null; gen: number }>;
const NO_LINGER: ReadonlyMap<string, Stay> = new Map();

/**
 * 勾完先留在原位的那几条：ids 给列表；put 记进来、回这一轮的代号；drop 拿掉（给了代号就只在代号对得上时拿）；
 * settle 撤销这一条：按 shown 画，写完（promise 回来）才拿掉，这之前一直留在原位；shownOf 给方框
 */
export function useLinger() {
  const [m, setM] = useState<ReadonlyMap<string, Stay>>(NO_LINGER);
  const gen = useRef(0);
  const ids = useMemo(() => new Set(m.keys()), [m]);
  const put = (id: string, shown: boolean | null): number => {
    gen.current += 1;
    const g = gen.current;
    setM((x) => new Map(x).set(id, { shown, gen: g }));
    return g;
  };
  const drop = (id: string, g?: number) =>
    setM((x) => {
      const cur = x.get(id);
      if (!cur || (g !== undefined && cur.gen !== g)) return x;
      const next = new Map(x);
      next.delete(id);
      return next;
    });
  return {
    ids,
    put,
    drop,
    settle(id: string, shown: boolean, write: Promise<unknown>) {
      const g = put(id, shown);
      void write.then(() => drop(id, g));
    },
    shownOf: (id: string): boolean | null => m.get(id)?.shown ?? null,
  };
}
export type Linger = ReturnType<typeof useLinger>;

/** kit useListActions 回来的那几样（页面的 a） */
interface Acts {
  g: ReadonlyGuard<ListToast | DoneToast>;
  isRo(id: string): boolean;
  tick(id: string, on: boolean, keep?: boolean): Promise<ActionResult>;
  shown(id: string, done: boolean): boolean;
  report(r: ActionResult): void;
}

/** 正在走的一轮：gen 同 linger 的代号；ok 写入回来是 ok；due 停留时间到了；timer 正排着的那个计时 */
interface Run {
  gen: number;
  ok: boolean;
  due: boolean;
  timer: number;
}

/**
 * 开始收起这一行时：焦点在行里就移到下一行的方框（行在 kit/components/TodoRow.tsx 打 data-row、data-row-id），回 false；
 * 没有下一行回 true（由调用方等撤销条画出来再移过去）；焦点不在行里回 false
 */
function passFocus(prefix: string, id: string): boolean {
  const rows = [...document.querySelectorAll<HTMLElement>(`[data-row="${prefix}"]`)];
  const i = rows.findIndex((r) => r.dataset['rowId'] === id);
  if (!rows[i]?.contains(document.activeElement)) return false;
  const next = rows.slice(i + 1).find((r) => !r.hasAttribute('data-out'))?.querySelector<HTMLElement>('input[type="checkbox"]');
  next?.focus();
  return !next;
}

/** hold：页面 useHoldView 的 hold（改回未完成时先留住列表）；text.done 是打勾完成那条的文案；prefix 是测试 id 前缀（todos、cal-todos、today） */
export function useDoneFlow(a: Acts, lg: Linger, hold: () => void, text: { done: string }, prefix: string) {
  // 计时到点、写入回来时用最新一次渲染的 a、lg（不用闭包里旧的那份）；提交以后才换，不在渲染里写
  const cur = useRef({ a, lg });
  useLayoutEffect(() => {
    cur.current = { a, lg };
  });
  const seq = useRef(0);
  const runs = useRef(new Map<string, Run>());
  /** 勾子任务会自动完成时 plan 记进 linger 的代号（result 按它拿掉） */
  const plans = useRef(new Map<string, number>());
  /** 要等撤销条画出来再把焦点移过去；undoRef 经 useTodoRows 的 toasts 交给 ListToasts，挂在“已完成 · 撤销”条的“撤销”上（独立评审 11-17 第 12 条：不再按测试 id 找） */
  const focusToast = useRef(false);
  const undoRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusToast.current) return;
    const b = undoRef.current;
    if (!b) return;
    focusToast.current = false;
    b.focus();
  });
  /** 正在收起的那几条（行上打 data-out） */
  const [out, setOut] = useState<ReadonlySet<string>>(() => new Set());
  const setOutOf = (id: string, on: boolean) =>
    setOut((x) => (x.has(id) === on ? x : on ? new Set(x).add(id) : new Set([...x].filter((k) => k !== id))));
  const cancel = (id: string) => {
    const r = runs.current.get(id);
    if (r) clearTimeout(r.timer);
    runs.current.delete(id);
    setOutOf(id, false);
  };
  useEffect(() => {
    const all = runs.current;
    return () => {
      for (const r of all.values()) clearTimeout(r.timer);
      all.clear();
    };
  }, []);

  /** 留在原位、停到 HOLD_MS、写入 ok 才收起出撤销条；write 是这次写入（自动完成的已经写完，传 ok） */
  const stay = (id: string, undo: DoneToast['undo'], message: string, write: Promise<ActionResult>) => {
    cancel(id);
    const run: Run = { gen: lg.put(id, true), ok: false, due: false, timer: 0 };
    runs.current.set(id, run);
    const live = () => runs.current.get(id) === run;
    // 停够了、写入也 ok 了，才开始收起（两样谁后到谁来开）
    const begin = () => {
      if (!live() || !run.ok || !run.due) return;
      if (passFocus(prefix, id)) focusToast.current = true;
      setOutOf(id, true);
      seq.current += 1;
      cur.current.a.g.show({ kind: 'done', id, undo, message, n: seq.current }, null);
      const drop = () => {
        if (!live()) return;
        // 两件同一拍：这一行离开原来的组（离场那一份还带着 data-out），在“已完成”组里重新出现时不带
        runs.current.delete(id);
        setOutOf(id, false);
        cur.current.lg.drop(id, run.gen);
      };
      run.timer = window.setTimeout(() => {
        if (!live()) return;
        // 到点时这一行还没收完（机器卡、收起过渡落后于计时器）就等过渡播完再挪走，最多再等 COLLAPSE_LATE_MS：
        // 带着没收完的高度挪走，离场那一份会把这截高度留到离场播完，下一行最后跳一下（11-18 CI run 44168443536 逐帧取样：剩 40px，约 240ms 后下一行一下子上移 41px）
        const li = document.querySelector<HTMLElement>(`[data-row="${prefix}"][data-row-id="${id}"]`);
        if (!li || li.getBoundingClientRect().height <= 1) return drop();
        const onEnd = (e: TransitionEvent) => {
          if (e.target !== li && e.target !== li.firstElementChild) return;
          // 收到约 0 才算播完；减弱动态效果（根上 data-rm="1"）不收高度、只有行面淡出，淡完就算
          const rm = document.documentElement.dataset['rm'] === '1';
          if (li.getBoundingClientRect().height > 1 && !(rm && e.propertyName === 'opacity')) return;
          li.removeEventListener('transitionend', onEnd);
          clearTimeout(run.timer);
          drop();
        };
        li.addEventListener('transitionend', onEnd);
        run.timer = window.setTimeout(() => {
          li.removeEventListener('transitionend', onEnd);
          drop();
        }, COLLAPSE_LATE_MS);
      }, OUT_MS);
    };
    run.timer = window.setTimeout(() => {
      run.due = true;
      begin();
    }, HOLD_MS);
    void write.then((r) => {
      if (!live()) return;
      if (r === 'ok') {
        run.ok = true;
        return begin();
      }
      // 没写进去（出错条、只读提示已由 tick 报了）：不收、不出撤销条，方框回到数据里的样子
      cancel(id);
      cur.current.lg.drop(id, run.gen);
    });
  };
  return {
    out,
    /** 交给 ListToasts 的 undoRef */
    undoRef,
    /** 方框画成什么：留在原位的那几条按 linger，其余照 kit useListActions 的 shown（改回未完成时留着的期间按刚点成什么） */
    shown: (id: string, done: boolean): boolean => lg.shownOf(id) ?? a.shown(id, done),
    /**
     * 这一行刚勾上、还在原位（kit CheckCircle 的 fresh，方框画亮柠檬黄）：linger 里按“勾上”留着的那几条——打勾、子任务自动完成停留和收起期间；
     * 收完从 linger 拿掉（归进“已完成”）、撤销（按“没勾上”留着）、写入失败都不算，挂载时就勾上的不在 linger 里
     */
    fresh: (id: string): boolean => lg.shownOf(id) === true,
    /** 打勾；收起之前把方框自己点回去 = 撤销（撤销条是它的就一起收起）；只读行 tick 里拦下 */
    check(id: string, v: boolean) {
      if (a.isRo(id)) return void a.tick(id, v);
      if (v) return stay(id, null, text.done, a.tick(id, true, false));
      cancel(id);
      lg.settle(id, false, a.tick(id, false));
      const toast = a.g.toast;
      if (toast?.kind === 'done' && toast.id === id) a.g.dismiss(toast);
    },
    /**
     * 勾子任务写之前（子任务卡片的 onPlan）：会自动完成就先记进 linger（方框照数据画），代号留给 result；会改回未完成就先留住列表（Q2）。
     * 这一条已经有一轮在走（刚勾了主待办、还在停留或收起）时什么都不做，不盖掉那一轮
     */
    plan(id: string, plan: boolean | null) {
      if (runs.current.has(id)) return;
      if (plan === true) plans.current.set(id, lg.put(id, null));
      else if (plan === false) hold();
    },
    /** 勾子任务写完（onResult）：自动完成了照打勾一样停留、收起、出撤销条；没自动完成（出错、被别处抢先改了）按 plan 的代号拿掉，不碰别的一轮 */
    result(id: string, r: SubDone) {
      const g = plans.current.get(id);
      plans.current.delete(id);
      if (r.res === 'ok' && r.auto === true) return stay(id, r.undo, r.message, Promise.resolve('ok'));
      if (g !== undefined) lg.drop(id, g);
      a.report(r.res);
    },
    /** 撤销条的文案和撤销做什么（kit ListToasts 的 extra）；时长用 kit 默认的 5 秒（UNDO_TOAST_MS，倒计时色带同一时长） */
    undoOf: (x: DoneToast): ExtraUndo => ({
      key: `done:${x.n}`,
      message: x.message,
      onUndo: () => {
        cancel(x.id);
        lg.settle(x.id, false, x.undo ? x.undo().then(a.report) : a.tick(x.id, false));
      },
      testId: `${prefix}-${x.undo ? 'auto' : 'done'}-toast`,
    }),
  };
}
