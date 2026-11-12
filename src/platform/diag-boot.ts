// 非正式版的诊断启动件（启动时的诊断代码只在这里，架构约定 10.5）：main.tsx 只在非正式版动态 import 本模块，正式构建整块摇掉
// （分包名登记在 build/check_no_probe.mjs 的 PROBE_MARKERS）。冷启动时只起全局运行日志（一直开，run-log.ts）。
// 11-12 视口清理：台账 Q-2 的启动画面颜色诊断、R-371 的冷启动时间线都删掉（路由、视口、底栏由运行日志记），启动画面收起不再等本模块
import { startRunLog } from './run-log.ts';

export function startDiagBoot(store: Storage = localStorage): void {
  startRunLog(window, { store });
}
