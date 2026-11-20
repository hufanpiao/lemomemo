// 整页 View Transition 的实现（进页新页从右滑进盖住、返回反过来；负责人 11-20 选“新页从右滑进盖住”）。
// 首屏画完以后才下载：由 page-swap.ts 转出、跟换页动画实现同一块（motion/index.ts 的 loadPageSwap）；没到时 index.ts 的 transition 直接换页、不播。
// 11-20 从 index.ts 挪出：ci 309ff11c 起首屏预算 150 KB 超线（150.8 KB），这段首屏用不上（第一次点进下一页才用），同 a424c819 换页动画实现挪出首屏的做法
import { shownMain, waitDom } from './page-shown.ts';
import { prefersReducedMotion } from './reduced.ts';
import { reportDuplicateVtNames } from './vt.ts';

/**
 * 页面级懒加载块还没出来时，它的 Suspense 占位上打的标记（kit 的 PagePending 画一个隐藏的 <i data-page-pending>）。
 * App 的页面那层、设置二级页那层用它（独立评审 11-20 第 2 条：设置二级页外层 main 先在、里面一层懒加载还空着，只看 main 会当场放行）。
 * 只有这里用：放这里不放首屏的 page-shown.ts（11-20 首屏预算）
 */
const PENDING_ATTR = 'data-page-pending';

/** 新页真的画出来了：有显示着的 <main>，页面级的懒加载块也都到了 */
const pageReady = (): boolean => shownMain() !== null && document.querySelector(`[${PENDING_ATTR}]`) === null;

interface VtDocument {
  startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> };
}

/** Pressable 在 DOM 上的标记（Pressable.tsx 写 data-pressable；data-snap 的样式在 Pressable.module.css） */
const PRESSABLE_SEL = '[data-pressable]';
const SNAP_ATTR = 'data-snap';

/** 切页前把页面上所有 Pressable 瞬间复位（UI-4 B1 动效确认 C3 / X-3）：
 * 点完按钮马上切页时，按钮还缩着或正在弹回，浏览器截旧画面会截到这一刻、淡出时定格（36319a2 查到的根因）。
 * 统一在这里处理，不再每个按钮局部改：打 data-snap 去掉过渡、回到原大小，旧画面截的是复位后的样子；
 * View Transition 的回调里（旧画面已经截完、新页面画之前）摘掉 */
function snapPressables(doc: Document, on: boolean): void {
  for (const el of doc.querySelectorAll(on ? PRESSABLE_SEL : `[${SNAP_ATTR}]`)) {
    if (on) el.setAttribute(SNAP_ATTR, '');
    else el.removeAttribute(SNAP_ATTR);
  }
}

/**
 * 过渡期间给 <html> 打 data-vt（11-06 代码审查 S4）：iOS 18.0～18.1 有 startViewTransition 但不认 :active-view-transition，
 * 要按“正在过渡”写的样式或测试认这个属性。原来底栏“过渡中换实色”的 CSS 用它，11-06 实色已经去掉（负责人真机 9d40848），
 * 页签互切也不再起 View Transition（fadeSwap 不打这个属性）；现在只有整页 View Transition 时打，CSS 不用它、测试和 e2e 读它。
 * 返回方向 data-vt-back 跟着它的计数一起摘（最后一个过渡结束才摘），删这个计数会连方向一起删坏。
 * 旧画面在调用 startViewTransition 之后才截，所以要在调用之前打上；新过渡打断旧过渡时，旧的 finished 先结束，用计数，最后一个结束才摘
 */
let vtOpen = 0;
function markVt(doc: Document, on: boolean): void {
  vtOpen = Math.max(0, vtOpen + (on ? 1 : -1));
  if (vtOpen > 0) doc.documentElement.setAttribute('data-vt', '');
  else {
    doc.documentElement.removeAttribute('data-vt');
    doc.documentElement.removeAttribute(VT_BACK_ATTR);
  }
}
/** 整页过渡往回走（返回）：base.css 按它把滑入滑出换成反方向 */
const VT_BACK_ATTR = 'data-vt-back';
/** 整页过渡最多等新页显示出来多久再截新图（屏幕这段时间停在旧页上，太长像卡住） */
export const VT_WAIT_MS = 300;

/**
 * 页面切换：支持 View Transitions 就包一层，不支持或减少动态效果时直接执行（17.2 第 3 点）。
 * 进页新页从右边滑进来盖住旧页、旧页往左退一点；back 为真（返回上一页、回上一层）反过来，旧页往右滑出、露出下面的上一页
 * （负责人 11-20 选“新页从右滑进盖住”，原来先淡出再淡入中间黑一下）。方向打在 <html data-vt-back> 上，base.css 按它换关键帧
 */
export function transition(update: () => void, back = false): Promise<void> {
  const doc = typeof document === 'undefined' ? undefined : (document as Document & VtDocument);
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    update();
    return Promise.resolve();
  }
  // 这次过渡的序号：被下一次打断以后，这次的回调不再摘下一次打的 data-snap（独立评审 11-20 第 10 条）
  const my = ++vtSeq;
  const html = doc.documentElement;
  const wasBack = html.hasAttribute(VT_BACK_ATTR);
  snapPressables(doc, true);
  html.toggleAttribute(VT_BACK_ATTR, back);
  markVt(doc, true);
  let vt: { finished: Promise<void> };
  try {
    vt = doc.startViewTransition(() => {
      if (my === vtSeq) snapPressables(doc, false);
      update();
      return untilPageReady(doc).then(() => {
        // 开发版：新页面画完就查 view-transition-name 重名（17.2 第 3 点；X-5 改成读计算样式，CSS Modules 起的名字也查得到）
        if (import.meta.env.DEV) reportDuplicateVtNames(doc);
      });
    });
  } catch {
    // startViewTransition 同步抛错（个别实现、以后加的包装；代码审查 S2）：摘掉标记、直接画新页面，
    // 不然 data-snap 一直留着，所有 Pressable 都没了按下反馈；方向还原成前一个还在播的过渡的（独立评审 11-20 第 9 条）
    snapPressables(doc, false);
    html.toggleAttribute(VT_BACK_ATTR, wasBack);
    markVt(doc, false);
    update();
    return Promise.resolve();
  }
  const done = (): void => markVt(doc, false);
  return vt.finished.then(done, done);
}
let vtSeq = 0;

/**
 * 等新页真的画出来再截新图（负责人 11-20 录屏“设置进入待办最近删除页的时候顶部闪一下”）：懒加载的页第一次渲染哪怕分包已经下好
 * 也先挂起一拍，不等的话新页先空着滑进来、内容后弹出。判断看 page-shown.ts 的 pageReady（main 显示出来、页面级懒加载块也到了）。
 * 等的时候屏幕停在旧页上、DOM 已经是新页，这段时间手指、鼠标的点按吞掉（不然点在看得见的旧页上、实际点中新页同一位置的按钮；独立评审 11-20 第 1 条）；
 * 最多 VT_WAIT_MS，过了照常播
 */
function untilPageReady(doc: Document): Promise<void> {
  return new Promise<void>((done) => {
    const eat = (e: Event): void => {
      // 键盘回车、空格触发的 click（detail 为 0）不吞：键盘不存在“点在看得见的旧页上”，吞了会让键盘返回失灵（e2e settings-quiet-focus）
      if (e.type === 'click' && (e as MouseEvent).detail === 0) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const types = ['pointerdown', 'pointerup', 'click'] as const;
    for (const t of types) doc.addEventListener(t, eat, true);
    waitDom(pageReady, VT_WAIT_MS, () => {
      for (const t of types) doc.removeEventListener(t, eat, true);
      done();
    });
  });
}
