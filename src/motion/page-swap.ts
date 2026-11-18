// 页面切换的两种动法（11-18 独立评审后从 index.ts 拆出来整块重写，不再在原代码上叠补丁）：
// • fadeSwap：底栏四个页签互切，和日历翻月同一份原地模糊淡换（blur-swap.ts；负责人 11-18“做成一模一样的动效”）
// • growSwap：打字条点“详细”，那张卡长成新建页（负责人 11-18“用A整页成长方案”）
// 首屏画完以后才下载（motion/index.ts 的 loadPageSwap，main.tsx 和动画实现同一时机；11-18 ci 首屏预算 151.7 KB 超线后挪出首屏）；
// 首屏要用的常量和“新页显示出来没有”的判断在 ./page-shown.ts。
// 两种共用：旧页快照（makeGhost）、等新页出来（waitDom）、换页后吞点按（guardTaps）、一份“正在播”的状态（cur）和一个收尾（endSwap）
import { copyNode } from './copy-node.ts';
import { blurSwapIn, blurSwapInFilter, blurSwapOut, blurSwapTiming } from './blur-swap.ts';
import { FADE_GUARD_MS, FADE_WAIT_MS, GROW_HOLD, pageVisible, shownMain, waitDom } from './page-shown.ts';
import { prefersReducedMotion } from './reduced.ts';
import { swallowNextClick } from './swallow-click.ts';
import { bezierCss, dur, ease } from './tokens.ts';

/** 页面底色（同 base.css 的 body::after）：长成时新建页 main 和遮罩画这个，长出来的是一整张页面 */
const PAGE_BG = 'var(--scr-bg, var(--bg))';

const noop = (): void => undefined;
const px = (x: number): string => (x === 0 ? 'none' : `translateX(${Math.round(x * 100) / 100}px)`);

/**
 * 在 document 上用 capture 吞掉 ms 以内落在 main 里的 pointerdown、click；返回摘掉监听的函数。
 * 窗口里吞掉了 pointerdown 时，跟着的那次 click 晚到窗口外也吞：交给 swallowNextClick（最多等 TAP_SWALLOW_MS，从按下算；
 * 新的一次按下、被吞的按下变成滚动就不再等，代码审查 S12）。吞用 stopImmediatePropagation；
 * 键盘的 click（窗口里先有 keydown）不是手指点在旧画面上，不吞（R-420 审查第 13 条）
 */
function guardTaps(doc: Document, ms: number): () => void {
  const t0 = performance.now();
  let late: (() => void) | null = null;
  let keyed = false;
  const mainOf = (e: Event): Element | null => (e.target instanceof Element ? e.target.closest('main') : null);
  const eat = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const down = (e: Event): void => {
    if (performance.now() - t0 >= ms) return void stop();
    const main = mainOf(e);
    if (!main) return;
    eat(e);
    late?.();
    late = swallowNextClick({ within: main });
  };
  const click = (e: Event): void => {
    if (performance.now() - t0 >= ms) return void stop();
    if (keyed) keyed = false;
    else if (mainOf(e)) eat(e);
  };
  const key = (): void => {
    keyed = true;
  };
  const timer = setTimeout(() => stop(), ms);
  let dead = false;
  /** 窗口到了：只摘窗口本身的监听，晚到的那一下还由 late 等着 */
  const stop = (): void => {
    if (dead) return;
    dead = true;
    clearTimeout(timer);
    doc.removeEventListener('pointerdown', down, true);
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('keydown', key, true);
  };
  doc.addEventListener('pointerdown', down, true);
  doc.addEventListener('click', click, true);
  doc.addEventListener('keydown', key, true);
  return () => {
    stop();
    late?.();
  };
}
let guardStop: (() => void) | null = null;
function guardAgain(): void {
  guardStop?.();
  guardStop = guardTaps(document, FADE_GUARD_MS);
}

/**
 * 页签互切时钉在原处不动的元素（负责人 11-18 录屏“切页的时候头像抖动”：右上角设置头像 MeLink 四页在同一处，
 * 原来新页和旧页快照各带一个、往两边滑，两三帧里叠出左右错开的两个头像）。打了这个属性的元素：
 * 旧页快照里的藏掉，另拍一份静态副本钉在原处（不跟快照滑、不跟快照淡出）；新页里同一种的那个滑动期间透明（照样能点），收尾时露出来、副本拿掉。
 * 新页里没有（电脑版藏了头像）时，副本跟着快照一起淡出
 */
const SWAP_PIN = 'data-swap-pin';
const PIN_SEL = `[${SWAP_PIN}]`;

interface Ghost {
  box: HTMLElement;
  /** 钉住不动的那几个的副本（一层视口大小的 fixed 框，排在快照后面）；旧页里没有就是 null */
  pins: HTMLElement | null;
  /** 新页里滑动期间藏起来的那几个，收尾时露出来 */
  held: HTMLElement[];
  /** 显示出来（换页前先藏着放好，旧页一卸掉就显示，不露空白），并抄回滚动位置 */
  show: () => void;
}

/** 钉住的副本：按各自此刻在屏幕上的位置摆；摆不出来（没有大小）的不要 */
function makePins(main: Element): HTMLElement | null {
  const els = [...main.querySelectorAll(PIN_SEL)].filter((e) => e.getBoundingClientRect().width > 0);
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
 * 外壳不用 <main>：页面上 querySelector('main') 只该找到真页面。抄的时候出任何错就不要快照（直接换页，不卡住换页）
 */
function makeGhost(main: Element, pin: boolean): Ghost | null {
  if (!(main instanceof HTMLElement)) return null;
  try {
    const r = main.getBoundingClientRect();
    const scrolled: [Element, Element][] = [];
    const pins = pin ? makePins(main) : null;
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
    box.append(copy);
    const pos = scrolled.map(([s, c]) => [c, s.scrollTop, s.scrollLeft] as const);
    let shown = false;
    const show = (): void => {
      if (shown) return;
      shown = true;
      box.style.removeProperty('visibility');
      pins?.style.removeProperty('visibility');
      for (const [c, top, left] of pos) {
        c.scrollTop = top;
        c.scrollLeft = left;
      }
    };
    return { box, pins, held: [], show };
  } catch {
    return null;
  }
}

/**
 * 平移加在哪些元素上：main 里没有 position: fixed 的元素时就是 main 自己；有的话（随手记贴底的输入行、页底提示条），
 * 祖先带 transform 会让它们改按祖先定位、过渡期间错位，所以只给“不含 fixed 元素的最大子树”加平移，fixed 的那几个原地不动（同底栏）。
 * 透明度照样加在 main 上：opacity 不改 fixed 元素的定位
 */
function shiftTargets(main: Element): Element[] {
  const tainted = new Set<Element>();
  for (const el of main.querySelectorAll('*')) {
    if (getComputedStyle(el).position !== 'fixed') continue;
    for (let e: Element | null = el; e !== null && e !== main; e = e.parentElement) tainted.add(e);
  }
  if (tainted.size === 0) return [main];
  const out: Element[] = [];
  const walk = (el: Element): void => {
    for (const c of el.children) {
      if (!tainted.has(c)) out.push(c);
      else if (getComputedStyle(c).position !== 'fixed') walk(c);
    }
  };
  walk(main);
  return out;
}

interface Look {
  x: number;
  opacity: number;
}
const STILL: Look = { x: 0, opacity: 1 };

type Kind = 'slide' | 'grow';

/** 一次换页的全部状态：取消、放完、等不到新页、出错都走 endSwap，只收一次尾 */
interface Swap {
  kind: Kind;
  ghost: Ghost | null;
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
    for (const e of s.ghost?.held ?? []) e.style.removeProperty('opacity');
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
 * transition() 开头调（整页过渡要截的是完整的旧画面）；路由同页内切换调 cancelFade(false)：只停等待，不打断正在播的
 */
export function cancelFade(anim = true): void {
  guardStop?.();
  guardStop = null;
  if (cur && (anim || cur.anims.length === 0)) endSwap(cur);
}

/** 等不到新页（FADE_WAIT_MS）以后快照还留多久：新页再晚也不露空白，直到它出来或下一次导航（复审第 4 条）；这么久还没出来才拿掉 */
const GHOST_KEEP_MS = 30_000;

/**
 * 两种换页共用的流程：换页前拷旧页快照、藏着放在整个 app 前面（旧页卸掉或被 Suspense 藏起来就显示，分包晚到也不露空白）；update 换页；
 * 等换上来的新 main（不是换页前那个、而且显示着）出来，显示快照、调 play 起动画；领头的动画放完收尾。
 * FADE_WAIT_MS 内等不到：不放动画，快照留着等新页出来（最多 GHOST_KEEP_MS）；被 cancelFade 停掉、play 或 settle 出错都直接收尾。
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
  // 显示着的页找不到时（连点、上一次的新页分包还没到）就是那个被 Suspense 藏着的旧页：拷它（去掉 display），画面上本来就是它的快照（复审第 2 条）
  const before = shownMain() ?? document.querySelector('main');
  const reduced = prefersReducedMotion();
  const ghost = before && !reduced ? makeGhost(before, kind === 'slide') : null;
  // 上一次页签互切放完以前：快照从它此刻的样子起，不是全亮（代码审查 M1）
  const start = cur?.kind === 'slide' && cur.anims.length ? cur.look() : STILL;
  cancelFade();
  if (ghost) {
    ghost.box.style.opacity = String(start.opacity);
    ghost.box.style.transform = px(start.x);
    // 挂在 body 下装整个 app 的那一层前面（评审高①）：插在旧页 main 旁边时，隐私记页 main 外还包着一层（data-testid="vault"），
    // Suspense 藏的是那一层，快照跟着被藏、露出白屏。这一层 Suspense 藏不到；层级同原来：页面里定位的元素、底栏照样盖在它上面
    (before?.closest('body > *') ?? before)?.before(ghost.box);
    // 钉住的副本排在快照后面（盖在快照上），同样在新页底下
    if (ghost.pins) ghost.box.after(ghost.pins);
  }
  try {
    update();
  } catch (e) {
    ghost?.box.remove();
    ghost?.pins?.remove();
    onEnd();
    throw e;
  }
  guardAgain();
  if (reduced) {
    onEnd();
    return Promise.resolve();
  }
  const s: Swap = { kind, ghost, anims: [], look: () => STILL, start, onEnd, stopWait: noop, resolve: noop, done: false };
  const done = new Promise<void>((r) => (s.resolve = r));
  cur = s;
  const end = (): void => endSwap(s);
  const fresh = (): HTMLElement | null => {
    const el = shownMain();
    return el !== null && el !== before ? el : null;
  };
  const watch = (): boolean => {
    if (!pageVisible(before)) ghost?.show();
    return fresh() !== null;
  };
  let sync = true;
  const go = (el: HTMLElement): void => {
    if (!sync) guardAgain();
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
  const stopWait = waitDom(watch, FADE_WAIT_MS, (ok) => {
    s.stopWait = noop;
    const el = ok ? fresh() : null;
    if (el && typeof el.animate === 'function') {
      try {
        go(el);
      } catch {
        end();
      }
      return;
    }
    if (ok || !ghost) return end();
    // 等不到：不放动画了，快照留到新页出来；调用方该收的先收
    onLate();
    s.stopWait = waitDom(watch, GHOST_KEEP_MS, end);
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
    // 模糊加在不含 fixed 元素的子树上（filter 同 transform，会让 fixed 后代改按祖先定位），透明度加在 main 上
    const targets = shiftTargets(el);
    const whole = targets.length === 1 && targets[0] === el;
    const lead = track(s, el.animate(blurSwapIn(false, whole), opts));
    if (!whole) for (const t of targets) track(s, t.animate(blurSwapInFilter(), opts));
    const g = s.ghost?.box;
    // fill: forwards：放完到拿掉之间停在透明，不回到不透明露一帧旧页（11-18 逐帧对照实测）；连点时从上一页此刻的透明度起
    if (g) track(s, g.animate(blurSwapOut(false, 0, s.start.opacity), { ...opts, fill: 'forwards' }));
    // 钉住的（头像）：新页里也有就先藏着、副本原地不动，收尾时换回新页自己的；新页里没有就让副本跟快照一起淡出
    const pins = s.ghost?.pins;
    if (pins && s.ghost) {
      const mine = [...el.querySelectorAll<HTMLElement>(PIN_SEL)].filter((e) => e.getBoundingClientRect().width > 0);
      // 用透明度藏、不用 visibility：滑动那 200ms 里点头像照样进设置（b2-vt-taps：换页 10、80、150 ms 点新页上的链接要点到）
      for (const e of mine) e.style.setProperty('opacity', '0');
      s.ghost.held = mine;
      if (mine.length === 0) track(s, pins.animate([{ opacity: s.start.opacity }, { opacity: 0 }], { ...opts, fill: 'forwards' }));
    }
    // 原地换、不平移；连点时下一次的快照从新页此刻的透明度起（不是全亮，代码审查 M1）
    s.look = () => {
      const o = Number.parseFloat(getComputedStyle(el).opacity);
      return { x: 0, opacity: lead.playState === 'finished' || Number.isNaN(o) ? 1 : o };
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
