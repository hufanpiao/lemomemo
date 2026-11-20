// 液态玻璃底栏的“首屏后”部分（B2 FA-7；主持人 11-05 首屏选 ③）：外壳 GlassBar.tsx 首屏画完以后才下载这个文件
// • 底部实色带（11-06 负责人真机 69659c1“底部导航栏透明又没了！！ 这个不要动！”）：实色 --bg 只铺在底栏底边以下到屏幕底，往上 --band-fade 渐隐；底栏和“＋”后面不垫实色，照样透出模糊的内容（GlassBarFx.module.css）；上沿外再加 --edge-fade 渐隐（.edge，负责人 11-06 选 B12），底栏、“＋”的形状挖掉；• 按住当前选中的页签放大（D3，data-state=press）
// • 自动深浅（深色玻璃层 .adTint、data-ad）11-06 取消（主持人方案甲，当时的理由是底栏后面是实色；实色带改回只铺底栏以下以后，负责人 11-06 定不恢复）
// • 玻璃标记、帧循环（motion/glass-ghost.ts）：这个文件挂上以后再 import()（0.31 第 6 条：motion 以外不准静态引它）
// • 切页过渡期间的点按（原来的 R4、R6 按坐标代点）11-20 删掉：进出二级页不再用 View Transition（motion/page-swap.ts 的 transition），
//   过渡中点按直接落在真元素上，不用再替它点
// • 实色带、上沿渐隐是 main 外面的 fixed 层：整页推页时 motion/page-swap.ts 把它们当成页面的一部分，跟着自己那一页一起滑
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

export interface GlassBarFxProps {
  nav: RefObject<HTMLElement | null>;
  drop: RefObject<HTMLSpanElement | null>;
  /** 液滴里层（果冻放在它身上） */
  gel: RefObject<HTMLSpanElement | null>;
  /** 液滴现在在第几个页签 */
  i: number;
  /** 有没有“＋”（随手记没有）：变了就重开副本引擎 */
  hasAdd: boolean;
  /** 电脑版侧栏（外壳按 (width >= 900px) 算好传进来）：侧栏不开副本引擎 */
  wide: boolean;
  /** 启动时异步下载到、晚于外壳挂上的那一次：实色带、渐隐层从 0 淡入（data-fade，@starting-style）；底栏重挂时用缓存同步画，不淡入 */
  fadeIn?: boolean;
}

export function GlassBarFx({ nav, drop, gel, i, hasAdd, wide, fadeIn = false }: GlassBarFxProps) {
  const glass = useRef<{ poke(ms?: number): void } | null>(null);
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
    let off = wide;
    let stop = (): void => undefined;
    import('../../../motion/glass-ghost.ts')
      .then((m) => {
        m.forgetTilt(); // 不分宽窄屏都删以前的倾斜高光开关（R-373）
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
      <div className={fx.band} aria-hidden="true" data-fade={fadeIn ? '1' : undefined} data-testid="tabbar-band" />
      {/* 上沿外渐隐（B12）：在实色带后面挂，叠在它上面；没有“＋”时不挖那个圆 */}
      <div className={fx.edge} aria-hidden="true" data-add={hasAdd ? '1' : '0'} data-fade={fadeIn ? '1' : undefined} data-testid="tabbar-edge">
        <div className={fx.edgeTint} />
      </div>
    </>
  );
}
