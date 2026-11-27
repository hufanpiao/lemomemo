// 贴底浮条（position: fixed）里的输入框原地聚焦（键盘监听、拦整页缩放在 viewport.ts）。
// 不变量：贴底浮条里的输入框程序聚焦一律经 focusInPlace，输入框上一律挂 inPlaceTouchStart / inPlaceTouchEnd（原生元素上不许展开属性，A26，所以各处各写这两行），
// 不让 iOS 为了露出输入框去滚页面：iPhone 文字框聚焦时系统一律把它滚到可视区中间（WebKit _zoomToFocusRect 的 forceScroll），
// 滚过以后固定容器里的光标和画面差出一截（WebKit bug 176896、300690），只有 focus({ preventScroll: true }) 让它整个跳过。
// 取舍：没聚焦时手指点一下，光标一律放到末尾；已经聚焦着点，照原生行为。
// 例外（trackFocus）：原地聚焦过的输入框，iOS 收键盘只发 blur、焦点还留着（假失焦），就替它真 blur；iPhone 上键盘一直没弹，点一下重聚焦一次。
// 例外（deferFocus）：原生选图菜单还开着时点输入框，等菜单关了再聚焦（系统收菜单时会收掉键盘）。
// 拖动、长按不拦，照原生行为。页面里普通的输入框照旧要系统滚出来，不用这些。
// keepFieldFocus：贴底浮条的 form 挂 onMouseDown={keepFieldFocus}。按下的不是输入框本身就拦掉 mousedown 的默认，输入框不失焦：
// 否则 iOS 抬手先派发 mousedown 让输入框失焦（浮条往下挪），click 落到浮条下面的空白处，按钮第一下点不动。
// 只拦 mousedown：拦 touchstart，iOS 连 click 都不发；拦 pointerdown 管不到失焦。要收键盘的按钮自己 blur
import { LONG_PRESS_MS, TAP_SLOP_PX } from '../../shared/logic/gesture.ts';
import { isIPhone } from './env.ts';
import { monoNow, pickerClosedFor, pickerPending } from './file-picker.ts';
import { rlog } from './run-log-api.ts';
import { isKeyboardUp } from './viewport.ts';

/** 菜单关了以后再等这么久才聚焦（系统约 50ms 后收完键盘） */
const AFTER_PICKER_MS = 120;
/** 几个检查时刻（ms）：都在 1 秒内，WebKit 只把点按手势带进 1 秒内的定时器，聚焦才弹得出键盘；最后一个不管菜单关没关都聚焦 */
const DEFER_AT_MS = [200, 350, 500, 650, 800, 950] as const;
/** 正在等菜单关的输入框（等着时再点只拦默认，不再排一遍） */
const waiting = new WeakSet<Field>();
function deferFocus(el: Field): void {
  if (waiting.has(el)) return;
  waiting.add(el);
  const t0 = monoNow();
  rlog('focus wait picker');
  const timers = DEFER_AT_MS.map((at, i) =>
    setTimeout(() => {
      const since = pickerClosedFor();
      const closed = since >= 0;
      const last = i === DEFER_AT_MS.length - 1;
      if (el.isConnected && !last && !(closed && since >= AFTER_PICKER_MS)) return;
      timers.forEach(clearTimeout);
      waiting.delete(el);
      if (!el.isConnected) return;
      focusInPlace(el, 'after-picker');
      caretToEnd(el);
      rlog(`focus after-picker wait=${Math.round(monoNow() - t0)} closed=${+closed}`);
      setTimeout(() => el.isConnected && rlog(`focus after-picker kb up=${+isKeyboardUp()} act=${+(el.ownerDocument.activeElement === el)}`), 700);
    }, at),
  );
}
const caretToEnd = (el: Field): void => {
  const end = el.value.length;
  el.setSelectionRange(end, end);
};

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * 原地聚焦：先读一次 offsetHeight 让刚画出的输入框排完版面（WebKit bug 238093：否则聚焦后才排、会再自己滚一次），
 * 再 focus({ preventScroll: true })。要在点按的同一个任务里调（iOS 只在这时弹键盘）。via 记进运行日志
 */
export function focusInPlace(el: Field | null, via: string): void {
  if (!el) return;
  const h = el.offsetHeight;
  el.focus({ preventScroll: true });
  rlog(`focus in-place via=${via} h=${h} y=${Math.round(typeof window === 'undefined' ? 0 : window.scrollY)}`);
  if (isIPhone()) trackFocus(el, via === 'refocus');
}

/**
 * 原地聚焦后盯着这一次焦点：iOS 弹完键盘又收掉、只发 blur 焦点还留着时，替它真 blur（模糊层跟着关）；
 * 键盘一直没弹：inPlaceTouchEnd 重聚焦一次（retried），再不弹就照原生（接实体键盘本来就不弹）。焦点真走了就不再盯
 */
interface FocusTrack {
  readonly retried: boolean;
  /** 不再盯（重聚焦前先停，免得自己的 blur 被当成假失焦） */
  readonly stop: () => void;
}
const tracks = new WeakMap<Field, FocusTrack>();
function trackFocus(el: Field, retried: boolean): void {
  if (tracks.has(el)) return;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    el.removeEventListener('blur', onBlur);
    tracks.delete(el);
  };
  // iOS 收键盘时只发 blur、不发 focusout，焦点还留着：React 的 onBlur 认 focusout，模糊层就不关。
  // 下一拍焦点还在就是假失焦，替它真 blur 一次。当场重聚焦留不住键盘，不再试
  const onBlur = (): void => {
    setTimeout(() => {
      // 切走 App、拉通知中心也只发 blur、焦点留着：那不是收键盘，回来焦点照旧
      if (stopped || el.ownerDocument.visibilityState !== 'visible') return;
      if (el.ownerDocument.activeElement !== el) return stop();
      rlog('kb dropped keep-focus → blur');
      el.blur();
    }, 0);
  };
  el.addEventListener('blur', onBlur);
  tracks.set(el, { retried, stop });
}


/** 原地聚焦要用的触摸事件字段：React 的触摸事件、原生 TouchEvent 都合用（platform 不引 React 类型） */
export interface InPlaceTouch {
  readonly currentTarget: EventTarget | null;
  readonly changedTouches: { readonly length: number; readonly [i: number]: { readonly clientX: number; readonly clientY: number } | undefined };
  readonly timeStamp: number;
  readonly cancelable: boolean;
  preventDefault(): void;
}

/** 每个输入框这一次按下的位置和时刻 */
const touchFrom = new WeakMap<EventTarget, { x: number; y: number; t: number }>();
const fieldOf = (t: EventTarget | null): Field | null => (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ? t : null);

/** 贴底浮条的输入框挂 onTouchStart：记下按下的位置和时刻 */
export function inPlaceTouchStart(e: InPlaceTouch): void {
  const p = e.changedTouches[0];
  if (e.currentTarget && p) touchFrom.set(e.currentTarget, { x: p.clientX, y: p.clientY, t: e.timeStamp });
}

/**
 * 贴底浮条的输入框挂 onTouchEnd：没聚焦时的一下“点”拦掉默认（手指点出的聚焦不带 preventScroll），改成原地聚焦、光标放末尾。
 * 已经聚焦、拖动、长按、拦不了（cancelable=false）都照原生行为
 */
export function inPlaceTouchEnd(e: InPlaceTouch): void {
  const el = fieldOf(e.currentTarget);
  const from = el ? touchFrom.get(el) : undefined;
  if (el) touchFrom.delete(el);
  const p = e.changedTouches[0];
  const focused = el?.ownerDocument.activeElement === el;
  const track = el ? tracks.get(el) : undefined;
  // 已聚焦时的一下点记一行判断用到的每一样
  if (el && focused) rlog(`tap focused from=${+!!from} cancel=${+e.cancelable} phone=${+isIPhone()} up=${+isKeyboardUp()} track=${track ? (track.retried ? 'retried' : 1) : 0}`);
  if (!el || !from || !p || !e.cancelable) return;
  // 已聚焦：照原生；例外是 iPhone 上键盘一直没弹，重聚焦一次，不然系统为露出输入框滚页面
  if (focused && (!isIPhone() || isKeyboardUp() || !track || track.retried)) return;
  if (Math.hypot(p.clientX - from.x, p.clientY - from.y) >= TAP_SLOP_PX || e.timeStamp - from.t >= LONG_PRESS_MS) return;
  e.preventDefault();
  if (!focused && isIPhone() && pickerPending()) return deferFocus(el);
  if (focused) {
    track?.stop();
    el.blur();
  }
  focusInPlace(el, focused ? 'refocus' : 'tap');
  caretToEnd(el);
}

/**
 * 贴底浮条的 form 挂 onMouseDown：按下的不是输入框本身就拦掉默认，焦点留在输入框里、键盘不收、按钮不挪；
 * 按在输入框上照原生行为。React 和原生鼠标事件都合用
 */
export function keepFieldFocus(e: { readonly target: EventTarget | null; preventDefault(): void }): void {
  if (!fieldOf(e.target)) e.preventDefault();
}
