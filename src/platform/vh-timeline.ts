// 底栏偏高冷启动时间线（R-371，11-10 主持人批）：5 个探针都改不动 clientHeight（894），要分清“一直挂着的底栏也偏高”还是“只有新挂载时先高后落”，
// 并试“新挂载后补一次滚动”能不能让 iOS 当场摆对。只在非正式版里有：诊断页（VhProbe）的开关在本机存储里放 ARM_KEY，
// 下次冷启动由非正式版的诊断启动件 diag-boot.ts 读开关（timelineArmed），开着才调 startVhTimeline；本模块被 diag-boot 静态引入，
// 跟着 diag-boot 分包走（正式构建整块摇掉，不进首屏），开始记的同时把开关清掉（只跑一次）。
// 记什么：
//   ① 前 DURATION_MS 每 TICK_MS 一行：inner、client、vv、scrollY、底栏下沿（[data-testid="tabbar"] 的 getBoundingClientRect().bottom，没有记 -）、当前路由（hash，id 换成 :id）；
//   ② MutationObserver 盯底栏每次新挂载（开始记时已经挂着的那一个不算），记挂载那一刻和之后 MOUNT_FRAMES 帧的下沿；
//      第 1 次什么都不做（对照），第 2 次 scrollTo(0, scrollY)，第 3 次 scrollBy(0, 1)、下一帧滚回，第 4 次起按这三种循环。
//   ③ 换路由（App 用 pushState / replaceState，不发 hashchange：DOM 变动、resize、每个 tick 都核一次地址）记一行 route->：
//      documentElement.scrollHeight、body.scrollHeight、inner、vv、底栏下沿、挂着的页面（main[data-feature]，切页途中可能两个）；
//   ④ inner 或 vv 一变（resize 事件、DOM 变动、tick 都核）立刻记 vh-change：变前变后、离最近一次换路由过了多少 ms、当时挂着的页面；
//   ⑤ 切到日历后 CAL_WATCH_MS 内按帧记（只记和上一帧不一样的）：日历页根（main[data-feature="calendar"]）和翻页容器（cal-pager）
//      的高、scrollHeight、transform、overflow-y，加文档高（11-10 复审实测：月视图文档 940，今天页 895、触屏 896；切日历时把哪一步算进去，看这里）。
//   （原来的第 ⑥ 项焦点、vv.offsetTop、vv.scale 11-12 删掉：全局运行日志 run-log.ts 一直在记这几样）
// 结果是纯文字，存在 OUT_KEY（隔几秒存一次、结束和切到后台时也存），诊断页显示、可整段复制给主持人。
// requestAnimationFrame 只许 src/motion 用（A25）：等帧的函数由调用方传进来（main.tsx 传 motion 的 nextFrame）
import { BAR_SELECTOR } from './run-log-api.ts';

export const ARM_KEY = "lemo-vh-tl";
export const OUT_KEY = "lemo-vh-tl-out";
export const TICK_MS = 250;
export const DURATION_MS = 180_000;
export const SAVE_MS = 2000;
export const MOUNT_FRAMES = 10;
/** 切到日历后按帧盯多久 */
export const CAL_WATCH_MS = 2000;
export const CAL_ROOT = 'main[data-feature="calendar"]';
export const CAL_PAGER = '[data-testid="cal-pager"]';

/** 新挂载时的三种做法，按挂载次序循环 */
export const MOUNT_ACTS = ["none", "scrollTo", "scrollBy1"] as const;
export type MountAct = (typeof MOUNT_ACTS)[number];

export type Frame = (cb: () => void) => unknown;

/** 诊断页的开关：开着（下次冷启动记一次）没有 */
export function timelineArmed(store: Storage = localStorage): boolean {
  try {
    return store.getItem(ARM_KEY) === "1";
  } catch {
    return false;
  }
}

export function setTimelineArmed(
  on: boolean,
  store: Storage = localStorage,
): void {
  try {
    if (on) store.setItem(ARM_KEY, "1");
    else store.removeItem(ARM_KEY);
  } catch {
    // 本机存储用不了：开关不生效，诊断页按钮照样显示 OFF
  }
}

/** 上一次记下的时间线；没有是空串 */
export function readTimeline(store: Storage = localStorage): string {
  try {
    return store.getItem(OUT_KEY) ?? "";
  } catch {
    return "";
  }
}

const barBottom = (win: Window): string => {
  const el = win.document.querySelector(BAR_SELECTOR);
  return el ? String(Math.round(el.getBoundingClientRect().bottom)) : "-";
};

/** 路由只留形状（代码审 S3）：路径里的 id（uuid，或 16 位以上带数字的段）换成 :id；空的写 # */
export function routeShape(hash: string): string {
  if (!hash) return "#";
  return hash
    .split("/")
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || (seg.length >= 16 && /\d/.test(seg)) ? ":id" : seg,
    )
    .join("/");
}

/** 一行数：inner、client、vv、scrollY、底栏下沿、路由 */
export function sampleLine(win: Window): string {
  const vv = win.visualViewport ? Math.round(win.visualViewport.height) : "-";
  return `inner=${win.innerHeight} client=${win.document.documentElement.clientHeight} vv=${vv} y=${Math.round(win.scrollY)} bar=${barBottom(win)} route=${routeShape(win.location.hash)}`;
}

/** 挂着的页面：main[data-feature]，切页途中新旧两个都在时用 + 连起来；没有写 - */
export function pagesOf(doc: Document): string {
  return Array.from(doc.querySelectorAll("main[data-feature]"), (m) => m.getAttribute("data-feature") ?? "?").join("+") || "-";
}

const vvOf = (win: Window): number | "-" => (win.visualViewport ? Math.round(win.visualViewport.height) : "-");

/** 换路由那一行的数：文档高、body 高、inner、vv、底栏下沿、挂着的页面 */
export function routeLine(win: Window): string {
  const d = win.document;
  return `docH=${d.documentElement.scrollHeight} bodyH=${d.body.scrollHeight} inner=${win.innerHeight} vv=${vvOf(win)} bar=${barBottom(win)} page=${pagesOf(d)}`;
}

/** 日历页一帧的样子：根和翻页容器各自的高、scrollHeight、transform、overflow-y，加文档高；不在写 - */
export function calSig(win: Window): string {
  const d = win.document;
  const one = (name: string, sel: string): string => {
    const el = d.querySelector(sel);
    if (!el) return `${name}=-`;
    const cs = win.getComputedStyle(el);
    return `${name}=h${Math.round(el.getBoundingClientRect().height)}/sh${el.scrollHeight}/tf:${cs.transform}/ov:${cs.overflowY}`;
  };
  return `${one("root", CAL_ROOT)} ${one("pager", CAL_PAGER)} docH=${d.documentElement.scrollHeight}`;
}

/** 新挂载后做的那一下：label 写进结果；back 是下一帧要做的“滚回去”（只有 scrollBy1 有） */
export function applyMountAct(
  act: MountAct,
  win: Window,
): { label: string; back?: () => void } {
  const y = Math.round(win.scrollY);
  if (act === "scrollTo") win.scrollTo(0, y);
  if (act !== "scrollBy1") return { label: `${act}(y=${y})` };
  win.scrollBy(0, 1);
  return { label: `${act}(y=${y})`, back: () => win.scrollTo(0, y) };
}

export interface TimelineDeps {
  readonly win?: Window;
  readonly store?: Storage;
  readonly now?: () => number;
}

/** 开始记（diag-boot.ts 在冷启动、开关开着时调一次，frame 是 main.tsx 传给 diag-boot 的 nextFrame）；返回停止函数（测试用，到时自己也会停） */
export function startVhTimeline(
  frame: Frame,
  deps: TimelineDeps = {},
): () => void {
  const win = deps.win ?? window;
  const store = deps.store ?? localStorage;
  const now = deps.now ?? (() => Date.now());
  // 只跑一次：一开始就关掉开关（中途 App 被划掉也不会下次再记）
  setTimelineArmed(false, store);
  const t0 = now();
  const sec = (): string => ((now() - t0) / 1000).toFixed(2);
  const lines: string[] = [
    `vh-timeline start=${new Date(t0).toISOString()} screen=${win.screen.width}x${win.screen.height} tick=${TICK_MS}ms dur=${DURATION_MS / 1000}s`,
    `ua=${win.navigator.userAgent}`,
  ];
  const save = (): void => {
    try {
      store.setItem(OUT_KEY, lines.join("\n"));
    } catch {
      // 存不下（满了）：内存里的照样记，下次存时再试
    }
  };
  let done = false;
  let mounts = 0;
  let lastBar: Element | null = win.document.querySelector(BAR_SELECTOR);
  lines.push(
    `t=${sec()} initial-bar=${lastBar ? "yes" : "no"} ${sampleLine(win)}`,
  );

  const onMount = (el: Element): void => {
    const n = mounts++;
    const act = MOUNT_ACTS[n % MOUNT_ACTS.length] ?? "none";
    const at = sec();
    const head = `t=${at} mount#${n + 1} ${sampleLine(win)}`;
    const f0 = Math.round(el.getBoundingClientRect().bottom);
    const did = applyMountAct(act, win);
    const frames: number[] = [];
    const step = (): void => {
      frames.push(
        el.isConnected ? Math.round(el.getBoundingClientRect().bottom) : -1,
      );
      // scrollBy1：第一帧记完再滚回原处
      if (frames.length === 1) did.back?.();
      if (frames.length < MOUNT_FRAMES && !done) {
        frame(step);
        return;
      }
      lines.push(
        `${head} act=${did.label} f0=${f0} frames=${frames.join(",")}`,
      );
      save();
    };
    frame(step);
  };

  // ③④⑤ 换路由、可见高度变化、切到日历后按帧记
  let route = routeShape(win.location.hash);
  let routeAt = t0;
  let routes = 0;
  let inner = win.innerHeight;
  let vv = vvOf(win);
  let calUntil = 0;
  let calLast = "";
  const calStep = (): void => {
    if (done || now() > calUntil) return;
    const sig = calSig(win);
    if (sig !== calLast) {
      calLast = sig;
      lines.push(`t=${sec()} cal +${now() - routeAt}ms ${sig}`);
    }
    frame(calStep);
  };
  const watchCal = (): void => {
    const running = now() <= calUntil;
    calUntil = now() + CAL_WATCH_MS;
    calLast = "";
    if (!running) frame(calStep);
  };
  const check = (): void => {
    if (done) return;
    const r = routeShape(win.location.hash);
    if (r !== route) {
      lines.push(`t=${sec()} route-> ${r} (from ${route}) ${routeLine(win)}`);
      route = r;
      routeAt = now();
      routes += 1;
      if (r.startsWith("#/calendar")) watchCal();
    }
    const i = win.innerHeight;
    const v = vvOf(win);
    if (i !== inner || v !== vv) {
      lines.push(`t=${sec()} vh-change inner=${inner}->${i} vv=${vv}->${v} since-${routes > 0 ? "route" : "start"}=${now() - routeAt}ms route=${route} page=${pagesOf(win.document)} bar=${barBottom(win)}`);
      inner = i;
      vv = v;
      save();
    }
  };
  lines.push(`t=${sec()} route= ${route} ${routeLine(win)}`);
  if (route.startsWith("#/calendar")) watchCal();
  win.addEventListener("resize", check);
  win.visualViewport?.addEventListener("resize", check);

  const mo = new MutationObserver(() => {
    check();
    const el = win.document.querySelector(BAR_SELECTOR);
    if (el === lastBar) return;
    lastBar = el;
    if (el) onMount(el);
  });
  mo.observe(win.document.body, { childList: true, subtree: true });

  // 停止、存盘都按经过的时间算（代码审 S1）：iOS 切到后台时定时器会停，数跳了几次会拖过 3 分钟
  let lastSave = t0;
  const timer = win.setInterval(() => {
    check();
    lines.push(`t=${sec()} ${sampleLine(win)}`);
    const at = now();
    if (at - t0 >= DURATION_MS) {
      stop();
      return;
    }
    if (at - lastSave >= SAVE_MS) {
      lastSave = at;
      save();
    }
  }, TICK_MS);
  const onHide = (): void => {
    if (win.document.visibilityState === "hidden") {
      lines.push(`t=${sec()} hidden`);
      save();
    } else lines.push(`t=${sec()} visible ${sampleLine(win)}`);
  };
  win.document.addEventListener("visibilitychange", onHide);

  function stop(): void {
    if (done) return;
    done = true;
    win.clearInterval(timer);
    mo.disconnect();
    win.removeEventListener("resize", check);
    win.visualViewport?.removeEventListener("resize", check);
    win.document.removeEventListener("visibilitychange", onHide);
    lines.push(`t=${sec()} end mounts=${mounts} routes=${routes}`);
    save();
  }
  save();
  return stop;
}
