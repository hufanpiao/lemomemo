// 非正式版的诊断启动件（启动时的诊断代码只在这里，架构约定 10.5）：main.tsx 只在非正式版动态 import 本模块，正式构建整块摇掉
// （分包名和开关键名登记在 build/check_no_probe.mjs 的 PROBE_MARKERS）。冷启动时做两件事：
// • 全局运行日志（一直开，run-log.ts）；• R-371 冷启动时间线（诊断页开关开着才记，vh-timeline.ts）
// （台账 Q-2 的启动画面颜色诊断 11-12 随 Q-2 结案删掉，启动画面收起不再等本模块）
// 等帧的函数由调用方传进来（A25：requestAnimationFrame 只许 src/motion 用）
import { startRunLog } from './run-log.ts';
import { startVhTimeline, timelineArmed, type Frame } from './vh-timeline.ts';

export function startDiagBoot(frame: Frame, store: Storage = localStorage): void {
  startRunLog(window, { store });
  if (timelineArmed(store)) startVhTimeline(frame, { store });
}
