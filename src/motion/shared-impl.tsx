// 【动画实现】<SharedLayout> 的 motion 实现：由 ./motion-impl.tsx 合块、首屏画完以后下载；门面见 ./SharedLayout.tsx
// 同一页面里元素的衔接：包一层 layoutId；跨页面的大块切换用 ./page-swap.ts 的换页动画
// 同一个元素不能两种同时用。layoutId 要 domMax 功能包，异步加载、和 Appear 共用一块（见 ./features.ts）
// 减少动态效果：读同一个判断（系统设置或 data-rm="1"），
// 成立时 MotionConfig reducedMotion="always"，layoutId 的弹簧位移直接到位
import { LazyMotion, m, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { motionFeatures } from './features.ts';
import { tr } from './tokens.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

export function SharedLayout({ id, children, className }: { id: string; children: ReactNode; className?: string | undefined }) {
  const reduced = useReducedMotionPref();
  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <LazyMotion features={motionFeatures()} strict>
        <m.div layoutId={id} className={className} transition={tr.spring}>
          {children}
        </m.div>
      </LazyMotion>
    </MotionConfig>
  );
}
