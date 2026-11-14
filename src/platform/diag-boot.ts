// 非正式版的诊断启动件（启动时的诊断代码只在这里，架构约定 10.5）：main.tsx 只在非正式版动态 import 本模块，正式构建整块摇掉
// （分包名登记在 build/check_no_probe.mjs 的 PROBE_MARKERS）。冷启动时只起全局运行日志（一直开，run-log.ts）。
// 11-12 视口清理：台账 Q-2 的启动画面颜色诊断、R-371 的冷启动时间线都删掉（路由、视口、底栏由运行日志记），启动画面收起不再等本模块
// R-409（11-13 负责人定）：11-12 视口清理以后再没人写的两个旧本机存储键，启动后浏览器空闲时顺手清掉。
// 放这里不放首屏：写它们的 Gap fix 日志、启动画面颜色诊断只在 4.0 预览版跑过（4.0 没上过正式环境），正式包不用清；
// 键名也是 build/check_no_probe.mjs 的防回来标记，正式产物里不能出现
import { rlog } from './run-log-api.ts';
import { startRunLog } from './run-log.ts';
import { whenIdle } from './session.ts';

/** 已经没人写的旧键：Gap fix 冷启动日志（R-371）、启动画面颜色诊断开关（台账 Q-2） */
export const STALE_KEYS = ['lemo-gapfix-out', 'lemo-sp-color'] as const;

/** 删掉旧键；存储不可用（隐私模式、被禁）就算了 */
export function dropStaleKeys(store: Storage): void {
  for (const k of STALE_KEYS) {
    try {
      store.removeItem(k);
    } catch {
      // 删不掉不影响任何功能
    }
  }
}

/** main.tsx 的 start() 抛了、要跳登录页之前记的那一行（第三方审查前端第 3 条）：只记错误名，不记 message（可能带用户内容） */
export function logBootFailed(name: string): void {
  rlog(`boot start_failed ${name} -> auth`);
}

export function startDiagBoot(store: Storage = localStorage, idle: (fn: () => void) => void = whenIdle): void {
  startRunLog(window, { store });
  idle(() => dropStaleKeys(store));
}
