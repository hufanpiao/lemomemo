// 违规 F6：_shared 引到预览专用函数目录里的东西（会被正式函数间接带上去）
import { steps } from '../_preview/r2-probe/probe.ts';
export const leak = steps;
