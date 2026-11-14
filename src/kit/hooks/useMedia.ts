// 宽屏判断、断点只在这里做（架构 10.1）：JS 里的断点字符串只写这一份，组件按名字用。CSS 媒体查询里不能用变量，同一个数照写在
// GlassBar、GlassBarFx、MeLink、随手记页、base.css（侧栏）和 CalendarPage.module.css（月历宽屏）里，src/app/__tests__/layers-media-css.test.ts 核对一致。
// 没有 matchMedia（测试环境、老浏览器）一律当不匹配
import { useCallback, useSyncExternalStore } from 'react';

/** 电脑版侧栏 */
export const MQ_SIDEBAR = '(width >= 900px)';
/** 电脑版布局能拖、分栏（5.9b：窄于 1100 px 排成一列、不能拖；只在 JS 里判，CSS 不用这个数） */
export const MQ_DESK_WIDE = '(width >= 1100px)';
/** 月历每格放 4 个标签的电脑档 */
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
