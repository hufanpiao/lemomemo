// 列表增删 <AppearList> / <AppearItem>（架构 17.1、17.4 B2；B2 FA-5）的门面（R-354 做法 A，主持人 11-07 定）：只依赖 react，进首屏。
//   <AppearList as="ul">{items.map((x) => <AppearItem key={x.id} as="li">…</AppearItem>)}</AppearList>
// 真正的删行淡出、layout 收拢、加行淡入在 ./list-impl.tsx（motion 实现，首屏画完以后下载，见 ./features.ts）。
// • 挂上时动画实现已经到了：直接用实现
// • 还没到（今天页冷启动）：画静态的，和 motion 冷渲染逐属性一致——外壳 style="position: relative; isolation: isolate"，
//   每行 style="opacity: 1"，带原样的 className、data-*、aria-labelledby，不打 entering（__tests__/facade-dom.test.tsx）。
//   这段时间里删掉的行当场移除、新加的行直接显示（和原来功能包没到时一样）
// • 实现到了以后在安全的时机换上（整个列表子树重挂一次，DOM 一样，看不出来）：焦点不在列表里、没有按住的指针、
//   不在 useHoldView 停一拍期间，三件都满足才换，否则隔一会儿再看（./swap-guard.ts）。换完以后删行、打勾、撤销的动画和原来一样
// • 重挂会丢行内的临时状态：现在行内只有 Pressable 的按下态（按住时不换）；以后行里有别的状态要记得这一条
import { createContext, createElement, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { canSwap, SWAP_RETRY_MS, useMotionImpl, watchPointers } from './swap-guard.ts';

type ListTag = 'ul' | 'ol' | 'div';
type ItemTag = 'li' | 'section' | 'div';

export interface AppearListProps {
  as?: ListTag;
  className?: string | undefined;
  children: ReactNode;
  'data-testid'?: string | undefined;
}

export interface AppearItemProps {
  as?: ItemTag;
  className?: string | undefined;
  /** 整组（section）进出时用：标题的 id */
  'aria-labelledby'?: string | undefined;
  children: ReactNode;
  [data: `data-${string}`]: string | undefined;
}

/** 和 list-impl.tsx 的 LIST_STYLE 一致 */
const LIST_STYLE: CSSProperties = { position: 'relative', isolation: 'isolate' };
/** motion 冷渲染（initial={false}、animate={{ opacity: 1 }}）写的内联样式 */
const ITEM_STYLE: CSSProperties = { opacity: 1 };

/** 外壳现在用的是不是动画实现（行跟着外壳走） */
const LiveCtx = createContext(false);

export function AppearList(props: AppearListProps) {
  const impl = useMotionImpl();
  const [live, setLive] = useState(() => impl !== null);
  const el = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!live) watchPointers();
  }, [live]);
  useEffect(() => {
    if (live || impl === null) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (canSwap(el.current)) setLive(true);
      else t = setTimeout(attempt, SWAP_RETRY_MS);
    };
    attempt();
    return () => clearTimeout(t);
  }, [live, impl]);
  if (live && impl) {
    return (
      <LiveCtx.Provider value>
        <impl.AppearList {...props} />
      </LiveCtx.Provider>
    );
  }
  const { as = 'ul', className, children } = props;
  // 静态外壳明确给 false：嵌在已换成实现的外层列表里时，里面的行也按本列表的静态画（审查建议 1）
  return <LiveCtx.Provider value={false}>{createElement(as, { ref: el, className, style: LIST_STYLE, 'data-testid': props['data-testid'] }, children)}</LiveCtx.Provider>;
}

export function AppearItem(props: AppearItemProps) {
  const live = useContext(LiveCtx);
  const impl = useMotionImpl();
  if (live && impl) return <impl.AppearItem {...props} />;
  const { as = 'li', className, children, ...rest } = props;
  return createElement(as, { ...rest, className, style: ITEM_STYLE }, children);
}
