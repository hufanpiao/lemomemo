// 视口监听（这类事只在这里做；几何在 viewport-geom.ts）：盯 visualViewport 的 resize / scroll、焦点进出、回前台，按 viewportGeom 的结果写根节点：
// --kb（键盘压住布局视口的高度）、data-kbo（键盘弹着，浮条贴键盘）、--vh-gap（布局视口少一截，贴底元素补到屏幕底）、data-kbhide（底栏、“＋”藏起）。
// 不变量：data-kbhide = data-kbo 或“收起后暂缓”（主屏幕版 iPhone 键盘刚收、布局视口还没回到整屏，最多 HOLD_MS），watchKeyboard 报的开关和它一致；
// 键盘真收了（静了 KB_SETTLE_MS、没在输入）通知 watchKeyboardClosed（冷启动高度校正再做一次）。没有 visualViewport 的环境什么都不做。
// 另有 blockPageZoom：拦 iOS 整页双指缩放（iOS 不认 viewport 的 user-scalable=no，只有 gesture* 事件 preventDefault 停得住）
import { isStandalone } from './env.ts';
import { rlog } from './run-log-api.ts';
import { fullHeight, GAP_MAX_PX, TOL_PX, viewportGeom, type Geom } from './viewport-geom.ts';

export { fullHeight, GAP_MAX_PX, KB_MIN_PX, keyboardHeight } from './viewport-geom.ts';

/** 收起后暂缓最多这么久（冷启动高度校正补回整屏实测 0.33 秒） */
export const HOLD_MS = 1000;
/** 键盘收起后视口和焦点静了这么久才算真收了 */
export const KB_SETTLE_MS = 300;
export const GAP_VAR = '--vh-gap';
/** 底栏、“＋”、实色带、渐隐层藏起（kit GlassBar 的样式按它藏） */
export const BAR_HIDE_ATTR = 'data-kbhide';

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
  /** 有能弹键盘的东西聚焦着（不传就看 document.activeElement） */
  readonly editing?: () => boolean;
  /** 整屏高（不传：fullHeight(window)） */
  readonly full?: () => number;
  /** 是不是 iPhone（不传就看 UA） */
  readonly phone?: () => boolean;
  /** 现在的毫秒数（暂缓计时；不传用单调时钟，系统时间往回调不影响） */
  readonly now?: () => number;
}

/** iPhone、iPod（iPad 不算：iPadOS 的 UA 是 Macintosh，这里也不去认它） */
export const isIPhone = (ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean => /iPhone|iPod/.test(ua);

const NO_KB_INPUT = /^(button|checkbox|radio|range|submit|reset|file|color|image|hidden)$/i;

/** 有能弹键盘的东西聚焦着：可编辑元素、textarea、select、文字类 input */
export function editableFocused(doc: Document | null = typeof document !== 'undefined' ? document : null): boolean {
  const el = doc?.activeElement as HTMLElement | null | undefined;
  if (!el || el === doc?.body || el === doc?.documentElement) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !NO_KB_INPUT.test((el as HTMLInputElement).type);
}

type Listener = (open: boolean, heightPx: number) => void;
const DOC_EVENTS = ['visibilitychange', 'focusin', 'focusout'] as const;

export function createKeyboardWatcher(env: ViewportEnv = {}) {
  const vvOf = env.vv ?? (() => (typeof window !== 'undefined' ? (window.visualViewport ?? null) : null));
  const innerOf = env.innerHeight ?? (() => (typeof window !== 'undefined' ? window.innerHeight : 0));
  const rootOf = env.root ?? (() => (typeof document !== 'undefined' ? document.documentElement : null));
  const docOf = env.doc ?? (() => (typeof document !== 'undefined' ? document : null));
  const standaloneOf = env.standalone ?? (() => typeof navigator !== 'undefined' && isStandalone());
  const editingOf = env.editing ?? (() => editableFocused());
  const fullOf = env.full ?? (() => (typeof window === 'undefined' ? 0 : fullHeight(window)));
  const phoneOf = env.phone ?? (() => isIPhone());
  const nowOf = env.now ?? (() => performance.now());
  const listeners = new Set<Listener>();
  const closers = new Set<() => void>();
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
    armed = false;
    rlog('kb closed');
    for (const f of [...closers]) f();
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
    setVar('--kb', g.over);
    setAttr('data-kbo', g.open);
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
    if (reported !== height > 0) {
      reported = height > 0;
      setAttr(BAR_HIDE_ATTR, reported);
    }
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
    /** 键盘真收了时通知；返回取消函数 */
    onClosed: (fn: () => void): (() => void) => subscribe(closers, fn),
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

/** 键盘真收了时通知（冷启动高度校正用）；返回取消函数 */
export function watchKeyboardClosed(fn: () => void): () => void {
  return shared.onClosed(fn);
}

/** 开始盯视口、写根节点（App 首屏画完以后调）；返回停止函数 */
export function startViewport(): () => void {
  return shared.watch(() => undefined);
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
