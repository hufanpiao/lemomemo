// 打勾“先看到勾上、停一拍再挪走”（17.1 勾选完成；B2 FA-5 设计审查 M1，11-04）：
//   const h = useHoldView(groups);  点打勾时先 h.hold() 再保存；页面画 h.view
// • hold()：把现在画着的那一份（按下打勾之前的分组）留住 --dur-ui，圆圈在原地填满，列表里什么都不动；
//   时间到了才换成最新的那一份——这时候这一行离开原来的组、在“已完成”组出现，下面的行一起收上来（AppearList）
// • 留住期间又点了打勾：接着留着同一份、重新计时（几条一起挪），不会先跳走一条；
//   但从第一次 hold 算起最多留 HOLD_MAX（3 × --dur-ui，FA5-CR-low A2）：连着点不停时快照不会一直留着——
//   留着的是旧数据，这期间点到别处已删掉、改掉的行，操作的就是旧的那一行
// • release()：马上换成最新的（删除、撤销等不该被拖住的操作先调它）
// • 减少动态效果：不留，直接换（17.2 第 5 点）
// • holding：现在是不是留着（页面据此决定圆圈按“刚点成什么”画）
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { holdBegin } from './swap-guard.ts';
import { dur } from './tokens.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

const MS = 1000;
/** 从第一次 hold 起最多留多久（ms） */
export const HOLD_MAX = 3 * dur.ui * MS;

export function useHoldView<T>(live: T): { view: T; holding: boolean; hold(): void; release(): void } {
  const reduced = useReducedMotionPref();
  const [held, setHeld] = useState<{ v: T } | null>(null);
  // 点击时要的是“现在画着的那一份”：每次画完记下最新的
  const latest = useRef(live);
  useLayoutEffect(() => {
    latest.current = live;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 这一轮留住从什么时候开始（没留着时是 null）
  const since = useRef<number | null>(null);
  const release = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    since.current = null;
    setHeld(null);
  }, []);
  const hold = useCallback(() => {
    if (reduced) return;
    setHeld((h) => h ?? { v: latest.current });
    const now = Date.now();
    since.current ??= now;
    clearTimeout(timer.current);
    timer.current = setTimeout(release, Math.max(0, Math.min(dur.ui * MS, since.current + HOLD_MAX - now)));
  }, [reduced, release]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // 停一拍期间不把静态列表换成动画实现（R-354，./swap-guard.ts）：换了会重挂，留住的那一拍就断了
  const holding = held !== null;
  useEffect(() => (holding ? holdBegin() : undefined), [holding]);
  return { view: held ? held.v : live, holding, hold, release };
}
