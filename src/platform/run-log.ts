// 全局运行日志（只进非正式版，正式构建由 main.tsx 的 MODE 常量摇掉）
// 一直开着，本机分段保存（run-log-store.ts，最多 MAX_LINES 行，跨冷启动保留），诊断页“Copy run log”整段复制。
// 记：开头环境一行、视口变化和版面快照、焦点和输入法、按键（字符键只记“char”）、回车和提交、点按、选字（不记选中的字）、
// 路由和返回栈、前后台、报错和 console.error/warn、网络请求（路径不带参数）、业务代码经 rlog 记的结果、kbcheck。
// 版面快照、kbcheck 的读法在 run-log-layout.ts；这里挂事件、存日志、接 console 和 fetch。
// 隐私：不记用户输入的任何文字、不记网址参数；按钮只记 data-testid / aria-label / id
import { buildInfo, isStandalone } from './env.ts';
import { RL_SLOT } from './run-log-api.ts';
import { deepDiagOn } from './diag-deep.ts';
import { watchJank } from './jank-watch.ts';
import { createRunLogWriter } from './run-log-store.ts';
import { createLayoutProbe, describeEl, isMasked, RL_MASK_ATTR } from './run-log-layout.ts';
import { KBO_ATTR } from './viewport-screen.ts';

export { clearRunLog, MAX_LINES, readRunLog } from './run-log-store.ts';
/** 有新行后多久存一次（不放长：崩溃时 300ms 以前的行都已经在本机） */
const SAVE_MS = 300;
/** 视口事件合并 */
const VV_GAP_MS = 16;
/** 焦点、路由变化后多久再拍一次版面 */
const SETTLE_SNAP_MS = 400;
/** 焦点进来多久再记第二次 kbcheck（第一次在 SETTLE_SNAP_MS） */
export const KB_CHECK_MS = 1500;

/** globalThis 上的运行日志口子：q 下载前排的、sink 记一行、deep 深度诊断开着没有（motion 按分层规则引不到 diag-deep.ts，换页的旧页元素数从这里读） */
type Slot = { q: Array<[number, string]>; sink?: ((line: string) => void) | undefined; deep?: (() => boolean) | undefined };

/** 输入框的状态：值的长度、选区、只读/禁用（不含文字）；input、textarea 都记，只读的也记（会不会弹键盘看 env.ts 的 opensKeyboard） */
function fieldState(el: unknown): string {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return '';
  let sel = '-';
  try {
    sel = `${el.selectionStart ?? '-'}-${el.selectionEnd ?? '-'}`;
  } catch {
    sel = 'n/a';
  }
  return ` len=${el.value.length} sel=${sel}${el.readOnly ? ' ro' : ''}${el.disabled ? ' dis' : ''}`;
}

function fmtArg(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** 接上 console.error / warn 和 fetch（方法、路径不带参数、状态、耗时）；返回还原函数 */
function hookConsoleFetch(win: Window, add: (s: string) => void, now: () => number): () => void {
  const con = console;
  const origErr = con.error;
  const origWarn = con.warn;
  const fmt = (args: unknown[]): string => args.map(fmtArg).join(' ').slice(0, 300);
  con.error = (...args: unknown[]): void => {
    add(`console.error ${fmt(args)}`);
    origErr.apply(con, args);
  };
  con.warn = (...args: unknown[]): void => {
    add(`console.warn ${fmt(args)}`);
    origWarn.apply(con, args);
  };
  // 网络请求：方法、路径（不带参数）、状态、耗时
  const origFetch = typeof win.fetch === 'function' ? win.fetch : undefined;
  if (origFetch) {
    win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const started = now();
      let path = '?';
      let method = init?.method ?? 'GET';
      try {
        const isReq = typeof Request === 'function' && input instanceof Request;
        const u = new URL(isReq ? input.url : String(input), win.location.href);
        path = u.origin === win.location.origin ? u.pathname : `${u.host}${u.pathname}`;
        if (isReq && !init?.method) method = input.method;
      } catch {
        path = '?';
      }
      try {
        const res = await origFetch.call(win, input, init);
        add(`net ${method} ${path.slice(0, 120)} ${res.status} ${Math.round(now() - started)}ms`);
        return res;
      } catch (err) {
        add(`net ${method} ${path.slice(0, 120)} FAIL ${(err as Error | undefined)?.name ?? ''} ${Math.round(now() - started)}ms`);
        throw err;
      }
    };
  }
  return () => {
    con.error = origErr;
    con.warn = origWarn;
    if (origFetch) win.fetch = origFetch;
  };
}

export interface RunLogOptions {
  store?: Storage;
  now?: () => number;
  version?: string;
  /** 下一帧回调（由 app 层注入 motion 的 nextFrame；平台层不能引 motion、也不许直接调帧接口）；不给就不记切回前台的帧计时 */
  frame?: (cb: () => void) => void;
}

/** 开始记；返回停止函数 */
/** 这次打开是怎么来的（navigate 新开、reload 被重新加载——iOS 在后台杀掉页面进程再回来也是这一种、back_forward）；拿不到写 - */
function navType(win: Window): string {
  const e = win.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  return e?.type ?? '-';
}

export function startRunLog(win: Window = window, opts: RunLogOptions = {}): () => void {
  const store = opts.store ?? localStorage;
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  // 有新行后 SAVE_MS 存一次，离开页面、切到后台当场存
  const out = createRunLogWriter(store);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = (): void => {
    saveTimer = undefined;
    out.save();
  };
  /** 攒着没存的当场存 */
  const flush = (): void => {
    if (saveTimer === undefined) return;
    clearTimeout(saveTimer);
    save();
  };
  const stamp = (ms: number): string => `t=${((ms - t0) / 1000).toFixed(2)}`;
  const push = (line: string): void => {
    out.push(line);
    if (saveTimer === undefined) saveTimer = setTimeout(save, SAVE_MS);
  };
  // 换页：路由用 replaceState 换地址不触发 hashchange（router.ts 不能引日志），换地址当下就记（见 noteRoute）
  let lastHash = win.location.hash;
  /** 返回栈深度（router.ts 的 history.state.lemoStack）：只记个数，不记地址 */
  const depth = (): number => {
    const st: unknown = win.history.state;
    const s = typeof st === 'object' && st !== null ? (st as Record<string, unknown>)['lemoStack'] : undefined;
    return Array.isArray(s) ? s.length : 0;
  };
  let lastDepth = depth();
  /** 地址变了就记一行 route，换地址的当下就记（拦 pushState、replaceState，加 popstate、hashchange），时刻才准；add 里也先查一次兜底。
   *  返回栈深度变了另记一行 stack depth=N hist=浏览器历史条数（应该一直是 1） */
  const noteRoute = (): void => {
    const h = win.location.hash;
    const d = depth();
    if (h !== lastHash) {
      lastHash = h;
      push(`${stamp(now())} route ${h || '/'}`);
      // 换页头像诊断：只在深度诊断打开时下载 diag-deep-probe.ts，下载到后等两帧记 swap pin 行
      if (deepDiagOn()) void import('./diag-deep-probe.ts').then((m) => m.noteSwapPin(doc, add, opts.frame)).catch(() => undefined);
    }
    if (d !== lastDepth) {
      lastDepth = d;
      push(`${stamp(now())} stack depth=${d} hist=${win.history.length}`);
    }
  };
  const add = (s: string): void => {
    noteRoute();
    push(`${stamp(now())} ${s}`);
  };
  const hist = win.history as History | undefined;
  const origPush = hist?.pushState;
  const origReplace = hist?.replaceState;
  if (hist && origPush && origReplace) {
    hist.pushState = function (this: History, ...a: Parameters<History['pushState']>) {
      origPush.apply(this, a);
      noteRoute();
    };
    hist.replaceState = function (this: History, ...a: Parameters<History['replaceState']>) {
      origReplace.apply(this, a);
      noteRoute();
    };
  }
  const unhookHistory = (): void => {
    if (hist && origPush && origReplace) {
      hist.pushState = origPush;
      hist.replaceState = origReplace;
    }
  };
  const doc = win.document;
  const root = doc.documentElement;
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const mq = (q: string): boolean => win.matchMedia?.(q).matches === true;
  const standalone = isStandalone(nav, mq);
  // 主要指针（fine / coarse / none）+ 有没有任意一种细指针：滚动条样式、触屏判断都按这个分；有的电脑插着鼠标也报 none
  const ptr = `${mq('(pointer: coarse)') ? 'coarse' : mq('(pointer: fine)') ? 'fine' : 'none'}${mq('(any-pointer: fine)') ? '+fine' : ''}`;
  push(
    `=== start ${new Date(t0).toISOString()} v=${opts.version ?? `${buildInfo.version}@${buildInfo.commit}`} screen=${win.screen.width}x${win.screen.height} dpr=${win.devicePixelRatio} ptr=${ptr} standalone=${standalone} tap-hl=${win.getComputedStyle(doc.documentElement).getPropertyValue('-webkit-tap-highlight-color') || '-'} route=${win.location.hash || '/'} nav=${navType(win)} ua=${nav.userAgent.slice(0, 160)}`,
  );
  save();

  const vv = win.visualViewport;
  const probe = createLayoutProbe(win);
  const snap = (kind: string): void => add(`${kind} ${probe.vvState()} ${probe.layout()}`);

  let lastVv = '';
  let vvTimer: ReturnType<typeof setTimeout> | undefined;
  const onVv =
    (kind: string) =>
    (): void => {
      clearTimeout(vvTimer);
      vvTimer = setTimeout(() => {
        const s = `${probe.vvState()} ${probe.layout()}`;
        if (s === lastVv) return;
        lastVv = s;
        add(`${kind} ${s}`);
      }, VV_GAP_MS);
    };
  const onVvResize = onVv('vv');
  const onWinResize = onVv('win');
  const onWinScroll = onVv('scroll');
  const kbcheck = (): void => {
    const line = probe.kbcheck();
    if (line !== null) add(line);
  };
  /** kbcheck 自己的计时器（不和 settleTimer 共用：焦点进来后马上换路由也照样记） */
  let kbTimers: Array<ReturnType<typeof setTimeout>> = [];
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settleSnap = (why: string): void => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => snap(`settled(${why})`), SETTLE_SNAP_MS);
  };

  /** 最近一次点按的时间：焦点进来时判断是点出来的还是程序聚焦 */
  let lastDown = -1e9;
  const onFocusIn = (e: FocusEvent): void => {
    const by = now() - lastDown < 800 ? 'tap' : 'code';
    add(`focusin ${describeEl(e.target)} by=${by}${fieldState(e.target)} ${probe.vvState()} ${probe.layout()}`);
    probe.markFocus();
    settleSnap('focusin');
    // 400ms 一次；主屏幕版键盘弹完、布局视口压矮有时要 1 秒多，KB_CHECK_MS 再记一次
    for (const id of kbTimers) clearTimeout(id);
    kbTimers = [SETTLE_SNAP_MS, KB_CHECK_MS].map((ms) => setTimeout(kbcheck, ms));
  };
  const onFocusOut = (e: FocusEvent): void => {
    add(`focusout ${describeEl(e.target)} to=${describeEl(e.relatedTarget)}${fieldState(e.target)}`);
    settleSnap('focusout');
  };
  const pickTarget = (t: EventTarget | null): Element | null =>
    t instanceof Element ? (t.closest('button,a,[role="button"],input,textarea,select,label,[data-testid]') ?? t) : null;
  /** 这里的捕获监听最先挂、最先跑，记的时候后面的处理函数还没轮到：派发完再看一眼，被后面的谁 preventDefault 了（例如换页后吞点按的窗口）补记一行 */
  const preventedLater = (e: Event, line: string): void => {
    if (!e.defaultPrevented) setTimeout(() => e.defaultPrevented && add(`${line} prevented-later`), 0);
  };
  /** 坐标一段；点在带 data-rl-mask 的区域里不记（密码键盘的坐标就是按了哪个数） */
  const at = (e: PointerEvent): string => (isMasked(e.target) ? '' : ` x=${Math.round(e.clientX)} y=${Math.round(e.clientY)}`);
  const onDown = (e: PointerEvent): void => {
    lastDown = now();
    add(`down ${describeEl(pickTarget(e.target))} ${e.pointerType}${at(e)}`);
    preventedLater(e, `down ${describeEl(pickTarget(e.target))}`);
  };
  const onUp = (e: PointerEvent): void => add(`up ${describeEl(pickTarget(e.target))}${at(e)}`);
  const onCancel = (e: PointerEvent): void => add(`pointercancel ${describeEl(pickTarget(e.target))}`);
  const onClick = (e: MouseEvent): void => {
    add(`click ${describeEl(pickTarget(e.target))}${e.defaultPrevented ? ' prevented' : ''}`);
    preventedLater(e, `click ${describeEl(pickTarget(e.target))}`);
  };
  const onKey = (e: KeyboardEvent): void => {
    // 页面上挂着带 data-rl-mask 的（密码键盘）：实体键的焦点常在 body 上，记键名、keyCode 就数得出输了几位，一律只记 masked
    if (doc.querySelector(`[${RL_MASK_ATTR}]`) !== null) return add('key masked');
    const name = e.key.length === 1 ? 'char' : e.key;
    let extra = '';
    if (e.key === 'Enter' || e.keyCode === 13) {
      const t = e.target;
      const form = t instanceof Element ? t.closest('form') : null;
      const btn = form?.querySelector<HTMLButtonElement>('button[type="submit"],button:not([type])') ?? null;
      extra = ` form=${describeEl(form)} submitBtn=${btn ? (btn.disabled ? 'disabled' : 'enabled') : 'none'}${fieldState(t)}`;
    }
    // 字符键不记 keyCode（keyCode 就是按了哪个字，密码键盘上就是哪个数字）
    add(`key ${name}${name === 'char' ? '' : ` code=${e.keyCode}`}${e.isComposing ? ' composing' : ''}${e.defaultPrevented ? ' prevented' : ''} on=${describeEl(e.target)}${extra}`);
  };
  const onBeforeInput = (e: Event): void => {
    const ie = e as InputEvent;
    if (ie.inputType === 'insertText' || ie.inputType === 'insertCompositionText' || ie.inputType === 'deleteContentBackward') return;
    add(`beforeinput ${ie.inputType}${ie.isComposing ? ' composing' : ''} on=${describeEl(e.target)}`);
  };
  const onCompStart = (e: Event): void => add(`composition start on=${describeEl(e.target)}`);
  const onCompEnd = (e: Event): void => add(`composition end on=${describeEl(e.target)}${fieldState(e.target)}`);
  /** 选字（见文件头）：开始选、长按菜单落在哪，后面有没有人拦 */
  const onSelStart = (e: Event): void => {
    add(`selectstart ${describeEl(pickTarget(e.target))}${e.defaultPrevented ? ' prevented' : ''}`);
    preventedLater(e, `selectstart ${describeEl(pickTarget(e.target))}`);
  };
  const onMenu = (e: Event): void => {
    add(`contextmenu ${describeEl(pickTarget(e.target))}${e.defaultPrevented ? ' prevented' : ''}`);
    preventedLater(e, `contextmenu ${describeEl(pickTarget(e.target))}`);
  };
  let lastSel = '';
  const onSelChange = (): void => {
    const sel = doc.getSelection();
    const host = (n: Node | null | undefined): string => describeEl(pickTarget(n instanceof Element ? n : (n?.parentElement ?? null)));
    const s = sel ? `sel type=${sel.type} a=${host(sel.anchorNode)} f=${host(sel.focusNode)}` : 'sel none';
    if (s === lastSel) return;
    lastSel = s;
    add(s);
  };
  const onSubmit = (e: Event): void => add(`submit ${describeEl(e.target)} by=${describeEl((e as SubmitEvent).submitter)}`);
  const onHash = (): void => {
    noteRoute();
    settleSnap('route');
  };
  // 浏览器历史前进、后退（App 自己从不压历史，只有 iOS 系统边缘手势退旧记录时才有）：记一行，带历史条数（应该是 1，多了按它查哪来的）
  const onPop = (): void => {
    push(`${stamp(now())} popstate hist=${win.history.length}`);
    noteRoute();
  };
  const onVis = (): void => {
    snap(`visibility=${doc.visibilityState}`);
    // 切到后台：当场存（iOS 切走以后很快冻结页面，300ms 的计时器可能等不到，被系统杀掉时最后几行就没了）
    if (doc.visibilityState !== 'visible') return flush();
    // 切回前台：记第 1、2 帧离 visibilitychange 多久、0 ms 计时器多久才轮到，和页面上有几层背景模糊（backdrop-filter）。
    // 帧来得晚 = 主线程或合成器卡着；帧很快但用户看见白 = 系统在重画图层（层越多越慢）
    // 帧回调由调用方注入（opts.frame）：这里只量出帧时刻，不做动画
    const frame = opts.frame;
    if (!frame) return;
    const t0 = performance.now();
    let tm = -1;
    setTimeout(() => {
      tm = performance.now() - t0;
    }, 0);
    frame(() => {
      const f1 = performance.now() - t0;
      frame(() => {
        const f2 = performance.now() - t0;
        // 再记屏幕正中那一点是谁（白屏时是不是盖了东西）、根元素和 body 的不透明度（重新加载看 start 行的 nav=）
        const mid = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(win.innerWidth / 2, win.innerHeight / 2) : null;
        const op = `${getComputedStyle(doc.documentElement).opacity}/${doc.body ? getComputedStyle(doc.body).opacity : '-'}`;
        const line = (blur: number | string): void =>
          add(`vis-frames raf1=${Math.round(f1)} raf2=${Math.round(f2)} timer0=${Math.round(tm)} blur=${blur} els=${doc.getElementsByTagName('*').length} mid=${describeEl(mid)} op=${op}`);
        // 数模糊层要对全页元素逐个算样式，正好压在切回前台这一刻：只在深度诊断打开时下载 diag-deep-probe.ts 再数，关着写 blur=-
        if (deepDiagOn()) void import('./diag-deep-probe.ts').then((m) => line(m.countBlur(doc)), () => line('-'));
        else line('-');
      });
    });
  };
  const onPageShow = (e: PageTransitionEvent): void => snap(`pageshow persisted=${e.persisted}`);
  // 离开页面（location.replace 去登录页、刷新、关标签页）：攒着没存的当场存，不等 300ms（不然启动失败那一行会丢）
  const onPageHide = flush;
  const onErr = (e: ErrorEvent): void => add(`error ${String(e.message).slice(0, 300)} @${String(e.filename).split('/').pop()}:${e.lineno}:${e.colno}`);
  const onRej = (e: PromiseRejectionEvent): void => {
    const r = e.reason as { name?: string; message?: string; stack?: string } | undefined;
    const at = String(r?.stack ?? '').split('\n')[1]?.trim().slice(0, 160) ?? '';
    add(`rejection ${r?.name ?? ''} ${String(r?.message ?? r).slice(0, 300)} ${at}`);
  };
  let lastRoot = '';
  const mo =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          const s = probe.root();
          if (lastRoot === s) return;
          lastRoot = s;
          add(`root ${s} ${probe.layout()}`);
        })
      : null;
  mo?.observe(root, { attributes: true, attributeFilter: [KBO_ATTR, 'style'] });

  const unhook = hookConsoleFetch(win, add, now);

  // 业务代码 rlog 记的（下载前排队的补进来，之后直接写）
  const g = globalThis as unknown as Record<string, Slot | undefined>;
  const slot = (g[RL_SLOT] ??= { q: [] });
  for (const [ms, line] of slot.q) push(`${stamp(ms)} app ${line}`);
  slot.q = [];
  slot.sink = (line: string): void => add(`app ${line}`);
  slot.deep = () => deepDiagOn();

  /** 挂上的事件（停止时按同一张表拿掉）：目标、事件名、处理函数、选项（true = 捕获阶段） */
  const ons: Array<[EventTarget | null, string, (e: never) => void, AddEventListenerOptions | boolean | undefined]> = [
    [vv, 'resize', onVvResize, undefined],
    [vv, 'scroll', onVvResize, undefined],
    [win, 'resize', onWinResize, undefined],
    [win, 'scroll', onWinScroll, { passive: true }],
    [doc, 'focusin', onFocusIn, undefined],
    [doc, 'focusout', onFocusOut, undefined],
    [doc, 'pointerdown', onDown, true],
    [doc, 'pointerup', onUp, true],
    [doc, 'pointercancel', onCancel, true],
    [doc, 'click', onClick, true],
    [doc, 'keydown', onKey, true],
    [doc, 'beforeinput', onBeforeInput, true],
    [doc, 'compositionstart', onCompStart, true],
    [doc, 'compositionend', onCompEnd, true],
    [doc, 'submit', onSubmit, true],
    [doc, 'selectstart', onSelStart, true],
    [doc, 'contextmenu', onMenu, true],
    [doc, 'selectionchange', onSelChange, undefined],
    [win, 'hashchange', onHash, undefined],
    [win, 'popstate', onPop, undefined],
    [doc, 'visibilitychange', onVis, undefined],
    [win, 'pageshow', onPageShow, undefined],
    [win, 'pagehide', onPageHide, undefined],
    [win, 'error', onErr, undefined],
    [win, 'unhandledrejection', onRej, undefined],
  ];
  for (const [t, type, fn, o] of ons) t?.addEventListener(type, fn as EventListener, o);
  snap('boot');
  settleSnap('boot');
  // 长帧计数（jank-watch.ts）：有帧回调才起，前台时 10 秒里有 >50ms 的帧才记一行
  const stopJank = opts.frame ? watchJank(doc, opts.frame, add) : () => undefined;
  return () => {
    stopJank();
    mo?.disconnect();
    unhook();
    unhookHistory();
    slot.sink = undefined;
    slot.deep = undefined;
    for (const [t, type, fn, o] of ons) t?.removeEventListener(type, fn as EventListener, o);
    clearTimeout(vvTimer);
    clearTimeout(settleTimer);
    for (const id of kbTimers) clearTimeout(id);
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    save();
  };
}
