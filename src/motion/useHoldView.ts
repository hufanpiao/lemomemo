// 打勾“先看到勾上、停一拍再挪走”（17.1 勾选完成；B2 FA-5 设计审查 M1，11-04）：
//   const h = useHoldView(groups);  点打勾时先 h.hold() 再保存；页面画 h.view
// • hold()：把现在画着的那一份（按下打勾之前的分组）留住 --dur-ui，圆圈在原地填满，列表里什么都不动；
//   时间到了才换成最新的那一份——这时候这一行离开原来的组、在“已完成”组出现，下面的行一起收上来（AppearList）
// • 留住期间又点了打勾：接着留着同一份、重新计时（几条一起挪），不会先跳走一条
// • release()：马上换成最新的（删除、撤销等不该被拖住的操作先调它）
// • 减少动态效果：不留，直接换（17.2 第 5 点）
// • holding：现在是不是留着（页面据此决定圆圈按“刚点成什么”画）
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dur } from './tokens.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

const MS = 1000;

export function useHoldView<T>(live: T): { view: T; holding: boolean; hold(): void; release(): void } {
  const reduced = useReducedMotionPref();
  const [held, setHeld] = useState<{ v: T } | null>(null);
  // 点击时要的是“现在画着的那一份”：每次画完记下最新的
  const latest = useRef(live);
  useLayoutEffect(() => {
    latest.current = live;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const release = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setHeld(null);
  }, []);
  const hold = useCallback(() => {
    if (reduced) return;
    setHeld((h) => h ?? { v: latest.current });
    clearTimeout(timer.current);
    timer.current = setTimeout(release, dur.ui * MS);
  }, [reduced, release]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { view: held ? held.v : live, holding: held !== null, hold, release };
}
