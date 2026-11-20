// 页面切换的三种动法（11-18 独立评审后从 index.ts 拆出来整块重写，不再在原代码上叠补丁）：
// • fadeSwap：底栏四个页签互切，和日历翻月同一份原地模糊淡换（blur-swap.ts；负责人 11-18“做成一模一样的动效”）
// • growSwap：打字条点“详细”，那张卡长成新建页（负责人 11-18“用A整页成长方案”）
// • transition：点进下一页、返回（今天 ↔ 编辑页、设置……），新页从右边滑进来盖住、返回反过来（负责人 11-20 选“新页从右滑进盖住”）。
//   11-20 起不再用浏览器的 View Transition（负责人 11-20 录屏“进入2级页后退出的时候底部导航栏会模糊一下”：过渡里底栏是截图、拍不到后面的内容，
//   过渡一结束真底栏露出来，模糊突然出现）：和上面两种同一套引擎，底栏、“＋”从头到尾是真元素、一直实时模糊
// 首屏画完以后才下载（motion/index.ts 的 loadPageSwap，main.tsx 和动画实现同一时机；11-18 ci 首屏预算 151.7 KB 超线后挪出首屏）；
// 首屏要用的常量和“新页显示出来没有”的判断在 ./page-shown.ts。
// 三种共用：旧页快照（makeGhost）、等新页出来（waitDom）、换页后吞点按（guardTaps）、一份“正在播”的状态（cur）和一个收尾（endSwap）
import { copyNode } from './copy-node.ts';
import { blurSwapIn, blurSwapOut, blurSwapTiming } from './blur-swap.ts';
import { FADE_GUARD_MS, FADE_WAIT_MS, GROW_HOLD, pageVisible, shownMain, waitDom } from './page-shown.ts';
import { prefersReducedMotion } from './reduced.ts';
import { guardWindow, swallowNextClick } from './swallow-click.ts';
import { bezierCss, dur, ease } from './tokens.ts';

/** 整页推页最多等新页画完多久再动（屏幕这段时间停在旧页上，太长像卡住） */
export const PAGE_WAIT_MS = 300;
/**
 * 页面级懒加载块还没出来时，它的 Suspense 占位上打的标记（kit 的 PagePending 画一个隐藏的 <i data-page-pending>）。
 * App 的页面那层、设置二级页那层用它（独立评审 11-20 第 2 条：设置二级页外层 main 先在、里面一层懒加载还空着，只看 main 会当场放行）
 */
const PENDING_SEL = '[data-page-pending]';
/** 底栏 nav 和“＋”（GlassBar 打 data-swap-bar）：整页推页时只有一边有，就跟着那一页动（真元素，或旧页的真 DOM 副本） */
const BAR_ATTR = 'data-swap-bar';
/** 旧页底栏、“＋”的副本（挂在 body 下） */
const BAR_COPY_ATTR = 'data-swap-bar-copy';
const shownBars = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[${BAR_ATTR}]`)].filter((e) => e.getClientRects().length > 0);
/**
 * 装整个 app 的那一层里、main 外面的 fixed 层（底栏实色带、上沿渐隐、“＋”上方的提示气泡、版本横幅……）：
 * 原来 View Transition 时它们都在整页快照里、跟着整页一起滑，这里照样当成页面的一部分。不往 fixed 层里面找；底栏、“＋”另算
 */
function fixedOutside(main: Element): HTMLElement[] {
  const app = main.closest('body > *');
  const out: HTMLElement[] = [];
  const walk = (el: Element): void => {
    for (const c of el.children) {
      if (c === main || c.hasAttribute(BAR_ATTR)) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none') continue;
      if (cs.position !== 'fixed') walk(c);
      else if (c instanceof HTMLElement && c.getClientRects().length > 0) out.push(c);
    }
  };
  if (app && app !== main) walk(app);
  return out;
}

/** 页面底色（同 base.css 的 body::after）：长成时新建页 main 和遮罩画这个，长出来的是一整张页面 */
const PAGE_BG = 'var(--scr-bg, var(--bg))';

const noop = (): void => undefined;
const px = (x: number): string => (x === 0 ? 'none' : `translateX(${Math.round(x * 100) / 100}px)`);

/**
 * 吞掉 ms 以内落在 main 里的 pointerdown、click（swallow-click.ts 的 guardWindow，document 捕获阶段）；返回摘掉监听的函数。
 * 窗口里吞掉了 pointerdown 时，跟着的那次 click 晚到窗口外也吞：交给 swallowNextClick（最多等 TAP_SWALLOW_MS，从按下算；
 * 新的一次按下、被吞的按下变成滚动就不再等，代码审查 S12）；窗口到了只摘窗口本身，晚到的那一下还由 late 等着。吞用 stopImmediatePropagation；
 * 键盘的 click（窗口里先有 keydown）不是手指点在旧画面上，不吞（R-420 审查第 13 条）
 */
function guardTaps(ms: number): () => void {
  let late: (() => void) | null = null;
  const stop = guardWindow({
    ms,
    types: ['pointerdown', 'click'],
    keyboard: 'keydown',
    within: (e) => (e.target instanceof Element ? e.target.closest('main') : null),
    eat: (e, main) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'pointerdown') return;
      late?.();
      late = swallowNextClick({ within: main });
    },
  });
  return () => {
    stop();
    late?.();
  };
}
let guardStop: (() => void) | null = null;
function guardAgain(): void {
  guardStop?.();
  guardStop = guardTaps(FADE_GUARD_MS);
}

/**
 * 页签互切时钉在原处不动的元素（负责人 11-18 录屏“切页的时候头像抖动”“头像怎么也还是会消失”：右上角设置头像 MeLink 四页在同一处）。
 * 11-19 整块重写（原来新页的头像整段切页透明、由副本代画、收尾再交接；连点时下一次的副本抄到了那条透明，整段切页头像没了）：
 * • 新页里的头像从头到尾是真元素、全亮：淡入的透明度和模糊只加在不含它的子树上（fadeTargets），它自己不动、不藏、不交接；
 * • 旧页快照里的藏掉，另拍一份静态副本钉在原处，只管新页出来之前那一段（等分包、Suspense 把旧页藏起来）；新页出来那一刻拿掉；
 * • 新页里没有（电脑版藏了头像）时，副本跟着快照一起淡出
 */
const SWAP_PIN = 'data-swap-pin';
const PIN_SEL = `[${SWAP_PIN}]`;
const shownPins = (root: Element): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(PIN_SEL)].filter((e) => e.getBoundingClientRect().width > 0);

interface Ghost {
  box: HTMLElement;
  /** 钉住不动的那几个的副本（一层视口大小的 fixed 框，排在快照后面）；旧页里没有就是 null */
  pins: HTMLElement | null;
  /**
   * 整页推页：旧页底栏、“＋”的真 DOM 副本（不是截图），直接挂在 body 下、按自己的类名定位和分层（--z-bar），
   * 祖先里没有背景根，backdrop-filter 照样实时模糊后面的内容。别的换页没有
   */
  bars: HTMLElement[];
  /** 显示出来（换页前先藏着放好，旧页一卸掉就显示，不露空白），并抄回滚动位置 */
  show: () => void;
}

/** 钉住的副本：按各自此刻在屏幕上的位置摆；摆不出来（没有大小）的不要 */
function makePins(main: Element): HTMLElement | null {
  const els = shownPins(main);
  if (els.length === 0) return null;
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.dataset.tabPin = '';
  box.inert = true;
  box.style.cssText = 'position:fixed;inset:0;overflow:hidden;pointer-events:none;visibility:hidden';
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const c = copyNode(el);
    if (!(c instanceof HTMLElement)) continue;
    c.style.cssText += `;position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;box-sizing:border-box`;
    box.append(c);
  }
  return box;
}

/**
 * 旧页快照：换页前把旧 main 深拷一份，盖在页面那一层、不接点按、读屏不念；外面包一层视口大小的 fixed 框（overflow 裁掉），
 * 里面的拷贝按旧页当时的位置摆（滚动过的照样对得上）；去掉 id、data-testid、data-feature，不和新页重名。
 * 外壳不用 <main>：页面上 querySelector('main') 只该找到真页面。抄的时候出任何错就不要快照（直接换页，不卡住换页）。
 * page（整页推页）：外框画页面底色（整张旧页一起滑，不透出下面）；main 外面跟页面一起动的 fixed 层（底栏实色带、上沿渐隐）也抄进外框，
 * 外框和视口一样大，它们按外框定位、位置不变；底栏、“＋”另抄一份放在 bars
 */
function makeGhost(main: Element, pin: boolean, page = false): Ghost | null {
  if (!(main instanceof HTMLElement)) return null;
  try {
    const r = main.getBoundingClientRect();
    const scrolled: [Element, Element][] = [];
    const pins = pin ? makePins(main) : null;
    const bars = page ? shownBars().map((b) => copyNode(b, { strip: [BAR_ATTR] })) : [];
    for (const b of bars) {
      b.setAttribute(BAR_COPY_ATTR, '');
      b.setAttribute('aria-hidden', 'true');
      b.inert = true;
      b.style.setProperty('visibility', 'hidden');
    }
    // 静态副本走 motion 共用的 copyNode（评审第 6、9 条：不抄 style 属性、不抄视频画布）；外壳用 div，去掉 data-feature
    const copy = copyNode(main, { tag: 'div', strip: ['data-feature'], onScrolled: (a, b) => scrolled.push([a, b]) });
    // 钉住的那几个由 pins 画，快照里的藏掉
    if (pins) for (const e of copy.querySelectorAll<HTMLElement>(PIN_SEL)) e.style.setProperty('visibility', 'hidden');
    // 连点时旧页可能正被 Suspense 内联 display: none 藏着（画面上是上一次的快照）：拷贝不带这条，不然快照整张看不见（复审第 2 条）
    copy.style.removeProperty('display');
    copy.style.cssText += `;position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;margin:0`;
    const box = document.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    box.dataset.tabGhost = '';
    box.inert = true;
    box.style.cssText = 'position:fixed;inset:0;overflow:hidden;pointer-events:none;visibility:hidden';
    if (page) box.style.setProperty('background', PAGE_BG);
    box.append(copy);
    if (page) for (const e of fixedOutside(main)) box.append(copyNode(e));
    const pos = scrolled.map(([s, c]) => [c, s.scrollTop, s.scrollLeft] as const);
    let shown = false;
    const show = (): void => {
      if (shown) return;
      shown = true;
      box.style.removeProperty('visibility');
      pins?.style.removeProperty('visibility');
      for (const b of bars) b.style.removeProperty('visibility');
      for (const [c, top, left] of pos) {
        c.scrollTop = top;
        c.scrollLeft = left;
      }
    };
    return { box, pins, bars, show };
  } catch {
    return null;
  }
}

/**
 * 新页淡入加在哪些元素上。main 里没有 position: fixed 的元素、也没有钉住的头像时就是 main 自己（parts = [main]）；
 * 有的话只加在“不含它们的最大子树”上（parts：透明度 + 模糊）：
 * • fixed 的（随手记贴底的输入行、页底提示条）：祖先带 filter 会让它们改按祖先定位、过渡期间错位，只给它们自己加透明度（fixed）；
 * • 钉住的头像：祖先带透明度它就跟着淡，所以它和祖先都不加，从头到尾全亮（见 SWAP_PIN）
 */
function fadeTargets(main: Element, pins: readonly Element[]): { parts: Element[]; fixed: Element[] } {
  const isFixed = (el: Element): boolean => getComputedStyle(el).position === 'fixed';
  const keep = new Set<Element>(pins);
  const tainted = new Set<Element>();
  const mark = (el: Element): void => {
    for (let e: Element | null = el; e !== null && e !== main; e = e.parentElement) tainted.add(e);
  };
  for (const el of main.querySelectorAll('*')) if (isFixed(el)) mark(el);
  for (const el of pins) mark(el);
  if (tainted.size === 0) return { parts: [main], fixed: [] };
  const parts: Element[] = [];
  const fixed: Element[] = [];
  const walk = (el: Element): void => {
    for (const c of el.children) {
      if (keep.has(c)) continue;
      if (!tainted.has(c)) parts.push(c);
      else if (isFixed(c)) fixed.push(c);
      else walk(c);
    }
  };
  walk(main);
  return { parts, fixed };
}

interface Look {
  x: number;
  opacity: number;
}
const STILL: Look = { x: 0, opacity: 1 };

/** slide 页签互切；grow “详细”长成；push 点进下一页；pop 返回 */
type Kind = 'slide' | 'grow' | 'push' | 'pop';

/** 一次换页的全部状态：取消、放完、等不到新页、出错都走 endSwap，只收一次尾 */
interface Swap {
  kind: Kind;
  ghost: Ghost | null;
  /** 这次另外加进页面的层（整页推页时新页下面垫的页面底色），收尾时拿掉 */
  extra: Element[];
  /** 第一个是领头的那个（读进度、等它放完） */
  anims: Animation[];
  /** 新页此刻的平移（px）和透明度；连点时下一次的快照从这里起 */
  look: () => Look;
  /** 这次的快照从什么样子起（上一次没放完时是上一页此刻的样子，代码审查 M1） */
  start: Look;
  /** 收尾时同步调（growSwap 在这里还原新页 main 的临时样式、拿掉遮罩，并告诉调用方长完了） */
  onEnd: () => void;
  stopWait: () => void;
  resolve: () => void;
  done: boolean;
}
let cur: Swap | null = null;

function endSwap(s: Swap): void {
  if (s.done) return;
  s.done = true;
  if (cur === s) cur = null;
  s.stopWait();
  try {
    s.onEnd();
  } finally {
    for (const a of s.anims) a.cancel();
    s.ghost?.box.remove();
    s.ghost?.pins?.remove();
    for (const e of [...(s.ghost?.bars ?? []), ...s.extra]) e.remove();
    s.resolve();
  }
}

function track(s: Swap, a: Animation): Animation {
  s.anims.push(a);
  // 取消时 finished 会被拒，这里接住
  a.finished.catch(noop);
  return a;
}

/**
 * 停掉页面切换（代码审查方案 B M9）：换页后吞点按的窗口、还在等新页的那次（连快照一起拿掉）；anim 为 true 时连正在播的也停（还原成静止的新页）。
 * 整页推页开头调（motion/index.ts 的 transition：上一次没放完的先收成静止的新页，再拷这一次的旧页）；路由同页内切换调 cancelFade(false)：只停等待，不打断正在播的
 */
export function cancelFade(anim = true): void {
  guardStop?.();
  guardStop = null;
  if (cur && (anim || cur.anims.length === 0)) endSwap(cur);
}

/** 等不到新页（FADE_WAIT_MS）以后快照还留多久：新页再晚也不露空白，直到它出来或下一次导航（复审第 4 条）；这么久还没出来才拿掉 */
const GHOST_KEEP_MS = 30_000;

/**
 * 几种换页共用的流程：换页前拷旧页快照、藏着放在整个 app 前面（旧页卸掉或被 Suspense 藏起来就显示，分包晚到也不露空白）；update 换页；
 * 等换上来的新 main（不是换页前那个、而且显示着）出来，显示快照、调 play 起动画；领头的动画放完收尾。
 * FADE_WAIT_MS 内等不到：不放动画，快照留着等新页出来（最多 GHOST_KEEP_MS）；被 cancelFade 停掉、play 或 settle 出错都直接收尾。
 * 整页推页（push、pop）另有三处不同：快照换页后当场显示、新页先藏着点按吞掉（holdScreen），等的是“新页画完”（懒加载块也到了），最多 PAGE_WAIT_MS，
 * 到点 main 在就照常动。
 * 减少动态效果时只换页、不留快照。
 * 换页后 FADE_GUARD_MS 以内落在 main 里的点按吞掉（M8），分包晚到时从新页出来那一刻重新算。
 * 返回的 Promise 在收尾时 resolve
 */
function swap(
  kind: Kind,
  update: () => void,
  play: (el: HTMLElement, s: Swap) => void,
  settle?: (s: Swap, end: () => void) => void,
  onEnd: () => void = noop,
  /** 等不到新页（FADE_WAIT_MS）时当场调：快照照样留着等新页，但调用方该收的先收（growSwap 先收打字条，评审中⑥：不卡最多 GHOST_KEEP_MS） */
  onLate: () => void = noop,
): Promise<void> {
  if (typeof document === 'undefined') {
    update();
    onEnd();
    return Promise.resolve();
  }
  // 显示着的页找不到时（连点、上一次的新页分包还没到）就是那个被 Suspense 藏着的旧页（复审第 2 条）
  const shown = shownMain();
  const before = shown ?? document.querySelector('main');
  const reduced = prefersReducedMotion();
  // 上一次页签互切还在等新页（画面上是它的快照和钉住的头像）时又切：接着用那一份，不重拷。
  // 藏着的旧页量不出位置（宽 0），拷出来整页挤成一条、头像跑到左边（11-19 连点实时逐帧：x 370 → 44），钉住的头像也拍不出来
  const prev = !reduced && shown === null && kind === 'slide' && cur?.kind === 'slide' && cur.anims.length === 0 ? cur : null;
  const kept = prev?.ghost ?? null;
  if (prev) prev.ghost = null;
  const ghost = kept ?? (before && !reduced ? makeGhost(before, kind === 'slide', kind === 'push' || kind === 'pop') : null);
  // 上一次页签互切放完以前：快照从它此刻的样子起，不是全亮（代码审查 M1）；接着用的那一份照旧
  const start = prev ? prev.start : cur?.kind === 'slide' && cur.anims.length ? cur.look() : STILL;
  cancelFade();
  // 装整个 app 的那一层（body 下面那一个）
  const app = before?.closest<HTMLElement>('body > *') ?? before;
  if (ghost && !kept) {
    ghost.box.style.opacity = String(start.opacity);
    ghost.box.style.transform = px(start.x);
    // 挂在 body 下装整个 app 的那一层前面（评审高①）：插在旧页 main 旁边时，隐私记页 main 外还包着一层（data-testid="vault"），
    // Suspense 藏的是那一层，快照跟着被藏、露出白屏。这一层 Suspense 藏不到；层级同原来：页面里定位的元素、底栏照样盖在它上面。
    // 返回（pop）滑走的是旧页、要压在回来的那页上面：挂在 app 后面（层级见 slidePage）
    if (kind === 'pop') app?.after(ghost.box);
    else app?.before(ghost.box);
    // 钉住的副本排在快照后面（盖在快照上），同样在新页底下
    if (ghost.pins) ghost.box.after(ghost.pins);
    // 旧页底栏的副本放在最后，按自己的 --z-bar 盖在两页上面
    document.body.append(...ghost.bars);
  }
  try {
    update();
  } catch (e) {
    ghost?.box.remove();
    ghost?.pins?.remove();
    for (const b of ghost?.bars ?? []) b.remove();
    onEnd();
    throw e;
  }
  guardAgain();
  if (reduced) {
    onEnd();
    return Promise.resolve();
  }
  const page = kind === 'push' || kind === 'pop';
  // 整页推页等新页画完的这段（最多 PAGE_WAIT_MS）：屏幕停在旧页上——快照当场显示，换上来的新页先藏着（app 那一层透明度 0，
  // 不用 visibility：键盘焦点留得住），点按吞掉（看得见的是旧页，实际会点中新页同一位置的按钮；独立评审 11-20 第 1 条），
  // 键盘回车、空格触发的 click（detail 为 0）不吞（吞了键盘返回失灵，e2e settings-quiet-focus）。开始动（go）、收尾时放开
  const release = page ? holdScreen(app) : noop;
  if (page) ghost?.show();
  const s: Swap = {
    kind, ghost, extra: [], anims: [], look: () => STILL, start, stopWait: noop, resolve: noop, done: false,
    onEnd: () => {
      release();
      onEnd();
    },
  };
  const done = new Promise<void>((r) => (s.resolve = r));
  cur = s;
  const end = (): void => endSwap(s);
  // 整页推页：新页就是此刻显示着的 main（设置几层之间可能还是同一个 main 元素）；页签互切、长成：要换上来的新 main
  const fresh = (): HTMLElement | null => {
    const el = shownMain();
    return el !== null && (page || el !== before) ? el : null;
  };
  /** 整页推页还要等页面级懒加载块都到了（PagePending 的标记没了） */
  const ready = (): boolean => fresh() !== null && !(page && document.querySelector(PENDING_SEL) !== null);
  const watch = (): boolean => {
    if (!pageVisible(before)) ghost?.show();
    return ready();
  };
  let sync = true;
  const go = (el: HTMLElement): void => {
    if (!sync) guardAgain();
    release();
    ghost?.show();
    play(el, s);
    const lead = s.anims[0];
    if (!lead) return end();
    lead.finished.then(() => {
      if (s.done) return;
      try {
        if (settle) settle(s, end);
        else end();
      } catch {
        end();
      }
    }, end);
  };
  const stopWait = waitDom(watch, page ? PAGE_WAIT_MS : FADE_WAIT_MS, (ok) => {
    s.stopWait = noop;
    // 整页推页等满 PAGE_WAIT_MS：main 在（懒加载块还没到）就照常动，不让屏幕一直停在旧页上
    const el = ok || page ? fresh() : null;
    if (el && typeof el.animate === 'function') {
      try {
        go(el);
      } catch {
        end();
      }
      return;
    }
    if (ok || !ghost) return end();
    // 等不到：不放动画了，快照留到新页出来；调用方该收的先收（整页推页先放开藏着的新页和点按）
    release();
    onLate();
    s.stopWait = waitDom(() => {
      if (!pageVisible(before)) ghost.show();
      return fresh() !== null;
    }, GHOST_KEEP_MS, end);
  });
  sync = false;
  if (!s.done && s.anims.length === 0 && s.stopWait === noop) s.stopWait = stopWait;
  return done;
}

/**
 * 四个页签之间互切（负责人 11-06 选方案 B：不起 View Transition，底栏、“＋”、液滴、顶部模糊一直是真元素、一直实时模糊，WebKit bug 302256）。
 * 动法（负责人 11-18“底部导航切页动画直接套用日历的切页动画，做成一模一样的动效”）：和日历翻月同一份原地模糊淡换（blur-swap.ts）——
 * 旧页快照模糊到 4px、前 2/3 淡没，新页从模糊到清晰淡入，880 ms、--ease-out；不分方向、不平移。
 * 原来的“按底栏顺序左右滑入”（11-17 方案页 B）整段删掉。
 * 连点：和日历一样每次从头播；快照从上一页此刻的透明度起，不闪回全亮
 */
export function fadeSwap(update: () => void): Promise<void> {
  return swap('slide', update, (el, s) => {
    const opts = blurSwapTiming(false);
    // 新页自己的头像（钉住的）不淡入、一直全亮；透明度和模糊加在不含它、不含 fixed 元素的子树上（fadeTargets）
    const mine = shownPins(el);
    const { parts, fixed } = fadeTargets(el, mine);
    for (const t of parts) track(s, t.animate(blurSwapIn(false), opts));
    for (const t of fixed) track(s, t.animate(blurSwapIn(false, false), opts));
    const lead = s.anims[0];
    const g = s.ghost?.box;
    // fill: forwards：放完到拿掉之间停在透明，不回到不透明露一帧旧页（11-18 逐帧对照实测）；连点时从上一页此刻的透明度起
    if (g) track(s, g.animate(blurSwapOut(false, 0, s.start.opacity), { ...opts, fill: 'forwards' }));
    // 钉住的副本：新页里有自己的（真元素、全亮）就当场拿掉；新页里没有（电脑版）就跟快照一起淡出
    const pins = s.ghost?.pins;
    if (pins && mine.length > 0) pins.remove();
    else if (pins) track(s, pins.animate([{ opacity: s.start.opacity }, { opacity: 0 }], { ...opts, fill: 'forwards' }));
    // 原地换、不平移；连点时下一次的快照从新页此刻的透明度起（不是全亮，代码审查 M1）
    const fader = parts[0] ?? fixed[0] ?? null;
    s.look = () => {
      const o = fader ? Number.parseFloat(getComputedStyle(fader).opacity) : Number.NaN;
      return { x: 0, opacity: !lead || lead.playState === 'finished' || Number.isNaN(o) ? 1 : o };
    };
  });
}

/**
 * 打字条点“详细”：那张卡长成新建页（负责人 11-18“用A整页成长方案”，方案页 柠檬记APP-本机资料/设计方案/2026-11-18_详细切入动效）。
 * 旧页快照垫在整页模糊层下面，换页那一刻背景不变空；新建页 main 临时提到模糊层之上、打字条之下，底色画页面底色；
 * clip-path 从卡的位置和圆角（from、radius）长到整页、圆角变 0，--dur-grow 280ms、--ease-drawer；
 * 内容前 GROW_HOLD 不露、后段淡入（一层同底色的遮罩淡出，不给里面的元素逐个加动画：WebKit 会给下拉框补内联样式、被 CSP 拦）；
 * 打字条（card）前 GROW_HOLD 淡出，停在透明，不随取消回来（代码审查 M3）。
 * 长完调 landed（调用方收打字条和模糊层），等打字条真的卸掉了再还原 main 的临时样式（代码审查 H2：先还原的话，
 * 收起前那一帧新建页会被模糊层盖住）；被打断（例如马上点了返回）、出错时当场同步还原、照样调 landed（复审第 7 条）。landed 只调一次
 */
export function growSwap(update: () => void, from: DOMRect, radius: number, card: Element | null, landed: () => void): Promise<void> {
  let told = false;
  const land = (): void => {
    if (told) return;
    told = true;
    landed();
  };
  let restore = noop;
  return swap(
    'grow',
    update,
    (el, s) => {
      const r = el.getBoundingClientRect();
      const inset = `inset(${from.top - r.top}px ${r.right - from.right}px ${r.bottom - from.bottom}px ${from.left - r.left}px round ${radius}px)`;
      const st = el.style;
      const keep = ['position', 'z-index', 'background'].map((k) => [k, st.getPropertyValue(k), st.getPropertyPriority(k)] as const);
      const veil = document.createElement('div');
      restore = () => {
        restore = noop;
        veil.remove();
        for (const [k, v, pr] of keep) {
          if (v) st.setProperty(k, v, pr);
          else st.removeProperty(k);
        }
      };
      st.setProperty('position', 'relative');
      st.setProperty('z-index', 'calc(var(--z-mist) + 1)');
      st.setProperty('background', PAGE_BG);
      veil.setAttribute('aria-hidden', 'true');
      veil.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:2147483647;background:${PAGE_BG}`;
      el.append(veil);
      const opts = { duration: dur.grow * 1000, easing: bezierCss(ease.drawer), fill: 'both' as const };
      track(s, el.animate([{ clipPath: inset }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }], opts));
      track(s, veil.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: GROW_HOLD }, { opacity: 0, offset: 1 }], opts));
      card?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur.grow * 1000 * GROW_HOLD, easing: bezierCss(ease.linear), fill: 'forwards' }).finished.catch(noop);
    },
    (s, end) => {
      land();
      // 打字条卸掉（和模糊层同一次收起）以后再还原；最多等 FADE_WAIT_MS
      s.stopWait = waitDom(() => !card?.isConnected, FADE_WAIT_MS, end);
    },
    () => {
      // 收尾只有这一个口：放完、被打断、等不到、出错都在这里同步还原并告诉调用方
      restore();
      land();
    },
    land,
  );
}

/**
 * 整页推页等新页那段：藏起换上来的新页（app 那一层透明度 0）、吞手指点按（guardWindow，一直吞到放开）；返回放开的函数（只放一次）。
 * 键盘回车、空格触发的 click（前面有 keydown）不吞：键盘不存在“点在看得见的旧页上”，吞了会让键盘返回失灵（e2e settings-quiet-focus）
 */
function holdScreen(app: HTMLElement | null): () => void {
  const free = guardWindow({ ms: null, types: ['pointerdown', 'pointerup', 'click'], keyboard: 'keydown' });
  app?.style.setProperty('opacity', '0');
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    free();
    app?.style.removeProperty('opacity');
  };
}

/** Pressable 在 DOM 上的标记（Pressable.tsx 写 data-pressable；data-snap 的样式在 Pressable.module.css） */
const PRESSABLE_SEL = '[data-pressable]';
const SNAP_ATTR = 'data-snap';
/**
 * 拷旧页之前把页面上所有 Pressable 瞬间复位（UI-4 B1 动效确认 C3 / X-3）：点完按钮马上切页时，按钮还缩着或正在弹回，
 * 旧页快照会拷到这一刻、整段滑走都定格在缩着的样子（36319a2 查到的根因）。统一在这里处理，不再每个按钮局部改：
 * 打 data-snap 去掉过渡、回到原大小，拷完、换页之前摘掉
 */
function snapPressables(on: boolean): void {
  for (const el of document.querySelectorAll(on ? PRESSABLE_SEL : `[${SNAP_ATTR}]`)) {
    if (on) el.setAttribute(SNAP_ATTR, '');
    // 旧页副本（快照外框、底栏副本）里的留着：副本抄了 data-state，摘了按下的按钮会缩回 0.97
    else if (!el.closest(`[data-tab-ghost], [${BAR_COPY_ATTR}]`)) el.removeAttribute(SNAP_ATTR);
  }
}

/**
 * 整页推页进行中给 <html> 打 data-vt，返回方向再打 data-vt-back（收尾时一起摘）：样式不用，测试、运行日志按它认“正在整页切换”。
 * 名字沿用 11-20 以前 View Transition 时的（e2e、运行日志都认这两个）
 */
const VT_ATTR = 'data-vt';
const VT_BACK_ATTR = 'data-vt-back';

const DRAWER = bezierCss(ease.drawer);
/**
 * 整页推页的关键帧，照搬 11-20 以前 base.css 的 lemo-push-old / lemo-push-new / lemo-pop-old / lemo-pop-new / lemo-push-old-fade / lemo-pop-new-fade，
 * 数值一个不改；时长 --dur-sheet、曲线 --ease-drawer。CSS 动画的曲线是每两个关键帧之间各用一次，所以曲线写在每个关键帧上、整段 linear，和原来一样。
 * 平移用 translate 属性（等于 translateX），不碰元素自己的 transform；用 vw 不用 %：各层宽度不一样，按自己的宽算会滑得不一样远（11-20 电脑宽屏截图）
 */
const slide = (from: string, to: string): Keyframe[] => [
  { translate: from, easing: DRAWER },
  { translate: to },
];
/** 只有旧页有底栏、“＋”（进编辑页、设置）：跟着旧页往左退的同时前 40% 淡完（lemo-push-old-fade）；o 是它原本的不透明度 */
const pushOldFade = (o: number): Keyframe[] => [
  { offset: 0, opacity: o, translate: '0px', easing: DRAWER },
  { offset: 0.4, opacity: 0, easing: DRAWER },
  { offset: 1, opacity: 0, translate: '-30vw' },
];
/** 返回到有底栏的页：底栏跟着上一页从左边 30vw 回来，60% 以后才淡入（lemo-pop-new-fade） */
const popNewFade = (o: number): Keyframe[] => [
  { offset: 0, opacity: 0, translate: '-30vw', easing: DRAWER },
  { offset: 0.6, opacity: 0, easing: DRAWER },
  { offset: 1, opacity: o, translate: '0px' },
];
/** 返回时压到滑走的旧页下面：动画期间 z-index 取 auto（随手记输入行、底栏实色带这类带层级的 fixed 层），放完自动还原 */
const under = (f: Keyframe[]): Keyframe[] => f.map((k) => ({ ...k, zIndex: 'auto' }));
const opacityOf = (el: Element): number => {
  const o = Number.parseFloat(getComputedStyle(el).opacity);
  return Number.isFinite(o) ? o : 1;
};

/**
 * 整页推页的动法（负责人 11-20 选“新页从右滑进盖住”；动法照原来 View Transition 时一模一样，参考压过代码）。
 * 进页：新页从右边整屏宽滑进来盖住旧页，旧页往左退 30vw；返回反过来：旧页往右整屏宽滑出，露出下面从左边 30vw 回来的上一页。
 * 层级（从下往上）：
 * • 进页：旧页快照（外框画页面底色，抄进了实色带、上沿渐隐）→ 新页底色层 → 新页 → 旧页底栏副本（--z-bar，前 40% 淡完）；
 * • 返回：上一页（带层级的 fixed 层动画期间降成 auto）→ 旧页快照（挂在 app 后面）→ 真底栏（--z-bar，60% 以后淡入）。
 * 底栏、“＋”从头到尾是真元素或真 DOM 副本，backdrop-filter 一直实时模糊；两页都有底栏时真底栏原地不动（副本拿掉）。
 * 顶部状态栏底色条、顶部模糊带（层级 1、在 app 外面）原地不动、一直盖在最上面
 */
function slidePage(el: HTMLElement, s: Swap, back: boolean): void {
  const opts: KeyframeAnimationOptions = { duration: dur.sheet * 1000, easing: bezierCss(ease.linear), fill: 'both' };
  const run = (t: Element, f: Keyframe[]): void => void track(s, t.animate(f, opts));
  const g = s.ghost;
  if (g) run(g.box, back ? slide('0px', '100vw') : slide('0px', '-30vw'));
  const inn = back ? slide('-30vw', '0px') : slide('100vw', '0px');
  if (!back) {
    // 新页底色层：页面自己不画底色（R-439），整页滑进来时要带着一张底，才盖得住下面的旧页
    const bg = document.createElement('div');
    bg.setAttribute('aria-hidden', 'true');
    bg.style.cssText = `position:fixed;inset:0;pointer-events:none;background:${PAGE_BG}`;
    if (g) g.box.after(bg);
    else el.closest('body > *')?.before(bg);
    s.extra.push(bg);
    run(bg, inn);
  }
  const { parts, fixed } = fadeTargets(el, []);
  for (const t of parts) run(t, inn);
  const layer = back ? under(inn) : inn;
  const moved = new Set<Element>([...fixed, ...fixedOutside(el)]);
  for (const t of moved) run(t, layer);
  // 滑的途中才挂上的 main 外 fixed 层（例如“＋”上方的提示气泡，量完“＋”的位置才出来）：从此刻的进度接着跟这一页一起动
  const app = el.closest('body > *');
  const lead = s.anims[0];
  if (app && lead) {
    const mo = new MutationObserver(() => {
      for (const t of fixedOutside(el)) {
        if (moved.has(t)) continue;
        moved.add(t);
        const a = t.animate(layer, opts);
        a.currentTime = lead.currentTime;
        track(s, a);
      }
    });
    mo.observe(app, { childList: true, subtree: true });
    const end = s.onEnd;
    s.onEnd = () => {
      mo.disconnect();
      end();
    };
  }
  const real = shownBars();
  const copies = g?.bars ?? [];
  if (real.length > 0 && copies.length > 0) {
    for (const c of copies) c.remove();
    return;
  }
  for (const b of real) run(b, back ? popNewFade(opacityOf(b)) : inn);
  for (const c of copies) run(c, back ? slide('0px', '100vw') : pushOldFade(opacityOf(c)));
}

/**
 * 点进下一页、返回（router.ts 的 commit；motion/index.ts 的 transition 在实现到了以后转到这里）。back 为真是返回、回上一层。
 * 拷旧页之前 Pressable 复位；减少动态效果时 index.ts 直接换页、不到这里
 */
export function transition(update: () => void, back = false): Promise<void> {
  // 放不了 WAAPI 的环境（单测的 jsdom）：直接换页，同原来没有 View Transition 时
  if (typeof document === 'undefined' || typeof document.documentElement.animate !== 'function') {
    update();
    return Promise.resolve();
  }
  const html = document.documentElement;
  snapPressables(true);
  html.setAttribute(VT_ATTR, '');
  html.toggleAttribute(VT_BACK_ATTR, back);
  return swap(
    back ? 'pop' : 'push',
    () => {
      snapPressables(false);
      update();
    },
    (el, s) => slidePage(el, s, back),
    undefined,
    () => {
      html.removeAttribute(VT_ATTR);
      html.removeAttribute(VT_BACK_ATTR);
    },
  );
}
