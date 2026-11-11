// 键盘收起后再做一次 Gap fix（Q-4，11-11 负责人真机时间线：点“＋”弹键盘、点空白收起后 iOS 把 innerHeight 还原成冷启动那个错的 895，底栏又高 61、一直不落回）：
// 由 vh-gapfix.ts 的 startGapFix 在主屏幕版时调（同一个动态分包，首屏不带）。本文件只管“什么时候再做”，做不做、怎么做由调用方给（tryFix）：
//   盯 visualViewport / window 的 resize 和 focusout；看到键盘弹起（可视区比布局视口少 KB_MIN_PX 以上、
//   或者 iPhone 上 innerHeight 比整屏少的远超顶部安全区）才“上膛”；整屏按横竖取 screen 的长边或短边（独立验证 11-11：原来横屏也拿 screen.height 比，横屏一直上膛）；
//   只对 iPhone 认“innerHeight 变小”这一条，同 viewport.ts（iPad 台前调度、分屏时窗口本来就矮）；之后最后一次 resize / focusout 静了 KB_SETTLE_MS、键盘确实收了（也没有输入框聚焦）才调 tryFix；
//   不叠跑（调用方正在做、或冷启动那次还没做完，就等它做完调 idle() 再看），做一次就退膛，等下次键盘弹起；
//   顺带记着手指按没按着屏幕（touching），调用方据此在用户正在滚时不补那 1px 滚动（代码审 M1）。
// requestAnimationFrame 只许 src/motion 用（A25）：等帧的函数由调用方传进来

/** 键盘弹起的门槛（同 viewport.ts 的 KB_MIN_PX；不引那个文件，免得本分包多带东西） */
export const KB_MIN_PX = 120;
/** 键盘收起后最后一次 resize / focusout 静了这么久再看（防抖） */
export const KB_SETTLE_MS = 300;

type Frame = (cb: () => void) => unknown;

export interface KbHost {
  readonly win: Window;
  readonly frame: Frame;
  readonly now: () => number;
  readonly row: (what: string) => void;
  /** 调用方正在做（冷启动那次或上一次键盘那次） */
  readonly busy: () => boolean;
  /** 最近一次读到的顶部安全区 */
  readonly top: () => number;
  /** 键盘真收了：调用方查开关和条件，满足就做（日志带 kb） */
  readonly tryFix: () => void;
  /** 是不是 iPhone（不传就看 win.navigator 的 UA；同 viewport.ts 的 isIPhone，不引那个文件） */
  readonly phone?: () => boolean;
}

export interface KbWatch {
  /** 手指按着屏幕（可能正在滚） */
  touching(): boolean;
  /** 调用方做完了：做着的时候键盘收过，就再看一次 */
  idle(): void;
  stop(): void;
}

const NO_KB_INPUT = /^(button|checkbox|radio|range|submit|reset|file|color|image|hidden)$/i;
const TOUCH = ['touchstart', 'touchend', 'touchcancel'] as const;

export function watchKbClose(h: KbHost): KbWatch {
  const { win, frame, now, row } = h;
  const phone = h.phone ?? (() => /iPhone|iPod/.test(win.navigator.userAgent));
  /** 整屏高：横屏取 screen 短边、竖屏取长边（同 viewport.ts 的 fullHeight） */
  const full = (): number => {
    const { width, height } = win.screen;
    return win.innerWidth > Math.min(width, height) ? Math.min(width, height) : Math.max(width, height);
  };
  const doc = win.document;
  const vv = win.visualViewport ?? null;
  let cancelled = false;
  /** 看到键盘弹起过、还没再做 */
  let armed = false;
  /** 做着的时候键盘收了：做完再看一次 */
  let recheck = false;
  let touching = false;
  let due = 0;
  let ticking = false;
  /** 有能弹键盘的东西聚焦着 */
  const editing = (): boolean => {
    const el = doc.activeElement as HTMLElement | null;
    if (!el || el === doc.body || el === doc.documentElement) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !NO_KB_INPUT.test((el as HTMLInputElement).type);
  };
  /** 看得出键盘占着屏幕：可视区比布局视口少 KB_MIN_PX 以上；或（只 iPhone）innerHeight 比整屏少的远超顶部安全区（主屏幕版弹键盘时 innerHeight 本身变小，542 / 956） */
  const kbShown = (): boolean => {
    const inner = win.innerHeight;
    if (vv && inner - vv.height - vv.offsetTop >= KB_MIN_PX) return true;
    return phone() && full() - inner - h.top() >= KB_MIN_PX;
  };
  const tick = (): void => {
    if (cancelled) {
      ticking = false;
      return;
    }
    if (now() < due) {
      frame(tick);
      return;
    }
    ticking = false;
    if (!armed) return;
    if (h.busy()) {
      recheck = true;
      return;
    }
    // 键盘还在（或者焦点挪到了另一个输入框）：不做，等下一次 resize / focusout
    if (kbShown() || editing()) return;
    armed = false;
    h.tryFix();
  };
  const kick = (): void => {
    if (cancelled || !armed) return;
    due = now() + KB_SETTLE_MS;
    if (!ticking) {
      ticking = true;
      frame(tick);
    }
  };
  const onChange = (): void => {
    if (cancelled) return;
    if (!armed) {
      if (!kbShown()) return;
      armed = true;
      row(`kb open vv=${vv ? Math.round(vv.height) : '-'}`);
      return;
    }
    kick();
  };
  const onTouch = (e: Event): void => {
    touching = e.type === 'touchstart';
  };
  vv?.addEventListener('resize', onChange);
  win.addEventListener('resize', onChange);
  doc.addEventListener('focusout', onChange);
  for (const t of TOUCH) doc.addEventListener(t, onTouch, { passive: true });
  return {
    touching: () => touching,
    idle(): void {
      if (!recheck) return;
      recheck = false;
      kick();
    },
    stop(): void {
      cancelled = true;
      vv?.removeEventListener('resize', onChange);
      win.removeEventListener('resize', onChange);
      doc.removeEventListener('focusout', onChange);
      for (const t of TOUCH) doc.removeEventListener(t, onTouch);
    },
  };
}
