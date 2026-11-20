// 进出场组件 <Appear kind="toast" show={…}>（架构 17.2 第 4 点）的门面（R-354 做法 A，主持人 11-07 定）：只依赖 react，进首屏。
// 真正的进出场动画在 ./appear-impl.tsx（motion 实现，和功能包一起首屏画完以后下载，见 ./features.ts）。
// • 在“变成显示的那一刻”决定用哪个：动画实现已经到了就整次交给实现（照常播入场、退场）；
//   还没到就画静态的；实现到了以后，在这一条里没有焦点、没有按住的指针、不在停一拍期间时（swap-guard.ts 的 canSwap），
//   按“已停稳”换成实现（settled，DOM 一样看不出来），之后关掉照常有退场淡出（R-354 M1，负责人选“修掉”）；
//   换之前就关掉的（守卫一直不过）当场移除
// • 静态画出来的和 motion 冷渲染（功能包没到时挂上，画成停稳的样子）逐属性一致：
//   <div class data-appear style="opacity: 1; transform: none">，遮罩加 aria-hidden；减少动态效果时只有 opacity: 1
//   （__tests__/facade-dom.test.tsx 对比两边的 DOM）
// • 只进场、不带退场的几种（presets.ts 的 enters：撤销条、纪念日编辑层、电脑版详情抽屉、输入时的模糊层）用 useEnter：
//   元素是调用方自己的（aside、Radix Content、带 data-undo-toast 的 div），不多包一层；挂上那一刻用 element.animate 播起点 → 自己的样式，
//   首屏也能播（不等动画实现）；关掉直接卸载。不套 <Appear>：它一定带退场、减少动态效果时长减半、多包的那层 div 会成为毛玻璃的背景根
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { enters, type AppearKind, type EnterKind } from './presets.ts';
import { prefersReducedMotion } from './reduced.ts';
import { useMotionImpl, watchPointers, whenSafe } from './swap-guard.ts';
import { bezierCss } from './tokens.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

export interface AppearProps {
  kind: AppearKind;
  show: boolean;
  children: ReactNode;
  className?: string | undefined;
}

const SETTLED: CSSProperties = { opacity: 1, transform: 'none' };
const SETTLED_REDUCED: CSSProperties = { opacity: 1 };

export function Appear(props: AppearProps) {
  const { kind, show, children, className } = props;
  const impl = useMotionImpl();
  const reduced = useReducedMotionPref();
  // 这一次显示是不是静态的：显示时实现还没到就是；关掉以后清掉（下次显示重新看）
  const [still, setStill] = useState(() => show && impl === null);
  // 这一次是从静态换过来的：交给实现时按“已停稳”挂上；关掉以后清掉（下次显示照常播入场）
  const [landed, setLanded] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  if (still && !show) setStill(false);
  if (!still && show && impl === null) setStill(true);
  if (landed && !show && !still) setLanded(false);
  const waiting = still && show && impl !== null;
  useEffect(() => {
    if (!still) return;
    watchPointers();
  }, [still]);
  useEffect(() => {
    if (!waiting) return;
    return whenSafe(
      () => el.current,
      () => {
        setLanded(true);
        setStill(false);
      },
    );
  }, [waiting]);
  if (impl !== null && !(still && show)) return <impl.Appear {...props} settled={landed} />;
  if (!show) return null;
  return (
    <div ref={el} className={className} data-appear={kind} aria-hidden={kind === 'scrim' ? true : undefined} style={reduced ? SETTLED_REDUCED : SETTLED}>
      {children}
    </div>
  );
}

/**
 * 只进场的用法（见文件头）：返回一个稳定的 ref 回调，挂到要进场的元素上；元素挂上那一刻播 enters[kind] 的进场（只播这一次，之后重画不重播）。
 * also：调用方自己还要用这个元素时传它的 ref 对象，这里顺手写进去。种类按挂上那一刻的 kind 定（抽屉换边时不重播，同原来的 CSS）
 */
export function useEnter<T extends Element>(kind: EnterKind, also?: { current: T | null }): (el: T | null) => void {
  const k = useRef(kind);
  k.current = kind;
  return useCallback(
    (el: T | null) => {
      if (also) also.current = el;
      if (!el || typeof el.animate !== 'function') return;
      const p = enters[k.current];
      // 只给起点（offset 0）：终点是元素自己算出来的样式，同 CSS 只写 from 的关键帧
      el.animate([{ ...(prefersReducedMotion() ? p.reducedFrom : p.from), offset: 0 }], {
        duration: p.transition.duration * 1000,
        easing: bezierCss(p.transition.ease),
      });
    },
    [also],
  );
}
