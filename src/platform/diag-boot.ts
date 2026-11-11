// 非正式版的诊断启动件（启动时的诊断代码只在这里，架构约定 10.5）：main.tsx 只在非正式版动态 import 本模块，正式构建整块摇掉
// （分包名和开关键名登记在 build/check_no_probe.mjs 的 PROBE_MARKERS）。冷启动时做三件事：
// • 全局运行日志（一直开，run-log.ts）；• R-371 冷启动时间线（诊断页开关开着才记，vh-timeline.ts）；
// • 启动画面颜色诊断（诊断页开关开着才下载 splash-probe.ts）：涂色分包到了才打 data-splash-hold，让启动画面多留 8 秒（splash.ts）；
//   分包加载失败、开始涂色出错：不留标记、清掉开关（不然每次冷启动都重来），启动画面照常收起
// 返回的 Promise 在标记打好（或确定不打）以后才完成：main.tsx 收起启动画面先等它（diagReady），标记一定早于第一次收起
// 等帧的函数由调用方传进来（A25：requestAnimationFrame 只许 src/motion 用）
import { startRunLog } from './run-log.ts';
import { setSplashProbeArmed, splashProbeArmed } from './splash-probe-arm.ts';
import { SPLASH_HOLD_ATTR } from './splash.ts';
import { startVhTimeline, timelineArmed, type Frame } from './vh-timeline.ts';

export async function startDiagBoot(frame: Frame, store: Storage = localStorage): Promise<void> {
  startRunLog(window, { store });
  if (timelineArmed(store)) startVhTimeline(frame, { store });
  if (!splashProbeArmed(store)) return;
  const root = document.documentElement;
  try {
    const m = await import('./splash-probe.ts');
    root.dataset[SPLASH_HOLD_ATTR] = '1';
    m.startSplashProbe(window, store);
  } catch {
    delete root.dataset[SPLASH_HOLD_ATTR];
    setSplashProbeArmed(false, store);
  }
}
