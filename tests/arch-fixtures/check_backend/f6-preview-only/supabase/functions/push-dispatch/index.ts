// 违规 F6：正式会部署的函数 import 了预览专用函数的代码
import { steps } from '../_preview/r2-probe/probe.ts';
export const x = steps;
