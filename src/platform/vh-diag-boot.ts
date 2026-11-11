// R-371 非正式版冷启动诊断入口（11-10 代码审建议 2）：main.tsx 读时间线开关（ARM_KEY，见 vh-timeline.ts），开着才动态加载本模块。
// 正式构建 main.tsx 整块摇掉，本模块不进正式包。Gap fix 11-11 起默认开、正式版也做，不再经这里（main.tsx 按 vh-gapfix-gate.ts 直接加载 vh-gapfix.ts）。
// 等帧的函数由调用方传进来（A25：requestAnimationFrame 只许 src/motion 用）
import type { Frame } from './vh-gapfix.ts';
import { startVhTimeline, timelineArmed } from './vh-timeline.ts';

export function startVhDiag(frame: Frame, store: Storage = localStorage): void {
  if (timelineArmed(store)) startVhTimeline(frame, { store });
}
