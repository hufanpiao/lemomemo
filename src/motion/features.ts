// Motion 的动画实现和功能包（架构 2.6、17.3）：LazyMotion + m 组件。
// R-354（主持人 11-07 定做法 A，方案 docs/10-架构/方案-动画库移出首屏.md）：motion/react 整个移出首屏——
//   动画实现（./appear-impl.tsx 等）和功能包 domMax 合成 ./motion-impl.tsx 一块，main.tsx 在 appPainted() 之后调 loadMotionFeatures() 下载。
//   首屏上的 Appear、AppearList、AppearItem、SharedLayout 是只依赖 react 的门面，画的 DOM 和 motion 冷渲染逐属性一致
//   （__tests__/facade-dom.test.tsx），这一块到了以后在安全的时机换成实现（subscribeMotionImpl / useMotionImpl）
// • 只用一个包 domMax（含 domAnimation 的全部）：进出场、列表 layout、layoutId 共用一块，只下载一次
// • 实现里的组件只在这一块到了以后才挂（门面保证），拿到的 features 是同步的包本身；
//   实现里“没到时挂上就画成停稳”的分支（motionFeaturesReady()）留着兜底
// • 到了以后新挂上的门面直接用实现：Appear 在变成显示的那一刻看一次，AppearList 挂上时看一次，已经静态挂着的列表按 ./swap-guard.ts 的守卫换
// • 下载失败（离线、块丢了）：不抛，这一次一直不到，门面照常显示、只是没有动画；现在只有 main.tsx 调一次，失败以后没有第二个调用方，这次会话不再试（就算再调也不生效，原因如下）（FA-6 ② 审查 L2，e2e b2-motion-focus-retry 实测 11-04）：
//   chromium、webkit 都把失败的动态 import 缓存住，不再去取，要刷新页面才恢复。后果只是没有动画，暂不换法子。
//   webkit 还要页面由 SW 接管才行：没被接管时刷新以后照样用内存缓存里的失败结果、不发请求（审查 L-5，11-05 查清）；第二次打开起页面都由 SW 接管
//   （要换得绕开同一个地址，例如带查询串重新 import，Vite 的预加载和哈希文件名得一起处理）
// motion/react 只被 ./motion-impl.tsx 那一块用到：首屏闭包里出现 motion 的特征串由 build/check_first_paint_chunks.mjs 的 MOTION_MARKS 拦；
// 这里对 motion/react 和 motion-impl 都只有类型引用
import type { FeatureBundle } from 'motion/react';
import type * as MotionImplModule from './motion-impl.tsx';

type Loader = () => Promise<FeatureBundle>;
/** 动画实现那一块的导出（类型引用，不把它带进首屏） */
export type MotionImpl = typeof MotionImplModule;

let bundle: FeatureBundle | null = null;
let impl: MotionImpl | null = null;
let pending: Promise<FeatureBundle> | null = null;
const subs = new Set<() => void>();

/** 功能包到了的标记：<html data-motion="ready">（FA-6 ② 审查 L5）。e2e 等它再等两帧，不靠资源加载记录加固定 300 ms；
 *  各个 LazyMotion 拿到包是在这之后的那轮 then 里，所以 e2e 要再等帧，不能看到标记就当已经装上 */
export const MOTION_READY_ATTR = 'data-motion';
function markMotionReady(): void {
  if (typeof document !== 'undefined') document.documentElement.setAttribute(MOTION_READY_ATTR, 'ready');
}

/** 开始（或接着等）下载动画实现和功能包；只下载一次。到了先装好包、打标记，再通知门面换实现 */
export function loadMotionFeatures(): Promise<FeatureBundle> {
  pending ??= import('./motion-impl.tsx').then(
    (mod) => {
      bundle = mod.default;
      impl = mod;
      markMotionReady();
      for (const fn of [...subs]) fn();
      return bundle;
    },
    () => {
      pending = null;
      return new Promise<FeatureBundle>(() => undefined);
    },
  );
  return pending;
}

/** 功能包到了没有：组件挂上时据此决定是播入场，还是直接画成停稳的样子 */
export function motionFeaturesReady(): boolean {
  return bundle !== null;
}

/** 交给 LazyMotion 的 features：到了给包本身（同步装上），没到给加载函数 */
export function motionFeatures(): FeatureBundle | Loader {
  return bundle ?? loadMotionFeatures;
}

/** 动画实现：没到时是 null（门面画静态的） */
export function motionImpl(): MotionImpl | null {
  return impl;
}

/** 动画实现到了时通知（只通知一次：到了以后不会再变） */
export function subscribeMotionImpl(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 只给测试用：回到“还没下载”的状态 */
export function resetMotionFeaturesForTest(): void {
  bundle = null;
  impl = null;
  pending = null;
  if (typeof document !== 'undefined') document.documentElement.removeAttribute(MOTION_READY_ATTR);
}
