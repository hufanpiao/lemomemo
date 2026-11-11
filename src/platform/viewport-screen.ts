// 整屏几何（viewport-geom.ts 的首屏部分，11-12 首屏瘦身拆出）：横竖屏、整屏高，和冷启动高度校正也要用的两个门槛。
// 冷启动高度校正（vh-gapfix-gate.ts）在首屏，只用这几样；其余视口几何（可视高度、键盘高度、--vh-gap）在 viewport-geom.ts，
// 不在首屏块里，跟着 viewport.ts 的分包按需下载（首屏画完以后；iOS 主屏幕版冷启动时随 vh-gapfix.ts）。viewport-geom.ts 照样转出这里的东西，别处照旧从 viewport-geom.ts 引。纯函数，不读 DOM、不记状态

/** 两个高度差这么多以内算一样（回到整屏、少的正是顶部安全区） */
export const TOL_PX = 4;
/** 布局视口比整屏少这么多以内才当“少了顶部安全区”（再多是键盘、分屏等） */
export const GAP_MAX_PX = 100;

type WinLike = Pick<Window, 'innerWidth' | 'innerHeight'> & { screen: Pick<Screen, 'width' | 'height'> };

/** 横屏：innerWidth 比 screen 短边宽。iOS 的 screen 不随横竖屏转；不拿 innerHeight 比（弹键盘时它会被压得比宽还小） */
export const isLandscape = (w: WinLike): boolean => w.innerWidth > Math.min(w.screen.width, w.screen.height);

/** 整屏高：横屏取 screen 短边、竖屏取长边 */
export const fullHeight = (w: WinLike): number => {
  const { width, height } = w.screen;
  return isLandscape(w) ? Math.min(width, height) : Math.max(width, height);
};
