// 操作音效和震动的“调一下”入口（R-471）：业务代码只 import 这里的 fx(种类)（勾完成、删除、拖动、下拉都在首屏，首屏净增有 1 KB 额度）。
// 真正的实现 platform/feedback.ts 首屏画完后才下载（app/main.tsx 调 startFx），装好以前调 fx 什么都不做（冷启动头一秒内的操作不响不震）；
// 装好以后 fx 是同步直调，iOS 要求的“在用户手势里同步触发”不受影响。同 run-log-api.ts 的做法
export type FxKind = 'done' | 'lift' | 'drop' | 'pull' | 'delete';

let impl: ((kind: FxKind, micBusy: () => boolean) => void) | null = null;
let micBusy: () => boolean = () => false;

/** feedback.ts 下载好以后交过来 */
export function setFxImpl(f: ((kind: FxKind, micBusy: () => boolean) => void) | null): void {
  impl = f;
}

/** 录音、语音输入进行中的判断（plus 的 voice-main.ts 注入）：录着时一律不出声 */
export function setFxMicBusy(fn: () => boolean): void {
  micBusy = fn;
}

/** 这个操作的音效和震动（在手势里同步调） */
export function fx(kind: FxKind): void {
  impl?.(kind, micBusy);
}
