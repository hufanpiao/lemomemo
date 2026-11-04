// 键盘弹起（架构 5.9“键盘弹起”）：监听 visualViewport 的 resize 和 scroll，算出键盘高度
// • watchKeyboard(fn)：键盘弹起 / 收起时通知（fn(open, heightPx)）；返回取消函数。第一次订阅时开始监听，最后一个取消时停
// • 键盘高度 = 布局视口高 − 可视视口高 − 可视视口顶端偏移；超过 KB_MIN_PX 才算弹起（地址栏伸缩只有几十 px，不算）
// • 同时把高度写进 CSS 变量 --kb（贴底元素用 bottom: max(env(safe-area-inset-bottom) + 8px, var(--kb))）；没有 visualViewport 的环境什么都不做
// • 双指放大时（visualViewport.scale 不是 1）可视视口也会变小，这时不算键盘弹起（代码审查低 6）
// • 页面回到前台（visibilitychange）时重算一次：后台期间收起的键盘不会漏掉
// • 电脑上没有软键盘，一直是收起
// B2 先给提醒横幅排队用（FA-4）；导航和“＋”在键盘弹起时隐藏的那部分由各自页面读 --kb 或订阅这里
export const KB_MIN_PX = 120;

type VvLike = Pick<VisualViewport, 'height' | 'offsetTop' | 'addEventListener' | 'removeEventListener'> & { readonly scale?: number };
type DocLike = Pick<Document, 'addEventListener' | 'removeEventListener'>;

/** scale 和 1 差多少以内算没缩放 */
const SCALE_EPS = 0.01;

export interface ViewportEnv {
  readonly vv?: () => VvLike | null;
  readonly innerHeight?: () => number;
  readonly root?: () => { style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> } | null;
  readonly doc?: () => DocLike | null;
}

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
  let doc: DocLike | null = null;
  const listeners = new Set<Listener>();
  let height = 0;
  let vv: VvLike | null = null;

  const update = (): void => {
    if (!vv) return;
    const zoomed = typeof vv.scale === 'number' && Math.abs(vv.scale - 1) > SCALE_EPS;
    const h = zoomed ? 0 : keyboardHeight(innerOf(), vv.height, vv.offsetTop);
    if (h === height) return;
    const wasOpen = height > 0;
    height = h;
    const root = rootOf();
    if (h > 0) root?.style.setProperty('--kb', `${h}px`);
    else root?.style.removeProperty('--kb');
    if (wasOpen !== h > 0 || h > 0) for (const l of [...listeners]) l(h > 0, h);
  };

  return {
    /** 现在键盘是不是弹着 */
    isOpen: (): boolean => height > 0,
    watch(fn: Listener): () => void {
      if (listeners.size === 0) {
        vv = vvOf();
        vv?.addEventListener('resize', update);
        vv?.addEventListener('scroll', update);
        doc = vv ? docOf() : null;
        doc?.addEventListener('visibilitychange', update);
        update();
      }
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && vv) {
          vv.removeEventListener('resize', update);
          vv.removeEventListener('scroll', update);
          doc?.removeEventListener('visibilitychange', update);
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
