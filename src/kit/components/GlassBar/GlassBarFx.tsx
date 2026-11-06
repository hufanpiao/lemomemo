// 液态玻璃底栏的“首屏后”部分（B2 FA-7；主持人 11-05 首屏选 ③）：外壳 GlassBar.tsx 首屏画完以后才下载这个文件
// • 底部实色带（11-06 负责人真机 69659c1“底部导航栏透明又没了！！ 这个不要动！”）：实色 --bg 只铺在底栏底边以下到屏幕底，往上 --band-fade 渐隐；底栏和“＋”后面不垫实色，照样透出模糊的内容（GlassBarFx.module.css）；上沿外再加 --edge-fade 渐隐（.edge，负责人 11-06 选 B12），底栏、“＋”的形状挖掉；• 按住当前选中的页签放大（D3，data-state=press）
// • 自动深浅（深色玻璃层 .adTint、data-ad）11-06 取消（主持人方案甲，当时的理由是底栏后面是实色；实色带改回只铺底栏以下以后，负责人 11-06 定不恢复）
// • 玻璃标记、帧循环、倾斜高光（motion/glass-ghost.ts）：这个文件挂上以后再 import()（0.31 第 6 条：motion 以外不准静态引它）
// • 切页过渡期间的点按（设计复审二 R4）：过渡进行中浏览器把点按都算到 <html> 上（::view-transition 的 pointer-events 不管用），
//   底栏的页签和“＋”接不到；落在 <html> 上的点按按坐标找底栏里的页签或“＋”，替它点一下，马上开始下一次切页（新的过渡会打断旧的）
//   页面内容（设计复审三 R6，主持人 11-05 定做法 A，首屏 0 字节）：底栏没接住的，先把过渡放完，再按坐标找真正的目标代点（tapThrough）
//   R4、R6 都还要（11-06 代码审查方案 B：R6 曾删掉，后恢复）：页签互切不起 View Transition 了，可从编辑页、设置回到页签页时
//   GlassBar 在过渡回调里重新挂上，这个文件第二次下载是缓存，几毫秒就挂好，0.38 秒的过渡里它是在的，点底栏、点页面内容都靠它（这两项的监听在 useLayoutEffect 里，提交时就挂上）
// • 电脑版侧栏（D5，(width >= 900px)，外壳传 wide）：侧栏不用内容副本，宽屏时不开副本引擎；设置入口（头像）在外壳里（设计复审三 S1）
// • 液滴果冻（L1：副本引擎到了用它的 playGel，WAAPI 从当前形变接着放；没到或做不了时给里层重新加 CSS 动画类 .jelly）
// 外壳只留首屏必须的：页签、“＋”、液滴位置和点下就走（D1）。这个文件下不来（离线）时：没有实色带、没有果冻和按住放大，材质用后备
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import fx from './GlassBarFx.module.css';

/** “＋”：窄屏紧跟在 nav 后面，宽屏（侧栏）在 nav 前面（Pressable 不接 ref） */
const plusOf = (n: HTMLElement): HTMLButtonElement | null => {
  for (const el of [n.nextElementSibling, n.previousElementSibling]) if (el instanceof HTMLButtonElement) return el;
  return null;
};

/** 过渡开始这么久以内的点按算点在旧画面上（用户看着旧画面点的），丢掉不代点：代点会点到新画面同一位置上的别的东西（主持人 11-05） */
export const EARLY_MS = 50;
/**
 * 过渡放完以后，伪元素层要等下一次画面更新才撤：每隔 16 ms 找一次，最多找到点按后 HIT_MS（按挂钟算，代码审查 p1 M2）。
 * 原来按次数算（10 次约 160 ms，后来 120 次）：CI 的 Linux webkit 一帧要几百毫秒，次数上限在慢机上要么太短、要么远超 2 秒（11-06 ci-webkit-probe）
 */
export const HIT_MS = 2000;
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
 * （下一次画面更新才撤，最多等 HIT_MS），按坐标找真正的目标：是导航类的链接、按钮（TAPPABLE，不是 NOT_NAV、不带 data-no-proxy），而且没禁用、不在 inert / aria-hidden 里才代点。
 * 不在过渡里（没有过渡动画）时不管：那是点在空白处。
 * 返回取消函数（代码审查 p1 M1）：调用方同一时刻只留一个待发代点，用户又按下、组件卸载时取消；
 * 等待中换了路由（location.href 变了）或又进入新的过渡（出现没放完过的过渡动画）也放弃，免得点到新页面上
 */
function tapThrough(doc: Document, x: number, y: number): (() => void) | null {
  const vts = vtAnims(doc);
  if (vts.length === 0 || vts.some((a) => Number(a.currentTime ?? 0) < EARLY_MS)) return null;
  for (const a of vts) a.finish();
  const done = new Set(vts);
  const route = doc.location.href;
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dead = false;
  const hit = (): void => {
    timer = undefined;
    if (dead || doc.location.href !== route || vtAnims(doc).some((a) => !done.has(a))) return;
    const at = doc.elementFromPoint(x, y);
    if ((at === null || at === doc.documentElement) && Date.now() - t0 < HIT_MS) {
      timer = setTimeout(hit, 16);
      return;
    }
    dead = true;
    if (!at || at.closest(NOT_NAV)) return; // 表单控件（含藏在 label 里的复选框）、开关一类、危险按钮：点到的东西本身或外面套着的都算
    const el = at.closest<HTMLElement>(TAPPABLE);
    if (!el || el.matches(NOT_NAV) || blocked(el)) return;
    el.click();
  };
  hit();
  return () => {
    dead = true;
    if (timer !== undefined) clearTimeout(timer);
  };
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
  /** 启动时异步下载到、晚于外壳挂上的那一次：实色带、渐隐层从 0 淡入（data-fade，@starting-style）；底栏重挂时用缓存同步画，不淡入 */
  fadeIn?: boolean;
}

export function GlassBarFx({ nav, drop, gel, i, hasAdd, kb, wide, fadeIn = false }: GlassBarFxProps) {
  const glass = useRef<{ poke(ms?: number): void } | null>(null);
  const gelFx = useRef<((el: HTMLElement) => boolean) | null>(null);
  // 过渡中的点按（R4、R6）在提交时就挂上（useLayoutEffect）：从设置回今天时 GlassBar 在过渡回调里重新挂上，
  // webkit 过渡中被动 effect（useEffect）要晚约 100 ms 才跑（11-06 e2e 实测：点按 3244 ms、监听 3249 ms 才挂上），这段时间点页面内容会落空
  useLayoutEffect(() => {
    const n = nav.current;
    if (!n) return undefined;
    const doc = n.ownerDocument;
    const root = doc.documentElement;
    // 同一时刻只留一个待发代点（代码审查 p1 M1）：用户自己又按下（capture，先于页面处理）、再次代点、卸载时取消
    let pending: (() => void) | null = null;
    const cancelTap = (): void => {
      pending?.();
      pending = null;
    };
    doc.addEventListener('pointerdown', cancelTap, true);
    const lost = (e: MouseEvent): void => {
      if (e.target !== root) return;
      const plus = plusOf(n);
      // 键盘弹着时底栏藏着（data-kb），不替它点
      const bar = getComputedStyle(n).visibility === 'hidden' ? [] : [...n.querySelectorAll<HTMLElement>('a[data-tab]'), ...(plus ? [plus] : [])];
      cancelTap();
      for (const el of bar) {
        const r = el.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
        e.preventDefault();
        if (!blocked(el)) el.click();
        return;
      }
      pending = tapThrough(doc, e.clientX, e.clientY);
    };
    root.addEventListener('click', lost);
    return () => {
      cancelTap();
      doc.removeEventListener('pointerdown', cancelTap, true);
      root.removeEventListener('click', lost);
    };
  }, [nav]);
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
    let off = wide;
    let stop = (): void => undefined;
    import('../../../motion/glass-ghost.ts')
      .then((m) => {
        if (off) return;
        gelFx.current = m.playGel;
        const plus = plusOf(n);
        const g = m.startGlass({
          pieces: [{ el: n, fx: 'copy' }, { el: d, fx: 'drop' }, ...(hasAdd && plus ? [{ el: plus, fx: 'copy' as const }] : [])],
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
      <div className={fx.band} aria-hidden="true" data-kb={kb} data-fade={fadeIn ? '1' : undefined} data-testid="tabbar-band" />
      {/* 上沿外渐隐（B12）：在实色带后面挂，叠在它上面；没有“＋”时不挖那个圆 */}
      <div className={fx.edge} aria-hidden="true" data-kb={kb} data-add={hasAdd ? '1' : '0'} data-fade={fadeIn ? '1' : undefined} data-testid="tabbar-edge">
        <div className={fx.edgeTint} />
      </div>
    </>
  );
}
