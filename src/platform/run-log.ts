// 全局运行日志（负责人 11-11“以后所有的bug看log能不能解决”“要做就给我做详细的log”；只进非正式版，正式构建由 main.tsx 的 MODE 常量摇掉）
// 一直开着、不靠试验开关，本机环形保存（OUT_KEY，最多 MAX_LINES 行，跨冷启动保留），诊断页“Copy run log”整段复制。记这些：
// • 开头：时间、版本@提交、屏幕、dpr、是否主屏幕版、路由、UA
// • 视口：每次 visualViewport resize/scroll、window resize/scroll（同一帧合并）：innerHeight、可视区高度和偏移、缩放（不是 1 时才记）、scrollY、data-kbo、--kb、--vh-gap、
//   焦点元素，以及版面快照（底栏、“＋”、模糊带、打字条、随手记输入行、撤销条、焦点输入框和它所在浮层：相对可视区的上沿~下沿、高度、是否藏着）
// • 焦点进出（是点出来的还是程序聚焦、值的长度、选区）；输入法开始/结束；beforeinput 的 inputType；每个按键（字符键只记“char”）
// • 回车：所在表单、输入框值的长度、提交按钮在不在、禁没禁用、是不是正在用输入法；表单真提交了另记 submit
// • 点按（down/up/cancel/click）：点到哪个元素、坐标；路由；前后台；报错、未处理的 Promise 拒绝、console.error/warn；网络请求（方法、路径不带参数、状态、耗时）
// • 业务代码经 run-log-api.ts 的 rlog 记的结果（提交了没有、为什么没提交）
// • 焦点进出、路由变化后 400ms 再拍一次版面快照（等键盘、动画停稳）；焦点进来后 400ms、1500ms 各记一行 kbcheck（系统滚没滚页面、浮条贴没贴键盘，台账 Q-8）
// 隐私：不记用户输入的任何文字、不记网址参数；按钮只记 data-testid / aria-label / id
import { buildInfo, opensKeyboard } from './env.ts';
import { BAR_SELECTOR, RL_SLOT } from './run-log-api.ts';

export const OUT_KEY = 'lemo-run-log';
export const MAX_LINES = 3000;
/** 视口事件合并 */
const VV_GAP_MS = 16;
/** 焦点、路由变化后多久再拍一次版面 */
const SETTLE_SNAP_MS = 400;
/** 焦点进来多久再记第二次 kbcheck（第一次在 SETTLE_SNAP_MS） */
export const KB_CHECK_MS = 1500;
/** 版面快照要看的元素 */
export const LAYOUT_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ['bar', BAR_SELECTOR],
  ['add', '[data-testid="tabbar-add"]'],
  ['band', '[data-testid="tabbar-band"]'],
  ['type', '[data-testid="type-bar"]'],
  ['inrow', '[data-testid="notes-input-row"]'],
  ['undo', '[data-testid="undo-toast"]'],
];

type Slot = { q: Array<[number, string]>; sink?: ((line: string) => void) | undefined };

export function readRunLog(store: Storage = localStorage): string {
  try {
    return store.getItem(OUT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function clearRunLog(store: Storage = localStorage): void {
  try {
    store.removeItem(OUT_KEY);
  } catch {
    // 清不掉就算了
  }
}

/** 元素的简短说明：标签名 + type + data-testid / aria-label / id（不含内容文字） */
export function describeEl(el: unknown): string {
  if (!(el instanceof Element)) return '-';
  const tag = el.tagName.toLowerCase();
  const type = el instanceof HTMLInputElement ? `[${el.type}]` : '';
  const id = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.getAttribute('id') ?? '';
  return `${tag}${type}${id ? `#${id.slice(0, 40)}` : ''}`;
}

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

export interface RunLogOptions {
  store?: Storage;
  now?: () => number;
  version?: string;
}

/** 开始记；返回停止函数 */
export function startRunLog(win: Window = window, opts: RunLogOptions = {}): () => void {
  const store = opts.store ?? localStorage;
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  let lines: string[] = [];
  try {
    const old = store.getItem(OUT_KEY);
    if (old) lines = old.split('\n');
  } catch {
    lines = [];
  }
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = (): void => {
    saveTimer = undefined;
    try {
      store.setItem(OUT_KEY, lines.join('\n'));
    } catch {
      // 存不下：丢一半旧的再试一次
      lines.splice(0, Math.floor(lines.length / 2));
      try {
        store.setItem(OUT_KEY, lines.join('\n'));
      } catch {
        // 算了
      }
    }
  };
  const stamp = (ms: number): string => `t=${((ms - t0) / 1000).toFixed(2)}`;
  const push = (line: string): void => {
    lines.push(line);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    if (saveTimer === undefined) saveTimer = setTimeout(save, 300);
  };
  const add = (s: string): void => push(`${stamp(now())} ${s}`);
  const doc = win.document;
  const root = doc.documentElement;
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const standalone = nav.standalone === true || win.matchMedia?.('(display-mode: standalone)').matches === true;
  push(
    `=== start ${new Date(t0).toISOString()} v=${opts.version ?? `${buildInfo.version}@${buildInfo.commit}`} screen=${win.screen.width}x${win.screen.height} dpr=${win.devicePixelRatio} standalone=${standalone} route=${win.location.hash || '/'} ua=${nav.userAgent.slice(0, 160)}`,
  );
  save();

  const vv = win.visualViewport;
  const cssVar = (k: string): string => root.style.getPropertyValue(k).trim() || '0';
  const vvState = (): string =>
    `inner=${win.innerHeight} vv=${vv ? Math.round(vv.height) : '-'} top=${vv ? Math.round(vv.offsetTop) : '-'}${vv && Math.abs(vv.scale - 1) > 0.005 ? ` scale=${vv.scale.toFixed(2)}` : ''} y=${Math.round(win.scrollY)} kbo=${root.hasAttribute('data-kbo') ? 1 : 0} kb=${cssVar('--kb')} gap=${cssVar('--vh-gap')} focus=${describeEl(doc.activeElement)}`;
  /** 一个元素在屏幕上的位置和可见性：相对可视区的上沿~下沿、高度；藏着记 hid，不在页面里记 none */
  const rectOf = (el: Element | null): string => {
    if (!el) return 'none';
    const r = el.getBoundingClientRect();
    let vis = '';
    try {
      const cs = win.getComputedStyle(el);
      if (cs.visibility === 'hidden') vis = ' hid';
      else if (cs.display === 'none') vis = ' nodisp';
      else if (Number(cs.opacity) === 0) vis = ' op0';
    } catch {
      vis = '';
    }
    const off = vv ? vv.offsetTop : 0;
    return `${Math.round(r.top - off)}~${Math.round(r.bottom - off)}h${Math.round(r.height)}${vis}`;
  };
  /** 焦点所在的浮层（最近的 position: fixed 祖先） */
  const fixedHost = (el: Element | null): Element | null => {
    for (let n = el; n && n !== doc.body; n = n.parentElement) {
      try {
        if (win.getComputedStyle(n).position === 'fixed') return n;
      } catch {
        return null;
      }
    }
    return null;
  };
  const layout = (): string => {
    const parts = LAYOUT_TARGETS.map(([k, sel]) => `${k}=${rectOf(doc.querySelector(sel))}`);
    const act = doc.activeElement;
    if (opensKeyboard(act)) {
      parts.push(`field=${rectOf(act)}`);
      const host = fixedHost(act);
      parts.push(`host=${host ? `${describeEl(host)}:${rectOf(host)}` : 'none'}`);
    }
    return `[${parts.join(' ')}]`;
  };
  const snap = (kind: string): void => add(`${kind} ${vvState()} ${layout()}`);

  let lastVv = '';
  let vvTimer: ReturnType<typeof setTimeout> | undefined;
  const onVv =
    (kind: string) =>
    (): void => {
      clearTimeout(vvTimer);
      vvTimer = setTimeout(() => {
        const s = `${vvState()} ${layout()}`;
        if (s === lastVv) return;
        lastVv = s;
        add(`${kind} ${s}`);
      }, VV_GAP_MS);
    };
  const onVvResize = onVv('vv');
  const onWinResize = onVv('win');
  const onWinScroll = onVv('scroll');
  /** 焦点进来时的滚动位置和可视区偏移：kbcheck 用它们算系统滚了多少文档（dy）、平移了多少可视区（dtop） */
  let focusY = 0;
  let focusTop = 0;
  /**
   * 焦点停稳后一行结论（台账 Q-8）：dy 文档滚了多少、dtop 可视区平移了多少（都是 0 = 系统没动）、top 可视区偏移、
   * dock 浮层下沿离可视区底多远（0～12 = 贴着键盘）、fieldIn 输入框整个在可视区里
   */
  const kbcheck = (): void => {
    const act = doc.activeElement;
    if (!act || !opensKeyboard(act) || !vv) return;
    const top = vv.offsetTop;
    const f = act.getBoundingClientRect();
    const host = fixedHost(act)?.getBoundingClientRect();
    const dock = host ? Math.round(vv.height - (host.bottom - top)) : '-';
    const tail = `top=${Math.round(top)} dock=${dock} fieldIn=${f.top >= top && f.bottom - top <= vv.height ? 1 : 0}`;
    add(`kbcheck dy=${Math.round(win.scrollY - focusY)} dtop=${Math.round(top - focusTop)} ${tail}`);
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
    add(`focusin ${describeEl(e.target)} by=${by}${fieldState(e.target)} ${vvState()} ${layout()}`);
    focusY = win.scrollY;
    focusTop = vv?.offsetTop ?? 0;
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
  const onDown = (e: PointerEvent): void => {
    lastDown = now();
    add(`down ${describeEl(pickTarget(e.target))} ${e.pointerType} x=${Math.round(e.clientX)} y=${Math.round(e.clientY)}`);
  };
  const onUp = (e: PointerEvent): void => add(`up ${describeEl(pickTarget(e.target))} x=${Math.round(e.clientX)} y=${Math.round(e.clientY)}`);
  const onCancel = (e: PointerEvent): void => add(`pointercancel ${describeEl(pickTarget(e.target))}`);
  const onClick = (e: MouseEvent): void => add(`click ${describeEl(pickTarget(e.target))}${e.defaultPrevented ? ' prevented' : ''}`);
  const onKey = (e: KeyboardEvent): void => {
    const name = e.key.length === 1 ? 'char' : e.key;
    let extra = '';
    if (e.key === 'Enter' || e.keyCode === 13) {
      const t = e.target;
      const form = t instanceof Element ? t.closest('form') : null;
      const btn = form?.querySelector<HTMLButtonElement>('button[type="submit"],button:not([type])') ?? null;
      extra = ` form=${describeEl(form)} submitBtn=${btn ? (btn.disabled ? 'disabled' : 'enabled') : 'none'}${fieldState(t)}`;
    }
    add(`key ${name} code=${e.keyCode}${e.isComposing ? ' composing' : ''}${e.defaultPrevented ? ' prevented' : ''} on=${describeEl(e.target)}${extra}`);
  };
  const onBeforeInput = (e: Event): void => {
    const ie = e as InputEvent;
    if (ie.inputType === 'insertText' || ie.inputType === 'insertCompositionText' || ie.inputType === 'deleteContentBackward') return;
    add(`beforeinput ${ie.inputType}${ie.isComposing ? ' composing' : ''} on=${describeEl(e.target)}`);
  };
  const onCompStart = (e: Event): void => add(`composition start on=${describeEl(e.target)}`);
  const onCompEnd = (e: Event): void => add(`composition end on=${describeEl(e.target)}${fieldState(e.target)}`);
  const onSubmit = (e: Event): void => add(`submit ${describeEl(e.target)} by=${describeEl((e as SubmitEvent).submitter)}`);
  const onHash = (): void => {
    add(`route ${win.location.hash || '/'}`);
    settleSnap('route');
  };
  const onVis = (): void => snap(`visibility=${doc.visibilityState}`);
  const onPageShow = (e: PageTransitionEvent): void => snap(`pageshow persisted=${e.persisted}`);
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
          const s = `kbo=${root.hasAttribute('data-kbo') ? 1 : 0} kb=${cssVar('--kb')} gap=${cssVar('--vh-gap')}`;
          if (lastRoot === s) return;
          lastRoot = s;
          add(`root ${s} ${layout()}`);
        })
      : null;
  mo?.observe(root, { attributes: true, attributeFilter: ['data-kbo', 'style'] });

  // console.error / warn
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

  // 业务代码 rlog 记的（下载前排队的补进来，之后直接写）
  const g = globalThis as unknown as Record<string, Slot | undefined>;
  const slot = (g[RL_SLOT] ??= { q: [] });
  for (const [ms, line] of slot.q) push(`${stamp(ms)} app ${line}`);
  slot.q = [];
  slot.sink = (line: string): void => add(`app ${line}`);

  vv?.addEventListener('resize', onVvResize);
  vv?.addEventListener('scroll', onVvResize);
  win.addEventListener('resize', onWinResize);
  win.addEventListener('scroll', onWinScroll, { passive: true });
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('pointerdown', onDown, true);
  doc.addEventListener('pointerup', onUp, true);
  doc.addEventListener('pointercancel', onCancel, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('beforeinput', onBeforeInput, true);
  doc.addEventListener('compositionstart', onCompStart, true);
  doc.addEventListener('compositionend', onCompEnd, true);
  doc.addEventListener('submit', onSubmit, true);
  win.addEventListener('hashchange', onHash);
  doc.addEventListener('visibilitychange', onVis);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('error', onErr);
  win.addEventListener('unhandledrejection', onRej);
  snap('boot');
  settleSnap('boot');
  return () => {
    mo?.disconnect();
    con.error = origErr;
    con.warn = origWarn;
    if (origFetch) win.fetch = origFetch;
    slot.sink = undefined;
    vv?.removeEventListener('resize', onVvResize);
    vv?.removeEventListener('scroll', onVvResize);
    win.removeEventListener('resize', onWinResize);
    win.removeEventListener('scroll', onWinScroll);
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('focusout', onFocusOut);
    doc.removeEventListener('pointerdown', onDown, true);
    doc.removeEventListener('pointerup', onUp, true);
    doc.removeEventListener('pointercancel', onCancel, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('beforeinput', onBeforeInput, true);
    doc.removeEventListener('compositionstart', onCompStart, true);
    doc.removeEventListener('compositionend', onCompEnd, true);
    doc.removeEventListener('submit', onSubmit, true);
    win.removeEventListener('hashchange', onHash);
    doc.removeEventListener('visibilitychange', onVis);
    win.removeEventListener('pageshow', onPageShow);
    win.removeEventListener('error', onErr);
    win.removeEventListener('unhandledrejection', onRej);
    clearTimeout(vvTimer);
    clearTimeout(settleTimer);
    for (const id of kbTimers) clearTimeout(id);
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    save();
  };
}
