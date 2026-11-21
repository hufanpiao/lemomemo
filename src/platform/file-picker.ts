// 原生选图菜单开着没有（11-21 输入框下坠）：盯 input[type=file] 的 click / cancel / change，给 viewport.ts 的 deferFocus 用。
// 465 日志：取消菜单后马上点输入框，点在 5.35、cancel 5.67 才到，系统收菜单那一刻把键盘收回（5.66），这之前聚焦的都留不住；
// 所以菜单开着时点输入框先不聚焦，等 cancel / change 到了再聚焦。startViewport 开始盯，停止时清掉状态
import { rlog } from './run-log-api.ts';

/** 单调时钟（系统时间往回调不影响；viewport.ts 也用这个） */
export const monoNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

let pickerOpen = false;
let pickerEl: HTMLInputElement | null = null;
let pickerOpenAt = 0;
let pickerClosedAt = 0;
/** 点开以后这么久还没等到 cancel / change，就当菜单已经关了（老系统没有 cancel 事件；用户在菜单里翻相册可以翻很久，不能短） */
const PICKER_STALE_MS = 60_000;
const isFileInput = (t: EventTarget | null): t is HTMLInputElement => t instanceof HTMLInputElement && t.type === 'file';

/** 菜单这一刻开着（选图的 input 在 cancel / change 之前卸掉了，事件到不了 document：卸掉也当关了） */
export function pickerPending(now = monoNow()): boolean {
  return pickerOpen && !!pickerEl?.isConnected && now - pickerOpenAt < PICKER_STALE_MS;
}

/** 菜单关了多少毫秒；还开着返回 -1 */
export function pickerClosedFor(now = monoNow()): number {
  return pickerPending(now) ? -1 : now - pickerClosedAt;
}

/** 开始盯；返回停止函数（停止时把“开着”清掉） */
export function watchFilePicker(doc: Pick<Document, 'addEventListener' | 'removeEventListener'> | null): () => void {
  if (!doc) return () => undefined;
  const onOpen = (e: Event): void => {
    // 冒泡阶段、没被拦掉默认的 click 才真打开了菜单
    if (!isFileInput(e.target) || e.defaultPrevented) return;
    pickerOpen = true;
    pickerEl = e.target;
    pickerOpenAt = monoNow();
    rlog('file picker open');
  };
  const onClose = (e: Event): void => {
    if (!isFileInput(e.target) || !pickerPending()) return;
    pickerOpen = false;
    pickerEl = null;
    pickerClosedAt = monoNow();
    rlog(`file picker ${e.type}`);
  };
  doc.addEventListener('click', onOpen);
  doc.addEventListener('cancel', onClose, true);
  doc.addEventListener('change', onClose, true);
  return () => {
    pickerOpen = false;
    pickerEl = null;
    doc.removeEventListener('click', onOpen);
    doc.removeEventListener('cancel', onClose, true);
    doc.removeEventListener('change', onClose, true);
  };
}
