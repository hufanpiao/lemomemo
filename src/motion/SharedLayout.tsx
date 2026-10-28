// 同一页面里元素的衔接（架构 17.2 第 3 点）：包一层 layoutId；跨页面的大块切换用 View Transitions
// 同一个元素不能两种同时用。layoutId 要 domMax 功能包（比 domAnimation 大），只在用到的页面里加载
// 减少动态效果（17.2 第 5 点，UI-4 M-1）：读同一个判断（系统设置或 data-rm="1"），
// 成立时 MotionConfig reducedMotion="always"，layoutId 的弹簧位移直接到位
import { LazyMotion, m, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { motionLayoutFeatures } from './features.ts';
import { tr } from './tokens.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

export function SharedLayout({ id, children, className }: { id: string; children: ReactNode; className?: string | undefined }) {
  const reduced = useReducedMotionPref();
  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <LazyMotion features={motionLayoutFeatures} strict>
        <m.div layoutId={id} className={className} transition={tr.spring}>
          {children}
        </m.div>
      </LazyMotion>
    </MotionConfig>
  );
}
