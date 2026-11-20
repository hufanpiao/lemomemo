// 入口接“首屏画完”“#root 画出东西”（这类事只在这里接，架构约定 10.1）：等待只用 motion 的 waitDom，“页面出来”只认 motion 的 shownMain
// （显示着的 <main>）；首屏画完的标志存在 platform/root-paint.ts（同步、supabase-js、按需部件都等它）。
// 不变量：App 外壳不放常驻 <main>（first-paint-shell.test.tsx）
import { waitDom, whenMainShown } from '../motion/index.ts';
import { afterAppPainted, APP_PAINT_BACKSTOP_MS, armAppPaint, markAppPainted } from '../platform/root-paint.ts';

export type FrameScheduler = (fn: () => void) => () => void;

/**
 * 入口在 render 之前挂一次：第一个显示出来的页面 <main> 出来再过一帧算首屏画完（“再过一帧”由入口传 motion 的 nextFrame，A25）；
 * backstopMs 长兜底（root-paint 的 armAppPaint）。不管哪条路先算画完（时限、兜底），都停掉等待。返回取消（测试用）
 */
export function watchFirstPaint(frame: FrameScheduler, backstopMs: number = APP_PAINT_BACKSTOP_MS): () => void {
  const disarm = armAppPaint(backstopMs);
  let cancelFrame = (): void => undefined;
  const stop = whenMainShown(() => {
    cancelFrame = frame(markAppPainted);
  });
  afterAppPainted(stop);
  return () => {
    disarm();
    stop();
    cancelFrame();
  };
}

/** el（#root）里有内容（元素或非空白文本）就调 hit(true)（已经有就当场调）；ms 内一直没有调 hit(false)（不传就一直等）：收启动画面、卸“库被挡住”的整屏提示。返回取消 */
export const whenContent = (el: Element, hit: (ok: boolean) => void, ms = Infinity): (() => void) =>
  waitDom(() => el.firstElementChild !== null || /\S/.test(el.textContent ?? ''), ms, hit);
