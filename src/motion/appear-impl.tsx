// 【动画实现，R-354】<Appear> 的 motion 实现：和功能包 domMax 一起由 ./motion-impl.tsx 合成一块，首屏画完以后才下载；首屏用 ./Appear.tsx 的门面
// 进出场组件（架构 17.2 第 4 点）：<Appear kind="toast" show={…}>，退出动画由 AnimatePresence 管
// 不用 AnimatePresence 的 mode="popLayout"（会插内联 <style>，被 CSP 拦，2.0；ESLint 也拦，UI-4 L-4）
// 减少动态效果（17.2 第 5 点）：和 animateIn 等函数读同一个判断（系统设置或 data-rm="1"，UI-4 M-1）——
// 只淡入淡出、时长减半；MotionConfig 再兜一层，子树里别的 Motion 动画也不做位移和缩放
// 进场播完把 transform 清成 none（FA5-CR，前端 B 接线发现）：停在 translateY(0) scale(1) 的外层会成为 position: fixed 子元素的
// 定位参照（横幅、按钮条跑到页面中间）。停稳以后的退场用两段关键帧“原位 → 退场终点”，起点和清掉以前完全一样；
// 不直接从 none 起播——Motion 会把 none 换成全零的变换（scale 变成 0）。进场没播完就退场的，照旧从当前值起播
// • “已停稳”（FA-5 复审 N1）：进场播完才算；退场的起点在“开始离开”的那一次渲染里定下来、之后不变（写法同 AppearList 的 popped），
//   退场途中又打开（重新进场）就清掉，再关时从当前值起播，不会闪回“原位”
// • 停稳以后 animate 写 transform: 'none'（N2）：减少动态效果开了又关、或在减少动态效果下挂上后再关掉，都不会从 none（= scale(0)）放大
// • ⚠ 只保证停稳期间外层没有 transform（N3）：进场、退场期间外层带着 transform，fixed 子元素这段时间以外层为参照。
//   带 fixed 子元素又会退场的用法，把 fixed 元素放到 Appear 外面
// • 退场期间外层加 inert（接手清单 MOTION-leaving-inert）：CSS 的 pointer-events 只挡住鼠标和触摸，
//   inert 再挡住键盘（Tab 进不去、回车按不到）和读屏，退场那约 0.2 秒里按不到正在离开的按钮
// • 功能包异步加载（B2 FA-6 ②，见 ./features.ts）：功能包还没到时挂上的，直接画成停稳的样子
//   （initial={false}、transform 已是 none、算“已停稳”），不会停在 initial 的透明里；之后的退场从“原位”起播
// • settled（R-354 M1）：门面把实现到达前就已静态显示的那一条换成实现时传 true，挂上就画成停稳的样子（同上），关掉时照常有退场
import { AnimatePresence, LazyMotion, m, MotionConfig, useIsPresent } from 'motion/react';
import { useRef, useState, type ReactNode } from 'react';
import { motionFeatures, motionFeaturesReady } from './features.ts';
import { presets, type AppearKind } from './presets.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

export interface AppearProps {
  kind: AppearKind;
  show: boolean;
  children: ReactNode;
  className?: string | undefined;
  /** 挂上时就是停稳的样子、不播入场（门面换实现用，R-354 M1） */
  settled?: boolean | undefined;
}

/** 某种进出场在“减少动态效果”开或关时交给 Motion 的参数（组件和测试共用一份，改手感只改 presets） */
export function appearMotion(kind: AppearKind, reduced: boolean, settled = false) {
  const p = presets[kind];
  // 减少动态效果：只淡入淡出，时长减半（17.2 第 5 点）
  const half = <T extends { duration: number }>(t: T): T => (reduced ? { ...t, duration: t.duration / 2 } : t);
  const out = p.exitTransition ?? p.transition;
  // settled：进场已经播完、transform 已清成 none。退场从“原位”（animate 的 transform）起播到退场终点（见文件头）
  const exitTarget = reduced ? p.reduced : settled ? { opacity: p.exit.opacity, transform: [p.animate.transform, p.exit.transform] } : p.exit;
  return {
    initial: reduced ? p.reduced : p.initial,
    // 播完把 transform 清成 none（transitionEnd 在这段动画结束时立刻设上，不参与插值）；减少动态效果时本来就不带 transform。
    // 停稳以后目标就是 none（N2）：none → none 不插值，不会从全零变换放大
    animate: reduced ? { opacity: 1 } : settled ? { opacity: p.animate.opacity, transform: 'none' } : { ...p.animate, transitionEnd: { transform: 'none' } },
    // 退场的时长曲线写在 exit 目标里（Motion 优先用目标自带的 transition）：弹层退场比进场快（MOTION-sheet-exit）
    exit: { ...exitTarget, transition: half(out) },
    transition: half(p.transition),
  };
}

/** 真正画出来的那一层：退出动画期间 AnimatePresence 留着的是旧元素（props 不再更新），
 * 靠 useIsPresent 知道自己正在退出，打 data-state="leaving"（17.2 第 2 点），使用方可以据此不接点按（如 Dialog，UI-4 L-2） */
function AppearBody({ kind, className, reduced, still, children }: { kind: AppearKind; className?: string | undefined; reduced: boolean; still: boolean; children: ReactNode }) {
  const present = useIsPresent();
  // 进场播完了没有（之后 transform 是 none，退场要从“原位”起播）；播完时重画一次，让 animate 换成停稳后的目标
  // 功能包还没到时挂上的（FA-6 ②）：不播入场，一挂上就算停稳
  const [cold] = useState(() => still || !motionFeaturesReady());
  const settled = useRef(cold);
  const [, repaint] = useState(0);
  // 退场起点：开始离开的那一次渲染里按当时是否停稳冻结（N1）；离开途中又回来（重新进场）就清掉，“已停稳”也一起清掉
  const leftSettled = useRef<boolean | null>(null);
  if (present && leftSettled.current !== null) {
    leftSettled.current = null;
    settled.current = false;
  } else if (!present && leftSettled.current === null) {
    leftSettled.current = settled.current;
  }
  const mo = appearMotion(kind, reduced, present ? settled.current : (leftSettled.current ?? false));
  return (
    <m.div
      className={className}
      data-appear={kind}
      data-state={present ? undefined : 'leaving'}
      // 退场期间键盘、读屏也碰不到（MOTION-leaving-inert）
      inert={present ? undefined : true}
      // 遮罩只是装饰：读屏跳过（代码审查 S8，和改用 Appear 之前 Dialog 的遮罩一致）
      aria-hidden={kind === 'scrim' ? true : undefined}
      initial={cold ? false : mo.initial}
      animate={mo.animate}
      exit={mo.exit}
      transition={mo.transition}
      onAnimationComplete={() => {
        if (!present || settled.current) return;
        settled.current = true;
        repaint((n) => n + 1);
      }}
    >
      {children}
    </m.div>
  );
}

export function Appear({ kind, show, children, className, settled = false }: AppearProps) {
  const reduced = useReducedMotionPref();
  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <LazyMotion features={motionFeatures()} strict>
        <AnimatePresence initial>
          {show ? (
            <AppearBody key={kind} kind={kind} className={className} reduced={reduced} still={settled}>
              {children}
            </AppearBody>
          ) : null}
        </AnimatePresence>
      </LazyMotion>
    </MotionConfig>
  );
}
