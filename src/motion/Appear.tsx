// 进出场组件（架构 17.2 第 4 点）：<Appear kind="toast" show={…}>，退出动画由 AnimatePresence 管
// 不用 AnimatePresence 的 mode="popLayout"（会插内联 <style>，被 CSP 拦，2.0；ESLint 也拦，UI-4 L-4）
// 减少动态效果（17.2 第 5 点）：和 animateIn 等函数读同一个判断（系统设置或 data-rm="1"，UI-4 M-1）——
// 只淡入淡出、时长减半；MotionConfig 再兜一层，子树里别的 Motion 动画也不做位移和缩放
import { AnimatePresence, LazyMotion, m, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { motionFeatures } from './features.ts';
import { presets, type AppearKind } from './presets.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

export interface AppearProps {
  kind: AppearKind;
  show: boolean;
  children: ReactNode;
  className?: string | undefined;
}

/** 某种进出场在“减少动态效果”开或关时交给 Motion 的参数（组件和测试共用一份，改手感只改 presets） */
export function appearMotion(kind: AppearKind, reduced: boolean) {
  const p = presets[kind];
  return {
    initial: reduced ? p.reduced : p.initial,
    animate: reduced ? { opacity: 1 } : p.animate,
    exit: reduced ? p.reduced : p.exit,
    // 减少动态效果：只淡入淡出，时长减半（17.2 第 5 点）
    transition: reduced ? { ...p.transition, duration: p.transition.duration / 2 } : p.transition,
  };
}

export function Appear({ kind, show, children, className }: AppearProps) {
  const reduced = useReducedMotionPref();
  const mo = appearMotion(kind, reduced);
  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <LazyMotion features={motionFeatures} strict>
        <AnimatePresence initial>
          {show ? (
            <m.div
              key={kind}
              className={className}
              data-appear={kind}
              initial={mo.initial}
              animate={mo.animate}
              exit={mo.exit}
              transition={mo.transition}
            >
              {children}
            </m.div>
          ) : null}
        </AnimatePresence>
      </LazyMotion>
    </MotionConfig>
  );
}
