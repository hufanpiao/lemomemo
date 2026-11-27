// 操作音效和震动的“调一下”入口：业务代码只 import 这里的 fx(种类)（这里算进首屏预算，所以只放入口、实现另下载）。
// 真正的实现 platform/feedback.ts 首屏画完后才下载（app/main.tsx 调 startFx），装好以前调 fx 什么都不做；
// 装好以后 fx 是同步直调，iOS 要求的“在用户手势里同步触发”不受影响。同 run-log-api.ts 的做法
// • iOS 的震动：只有手指真点到 <input type="checkbox" switch> 才震，脚本代点一律不震。手指点的那个元素下面放一个真开关
//   （kit 的 TapSwitch、CheckCircle 的 checkbox 带 switch），这一下系统补来的 click 由它们调 takeBuzz 问“要不要震”：
//   这次点按里（或 BUZZ_MS 之内）调过 fx、实现说该震才放这次 click 切开关，不然 preventDefault 不让切、不震
export type FxKind = 'done' | 'lift' | 'drop' | 'pull' | 'delete';

/** 调过 fx 以后多久之内补来的 click 还算这一下（同 CheckCircle 拦补发 click 的 800ms：日志里补发最晚 0.26 s） */
export const BUZZ_MS = 800;

/** 实现返回 true = 这一下该由手指下的系统开关出触感 */
let impl: ((kind: FxKind, micBusy: () => boolean) => boolean) | null = null;
let buzzAt = -Infinity;
let release: (() => void) | null = null;
let rewarm: (() => void) | null = null;
let micBusy: () => boolean = () => false;

/** feedback.ts 下载好以后交过来（rel：关掉放音上下文、让出音频会话；warm：收音结束后空闲时把放音上下文先建回来） */
export function setFxImpl(
  f: ((kind: FxKind, micBusy: () => boolean) => boolean) | null,
  rel: (() => void) | null = null,
  warm: (() => void) | null = null,
): void {
  impl = f;
  release = rel;
  rewarm = warm;
  buzzAt = -Infinity;
}

/** 记下“这一下该由系统开关震”（fx 里、设置诊断区试震动调） */
export function markBuzz(): void {
  buzzAt = performance.now();
}

/** 手指下的系统开关收到 click 时问：BUZZ_MS 内有该震的 fx 吗。keep 为 false（默认）时问完就清掉，一下只放一次 */
export function takeBuzz(keep = false): boolean {
  const ok = performance.now() - buzzAt < BUZZ_MS;
  if (!keep) buzzAt = -Infinity;
  return ok;
}

/** 开始收音时调（plus 的 voice-main.ts）：放音上下文平时只 suspend 不关，收音前彻底关掉，免得麦克风录进来全是静音 */
export function releaseFxAudio(): void {
  release?.();
}

/**
 * 收音结束时调（plus 的 voice-main.ts）：空闲时先把放音上下文建回来，下一下勾待办只 resume（不然第一次出声在手势里新建会卡）
 */
export function rewarmFxAudio(): void {
  rewarm?.();
}

/** 录音、语音输入进行中的判断（plus 的 voice-main.ts 注入）：录着时一律不出声 */
/** 这一刻在录音吗（feedback.ts 的 warmAudio 先建声音前看） */
export const fxMicBusy = (): boolean => micBusy();

export function setFxMicBusy(fn: () => boolean): void {
  micBusy = fn;
}

/** 这个操作的音效和震动（在手势里同步调） */
export function fx(kind: FxKind): void {
  // 只有点一下的两种（勾完成、点“删除”）会有手指下的开关来问；长按、拖动、下拉没有 click，记了会被 0.8 秒内别的点按借走
  if (impl?.(kind, micBusy) && (kind === 'done' || kind === 'delete')) markBuzz();
}
