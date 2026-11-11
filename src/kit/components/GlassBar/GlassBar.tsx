// 液态玻璃底栏（B2 FA-7；架构 0.27 第 5 点 R-153、0.25 渐进模糊带；设计稿 皮肤-v4/液态玻璃-真机试验.html；方案 docs/09-路线图/B2-FA7-液态玻璃-实现方案.md）
// 这个文件是首屏的外壳：4 个页签、“＋”、液滴，材质先用 backdrop-filter 后备（--g-tint-fb）；减少透明效果时一直是实色。
// 首屏用不着的（底部实色带、玻璃标记、帧循环、果冻、按住放大）在 GlassBarFx.tsx，首屏画完后才下载（主持人 11-05 首屏选 ③）；
// 下载到以前和下不来时：没有模糊带、果冻、按住放大，材质用后备。
// • 页签是 <a href>（新标签页打开照常），点按交给 navigateTab 按层级记历史（R-372）；选中项 aria-current="page"；“＋”是 Pressable（按下回弹，设计动效评审 L3），没有新建动作的页（随手记）不出
// • 液滴：用 --i（第几个页签）做 translate；减少动态效果时直接换位置（CSS 两段覆盖）
//   点页签时液滴马上往那边走，不等路由换过来（webkit 切到要下载的页时路由要晚 0.3 秒；设计动效评审 D1）：记下“从哪页点到哪页”，
//   路由还是那一页就按点的那个画，路由一变就作废、用路由的
// • 两个皮肤都用（负责人 11-05 ④）
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { hrefOf, navigateTab, plainClick } from '../../../app/router.ts';
import { Pressable } from '../../../motion/components.ts';
import { MQ_SIDEBAR, useMedia } from '../../hooks/useMedia.ts';
import { useT } from '../../hooks/useT.ts';
import type { GlassBarFxProps } from './GlassBarFx.tsx';
import styles from './GlassBar.module.css';

/** 下载到的首屏后部分（模块级缓存）：没有底栏的页（新建、编辑、设置）会卸掉底栏，回来时重新挂载，
 *  这时直接同步用缓存、和外壳同一次画出来，实色带第一帧就在（主持人 11-07 复查：重挂不许再从 0 淡入、红线以下透字） */
let loadedFx: ComponentType<GlassBarFxProps> | null = null;
/** @internal 仅测试用：清掉缓存，回到“这次启动还没下载过”的状态 */
export function __forgetGlassBarFxForTest(): void {
  loadedFx = null;
}

/** 去掉 data-fade 前在 --dur-ui 之外多等的余量 */
export const FADE_SLACK_MS = 100;
/** --dur-ui（tokens.css，如 220ms / .22s）换成毫秒；读不到按 220 */
function durUiMs(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-ui').trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 220;
  return v.endsWith('ms') ? n : n * 1000;
}

export type TabName = 'today' | 'calendar' | 'todos' | 'notes';
const TABS: readonly TabName[] = ['today', 'calendar', 'todos', 'notes'];
// 图标照试验页（今天 ◎、日历 ▦、待办 ✓、随手记 ✎），24 格、描边 2
const ICONS: Record<TabName, string> = {
  today: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z',
  calendar: 'M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM4 10h16M9 5v15M15 5v15M4 15h16',
  todos: 'M5 12.5l4.5 4.5L19 7.5',
  notes: 'M15 5l4 4-10 10H5v-4z',
};

export interface GlassBarProps {
  active: TabName;
  /** “＋”：按页新建（今天、日历新建日程，待办新建待办）；不传就不出“＋” */
  add?: { label: string; onClick(): void };
  /** 什么时候下载首屏后部分（GlassBarFx.tsx）：App 传 afterAppPainted（首屏画完以后；kit 不直接依赖 platform）；不传就马上 */
  later?: (fn: () => void) => void;
}

/** 键盘弹着时底栏、“＋”、实色带、渐隐层藏起来（FA-7 第 3 项）：只靠根节点 data-kbhide（platform/viewport.ts 写）和样式，不走属性 */
export function GlassBar({ active, add, later = (fn) => fn() }: GlassBarProps) {
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
  // 电脑版侧栏（D5，kit/hooks/useMedia.ts 的 MQ_SIDEBAR）：侧栏里“＋”画在最上面，
  // DOM 也把它放到 nav 前面，Tab 顺序和画面上下一致（设计复审三 S2）；窄屏“＋”在底栏右边，DOM 在 nav 后面
  const wide = useMedia(MQ_SIDEBAR);
  const [Fx, setFx] = useState<ComponentType<GlassBarFxProps> | null>(() => loadedFx);
  // 只有这次挂载以后才异步到的那一次（启动时）实色带、渐隐层才淡入；用缓存同步画出来的不淡入
  const [fadeIn, setFadeIn] = useState(false);
  // 淡入放完（--dur-ui，再留 FADE_SLACK_MS）就去掉 data-fade：不然之后从 display: none 变回显示（关掉减少透明效果、
  // 900px 上下拖宽度）时 @starting-style 又会生效、再淡入一次（主持人 11-07 第三轮复查）。还在等安全区时去掉也没关系：
  // 放行时走的是 data-inset-wait 那条普通过渡，不靠 @starting-style
  useEffect(() => {
    if (!fadeIn) return undefined;
    const id = setTimeout(() => setFadeIn(false), durUiMs() + FADE_SLACK_MS);
    return () => clearTimeout(id);
  }, [fadeIn]);
  useEffect(() => {
    if (loadedFx) return;
    let off = false;
    later(() => {
      import('./GlassBarFx.tsx')
        .then((m) => {
          loadedFx = m.GlassBarFx;
          if (off) return;
          setFadeIn(true);
          setFx(() => m.GlassBarFx);
        })
        .catch(() => undefined); // 下不来（离线）：一直用后备材质
    });
    return () => {
      off = true;
    };
    // later 每次渲染可能是新函数，只在挂载时下载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fab = add && (
    <Pressable type="button" className={styles.fab} aria-label={add.label} onClick={add.onClick} data-testid="tabbar-add">
      <span className={`${styles.glass} ${styles.fabTint}`} aria-hidden="true" />
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </Pressable>
  );
  return (
    <>
      {wide && fab}
      <nav
        className={styles.bar}
        aria-label={t('nav.label', {})}
        data-testid="tabbar"
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
              // 新标签页打开（按着修饰键、中键）不算换页，照浏览器默认；普通点击按层级记历史（R-372）：不让链接自己压一条，
              // 交给 navigateTab（今天 → 别的页签压一条，页签之间原地换，回今天能退就退）
              if (!plainClick(e)) return;
              setWant({ from: active, to: name });
              navigateTab(name);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={ICONS[name]} />
            </svg>
            <span>{t(`nav.${name}`, {})}</span>
          </a>
        ))}
        {/* 侧栏最下面的设置入口（头像，D5）：在首屏外壳里，首屏后部分下不来时宽屏也有设置入口（设计复审三 S1）；窄屏不显示，用今天页右上角的 */}
        {/* 点了按页签那套记历史（R-372 代码审建议）：从今天进压一条，从别的页签进原地换，设置里“‹ 今天”、左滑都回今天 */}
        <a className={styles.me} href={hrefOf('settings')} onClick={(e) => plainClick(e) && navigateTab('settings')} aria-label={t('app.settings', {})} data-testid="tabbar-settings">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0" />
          </svg>
        </a>
      </nav>
      {!wide && fab}
      {/* 放在外壳后面：底栏重挂时 Fx 用缓存和外壳同一次提交，它的 useLayoutEffect 要在 nav、液滴的 ref 挂上以后才跑（排在前面时 nav.current 还是空，点按代理挂不上）。
          实色带、渐隐层是 fixed + z-index 9，叠放不看 DOM 先后 */}
      {Fx && <Fx nav={navEl} drop={dropEl} gel={gelEl} i={i} hasAdd={add !== undefined} wide={wide} fadeIn={fadeIn} />}
    </>
  );
}
