// 启动时盯住底部安全区（G10，11-06 负责人：“刚打开的时候导航栏自己跑上面去”，主屏幕图标冷启动）
// • 原因（约 70% 把握）：iOS 主屏幕版冷启动时 env(safe-area-inset-bottom) 先给 0、过一会儿才给 34，底栏、“＋”、实色带跟着上跳 34pt
// • 做法（主持人 11-06）：底栏、“＋”、实色带都用 base.css 的 --inset-bottom（= env(safe-area-inset-bottom)）；
//   启动时 <html> 带 data-inset-wait，这三样先不显示（opacity 0），值稳定了去掉这个属性，三样一起淡入（不用位移动画）。
//   不用 max(…, 34px) 硬兜底：没有 Home 横条的机型安全区本来就是 0
// • 默认是显示的：只有这里挂上了才藏，画完后最多藏 INSET_MAX_MS（读不到、出错、别的入口、测试都不会一直看不见）
// • 计时从“首屏画完”算（入口在 first-paint 画完时调 markInsetPainted）：底栏跟着第一个页面一起出来，无头 webkit 实测要 2 秒多，
//   从脚本启动算的话底栏还没出来就放行了。没调 markInsetPainted 时 INSET_BACKSTOP_MS 兜底放行
// • “稳定”：画完以后，安全区底部和 innerHeight 都 INSET_QUIET_MS 没变；主屏幕版（standalone）读到 0 时多等到画完后 INSET_ZERO_WAIT_MS
//   （0 可能是还没给真值；没有 Home 横条的机型就是多等这一会儿再淡入）。读到非 0 只等 INSET_QUIET_MS
// • 时间线：每次安全区底部或 innerHeight 变了记一条（从页面导航开始算的毫秒），设置 › 关于的诊断里显示（diag-info.ts）。
//   挂上后每 INSET_POLL_MS 读一次（env 变了没有事件），放行了、或者挂上超过 INSET_BACKSTOP_MS 就不再按这个频率排（代码审查 11-06：首屏一直没画完时
//   原来会一直轮询）。放行以后只给时间线再低频读：每 INSET_LATE_POLL_MS 一次，读到画完后 INSET_LATE_LOG_MS（总时长仍不超过挂上后 INSET_BACKSTOP_MS），
//   “放行以后 iOS 才给出 34”也能在设置 › 关于的 launch 一行里看到（主持人 11-07）；只记、不再改底栏的显示。之后只靠 resize 事件记，最多记 INSET_MAX_ROWS 条
// • requestAnimationFrame 只许 src/motion 用（A25），这里用 setTimeout

export const INSET_QUIET_MS = 120;
export const INSET_ZERO_WAIT_MS = 600;
export const INSET_MAX_MS = 1500;
export const INSET_BACKSTOP_MS = 8000;
export const INSET_POLL_MS = 40;
/** 放行以后时间线低频再读的间隔、读到画完后多久（诊断用，不影响底栏显示） */
export const INSET_LATE_POLL_MS = 250;
export const INSET_LATE_LOG_MS = 3000;
export const INSET_MAX_ROWS = 30;
/** <html> 上的属性：带着它时底栏、“＋”、实色带不显示（GlassBar.module.css、GlassBarFx.module.css） */
export const INSET_WAIT_ATTR = 'data-inset-wait';

export interface InsetRow {
  /** 从页面导航开始算的毫秒 */
  readonly t: number;
  /** 安全区底部的计算值（如 '34px'） */
  readonly env: string;
  readonly inner: number;
}

export interface InsetTimeline {
  readonly rows: readonly InsetRow[];
  /** 什么时候算稳定、开始淡入（毫秒）；还没到是 null */
  readonly readyAt: number | null;
  /** 首屏画完的时刻（毫秒）；还没画完是 null */
  readonly paintedAt: number | null;
  /** 为什么放行：quiet（稳定了）、max（到了最长时限）、off（没挂） */
  readonly reason: 'quiet' | 'max' | 'off' | null;
  readonly standalone: boolean;
}

export interface InsetEnv {
  readonly win?: Window;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (id: unknown) => void;
}

let timeline: { rows: InsetRow[]; readyAt: number | null; paintedAt: number | null; reason: InsetTimeline['reason']; standalone: boolean } = {
  rows: [],
  readyAt: null,
  paintedAt: null,
  reason: 'off',
  standalone: false,
};
let stop: (() => void) | null = null;
let painted: (() => void) | null = null;

function isStandalone(win: Window): boolean {
  try {
    if ((win.navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
    return win.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

/**
 * 启动时挂一次（入口 main.tsx 在 render 之前调）。重复调用不再挂。返回取消函数（测试用：停计时、去掉属性）
 */
export function watchInsetBottom(env: InsetEnv = {}): () => void {
  if (stop) return stop;
  const win = env.win ?? window;
  const now = env.now ?? (() => win.performance.now());
  const setTimer = env.setTimer ?? ((fn: () => void, ms: number) => win.setTimeout(fn, ms));
  const clearTimer = env.clearTimer ?? ((id: unknown) => win.clearTimeout(id as number));
  const doc = win.document;
  const root = doc.documentElement;
  const standalone = isStandalone(win);
  timeline = { rows: [], readyAt: null, paintedAt: null, reason: null, standalone };

  // 隐藏探针：padding-bottom 跟着 --inset-bottom（不直接写 env：和底栏用同一个变量，读到的就是底栏用的）
  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  for (const [k, v] of [
    ['position', 'fixed'],
    ['left', '0'],
    ['bottom', '0'],
    ['width', '0'],
    ['height', '0'],
    ['visibility', 'hidden'],
    ['pointer-events', 'none'],
    ['padding-bottom', 'var(--inset-bottom, env(safe-area-inset-bottom))'],
  ] as const)
    probe.style.setProperty(k, v);
  (doc.body ?? root).append(probe);

  let paintedAt: number | null = null;
  const t0 = now();
  let lastChange = t0;
  let poll: unknown = null;
  let cap: unknown = null;
  let done = false;

  const read = (): InsetRow => {
    let envV = '?';
    try {
      envV = win.getComputedStyle(probe).paddingBottom || '?';
    } catch {
      envV = '?';
    }
    return { t: Math.round(now()), env: envV, inner: win.innerHeight };
  };

  const release = (reason: 'quiet' | 'max'): void => {
    if (timeline.readyAt !== null) return;
    timeline.readyAt = Math.round(now());
    timeline.reason = reason;
    root.removeAttribute(INSET_WAIT_ATTR);
    if (cap !== null) clearTimer(cap);
    cap = null;
    // 放行以后不再按 INSET_POLL_MS 轮询（tick 里也不会再排）；时间线改成低频读到画完后 INSET_LATE_LOG_MS
    if (poll !== null) clearTimer(poll);
    poll = null;
    lateUntil = Math.min(t0 + INSET_BACKSTOP_MS, (paintedAt ?? now()) + INSET_LATE_LOG_MS);
    lateTick(false);
  };

  // 放行以后：只记时间线，到 lateUntil 为止
  let lateUntil = 0;
  const lateTick = (read: boolean): void => {
    poll = null;
    if (done) return;
    if (read) check();
    const left = lateUntil - now();
    if (left > 0) poll = setTimer(() => lateTick(true), Math.min(INSET_LATE_POLL_MS, left));
  };

  const check = (): void => {
    if (done) return;
    const r = read();
    const last = timeline.rows[timeline.rows.length - 1];
    if (!last || last.env !== r.env || last.inner !== r.inner) {
      if (timeline.rows.length < INSET_MAX_ROWS) timeline.rows.push(r);
      lastChange = now();
    }
    if (timeline.readyAt === null && paintedAt !== null) {
      const t = now();
      const zero = r.env === '0px';
      const quiet = t - Math.max(lastChange, paintedAt) >= INSET_QUIET_MS;
      if (quiet && (!zero || !standalone || t - paintedAt >= INSET_ZERO_WAIT_MS)) release('quiet');
    }
  };

  const tick = (): void => {
    poll = null;
    check();
    if (!done && timeline.readyAt === null && now() - t0 < INSET_BACKSTOP_MS) poll = setTimer(tick, INSET_POLL_MS);
  };

  const setCap = (ms: number): void => {
    if (cap !== null) clearTimer(cap);
    cap = setTimer(() => {
      cap = null;
      check();
      release('max');
    }, ms);
  };

  root.setAttribute(INSET_WAIT_ATTR, '');
  setCap(INSET_BACKSTOP_MS);
  painted = () => {
    if (paintedAt !== null || done) return;
    paintedAt = now();
    timeline.paintedAt = Math.round(paintedAt);
    if (timeline.readyAt !== null) return;
    setCap(INSET_MAX_MS);
    check();
  };
  const onResize = (): void => check();
  win.addEventListener('resize', onResize);
  win.visualViewport?.addEventListener('resize', onResize);
  check();
  poll = setTimer(tick, INSET_POLL_MS);

  stop = () => {
    done = true;
    if (poll !== null) clearTimer(poll);
    if (cap !== null) clearTimer(cap);
    poll = null;
    cap = null;
    win.removeEventListener('resize', onResize);
    win.visualViewport?.removeEventListener('resize', onResize);
    probe.remove();
    root.removeAttribute(INSET_WAIT_ATTR);
    stop = null;
    painted = null;
  };
  return stop;
}

/** 首屏画完了（入口用 first-paint 的 afterAppPainted 调）：从这时起算“稳定”和最长时限。没挂 watchInsetBottom 时什么都不做 */
export function markInsetPainted(): void {
  painted?.();
}

/** 启动时间线（诊断用）：没挂过时 reason 是 off、rows 为空 */
export function insetTimeline(): InsetTimeline {
  return { rows: [...timeline.rows], readyAt: timeline.readyAt, paintedAt: timeline.paintedAt, reason: timeline.reason, standalone: timeline.standalone };
}
