// 对话区跟到底（回答出来时要自己滚到底，不用手动往下拉）：
// • 每次画完（新的一问、回答回来、三个点出现、卡片换了高度）和对话区变矮（弹键盘、拖半屏，ResizeObserver）都滚到最底
// • 自己往上翻过（离底超过 PIN_PX）就不拽回去；下一问（lastMe 换了）重新跟
// 调用方把返回的 ref、onScroll 挂到可滚动的对话区上（ui/ChatBody.tsx）
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** 离底多少像素以内算“还跟着底”（手指轻碰、回弹不算翻走） */
export const PIN_PX = 48;

export function useFollowBottom(lastMe: number): { ref: RefObject<HTMLDivElement | null>; onScroll(): void } {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const toEnd = (): void => {
    const f = ref.current;
    if (f && pinned.current) f.scrollTop = f.scrollHeight;
  };
  useLayoutEffect(() => {
    pinned.current = true;
  }, [lastMe]);
  // 不带依赖：每次画完都看一眼，没跟着时什么都不做
  useLayoutEffect(toEnd);
  useEffect(() => {
    const f = ref.current;
    if (!f || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) f.scrollTop = f.scrollHeight;
    });
    ro.observe(f);
    return () => ro.disconnect();
  }, []);
  const onScroll = (): void => {
    const f = ref.current;
    if (f) pinned.current = f.scrollHeight - f.scrollTop - f.clientHeight <= PIN_PX;
  };
  return { ref, onScroll };
}
