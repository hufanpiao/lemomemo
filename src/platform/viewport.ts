// 视口监听（这类事只在这里做；几何在 viewport-geom.ts）：盯 visualViewport 的 resize / scroll、焦点进出、回前台，按 viewportGeom 的结果写根节点：
// --kb（键盘压住布局视口的高度）、data-kbo（键盘弹着，浮条贴键盘）、--vh-gap（布局视口少一截，贴底元素补到屏幕底）、data-kbhide（底栏、“＋”藏起）。
// 不变量：data-kbhide = data-kbo 或“收起后暂缓”（主屏幕版 iPhone 键盘刚收、布局视口还没回到整屏，最多 HOLD_MS），watchKeyboard 报的开关和它一致；
// 键盘真收了（静了 KB_SETTLE_MS、没在输入）通知 watchKeyboardClosed（冷启动高度校正再做一次）；回调都没接（正在做）就保持上膛，下一次视口事件静下来再报。
// 没有 visualViewport 的环境什么都不做。
// 另有 blockPageZoom：拦 iOS 整页双指缩放（iOS 不认 viewport 的 user-scalable=no，只有 gesture* 事件 preventDefault 停得住）；
// focusInPlace、inPlaceTouchStart / inPlaceTouchEnd：贴底浮条（position: fixed）里的输入框原地聚焦（台账 Q-8）。
// 不变量：贴底浮条里的输入框（“＋”打字条、随手记底部输入行）程序聚焦一律经 focusInPlace，输入框上一律挂 inPlaceTouchStart / inPlaceTouchEnd，
// 不让 iOS 为了露出输入框去滚页面。iPhone 上文字输入框聚焦时，系统一律把它滚到键盘上方可视区的中间
// （WebKit _zoomToFocusRect：iPhone 文字框 forceScroll，不做“看得见就不滚”的判断），滚过以后固定容器里的光标和画面差出一截
// （WebKit bug 176896、300690），只有 focus({ preventScroll: true }) 让它整个跳过（_zoomToRevealFocusedElement 第一句）。
// 取舍（负责人 11-12 preview.278 真机看过，没有异议）：输入框没聚焦时手指点一下，光标一律放到末尾，不是手指点的位置；已经聚焦着点，照原生行为。
// 拖动（挪了 TAP_SLOP_PX 以上）、长按（按住 TAP_HOLD_MS 以上）不拦，照原生行为。页面里普通的输入框（编辑页等）照旧要系统滚出来，不用这些。
// keepFieldFocus：贴底浮条的 form 一律挂 onMouseDown={keepFieldFocus}（台账 Q-25）。浮条里按下的不是输入框本身（按钮等），拦掉 mousedown 的默认，
// 输入框不失焦：iOS 手指抬起后先派发 mousedown、让输入框失焦（键盘开始收、浮条往下挪），再派发 click，click 就落到浮条下面的空白处，按钮第一下点不动。
// 只拦 mousedown（失焦是 mousedown 的默认动作）：拦 touchstart，iOS 连 click 都不发；拦 pointerdown 管不到失焦。要收键盘的按钮（打字条“收起”）自己 blur
import { isIPhone, isStandalone, opensKeyboard } from './env.ts';
import { rlog } from './run-log-api.ts';
import { BAR_HIDE_ATTR, fullHeight, GAP_MAX_PX, GAP_VAR, KB_VAR, KBO_ATTR, TOL_PX, viewportGeom, type Geom } from './viewport-geom.ts';

/** 收起后暂缓最多这么久（冷启动高度校正补回整屏实测 0.33 秒） */
export const HOLD_MS = 1000;
/** 键盘收起后视口和焦点静了这么久才算真收了 */
export const KB_SETTLE_MS = 300;

type VvLike = Pick<VisualViewport, 'height' | 'offsetTop' | 'addEventListener' | 'removeEventListener'> & { readonly scale?: number };
type DocLike = Pick<Document, 'addEventListener' | 'removeEventListener'>;
type RootLike = {
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
  setAttribute?: (k: string, v: string) => void;
  removeAttribute?: (k: string) => void;
};

export interface ViewportEnv {
  readonly vv?: () => VvLike | null;
  readonly innerHeight?: () => number;
  readonly root?: () => RootLike | null;
  readonly doc?: () => DocLike | null;
  /** 是不是主屏幕版（不传就看 navigator.standalone / display-mode） */
  readonly standalone?: () => boolean;
  /** 有能弹键盘的东西聚焦着（不传就拿 document.activeElement 问 env.ts 的 opensKeyboard） */
  readonly editing?: () => boolean;
  /** 整屏高（不传：fullHeight(window)） */
  readonly full?: () => number;
  /** 是不是 iPhone（不传就看 env.ts 的 isIPhone） */
  readonly phone?: () => boolean;
  /** 现在的毫秒数（暂缓计时；不传用单调时钟，系统时间往回调不影响） */
  readonly now?: () => number;
}

type Listener = (open: boolean, heightPx: number) => void;
const DOC_EVENTS = ['visibilitychange', 'focusin', 'focusout'] as const;

export function createKeyboardWatcher(env: ViewportEnv = {}) {
  const vvOf = env.vv ?? (() => (typeof window !== 'undefined' ? (window.visualViewport ?? null) : null));
  const innerOf = env.innerHeight ?? (() => (typeof window !== 'undefined' ? window.innerHeight : 0));
  const rootOf = env.root ?? (() => (typeof document !== 'undefined' ? document.documentElement : null));
  const docOf = env.doc ?? (() => (typeof document !== 'undefined' ? document : null));
  const standaloneOf = env.standalone ?? (() => typeof navigator !== 'undefined' && isStandalone());
  const editingOf = env.editing ?? (() => typeof document !== 'undefined' && opensKeyboard(document.activeElement));
  const fullOf = env.full ?? (() => (typeof window === 'undefined' ? 0 : fullHeight(window)));
  const phoneOf = env.phone ?? (() => isIPhone());
  const nowOf = env.now ?? (() => performance.now());
  const listeners = new Set<Listener>();
  /** 返回 false 是这次没接 */
  const closers = new Set<() => boolean>();
  let vv: VvLike | null = null;
  let doc: DocLike | null = null;
  /** 上次报的键盘高度、开关（开关含暂缓）和写到根节点的值 */
  let height = 0;
  let reported = false;
  let kbVar = 0;
  let kboVar = false;
  let gapVar = 0;
  /** 暂缓到什么时候（0 = 不在暂缓） */
  let holdUntil = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** 键盘弹起过、还没报“真收了” */
  let armed = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const measure = (): Geom | null =>
    vv && viewportGeom({ inner: innerOf(), vv, full: fullOf(), standalone: standaloneOf(), phone: phoneOf(), editing: editingOf() });

  const setVar = (name: string, px: number): void => {
    const r = rootOf();
    if (px > 0) r?.style.setProperty(name, `${px}px`);
    else r?.style.removeProperty(name);
  };
  const setAttr = (name: string, on: boolean): void => {
    const r = rootOf();
    if (on) r?.setAttribute?.(name, '1');
    else r?.removeAttribute?.(name);
  };

  /** 静了 KB_SETTLE_MS：键盘没弹、没在输入、布局视口也不再矮出一大截（还在往下收）才算真收了 */
  const settled = (): void => {
    settleTimer = undefined;
    const g = measure();
    if (!g || g.open || editingOf() || (g.squeeze && g.short > GAP_MAX_PX)) return;
    let taken = false;
    for (const f of [...closers]) if (f()) taken = true;
    // 都没接（冷启动高度校正正在做）：保持上膛，下一次视口事件静了再报，不排队
    if (taken) armed = false;
    rlog(taken ? 'kb closed' : 'kb closed not-taken');
  };

  const update = (): void => {
    const g = measure();
    if (!g) return;
    if (g.gap !== gapVar) {
      gapVar = g.gap;
      setVar(GAP_VAR, g.gap);
    }
    if (g.kb > 0) holdUntil = 0;
    else if (height > 0 && g.squeeze) holdUntil = nowOf() + HOLD_MS;
    const holding = g.kb === 0 && holdUntil > 0 && nowOf() < holdUntil && g.short > TOL_PX;
    if (!holding) holdUntil = 0;
    clearTimeout(holdTimer);
    holdTimer = holding ? setTimeout(update, holdUntil - nowOf()) : undefined;
    if (closers.size > 0) {
      if (g.open) armed = true;
      clearTimeout(settleTimer);
      settleTimer = armed && !g.open ? setTimeout(settled, KB_SETTLE_MS) : undefined;
    }
    const show = g.open || holding;
    if (g.kb === height && g.over === kbVar && show === reported && g.open === kboVar) return;
    const wasShown = reported;
    kboVar = g.open;
    reported = show;
    height = g.kb;
    kbVar = g.over;
    setVar(KB_VAR, g.over);
    setAttr(KBO_ATTR, g.open);
    if (wasShown !== show) {
      setAttr(BAR_HIDE_ATTR, show);
      rlog(`kb bar-hide=${show ? 1 : 0}`);
    }
    if (wasShown !== show || g.kb > 0 || g.open) for (const l of [...listeners]) l(show, g.kb);
  };

  const start = (): void => {
    vv = vvOf();
    if (!vv) return;
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    doc = docOf();
    for (const k of DOC_EVENTS) doc?.addEventListener(k, update);
    update();
  };
  const stop = (): void => {
    if (!vv) return;
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
    for (const k of DOC_EVENTS) doc?.removeEventListener(k, update);
    clearTimeout(holdTimer);
    clearTimeout(settleTimer);
    holdTimer = settleTimer = undefined;
    holdUntil = 0;
    armed = false;
    // 停了就不再盯：写到根节点的四样（--vh-gap、--kb、data-kbo、data-kbhide）一起拿掉，记的值清零，再订阅时照量出来的重新写
    height = kbVar = gapVar = 0;
    reported = kboVar = false;
    for (const v of [GAP_VAR, KB_VAR]) setVar(v, 0);
    for (const a of [KBO_ATTR, BAR_HIDE_ATTR]) setAttr(a, false);
    doc = null;
    vv = null;
  };
  /** 第一个订阅时开始监听，最后一个取消时停 */
  const subscribe = <T>(set: Set<T>, fn: T): (() => void) => {
    if (listeners.size + closers.size === 0) start();
    set.add(fn);
    return () => {
      set.delete(fn);
      if (listeners.size + closers.size === 0) stop();
    };
  };

  return {
    /** 现在键盘是不是弹着（含收起后暂缓） */
    isOpen: (): boolean => reported,
    /** 键盘弹起 / 收起时通知（fn(open, heightPx)）；返回取消函数 */
    watch: (fn: Listener): (() => void) => subscribe(listeners, fn),
    /** 键盘真收了时通知（fn 返回 false 是这次没接，保持上膛等下一次视口事件）；返回取消函数 */
    onClosed: (fn: () => boolean): (() => void) => subscribe(closers, fn),
  };
}

const shared = createKeyboardWatcher();

/** 键盘弹起 / 收起时通知；返回取消函数 */
export function watchKeyboard(fn: Listener): () => void {
  return shared.watch(fn);
}

export function isKeyboardOpen(): boolean {
  return shared.isOpen();
}

/** 键盘真收了时通知（冷启动高度校正用；fn 返回 false 是这次没接）；返回取消函数 */
export function watchKeyboardClosed(fn: () => boolean): () => void {
  return shared.onClosed(fn);
}

/** 开始盯视口、写根节点（App 首屏画完以后调）；返回停止函数 */
export function startViewport(): () => void {
  return shared.watch(() => undefined);
}

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * 原地聚焦（文件头不变量）：先读一次 offsetHeight 让刚画出来的输入框排完版面（WebKit bug 238093：新插进来的元素聚焦后版面才排，会再自己滚一次），
 * 再 focus({ preventScroll: true })。要在点按的同一个任务里调（Q-24：iOS 只在这时弹键盘）。via 记进运行日志（open = 打开打字条或随手记页点“＋”，tap = 点输入框）
 */
export function focusInPlace(el: Field | null, via: string): void {
  if (!el) return;
  const h = el.offsetHeight;
  el.focus({ preventScroll: true });
  rlog(`focus in-place via=${via} h=${h} y=${Math.round(typeof window === 'undefined' ? 0 : window.scrollY)}`);
}

/** 按下到抬起挪动不到这么多（px）才算“点”（打字条点空白处 Q-10 也用这个） */
export const TAP_SLOP_PX = 10;
/** 按住这么久（ms）以上算长按，不拦（iOS 长按出放大镜、选字） */
export const TAP_HOLD_MS = 500;

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
 * 贴底浮条的输入框挂 onTouchEnd：还没聚焦时的一下“点”——拦掉默认（手指点出来的聚焦不带 preventScroll，系统照样滚），
 * 改成原地聚焦，光标放到末尾（文件头的取舍）。已经聚焦、拖动、长按、拦不了（cancelable=false）都不管，照原生行为
 */
export function inPlaceTouchEnd(e: InPlaceTouch): void {
  const el = fieldOf(e.currentTarget);
  const from = el ? touchFrom.get(el) : undefined;
  if (el) touchFrom.delete(el);
  const p = e.changedTouches[0];
  if (!el || !from || !p || !e.cancelable || el.ownerDocument.activeElement === el) return;
  if (Math.hypot(p.clientX - from.x, p.clientY - from.y) >= TAP_SLOP_PX || e.timeStamp - from.t >= TAP_HOLD_MS) return;
  e.preventDefault();
  focusInPlace(el, 'tap');
  const end = el.value.length;
  el.setSelectionRange(end, end);
}

/**
 * 贴底浮条的 form 挂 onMouseDown（文件头不变量，台账 Q-25）：按下的不是输入框本身，就拦掉默认，焦点留在输入框里、键盘不收、按钮不挪；
 * 按在输入框上照原生行为（放光标、选字）。只要 target 和 preventDefault，React 的鼠标事件、原生 MouseEvent 都合用
 */
export function keepFieldFocus(e: { readonly target: EventTarget | null; preventDefault(): void }): void {
  if (!fieldOf(e.target)) e.preventDefault();
}

const GESTURES = ['gesturestart', 'gesturechange', 'gestureend'] as const;
const stopGesture = (e: Event): void => e.preventDefault();

/** 开始拦整页双指缩放（只拦 gesture*，不碰触摸、滚动、双击）；返回取消函数 */
export function blockPageZoom(doc: Pick<Document, 'addEventListener' | 'removeEventListener'> | null = typeof document !== 'undefined' ? document : null): () => void {
  for (const g of GESTURES) doc?.addEventListener(g, stopGesture, { passive: false });
  return () => {
    for (const g of GESTURES) doc?.removeEventListener(g, stopGesture);
  };
}
