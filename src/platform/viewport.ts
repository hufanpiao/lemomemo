// 键盘弹起（架构 5.9“键盘弹起”）：监听 visualViewport 的 resize 和 scroll，算出键盘高度
// • watchKeyboard(fn)：键盘弹起 / 收起时通知（fn(open, heightPx)）；返回取消函数。第一次订阅时开始监听，最后一个取消时停
// • 键盘高度 = 布局视口高 − 可视视口高 − 可视视口顶端偏移；超过 KB_MIN_PX 才算弹起（地址栏伸缩只有几十 px，不算）
// • 同时把高度写进 CSS 变量 --kb（贴底元素用 bottom: max(env(safe-area-inset-bottom) + 8px, var(--kb))）；没有 visualViewport 的环境什么都不做
// • 双指放大时（visualViewport.scale 不是 1）可视视口也会变小，这时不算键盘弹起（代码审查低 6）
// • 页面回到前台（visibilitychange）时重算一次：后台期间收起的键盘不会漏掉
// • 电脑上没有软键盘，一直是收起
// • iOS 主屏幕版（Q-9，11-11 负责人 preview.259 时间线）：弹键盘时 iOS 把布局视口本身压矮（innerHeight 956→542，可视区跟着一样高），
//   上面那条算出来是 0，底栏、“＋”没藏（data-kb 没上），fixed 贴底跟着浮到键盘上方、挡在打字条和键盘中间。所以主屏幕版里另加一条：
//   有输入框聚焦着、而且 innerHeight 比整屏（按横竖取 screen 的长边或短边）少 KB_MIN_PX 以上，也算弹着（只差顶部安全区那 61 不算）。
//   这一条只对 iPhone（独立验证 11-11 采纳）：iPad 台前调度、分屏、接实体键盘时窗口本来就比整屏矮得多，会误藏底栏；
//   不改用“本次会话最大 innerHeight”，因为 iOS 主屏幕版的 innerHeight 本身就是不可靠的那个数（冷启动、收键盘后都是错的 895），横竖屏、台前调度改窗口大小也都会让最大值失真。
//   iPad 上照旧只用上面那条可视区算法（和这次改动之前一样）
//   这时布局视口下沿就是键盘上沿，--kb 记 0；根节点另打 data-kbo="1"（凡是键盘弹着都打），base.css 据此让 --dock-bottom 直接等于 --kb，
//   打字条、随手记输入行贴着键盘；底栏、“＋”照 FA-7 第 3 项藏起（visibility，等于被键盘盖住），收起键盘原样出现。焦点进出（focusin / focusout）也重算一次
// • 收起后暂缓（台账 Q-13，11-11 负责人“输入框收起来的时候导航栏也跟着上升一下再下降”，真机视频：键盘还在往下收时底栏就露在半屏，
//   接着比原位高约 60pt 停 0.2～0.3 秒才落下；时间线：收键盘时 inner 542→895，0.33 秒后 Gap fix 才补成 956）：iOS 主屏幕版 iPhone 上，
//   键盘刚收起、innerHeight 还没回到整屏（差超过 HOLD_TOL_PX），就再对订阅者报“还弹着”（底栏、“＋”继续藏），回到整屏或到 HOLD_MS 才报收起；
//   data-kbo、--kb 照实时算（打字条等浮条不受影响）
// • 底栏焊死（Q-13，负责人 11-11“导航给我焊死在下面！”）：iOS 主屏幕版 iPhone 键盘没弹时，innerHeight 比整屏少 HOLD_TOL_PX～GAP_MAX_PX
//   （就是那个错的 895，少的是顶部安全区；冷启动和收键盘后 Gap fix 补回 956 之前都会出现），把差值写进根节点 --vh-gap，
//   底栏、“＋”、实色带、渐隐层（kit GlassBar）的 bottom 减去它，落到屏幕最底，和 956 时同一个位置；回到整屏就清掉（只改位置，不碰玻璃材质，R-361）
// • blockPageZoom()：拦 iOS 整页双指缩放（11-11，见文件末尾）
// B2 先给提醒横幅排队用（FA-4）；导航和“＋”在键盘弹起时隐藏的那部分由各自页面读 --kb 或订阅这里
import { isStandalone } from './env.ts';

export const KB_MIN_PX = 120;
/** 收起后暂缓最多这么久（Q-13；Gap fix 补回整屏实测 0.33 秒） */
export const HOLD_MS = 1000;
/** innerHeight 离整屏这么多以内算回到整屏 */
export const HOLD_TOL_PX = 4;
/** 布局视口比整屏少这么多以内才当“少了顶部安全区”补到底（更多的是分屏、横屏等，不补） */
export const GAP_MAX_PX = 100;
export const GAP_VAR = '--vh-gap';

type VvLike = Pick<VisualViewport, 'height' | 'offsetTop' | 'addEventListener' | 'removeEventListener'> & { readonly scale?: number };
type DocLike = Pick<Document, 'addEventListener' | 'removeEventListener'>;

/** scale 和 1 差多少以内算没缩放 */
const SCALE_EPS = 0.01;

export interface ViewportEnv {
  readonly vv?: () => VvLike | null;
  readonly innerHeight?: () => number;
  readonly root?: () => { style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> } | null;
  readonly doc?: () => DocLike | null;
  /** 是不是主屏幕版（Q-9；不传就看 navigator.standalone / display-mode） */
  readonly standalone?: () => boolean;
  /** 有能弹键盘的东西聚焦着（Q-9；不传就看 document.activeElement） */
  readonly editing?: () => boolean;
  /** 整屏高（Q-9；不传：按横竖取 screen 的长边或短边） */
  readonly full?: () => number;
  /** 是不是 iPhone（Q-9 那条只对 iPhone；不传就看 UA） */
  readonly phone?: () => boolean;
  /** 现在的毫秒数（Q-13 暂缓计时；不传用 Date.now） */
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

/** 整屏高：横屏取 screen 短边、竖屏取长边（iOS 的 screen 不随横竖屏转：横竖只拿 innerWidth 比 screen 短边，不看 innerHeight——弹键盘时 innerHeight 会被压矮，小屏竖屏 375×667 键盘+辅助条后只剩约 363，比宽还小，按宽高比会误判横屏；独立验证 11-11 必改 2） */
export const fullHeight = (w: Pick<Window, 'innerWidth' | 'innerHeight'> & { screen: Pick<Screen, 'width' | 'height'> }): number => {
  const { width, height } = w.screen;
  return w.innerWidth > Math.min(width, height) ? Math.min(width, height) : Math.max(width, height);
};
const defaultFull = (): number => (typeof window === 'undefined' ? 0 : fullHeight(window));

/** 键盘高度（px）：算出来小于 KB_MIN_PX 的当 0 */
export function keyboardHeight(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  const h = Math.round(innerHeight - vvHeight - vvOffsetTop);
  return h >= KB_MIN_PX ? h : 0;
}

type Listener = (open: boolean, heightPx: number) => void;

export function createKeyboardWatcher(env: ViewportEnv = {}) {
  const vvOf = env.vv ?? (() => (typeof window !== 'undefined' ? (window.visualViewport ?? null) : null));
  const innerOf = env.innerHeight ?? (() => (typeof window !== 'undefined' ? window.innerHeight : 0));
  const rootOf = env.root ?? (() => (typeof document !== 'undefined' ? document.documentElement : null));
  const docOf = env.doc ?? (() => (typeof document !== 'undefined' ? document : null));
  const standaloneOf = env.standalone ?? (() => typeof navigator !== 'undefined' && isStandalone());
  const editingOf = env.editing ?? (() => editableFocused());
  const fullOf = env.full ?? defaultFull;
  const phoneOf = env.phone ?? (() => isIPhone());
  // 单调时钟：系统时间往回调不影响暂缓计时（独立验证 11-11 建议 3）
  const nowOf = env.now ?? (() => performance.now());
  /** 对订阅者报的开 / 关（Q-13 暂缓期间比 height 晚一步变成关） */
  let reported = false;
  /** 暂缓到什么时候（0 = 不在暂缓） */
  let holdUntil = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** 现在 --vh-gap 写的值 */
  let gapVar = 0;
  let doc: DocLike | null = null;
  const listeners = new Set<Listener>();
  let height = 0;
  /** 现在 --kb 写的值 */
  let kbVar = 0;
  let vv: VvLike | null = null;

  const update = (): void => {
    if (!vv) return;
    const zoomed = typeof vv.scale === 'number' && Math.abs(vv.scale - 1) > SCALE_EPS;
    const inner = innerOf();
    /** 键盘压在布局视口上的那部分（浏览器里；--kb 写它） */
    const over = zoomed ? 0 : keyboardHeight(inner, vv.height, vv.offsetTop);
    /** 主屏幕版：布局视口本身被压矮（Q-9） */
    const shrunk = !zoomed && over === 0 && standaloneOf() && phoneOf() && editingOf() ? Math.round(fullOf() - inner) : 0;
    const h = over > 0 ? over : shrunk >= KB_MIN_PX ? shrunk : 0;
    // 正在输入时不写（独立验证 11-11 建议 2：外接键盘只剩几十 px 快捷条时 h=0，差值落在范围里，会把底栏推到快捷条底下）
    const gapNow = h === 0 && !zoomed && standaloneOf() && phoneOf() && !editingOf() ? Math.round(fullOf() - inner) : 0;
    const gap = gapNow > HOLD_TOL_PX && gapNow <= GAP_MAX_PX ? gapNow : 0;
    if (gap !== gapVar) {
      gapVar = gap;
      const r = rootOf();
      if (gap > 0) r?.style.setProperty(GAP_VAR, `${gap}px`);
      else r?.style.removeProperty(GAP_VAR);
    }
    const wasOpen = height > 0;
    if (h > 0) holdUntil = 0;
    else if (wasOpen && !zoomed && standaloneOf() && phoneOf()) holdUntil = nowOf() + HOLD_MS;
    const holding = h === 0 && holdUntil > 0 && nowOf() < holdUntil && fullOf() - inner > HOLD_TOL_PX;
    if (!holding) holdUntil = 0;
    clearTimeout(holdTimer);
    holdTimer = holding ? setTimeout(update, holdUntil - nowOf()) : undefined;
    const show = h > 0 || holding;
    if (h === height && over === kbVar && show === reported) return;
    const wasShown = reported;
    reported = show;
    height = h;
    kbVar = over;
    const root = rootOf() as (ReturnType<typeof rootOf> & { setAttribute?: (k: string, v: string) => void; removeAttribute?: (k: string) => void }) | null;
    if (over > 0) root?.style.setProperty('--kb', `${over}px`);
    else root?.style.removeProperty('--kb');
    if (h > 0) root?.setAttribute?.('data-kbo', '1');
    else root?.removeAttribute?.('data-kbo');
    if (wasShown !== show || h > 0) for (const l of [...listeners]) l(show, h);
  };

  return {
    /** 现在键盘是不是弹着 */
    isOpen: (): boolean => reported,
    watch(fn: Listener): () => void {
      if (listeners.size === 0) {
        vv = vvOf();
        vv?.addEventListener('resize', update);
        vv?.addEventListener('scroll', update);
        doc = vv ? docOf() : null;
        doc?.addEventListener('visibilitychange', update);
        doc?.addEventListener('focusin', update);
        doc?.addEventListener('focusout', update);
        update();
      }
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && vv) {
          vv.removeEventListener('resize', update);
          vv.removeEventListener('scroll', update);
          doc?.removeEventListener('visibilitychange', update);
          doc?.removeEventListener('focusin', update);
          doc?.removeEventListener('focusout', update);
          clearTimeout(holdTimer);
          holdTimer = undefined;
          holdUntil = 0;
          reported = height > 0;
          doc = null;
          vv = null;
        }
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

// 禁止整页双指缩放（负责人 11-11“今天，代办跟随手记为啥可以用双指扩大整个画面？？？”“缩放后缩小的话导航位置会上升”）：
// iOS Safari / 主屏幕版不认 viewport 的 user-scalable=no、maximum-scale，html 的 touch-action: pan-x pan-y 在 iOS 上也拦不全双指，
// 只有对 iOS 独有的 gesturestart / gesturechange / gestureend 调 preventDefault（passive: false）才停得住。别的浏览器不发这几个事件，等于什么都不做。
// 只拦这三个，不碰 touchstart / touchmove：横滑翻页、竖向滚动、双击、拖动柄照常。首屏画完以后随本模块下载（App 的 TabBar 调），首屏 0 字节
const GESTURES = ['gesturestart', 'gesturechange', 'gestureend'] as const;
const stopGesture = (e: Event): void => e.preventDefault();

/** 开始拦整页双指缩放；返回取消函数 */
export function blockPageZoom(doc: Pick<Document, 'addEventListener' | 'removeEventListener'> | null = typeof document !== 'undefined' ? document : null): () => void {
  for (const g of GESTURES) doc?.addEventListener(g, stopGesture, { passive: false });
  return () => {
    for (const g of GESTURES) doc?.removeEventListener(g, stopGesture);
  };
}
