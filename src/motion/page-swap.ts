// 页面切换的两种动法（11-18 独立评审后从 index.ts 拆出来整块重写，不再在原代码上叠补丁）：
// • fadeSwap：底栏四个页签互切，按底栏顺序左右滑入（负责人 11-18“之前的B方案”，11-17 方案页 B）
// • growSwap：打字条点“详细”，那张卡长成新建页（负责人 11-18“用A整页成长方案”）
// 两种共用：旧页快照（makeGhost）、等新页出来（waitDom）、换页后吞点按（guardTaps）、一份“正在播”的状态（cur）和一个收尾（endSwap）
import { copyNode } from './copy-node.ts';
import { prefersReducedMotion } from './reduced.ts';
import { swallowNextClick } from './swallow-click.ts';
import { bezierCss, dur, ease } from './tokens.ts';

/** 新页分包还没到（页面的 Suspense 先什么都不画）时，最多等多久让它出来；过了就不动画了（App 等页面显示出来也用这个数） */
export const FADE_WAIT_MS = 1500;
/** 新页从第几毫秒起播（一帧，60Hz）：不画 opacity 0 的那一帧 */
export const FADE_SKIP_MS = 1000 / 60;
/**
 * 换页后这么久以内落在 main 里的点按吞掉（代码审查方案 B M8；沿用主持人 11-05 的规则“过渡开始很短时间内的点按算点在旧画面上”）：
 * 旧页在点页签那一刻就卸掉了，手指顺手再点一下原来那页的位置，人还没看清新页，会直接点中新页同一位置的删除 ×、勾选圈。
 * 新页第一帧约 17 ms 才画出来，再加人眼看清的最短时间，取 100 ms；底栏不在 main 里，连点页签不受影响
 */
export const FADE_GUARD_MS = 100;
/** 页签互切新页从侧边多远滑进来（新页 main 宽度的百分比，换成像素后所有平移的元素用同一个值） */
export const SLIDE_IN_PCT = 8;
/** 旧页（快照）往反方向移多远并淡出（同上） */
export const SLIDE_OUT_PCT = 4;
/** “详细”长成的前多少（比例）新建页内容不露、打字条淡完 */
export const GROW_HOLD = 0.35;
/** 页面底色（同 base.css 的 body::after）：长成时新建页 main 和遮罩画这个，长出来的是一整张页面 */
const PAGE_BG = 'var(--scr-bg, var(--bg))';

const noop = (): void => undefined;
const px = (x: number): string => (x === 0 ? 'none' : `translateX(${Math.round(x * 100) / 100}px)`);

/**
 * 这个元素此刻画在页面上没有（还在文档里、没被 display: none 藏起来）。新页分包没到时 Suspense 用内联 display: none 藏旧页、
 * 旧页仍在文档里（React 19 + flushSync，App 的注释和第二次复审第 1 条），只看 isConnected 判断不出来。
 * 换页动画等新页、显示旧页快照，App 等页面显示出来收打字条，都用这一个判断（这类事只在这里判断，架构约定 10.1；首屏画好没有另归 platform/root-paint.ts）
 */
export function pageVisible(el: Element | null): boolean {
  return el !== null && el.isConnected && el.getClientRects().length > 0;
}

/** 页面上第一个显示着的 <main>（真页面；快照外壳不是 main） */
export function shownMain(): HTMLElement | null {
  for (const m of document.querySelectorAll('main')) if (pageVisible(m)) return m;
  return null;
}

/**
 * 看着 body 等 test() 成立就调 hit(true)；已经成立就当场调；ms 内一直不成立调 hit(false)。返回停止（停了不再调 hit）。
 * 页签互切、“详细”长成等新页，App 等页面显示出来收打字条，都用这一个
 */
export function waitDom(test: () => boolean, ms: number, hit: (ok: boolean) => void): () => void {
  if (test()) {
    hit(true);
    return noop;
  }
  let live = true;
  const stop = (): void => {
    if (!live) return;
    live = false;
    mo.disconnect();
    clearTimeout(timer);
  };
  const mo = new MutationObserver(() => {
    if (!test()) return;
    stop();
    hit(true);
  });
  const timer = setTimeout(() => {
    stop();
    hit(false);
  }, ms);
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden'] });
  return stop;
}

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

interface Ghost {
  box: HTMLElement;
  /** 显示出来（换页前先藏着放好，旧页一卸掉就显示，不露空白），并抄回滚动位置 */
  show: () => void;
}

/**
 * 旧页快照：换页前把旧 main 深拷一份，盖在页面那一层、不接点按、读屏不念；外面包一层视口大小的 fixed 框（overflow 裁掉），
 * 里面的拷贝按旧页当时的位置摆（滚动过的照样对得上）；去掉 id、data-testid、data-feature，不和新页重名。
 * 外壳不用 <main>：页面上 querySelector('main') 只该找到真页面。抄的时候出任何错就不要快照（直接换页，不卡住换页）
 */
function makeGhost(main: Element): Ghost | null {
  if (!(main instanceof HTMLElement)) return null;
  try {
    const r = main.getBoundingClientRect();
    const scrolled: [Element, Element][] = [];
    // 静态副本走 motion 共用的 copyNode（评审第 6、9 条：不抄 style 属性、不抄视频画布）；外壳用 div，去掉 data-feature
    const copy = copyNode(main, { tag: 'div', strip: ['data-feature'], onScrolled: (a, b) => scrolled.push([a, b]) });
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
      for (const [c, top, left] of pos) {
        c.scrollTop = top;
        c.scrollLeft = left;
      }
    };
    return { box, show };
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
    s.resolve();
  }
}

function track(s: Swap, a: Animation): Animation {
  s.anims.push(a);
  // 取消时 finished 会被拒，这里接住
  a.finished.catch(noop);
  return a;
}

/** 正在播的页签互切走到哪了（0～1，已按曲线算好）；没在播、或在播的是长成，为 0。连点时下一页从这里接着走（可打断） */
function progressOf(s: Swap | null): number {
  if (s?.kind !== 'slide') return 0;
  const p = s.anims[0]?.effect?.getComputedTiming().progress;
  return typeof p === 'number' && p > 0 && p < 1 ? p : 0;
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
  const ghost = before && !reduced ? makeGhost(before) : null;
  // 上一次页签互切放完以前：快照从它此刻的样子起，不是全亮（代码审查 M1）
  const start = cur?.kind === 'slide' && cur.anims.length ? cur.look() : STILL;
  cancelFade();
  if (ghost) {
    ghost.box.style.opacity = String(start.opacity);
    ghost.box.style.transform = px(start.x);
    // 挂在 body 下装整个 app 的那一层前面（评审高①）：插在旧页 main 旁边时，隐私记页 main 外还包着一层（data-testid="vault"），
    // Suspense 藏的是那一层，快照跟着被藏、露出白屏。这一层 Suspense 藏不到；层级同原来：页面里定位的元素、底栏照样盖在它上面
    (before?.closest('body > *') ?? before)?.before(ghost.box);
  }
  try {
    update();
  } catch (e) {
    ghost?.box.remove();
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
 * 动法（负责人 11-18 选 11-17 方案页 B）：dir 为 1（往右边的页签点）新页从右边滑进，-1 从左边；
 * 新页 opacity 0→1、平移 SLIDE_IN_PCT→0；旧页快照同时往反方向移 SLIDE_OUT_PCT 并淡出；--dur-tab 200ms、--ease-out。
 * 平移按新页 main 的宽度换成像素，main 自己和各子树（见 shiftTargets）走一样的距离（代码审查 H1：百分比按各自宽度算，宽窄不一的子树会错开）。
 * 连点（可打断）：上一次还没放完时，新页从上一次此刻的进度接着走、用剩下的时长；快照从上一页此刻的样子起
 */
export function fadeSwap(update: () => void, dir: 1 | -1 = 1): Promise<void> {
  const from = progressOf(cur);
  return swap('slide', update, (el, s) => {
    const w = el.getBoundingClientRect().width || window.innerWidth;
    const inX = (w * SLIDE_IN_PCT * dir) / 100;
    const x0 = (1 - from) * inX;
    const opts = { duration: dur.tab * 1000 * (1 - from), easing: bezierCss(ease.out) };
    const targets = shiftTargets(el);
    const whole = targets.length === 1 && targets[0] === el;
    const lead = track(s, el.animate(whole ? [{ opacity: from, transform: px(x0) }, { opacity: 1, transform: 'none' }] : [{ opacity: from }, { opacity: 1 }], opts));
    if (!whole) for (const t of targets) track(s, t.animate([{ transform: px(x0) }, { transform: 'none' }], opts));
    const g = s.ghost?.box;
    if (g) {
      const { x: gx, opacity: go } = s.start;
      // fill: forwards：放完到拿掉之间停在透明，不回到不透明露一帧旧页（11-18 逐帧对照 200ms 那帧实测）
      track(s, g.animate([{ opacity: go, transform: px(gx) }, { opacity: 0, transform: px(gx - (w * SLIDE_OUT_PCT * dir) / 100) }], { ...opts, fill: 'forwards' }));
    }
    // 从头起播时跳过第一帧：从 0 起播时画出来的第一帧新页整页透明（11-06 chromium 逐帧实测）；接着上一次走的不用跳
    if (from === 0) for (const a of s.anims) a.currentTime = FADE_SKIP_MS;
    // 此刻的平移：这一段是从 x0 走到 0（复审第 6 条：不是 at(q)）；有 fixed 元素时各子树走的也是这个值
    s.look = () => {
      const p = lead.effect?.getComputedTiming().progress;
      const q = typeof p === 'number' ? p : 1;
      return { x: (1 - q) * x0, opacity: from + (1 - from) * q };
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
