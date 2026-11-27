// 一组从头到尾是同一个函数的回调，调的是最新一次渲染给的那一份（今天页、待办页、日历日清单把点行、删除、收起交给 memo 的行：
// 行拿到的引用不变，memo 才命中；点下去的时候用的照样是最新的 isRo、导航、分组。每次传内联函数的话，打勾一次每一行都要重画）
// 只适合事件回调（点按时才调）；渲染时要调的函数不能这么包，不然内容变了行也不重画
import { useLayoutEffect, useRef, useState } from 'react';

type Fns = Record<string, (...args: never[]) => unknown>;

export function useLive<T extends Fns>(fns: T): T {
  const live = useRef(fns);
  useLayoutEffect(() => {
    live.current = fns;
  });
  const [stable] = useState(() => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(fns)) out[k] = (...a: never[]) => (live.current[k] as (...x: never[]) => unknown)(...a);
    return out as T;
  });
  return stable;
}
