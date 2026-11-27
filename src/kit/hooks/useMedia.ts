// 宽屏判断、断点只在这里做：JS 里的断点字符串只写这一份，组件按名字用。CSS 媒体查询里不能用变量，同一个数照写在
// GlassBar、GlassBarFx、MeLink、随手记页、base.css（侧栏、网页版宽屏令牌）和 MonthPicker.module.css（月历宽屏，年月选择器）里，src/app/__tests__/layers-media-css.test.ts 核对一致。
// 没有 matchMedia（测试环境、老浏览器）一律当不匹配
import { useCallback, useSyncExternalStore } from 'react';

/** 电脑版侧栏 */
export const MQ_SIDEBAR = '(width >= 900px)';
/** 网页版宽屏排法（今天、日历、待办、随手记、纪念日、设置铺满一屏，有 dock 的页右边常驻 AI 助手栏）。CSS 里只有 base.css 的 --dk-* 那一段写这个数，
 *  页面按 JS 判断挂 kit Desk.module.css 的类（src/app/__tests__/layers-media-css.test.ts 核对一致） */
export const MQ_DESK_WIDE = '(width >= 1024px)';   // 1024 起：iPad 横屏也用
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
