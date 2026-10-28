// 进出场组件（架构 17.2 第 4 点）：<Appear kind="toast" show={…}>，退出动画由 AnimatePresence 管
// 不用 AnimatePresence 的 mode="popLayout"（会插内联 <style>，被 CSP 拦，2.0）
import { AnimatePresence, LazyMotion, m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { motionFeatures } from './features.ts';
import { presets, type AppearKind } from './presets.ts';

export interface AppearProps {
  kind: AppearKind;
  show: boolean;
  children: ReactNode;
  className?: string | undefined;
}

export function Appear({ kind, show, children, className }: AppearProps) {
  const reduced = useReducedMotion() === true;
  const p = presets[kind];
  const transition = reduced ? { ...p.transition, duration: p.transition.duration / 2 } : p.transition;
  return (
    <LazyMotion features={motionFeatures} strict>
      <AnimatePresence initial>
        {show ? (
          <m.div
            key={kind}
            className={className}
            data-appear={kind}
            initial={reduced ? p.reduced : p.initial}
            animate={reduced ? { opacity: 1 } : p.animate}
            exit={reduced ? p.reduced : p.exit}
            transition={transition}
          >
            {children}
          </m.div>
        ) : null}
      </AnimatePresence>
    </LazyMotion>
  );
}
