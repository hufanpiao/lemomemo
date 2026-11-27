// 整屏几何（viewport-geom.ts 的首屏部分）：横竖屏、整屏高，和冷启动高度校正也要用的两个门槛；另有根节点三样的名字和 SCALE_EPS（运行日志要读）。
// 冷启动高度校正（vh-gapfix-gate.ts）在首屏，只用这几样；其余视口几何在 viewport-geom.ts，跟着 viewport.ts 的分包首屏画完以后按需下载。
// viewport-geom.ts 照样转出这里的东西，别处从 viewport-geom.ts 引（运行日志例外，直接引这里）。纯函数，不读 DOM、不记状态

/** viewport.ts 写到根节点的四样（停止监听时一起拿掉）：--vh-gap 布局视口少的那截（贴底元素补到屏幕底）、--kb 键盘压住的高度、data-kbo 手机上键盘弹着、data-kbhide 底栏藏起。
 *  名字不放 viewport.ts：运行日志要读，不静态引 viewport.ts；也不放 viewport-geom.ts：运行日志在今天页出现之前就下载，不为几个常量多下载整块 */
export const GAP_VAR = '--vh-gap';
export const KB_VAR = '--kb';
export const KBO_ATTR = 'data-kbo';
/** 底栏、“＋”、实色带、渐隐层藏起（kit GlassBar 的样式按它藏） */
export const BAR_HIDE_ATTR = 'data-kbhide';
/** 可视区缩放和 1 差这么多以内算没缩放（运行日志判“缩放了才记 scale=”也用它） */
export const SCALE_EPS = 0.01;

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
