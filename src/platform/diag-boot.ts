// 非正式版的诊断启动件（启动时的诊断代码只在这里，架构约定 10.5）：main.tsx 只在非正式版动态 import 本模块，正式构建整块摇掉
// （分包名和开关键名登记在 build/check_no_probe.mjs 的 PROBE_MARKERS）。冷启动时做三件事：
// • 全局运行日志（一直开，run-log.ts）；• R-371 冷启动时间线（诊断页开关开着才记，vh-timeline.ts）；
// • 启动画面颜色诊断（诊断页开关开着才下载 splash-probe.ts）：先打 data-splash-hold 让启动画面多留 8 秒（splash.ts）；分包加载失败拿掉标记、清掉开关
// 等帧的函数由调用方传进来（A25：requestAnimationFrame 只许 src/motion 用）
import { startRunLog } from './run-log.ts';
import { ARM_KEY as SPLASH_ARM_KEY, splashProbeArmed } from './splash-probe-arm.ts';
import { cancelSplashHold, SPLASH_HOLD_ATTR } from './splash.ts';
import { startVhTimeline, timelineArmed, type Frame } from './vh-timeline.ts';

export function startDiagBoot(frame: Frame, store: Storage = localStorage): void {
  startRunLog(window, { store });
  if (timelineArmed(store)) startVhTimeline(frame, { store });
  if (splashProbeArmed(store)) {
    document.documentElement.dataset[SPLASH_HOLD_ATTR] = '1';
    void import('./splash-probe.ts').then((m) => m.startSplashProbe(window, store)).catch(() => cancelSplashHold(SPLASH_ARM_KEY, store));
  }
}
