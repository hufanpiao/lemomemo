// 可见高度真机探测（R-371 第二条路，11-10 主持人）：iOS 主屏幕版冷启动后约 4 分钟里 innerHeight 是 894、screen.height 是 956（少算状态栏那一截），
// 底栏跟着上浮。v1 用 --inset-bottom 往下补被代码审打回（实色带、iPad 窗口化、画在可见区外），改查“能不能让 iOS 自己把 innerHeight 改回 956”。
// 这里是几种办法，每种都：记下前值 → 做一下 → 等 WAIT_MS 记“做着时” → 撤回 → 等 WAIT_MS 记“撤回后” → 再等 LATER_MS 记“过一会儿”。
// 只在设置 › 关于的诊断里由按钮触发（settings 分包，首屏 0 字节）；每种都能撤回，撤回失败也不抛（结果里写 undo-err）。
// requestAnimationFrame 只许 src/motion 用（A25），这里用 setTimeout 等重排
export const WAIT_MS = 300;
export const LATER_MS = 1000;

export interface VhSnap {
  readonly inner: number;
  readonly screen: number;
  /** visualViewport.height，没有是 null */
  readonly vv: number | null;
  /** document.documentElement.clientHeight */
  readonly client: number;
  readonly scrollY: number;
}

export function vhSnap(win: Window = window): VhSnap {
  return {
    inner: win.innerHeight,
    screen: win.screen.height,
    vv: win.visualViewport ? Math.round(win.visualViewport.height) : null,
    client: win.document.documentElement.clientHeight,
    scrollY: Math.round(win.scrollY),
  };
}

const fmt = (s: VhSnap): string => `inner=${s.inner} screen=${s.screen} vv=${s.vv ?? '-'} client=${s.client} y=${s.scrollY}`;

export interface VhMethod {
  readonly id: string;
  /** 按钮上的字（诊断区一律英文、不进词典，同 diag-info） */
  readonly label: string;
  /** 做一下；返回撤回函数 */
  apply(win: Window): () => void;
}

/** 改 <meta name="viewport"> 的 content，撤回时原样写回 */
function withViewportMeta(win: Window, edit: (c: string) => string): () => void {
  const meta = win.document.querySelector('meta[name="viewport"]');
  if (!meta) return () => undefined;
  const old = meta.getAttribute('content') ?? '';
  meta.setAttribute('content', edit(old));
  return () => meta.setAttribute('content', old);
}

/** 改 <html> 的一项内联样式，撤回时写回原值（原来没有就删掉） */
function withRootStyle(win: Window, prop: string, value: string): () => void {
  const st = win.document.documentElement.style;
  const old = st.getPropertyValue(prop);
  st.setProperty(prop, value);
  return () => {
    if (old) st.setProperty(prop, old);
    else st.removeProperty(prop);
  };
}

export const VH_METHODS: readonly VhMethod[] = [
  {
    // ① viewport 加 height=device-height（iOS 按它重算布局视口高度），撤回时写回原 content
    id: 'meta-height',
    label: '1 meta height',
    apply: (win) => withViewportMeta(win, (c) => `${c}, height=device-height`),
  },
  {
    // ② 滚到最顶再滚回原处，逼一次重排、重算可见区
    id: 'scroll-top',
    label: '2 scrollTo 0',
    apply: (win) => {
      const y = win.scrollY;
      win.scrollTo(0, 0);
      return () => win.scrollTo(0, y);
    },
  },
  {
    // ③ html 高度先设成 100vh，撤回时去掉
    id: 'html-100vh',
    label: '3 html 100vh',
    apply: (win) => withRootStyle(win, 'height', '100vh'),
  },
  {
    // ④ 老办法“滚 1px”：html 至少比一屏高 1px、滚到 y=1（Safari 收地址栏、重算可见区的路子），撤回时滚回去、去掉最小高度
    id: 'scroll-1px',
    label: '4 scroll 1px',
    apply: (win) => {
      const y = win.scrollY;
      const undoMin = withRootStyle(win, 'min-height', 'calc(100vh + 1px)');
      win.scrollTo(0, y + 1);
      return () => {
        win.scrollTo(0, y);
        undoMin();
      };
    },
  },
  {
    // ⑤ viewport 去掉 viewport-fit=cover 再写回：状态栏那一截和安全区有关，切一下看 iOS 会不会重算可见高度
    id: 'meta-fit',
    label: '5 meta fit',
    apply: (win) => withViewportMeta(win, (c) => c.replace(/,?\s*viewport-fit=cover/, '')),
  },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 跑一种办法，返回一行结果（诊断区显示，负责人截图） */
export async function runVhMethod(m: VhMethod, win: Window = window, wait: (ms: number) => Promise<void> = sleep): Promise<string> {
  const before = vhSnap(win);
  let undo: () => void = () => undefined;
  let err = '';
  try {
    undo = m.apply(win);
  } catch (e) {
    err = ` apply-err=${String(e)}`;
  }
  await wait(WAIT_MS);
  const during = vhSnap(win);
  try {
    undo();
  } catch (e) {
    err += ` undo-err=${String(e)}`;
  }
  await wait(WAIT_MS);
  const after = vhSnap(win);
  await wait(LATER_MS);
  const later = vhSnap(win);
  return `vh ${m.id}:${err} | before ${fmt(before)} | doing ${fmt(during)} | undone ${fmt(after)} | +1s ${fmt(later)}`;
}
