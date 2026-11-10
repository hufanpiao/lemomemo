// R-371 非正式版冷启动诊断的统一入口（11-10 代码审建议 2）：main.tsx 只读两个开关、只留一处动态加载，首屏少一份 import 包装；
// 两个开关（时间线 ARM_KEY、Gap fix ON_KEY）各自开着才跑，键名见 vh-timeline.ts、vh-gapfix.ts。正式构建 main.tsx 整块摇掉，本模块不进正式包。
// 等帧的函数由调用方传进来（A25：requestAnimationFrame 只许 src/motion 用）
import { type Frame, gapFixOn, startGapFix } from './vh-gapfix.ts';
import { startVhTimeline, timelineArmed } from './vh-timeline.ts';

export function startVhDiag(frame: Frame, store: Storage = localStorage): void {
  if (timelineArmed(store)) startVhTimeline(frame, { store });
  if (gapFixOn(store)) startGapFix(frame, { store });
}
