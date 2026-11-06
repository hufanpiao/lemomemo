// Motion 的功能包（架构 2.6、17.3）：LazyMotion + m 组件。
// 功能包异步加载（B2 FA-6 ②）：m、AnimatePresence、LazyMotion、MotionConfig 这层壳很小（约 9 KB gzip），
// 动画、手势、layout 这些功能（domMax，约 36 KB gzip）放在 ./feature-bundle.ts 单独一块，第一次挂上 LazyMotion 时才开始下载
// （LazyMotion 在 useEffect 里调加载函数，这时今天页已经画出来了），不进首屏。
// • 只用一个包 domMax（含 domAnimation 的全部）：进出场、列表 layout、layoutId 共用一块，只下载一次
// • 加载期间挂上的 m 组件拿不到动画功能：Motion 不会补播它的入场，会一直停在 initial（opacity 0）、onAnimationComplete 也不触发。
//   所以组件挂上时先看 motionFeaturesReady()：还没到的，直接画成停稳的样子（initial={false}、不进“进场中”），见 Appear、AppearList。
//   加载期间要离开的元素当场移除（没有退场动画）；加载前挂上、到了以后才离开的，退场照常播
// • 到了以后新挂上的 LazyMotion 直接拿同步的包（motionFeatures() 返回包本身）：异步的写法每个新实例都要等一轮 then，
//   这一轮里新挂上的元素同样拿不到动画（例如以后才打开的弹层），所以到了就不再走异步
// • 下载失败（离线、块丢了）：不抛（LazyMotion 的 then 没接 catch），这一次一直不到，元素照常显示、只是没有动画；
//   下一个新挂上的 LazyMotion 再试一次。**这一次“再试”实际不生效**（FA-6 ② 审查 L2，e2e b2-motion-focus-retry 实测 11-04）：
//   chromium、webkit 都把失败的动态 import 缓存住，不再去取，要刷新页面才恢复。后果只是没有动画，暂不换法子。
//   webkit 还要页面由 SW 接管才行：没被接管时刷新以后照样用内存缓存里的失败结果、不发请求（审查 L-5，11-05 查清）；第二次打开起页面都由 SW 接管
//   （要换得绕开同一个地址，例如带查询串重新 import，Vite 的预加载和哈希文件名得一起处理）
// motion/react 只被 ./components.ts 那几个组件用到（check_size 会看）
import type { FeatureBundle } from 'motion/react';

type Loader = () => Promise<FeatureBundle>;

let bundle: FeatureBundle | null = null;
let pending: Promise<FeatureBundle> | null = null;

/** 功能包到了的标记：<html data-motion="ready">（FA-6 ② 审查 L5）。e2e 等它再等两帧，不靠资源加载记录加固定 300 ms；
 *  各个 LazyMotion 拿到包是在这之后的那轮 then 里，所以 e2e 要再等帧，不能看到标记就当已经装上 */
export const MOTION_READY_ATTR = 'data-motion';
function markMotionReady(): void {
  if (typeof document !== 'undefined') document.documentElement.setAttribute(MOTION_READY_ATTR, 'ready');
}

/** 开始（或接着等）下载功能包；只下载一次 */
export function loadMotionFeatures(): Promise<FeatureBundle> {
  pending ??= import('./feature-bundle.ts').then(
    (mod) => {
      bundle = mod.default;
      markMotionReady();
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

/** 只给测试用：回到“还没下载”的状态 */
export function resetMotionFeaturesForTest(): void {
  bundle = null;
  pending = null;
  if (typeof document !== 'undefined') document.documentElement.removeAttribute(MOTION_READY_ATTR);
}
