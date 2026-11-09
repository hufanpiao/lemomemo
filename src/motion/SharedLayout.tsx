// 同一页面里元素的衔接 <SharedLayout id>（架构 17.2 第 3 点）的门面（R-354 做法 A）：只依赖 react。
// 真正的 layoutId 衔接在 ./shared-impl.tsx（motion 实现，首屏画完以后下载）。挂上时看一次：
// 实现已经到了就交给实现；没到就画一个静态的 <div class>（和 motion 冷渲染一致），这一次挂着期间都不衔接
import { useState, type ReactNode } from 'react';
import { motionImpl } from './features.ts';

export function SharedLayout(props: { id: string; children: ReactNode; className?: string | undefined }) {
  const [impl] = useState(motionImpl);
  if (impl) return <impl.SharedLayout {...props} />;
  return <div className={props.className}>{props.children}</div>;
}
