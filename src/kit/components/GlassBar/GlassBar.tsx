// 液态玻璃底栏（B2 FA-7；架构 0.27 第 5 点 R-153、0.25 渐进模糊带；设计稿 皮肤-v4/液态玻璃-真机试验.html；方案 docs/09-路线图/B2-FA7-液态玻璃-实现方案.md）
// 这个文件是首屏的外壳：4 个页签、“＋”、液滴，材质先用 backdrop-filter 后备（--g-tint-fb）；减少透明效果时一直是实色。
// 首屏用不着的（底部实色带、玻璃标记、帧循环、果冻、按住放大）在 GlassBarFx.tsx，首屏画完后才下载（主持人 11-05 首屏选 ③）；
// 下载到以前和下不来时：没有模糊带、果冻、按住放大，材质用后备。
// • 页签是 <a href>，选中项 aria-current="page"；“＋”是 Pressable（按下回弹，设计动效评审 L3），没有新建动作的页（随手记）不出
// • 液滴：用 --i（第几个页签）做 translate；减少动态效果时直接换位置（CSS 两段覆盖）
//   点页签时液滴马上往那边走，不等路由换过来（webkit 切到要下载的页时路由要晚 0.3 秒；设计动效评审 D1）：记下“从哪页点到哪页”，
//   路由还是那一页就按点的那个画，路由一变就作废、用路由的
// • 两个皮肤都用（负责人 11-05 ④）
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react';
import { hrefOf } from '../../../app/router.ts';
import { Pressable } from '../../../motion/components.ts';
import { useT } from '../../hooks/useT.ts';
import type { GlassBarFxProps } from './GlassBarFx.tsx';
import styles from './GlassBar.module.css';

export type TabName = 'today' | 'calendar' | 'todos' | 'notes';
const TABS: readonly TabName[] = ['today', 'calendar', 'todos', 'notes'];
// 图标照试验页（今天 ◎、日历 ▦、待办 ✓、随手记 ✎），24 格、描边 2
const ICONS: Record<TabName, string> = {
  today: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z',
  calendar: 'M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM4 10h16M9 5v15M15 5v15M4 15h16',
  todos: 'M5 12.5l4.5 4.5L19 7.5',
  notes: 'M15 5l4 4-10 10H5v-4z',
};

// 电脑版侧栏（D5，(width >= 900px)，和 GlassBar.module.css、base.css 那段媒体查询一样）：侧栏里“＋”画在最上面，
// DOM 也把它放到 nav 前面，Tab 顺序和画面上下一致（设计复审三 S2）；窄屏“＋”在底栏右边，DOM 在 nav 后面
const wideMq = (): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia('(width >= 900px)') : null);
const onWide = (fn: () => void): (() => void) => {
  const mq = wideMq();
  mq?.addEventListener('change', fn);
  return () => mq?.removeEventListener('change', fn);
};
const isWide = (): boolean => wideMq()?.matches ?? false;

export interface GlassBarProps {
  active: TabName;
  /** “＋”：按页新建（今天、日历新建日程，待办新建待办）；不传就不出“＋” */
  add?: { label: string; onClick(): void };
  /** 什么时候下载首屏后部分（GlassBarFx.tsx）：App 传 afterAppPainted（首屏画完以后；kit 不直接依赖 platform）；不传就马上 */
  later?: (fn: () => void) => void;
  /** 键盘弹着：底栏、“＋”、模糊带都藏起来（FA-7 第 3 项；App 订阅 platform/viewport.ts） */
  hide?: boolean;
}

export function GlassBar({ active, add, later = (fn) => fn(), hide = false }: GlassBarProps) {
  const kb = hide ? '1' : undefined;
  const t = useT();
  const [want, setWant] = useState<{ from: TabName; to: TabName } | null>(null);
  // 路由换了（点过去到了，或者后退、别处跳走）就作废：不然后退回原页时又会按旧的“点到哪页”画
  if (want !== null && want.from !== active) setWant(null);
  const shown = want !== null && want.from === active ? want.to : active;
  const i = TABS.indexOf(shown);
  // 液滴位置用 CSSOM 写（style.setProperty）：不走 React 的 style 属性，CSP 的 style-src-attr 不放行内联 style（webkit 实测会报）
  const dropEl = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => dropEl.current?.style.setProperty('--i', String(i)), [i]);
  const navEl = useRef<HTMLElement>(null);
  const gelEl = useRef<HTMLSpanElement>(null);
  const wide = useSyncExternalStore(onWide, isWide);
  const [Fx, setFx] = useState<ComponentType<GlassBarFxProps> | null>(null);
  useEffect(() => {
    let off = false;
    later(() => {
      import('./GlassBarFx.tsx')
        .then((m) => off || setFx(() => m.GlassBarFx))
        .catch(() => undefined); // 下不来（离线）：一直用后备材质
    });
    return () => {
      off = true;
    };
    // later 每次渲染可能是新函数，只在挂载时下载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fab = add && (
    <Pressable type="button" className={styles.fab} aria-label={add.label} onClick={add.onClick} data-testid="tabbar-add" data-kb={kb}>
      <span className={`${styles.glass} ${styles.fabTint}`} aria-hidden="true" />
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </Pressable>
  );
  return (
    <>
      {Fx && <Fx nav={navEl} drop={dropEl} gel={gelEl} i={i} hasAdd={add !== undefined} kb={kb} wide={wide} />}
      {wide && fab}
      <nav
        className={styles.bar}
        aria-label={t('nav.label', {})}
        data-testid="tabbar"
        data-kb={kb}
        ref={navEl}
      >
        <span className={`${styles.glass} ${styles.barTint}`} aria-hidden="true" />
        <span ref={dropEl} className={styles.drop} aria-hidden="true">
          <span ref={gelEl} className={styles.jellyJs}>
            <span className={`${styles.glass} ${styles.pill}`} />
          </span>
        </span>
        {TABS.map((name) => (
          <a
            key={name}
            className={styles.tab}
            href={hrefOf(name)}
            aria-current={name === active ? 'page' : undefined}
            data-tab={name}
            onClick={(e) => {
              // 新标签页打开（按着修饰键、中键）不算换页
              if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) setWant({ from: active, to: name });
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={ICONS[name]} />
            </svg>
            <span>{t(`nav.${name}`, {})}</span>
          </a>
        ))}
        {/* 侧栏最下面的设置入口（头像，D5）：在首屏外壳里，首屏后部分下不来时宽屏也有设置入口（设计复审三 S1）；窄屏不显示，用今天页右上角的 */}
        <a className={styles.me} href={hrefOf('settings')} aria-label={t('app.settings', {})} data-testid="tabbar-settings">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0" />
          </svg>
        </a>
      </nav>
      {!wide && fab}
    </>
  );
}
