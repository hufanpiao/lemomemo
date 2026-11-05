// 液态玻璃底栏的“首屏后”部分（B2 FA-7；主持人 11-05 首屏选 ③）：外壳 GlassBar.tsx 首屏画完以后才下载这个文件
// • 渐进模糊带 5 层（0.25）；• 按住当前选中的页签放大（D3，data-state=press）
// • 自动深浅的深色玻璃层 .adTint（L2）：用 portal 放进底栏 nav 最后面（只有副本引擎写 data-ad 时才用得上）
// • 内容副本、自动深浅、帧循环（motion/glass-ghost.ts）：这个文件挂上以后再 import()（0.31 第 6 条：motion 以外不准静态引它）
// • 切页过渡期间的点按（设计复审二 R4）：过渡进行中浏览器把点按都算到 <html> 上（::view-transition 的 pointer-events 不管用），
//   底栏的页签和“＋”接不到；落在 <html> 上的点按按坐标找底栏里的页签或“＋”，替它点一下，马上开始下一次切页（新的过渡会打断旧的）
//   页面内容（设计复审三 R6，主持人 11-05 定做法 A，首屏 0 字节）：底栏没接住的，先把过渡放完，再按坐标找真正的目标代点（tapThrough）
// • 电脑版侧栏（D5，(width >= 900px)，外壳传 wide）：侧栏不用内容副本，宽屏时不开副本引擎；设置入口（头像）在外壳里（设计复审三 S1）
// • 液滴果冻（L1：副本引擎到了用它的 playGel，WAAPI 从当前形变接着放；没到或做不了时给里层重新加 CSS 动画类 .jelly）
// 外壳只留首屏必须的：页签、“＋”、液滴位置和点下就走（D1）。这个文件下不来（离线）时：没有模糊带、没有果冻和按住放大，材质用后备
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import styles from './GlassBar.module.css';
import fx from './GlassBarFx.module.css';

/** “＋”：窄屏紧跟在 nav 后面，宽屏（侧栏）在 nav 前面（Pressable 不接 ref） */
const plusOf = (n: HTMLElement): HTMLButtonElement | null => {
  for (const el of [n.nextElementSibling, n.previousElementSibling]) if (el instanceof HTMLButtonElement) return el;
  return null;
};

/** 过渡开始这么久以内的点按算点在旧画面上（用户看着旧画面点的），丢掉不代点：代点会点到新画面同一位置上的别的东西（主持人 11-05） */
export const EARLY_MS = 50;
/**
 * 页面内容里只代点导航类的链接和按钮（主持人 11-05 收紧）：复选框、开关、单选（input 和 role 同类、带 aria-pressed / aria-checked 的切换按钮）、
 * 文字输入、下拉、label 都不代点，免得过渡中顺手勾掉待办；删除等危险按钮自己带 data-no-proxy（设计复审五 R6-a），也不代点
 */
const TAPPABLE = 'a[href],button,[role="button"],[role="link"]';
const NOT_NAV = 'input,select,textarea,label,[data-no-proxy],[role="checkbox"],[role="switch"],[role="radio"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[aria-pressed],[aria-checked]';

/** 不该代点的：禁用的（disabled、aria-disabled），inert 里的、aria-hidden 里的（底栏的页签和“＋”也一样，代码审查 L15） */
const blocked = (el: Element): boolean => el.matches(':disabled,[aria-disabled="true"]') || el.closest('[inert],[aria-hidden="true"]') !== null;

/** 正在跑的整页过渡动画（::view-transition-* 伪元素上的） */
const vtAnims = (doc: Document): Animation[] =>
  (typeof doc.getAnimations === 'function' ? doc.getAnimations() : []).filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition') === true);

/**
 * 过渡中落在 <html> 上、底栏没接住的点按（R6）：过渡开始 EARLY_MS 以内的丢掉；否则把过渡动画放完，等伪元素层撤掉
 * （下一次画面更新才撤，最多等 10 次、每次 16 ms），按坐标找真正的目标：是导航类的链接、按钮（TAPPABLE，不是 NOT_NAV、不带 data-no-proxy），而且没禁用、不在 inert / aria-hidden 里才代点。
 * 不在过渡里（没有过渡动画）时不管：那是点在空白处
 */
function tapThrough(doc: Document, x: number, y: number): void {
  const vts = vtAnims(doc);
  if (vts.length === 0 || vts.some((a) => Number(a.currentTime ?? 0) < EARLY_MS)) return;
  for (const a of vts) a.finish();
  let tries = 0;
  const hit = (): void => {
    const at = doc.elementFromPoint(x, y);
    if ((at === null || at === doc.documentElement) && ++tries < 10) {
      setTimeout(hit, 16);
      return;
    }
    if (!at || at.closest(NOT_NAV)) return; // 表单控件（含藏在 label 里的复选框）、开关一类、危险按钮：点到的东西本身或外面套着的都算
    const el = at.closest<HTMLElement>(TAPPABLE);
    if (!el || el.matches(NOT_NAV) || blocked(el)) return;
    el.click();
  };
  hit();
}

export interface GlassBarFxProps {
  nav: RefObject<HTMLElement | null>;
  drop: RefObject<HTMLSpanElement | null>;
  /** 液滴里层（果冻放在它身上） */
  gel: RefObject<HTMLSpanElement | null>;
  /** 液滴现在在第几个页签 */
  i: number;
  /** 有没有“＋”（随手记没有）：变了就重开副本引擎 */
  hasAdd: boolean;
  kb: '1' | undefined;
  /** 电脑版侧栏（外壳按 (width >= 900px) 算好传进来）：侧栏不开副本引擎 */
  wide: boolean;
}

export function GlassBarFx({ nav, drop, gel, i, hasAdd, kb, wide }: GlassBarFxProps) {
  const glass = useRef<{ poke(ms?: number): void } | null>(null);
  // nav 挂上以后才有 portal 的落点（这个组件比外壳晚挂，第一次渲染时 nav 已经在了）
  const [host] = useState(() => nav.current);
  const gelFx = useRef<((el: HTMLElement) => boolean) | null>(null);
  useEffect(() => {
    const n = nav.current;
    const d = drop.current;
    if (!n || !d) return undefined;
    // 按住当前选中的页签才放大（D3）；按哪儿都让副本跟一会儿
    const down = (e: PointerEvent): void => {
      if (e.target instanceof Element && e.target.closest('[aria-current]')) d.dataset['state'] = 'press';
      glass.current?.poke(400);
    };
    const up = (): void => {
      delete d.dataset['state'];
    };
    const ends = ['pointerup', 'pointercancel', 'pointerleave'] as const;
    n.addEventListener('pointerdown', down);
    for (const t of ends) n.addEventListener(t, up);
    const root = n.ownerDocument.documentElement;
    const lost = (e: MouseEvent): void => {
      if (e.target !== root) return;
      const plus = plusOf(n);
      // 键盘弹着时底栏藏着（data-kb），不替它点
      const bar = getComputedStyle(n).visibility === 'hidden' ? [] : [...n.querySelectorAll<HTMLElement>('a[data-tab]'), ...(plus ? [plus] : [])];
      for (const el of bar) {
        const r = el.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
        e.preventDefault();
        if (!blocked(el)) el.click();
        return;
      }
      tapThrough(n.ownerDocument, e.clientX, e.clientY);
    };
    root.addEventListener('click', lost);
    let off = wide;
    let stop = (): void => undefined;
    import('../../../motion/glass-ghost.ts')
      .then((m) => {
        if (off) return;
        gelFx.current = m.playGel;
        const plus = plusOf(n);
        const g = m.startGlass({
          pieces: [{ el: n, fx: 'copy' }, { el: d, fx: 'drop' }, ...(hasAdd && plus ? [{ el: plus, fx: 'copy' as const }] : [])],
          adTarget: n,
        });
        glass.current = g;
        stop = g.stop;
      })
      .catch(() => undefined); // 下不来（离线）或浏览器缺 IntersectionObserver 之类：不开副本，用后备材质
    return () => {
      off = true;
      glass.current = null;
      stop();
      up();
      root.removeEventListener('click', lost);
      n.removeEventListener('pointerdown', down);
      for (const t of ends) n.removeEventListener(t, up);
    };
  }, [nav, drop, hasAdd, wide]);
  // 换页签：副本跟着液滴走（--dur-drop 0.55s）、放一次果冻；下载到时的那个位置不放
  const last = useRef(i);
  useLayoutEffect(() => {
    if (last.current === i) return;
    last.current = i;
    glass.current?.poke(700);
    const el = gel.current;
    const css = fx.jelly ?? '';
    if (!el || gelFx.current?.(el)) return;
    el.classList.remove(css);
    void el.offsetWidth; // 加回 CSS 动画类前先让样式落一次，动画才从头放
    el.classList.add(css);
  }, [i, gel]);
  return (
    <>
      <div className={fx.band} aria-hidden="true" data-kb={kb} data-testid="tabbar-band">
        <i />
        <i />
        <i />
        <i />
        <i />
        <b />
      </div>
      {host && createPortal(<span className={`${styles.glass} ${styles.adTint}`} aria-hidden="true" />, host)}
    </>
  );
}
