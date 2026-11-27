// 非正式版的诊断启动件（启动时的诊断代码只在这里）：main.tsx 只在非正式版动态 import 本模块，正式构建整块摇掉
// （分包名登记在 build/check_no_probe.mjs 的 PROBE_MARKERS）。冷启动时只起全局运行日志（run-log.ts）；启动画面收起不等本模块。
// 另在空闲时清两个旧本机存储键：只在预览版写过，正式包不用清；键名也是 check_no_probe.mjs 的防回来标记，正式产物里不能出现
import { rlog } from './run-log-api.ts';
import { startRunLog } from './run-log.ts';
import { whenIdle } from './session.ts';

/** 已经没人写的旧键 */
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

/** main.tsx 的 start() 抛了、跳登录页之前记一行：只记错误名，不记 message（可能带用户内容）；放这里不占首屏额度 */
export function logBootFailed(e: unknown): void {
  rlog(`boot start_failed ${(e instanceof Error ? e.name : typeof e).slice(0, 40)} -> auth`);
}

/** frame：main.tsx 传 motion 的 nextFrame（平台层不能引 motion），给运行日志量切回前台出帧的时间 */
export function startDiagBoot({
  store = localStorage,
  idle = whenIdle,
  frame,
}: { store?: Storage; idle?: (fn: () => void) => void; frame?: (cb: () => void) => void } = {}): void {
  startRunLog(window, frame ? { store, frame } : { store });
  idle(() => dropStaleKeys(store));
}
