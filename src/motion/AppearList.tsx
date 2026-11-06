// 列表增删（架构 17.1“列表增删”“勾选完成”、17.4 B2；B2 FA-5，设计审查 M1～M3 返工 11-04）：
//   <AppearList as="ul">{items.map((x) => <AppearItem key={x.id} as="li">…</AppearItem>)}</AppearList>
// • 删除（含打勾后从原来的组离开）：一开始退场就移出文档流（按退场前量好的位置绝对定位，等于自己做的 popLayout），
//   淡出马上开始，下面的行用 layout（FLIP，只动 transform）晚两帧（LIST_LAYOUT_LAG ≈ 33 ms）收上来，收拢 --dur-ui（设计审查 M3；
//   第三轮 P1：今天页整组离开时，紧贴在下面的“今天的安排”第一帧就会碰上残影，先让残影淡两帧）。
//   淡出只用 --dur-ui 的一半（110 ms，--ease-out；减少动态效果时也是 110 ms），残影在收上来的字压过来之前就淡掉；
//   兜底：列表外壳 isolation: isolate 自成层叠上下文，离开的那一项 z-index: -1 画在收上来的行下面——
//   两处必须一起：单加 -1 会掉到外层底色（今天页红框卡片）下面（第二轮设计审查 N1）
//   不用 AnimatePresence 的 mode="popLayout"：它会插内联 <style>，被 CSP 拦（2.0；ESLint 也拦，UI-4 L-4）；
//   这里的定位写在元素的 style 上（React 走 CSSOM），CSP 不拦
// • 新增（含撤销恢复、打勾后挪进“已完成”组）：只淡入、不上移，并且晚 --dur-ui 的一半才开始——ease-out 前段快，
//   这时周围的行已基本让开，新行看得见的时候不和任何一行叠着（设计审查 M2；第二轮 L1 把等待从 220 减到 110 ms；
//   第三轮 P1 收拢晚了 LIST_LAYOUT_LAG，等待同步加上，≈ 143 ms）。
//   淡入播完以前打 data-state="entering"、不接点按（透明的时候点不到看不见的圆圈或 ×，第二轮 L3）。
//   淡入和周围行的 layout 位移必须走同一个时钟（MOTION-list-undo-flaky，11-05）：opacity 默认被 Motion 交给 WAAPI 在合成器上按墙钟播，
//   layout 位移是 JS 帧循环推的；主线程一忙（webkit 实测位移在 FLIP 起点停了 500 ms 以上），淡入照样播完，新行显出来时下面那组还没让开、
//   字叠在一起。所以进场中给元素挂一个空的 onUpdate——Motion 见到 onUpdate 就不走 WAAPI（motion-dom supportsBrowserAnimation），
//   淡入改由同一个帧循环推，位移卡住时淡入也一起等。退场不挂：退场的残影淡出要快、不等别人（下面的行收上来本来就晚两帧）。
//   起点也要对齐：淡入的计时原来从挂载那一刻起，周围行的位移要等下一帧帧循环才开始（负载下差 200 ms 以上，实测淡到 0.57 时位移才走六成）；
//   所以新行挂上以后先停在 opacity 0，等挂载后的第一帧回来（这时位移已经开始）才把 animate 换成淡入，等待和时长照旧从那一刻算
// • 打勾“圆圈先填满再离开”的那一拍（17.1）不在这里等：页面用 useHoldView 让分组晚 --dur-ui 再变，列表里那一刻什么都不动（M1）
// • 第一次画列表不播（initial={false}）：冷启动、进页面不逐条入场
// • 离开途中打 data-state="leaving"（17.2 第 2 点），使用方据此不接点按（免得点到正在淡出的那一行）；
//   同时带 inert（FA-6 ② 审查 L3，和 Appear 一致）：Tab 进不去正在淡出的行里的 × 和打勾框，读屏也不念
// • 减少动态效果：和 <Appear> 同一个判断，只淡入淡出、时长减半、新行不等；MotionConfig 让 layout 位移直接到位
// • 功能包异步加载（B2 FA-6 ②，见 ./features.ts）：功能包还没到时加进来的行直接显示（initial={false}），不打“进场中”、照常接点按；
//   不会停在 opacity 0。这段时间里删掉的行当场移除（没有淡出、下面的行直接跳上来）
import { AnimatePresence, LayoutGroup, LazyMotion, m, MotionConfig, PresenceContext, useIsPresent, type MotionStyle } from 'motion/react';
import { createElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { motionFeatures, motionFeaturesReady } from './features.ts';
import { dur, LIST_LAYOUT_LAG, tr } from './tokens.ts';
import { useReducedMotionPref } from './useReducedMotionPref.ts';

type ListTag = 'ul' | 'ol' | 'div';
type ItemTag = 'li' | 'section' | 'div';

export interface AppearListProps {
  as?: ListTag;
  className?: string | undefined;
  children: ReactNode;
  'data-testid'?: string | undefined;
}

/** 外壳要是定位元素：离开的那一项按它定位（offsetTop / offsetLeft 也是相对它量的）；
 *  isolation 让它自成层叠上下文，离开那一项的 z-index: -1 只沉到这个列表里别的行下面，不掉到外层底色下面 */
const LIST_STYLE: CSSProperties = { position: 'relative', isolation: 'isolate' };

/** 列表外壳：子元素要带稳定的 key（AnimatePresence 靠 key 认出谁走了） */
export function AppearList({ as = 'ul', className, children, ...rest }: AppearListProps) {
  const reduced = useReducedMotionPref();
  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <LazyMotion features={motionFeatures()} strict>
        <LayoutGroup>
          {createElement(as, { className, style: LIST_STYLE, 'data-testid': rest['data-testid'] }, <AnimatePresence initial={false}>{children}</AnimatePresence>)}
        </LayoutGroup>
      </LazyMotion>
    </MotionConfig>
  );
}

export interface AppearItemProps {
  as?: ItemTag;
  className?: string | undefined;
  /** 整组（section）进出时用：标题的 id */
  'aria-labelledby'?: string | undefined;
  children: ReactNode;
  [data: `data-${string}`]: string | undefined;
}

const tags = { li: m.li, section: m.section, div: m.div } as const;

/** 列表项交给 Motion 的参数（组件和测试共用一份） */
export function itemMotion(reduced: boolean) {
  const t = reduced ? { ...tr.ui, duration: dur.ui / 2 } : tr.ui;
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    // 退场马上开始（和收拢同时），只淡出、--dur-ui 的一半，减少动态效果时同样 110 ms（不再减半，N1）；
    // 进场等周围基本让开（--dur-ui 的一半，加上收拢晚开始的 LIST_LAYOUT_LAG）再淡入；
    // 收拢晚 LIST_LAYOUT_LAG 开始（残影先淡两帧）。减少动态效果时都不等（layout 本来就直接到位）
    exit: { opacity: 0, transition: { ...tr.ui, duration: dur.ui / 2 } },
    transition: {
      ...t,
      delay: reduced ? 0 : dur.ui / 2 + LIST_LAYOUT_LAG,
      layout: reduced ? tr.ui : { ...tr.ui, delay: LIST_LAYOUT_LAG },
    },
  };
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 离开时的定位：按开始离开那一刻的位置、大小绝对定位，下面的行立刻收上来（只这一项，不影响别的） */
function popStyle(b: Box): MotionStyle {
  return { position: 'absolute', top: b.top, left: b.left, width: b.width, height: b.height, margin: 0, zIndex: -1 };
}

/** 淡入播完以前：不接点按（第二轮 L3） */
const ENTERING_STYLE: MotionStyle = { pointerEvents: 'none' };

/** 进场中挂上：有 onUpdate 时 Motion 不用 WAAPI，淡入和周围行的 layout 位移由同一个 JS 帧循环推（见文件头） */
const SAME_CLOCK = (): void => undefined;

/** 列表里的一项：进出场只动 opacity，位置变化用 layout 平移过去 */
export function AppearItem({ as = 'li', className, children, ...data }: AppearItemProps) {
  const present = useIsPresent();
  // 第一次画列表时（AnimatePresence initial={false}）不播进场，也就不算“进场中”；之后加进来的才算
  const firstPaint = useContext(PresenceContext)?.initial === false;
  // 功能包还没到时挂上的：Motion 不会补播它的入场（FA-6 ②），直接显示，不算“进场中”
  const [cold] = useState(() => !motionFeaturesReady());
  const [entering, setEntering] = useState(!firstPaint && !cold);
  // 进场的淡入等挂载后第一帧再开始（见文件头“起点也要对齐”）；不进场的（第一次画、冷挂上）直接是 true
  const [go, setGo] = useState(!entering);
  useEffect(() => {
    if (go) return;
    const id = requestAnimationFrame(() => setGo(true));
    return () => cancelAnimationFrame(id);
  }, [go]);
  const goRef = useRef(go);
  // 在提交以后同步（审查 L3：render 里写会被丢弃的 render 带偏）
  useLayoutEffect(() => {
    goRef.current = go;
  }, [go]);
  // 还没开始淡入时 Motion 也可能报一次“动画完成”（animate 和 initial 一样是 0）：那一次不算进场完
  const entered = useCallback(() => {
    if (goRef.current) setEntering(false);
  }, []);
  const reduced = useReducedMotionPref();
  const mo = itemMotion(reduced);
  const Tag = tags[as];
  const el = useRef<HTMLElement | null>(null);
  // 三种标签共用一个回调 ref（RefObject 对不上 li / section / div 的交叉类型）
  const setEl = useCallback((e: HTMLElement | null) => {
    el.current = e;
  }, []);
  // 开始离开的那一次渲染：读这一项现在的位置、大小（相对列表外壳；已经提交的布局，不受 FLIP 的 transform 影响），
  // 和“这一项被删掉”同一次提交里移出文档流。只量一次：之后它已经是绝对定位，再量也一样，但没必要。
  // 退场途中同一个 key 又被加回来（Motion 复用同一个实例）：回到 present 时清掉，下次离开重新量（FA5-CR-low A1）
  const popped = useRef<MotionStyle | undefined>(undefined);
  if (present) popped.current = undefined;
  if (!present && popped.current === undefined && el.current) {
    const e = el.current;
    popped.current = popStyle({ top: e.offsetTop, left: e.offsetLeft, width: e.offsetWidth, height: e.offsetHeight });
  }
  const leaving = present ? undefined : popped.current;
  const style = leaving ?? (entering ? ENTERING_STYLE : undefined);
  return (
    <Tag
      {...data}
      ref={setEl}
      className={className}
      {...(style ? { style } : {})}
      data-state={present ? (entering ? 'entering' : data['data-state']) : 'leaving'}
      // 离开途中键盘、读屏也碰不到（和 Appear 一致；FA-6 ② 审查 L3）：pointer-events 只挡鼠标和触摸
      inert={present ? undefined : true}
      layout="position"
      initial={cold ? false : mo.initial}
      animate={go ? mo.animate : mo.initial}
      exit={mo.exit}
      transition={mo.transition}
      onAnimationComplete={entered}
      {...(entering ? { onUpdate: SAME_CLOCK } : {})}
    >
      {children}
    </Tag>
  );
}
