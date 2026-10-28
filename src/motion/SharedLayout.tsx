// 同一页面里元素的衔接（架构 17.2 第 3 点）：包一层 layoutId；跨页面的大块切换用 View Transitions
// 同一个元素不能两种同时用。layoutId 要 domMax 功能包（比 domAnimation 大），只在用到的页面里加载
import { LazyMotion, m } from 'motion/react';
import type { ReactNode } from 'react';
import { motionLayoutFeatures } from './features.ts';
import { tr } from './tokens.ts';

export function SharedLayout({ id, children, className }: { id: string; children: ReactNode; className?: string | undefined }) {
  return (
    <LazyMotion features={motionLayoutFeatures} strict>
      <m.div layoutId={id} className={className} transition={tr.spring}>
        {children}
      </m.div>
    </LazyMotion>
  );
}
