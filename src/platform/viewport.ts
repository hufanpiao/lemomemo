// 视口监听（这类事只在这里做；几何在 viewport-geom.ts）：盯 visualViewport 的 resize / scroll、焦点进出、回前台，按 viewportGeom 的结果写根节点：
// --kb（键盘压住布局视口的高度）、data-kbo（键盘弹着，浮条贴键盘）、--vh-gap（键盘没弹时布局视口少一截，贴底元素补到屏幕底）、data-kbhide（底栏、“＋”藏起）。
// 不变量：data-kbhide = data-kbo 或“收起后暂缓”（主屏幕版 iPhone 键盘刚收、布局视口还没回到整屏，最多 HOLD_MS），watchKeyboard 报的开关和它一致。
// “布局视口少一截”：冷启动由 vh-gapfix-gate.ts 的垫块把 innerHeight 本身修回来；之后再少（键盘弹到一半切页，收完停在少 50）只能由 --vh-gap 把贴底元素补到屏幕底，
// 值变了记 gapfix short=…（0 = 回到整屏）。没有 visualViewport 的环境什么都不做。
// 另有 blockPageZoom：拦 iOS 整页双指缩放（iOS 不认 user-scalable=no，只有 gesture* 事件 preventDefault 停得住）。
// 贴底浮条里输入框的原地聚焦在 in-place-focus.ts
import { isIPhone, isStandalone, opensKeyboard } from './env.ts';
import { rlog } from './run-log-api.ts';
import { monoNow, watchFilePicker } from './file-picker.ts';
import { BAR_HIDE_ATTR, fullHeight, GAP_VAR, KB_VAR, KBO_ATTR, TOL_PX, viewportGeom, type Geom } from './viewport-geom.ts';

/** 收起后暂缓最多这么久（键盘收完到布局视口回到整屏，真机实测 0.33 秒） */
export const HOLD_MS = 1000;

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
  const nowOf = env.now ?? monoNow;
  const listeners = new Set<Listener>();
  let vv: VvLike | null = null;
  let doc: DocLike | null = null;
  /** 上次报的键盘高度、开关（开关含暂缓）和写到根节点的值 */
  let height = 0;
  let reported = false;
  let kbVar = 0;
  let kboVar = false;
  /** 上次记进日志的“键盘没弹时布局视口还少的那截” */
  let shortLogged = 0;
  /** 暂缓到什么时候（0 = 不在暂缓） */
  let holdUntil = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

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

  const update = (): void => {
    const g = measure();
    if (!g) return;
    if (g.gap !== shortLogged) {
      shortLogged = g.gap;
      // 贴底元素（底栏、“＋”、实色带、半屏、雾层）往下补这么多到屏幕底。常开日志：0 = 回到整屏
      setVar(GAP_VAR, g.gap);
      rlog(`gapfix short=${g.gap}`);
    }
    if (g.kb > 0) holdUntil = 0;
    else if (height > 0 && g.squeeze) holdUntil = nowOf() + HOLD_MS;
    const holding = g.kb === 0 && holdUntil > 0 && nowOf() < holdUntil && g.short > TOL_PX;
    if (!holding) holdUntil = 0;
    clearTimeout(holdTimer);
    holdTimer = holding ? setTimeout(update, holdUntil - nowOf()) : undefined;
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
    holdTimer = undefined;
    holdUntil = 0;
    // 停了：根节点四样一起拿掉、记的值清零，再订阅时重新写
    height = kbVar = shortLogged = 0;
    reported = kboVar = false;
    for (const v of [GAP_VAR, KB_VAR]) setVar(v, 0);
    for (const a of [KBO_ATTR, BAR_HIDE_ATTR]) setAttr(a, false);
    doc = null;
    vv = null;
  };

  return {
    /** 现在键盘是不是弹着（含收起后暂缓） */
    isOpen: (): boolean => reported,
    /** 键盘这一刻真弹着（data-kbo，不含收起后暂缓） */
    isUp: (): boolean => kboVar,
    /** 现在写在根节点 --kb 上的值（键盘压住布局视口的高度；watch 报的 heightPx 另含布局视口被挤矮的情况） */
    kbVar: (): number => kbVar,
    /** 键盘弹起 / 收起时通知（fn(open, heightPx)）；第一个订阅时开始监听，最后一个取消时停；返回取消函数 */
    watch: (fn: Listener): (() => void) => {
      if (listeners.size === 0) start();
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) stop();
      };
    },
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

/** 现在写在根节点 --kb 上的值（kb-hint.ts 用） */
export function keyboardOverPx(): number {
  return shared.kbVar();
}

/** 键盘这一刻真弹着（不含收起后暂缓） */
export function isKeyboardUp(): boolean {
  return shared.isUp();
}

/** 开始盯视口、写根节点（App 首屏画完以后调）；返回停止函数 */
export function startViewport(): () => void {
  const stops = [watchFilePicker(typeof document !== 'undefined' ? document : null), shared.watch(() => undefined)];
  return () => stops.forEach((f) => f());
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
