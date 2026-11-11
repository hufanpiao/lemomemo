// 宽屏判断、断点只在这里做（架构 10.1）：断点字符串只写这一份，组件按名字用；CSS 那边的同值媒体查询见各 module.css
// 没有 matchMedia（测试环境、老浏览器）一律当不匹配
import { useCallback, useSyncExternalStore } from 'react';

/** 电脑版侧栏（D5）：和 GlassBar.module.css、base.css 那段媒体查询一样 */
export const MQ_SIDEBAR = '(width >= 900px)';
/** 月历每格放 4 个标签的电脑档（5.12、R-100） */
export const MQ_CAL_WIDE = '(min-width: 768px)';

const mq = (q: string): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia(q) : null);

export function useMedia(q: string): boolean {
  const sub = useCallback((fn: () => void) => {
    const m = mq(q);
    m?.addEventListener('change', fn);
    return () => m?.removeEventListener('change', fn);
  }, [q]);
  return useSyncExternalStore(sub, () => mq(q)?.matches ?? false, () => false);
}
