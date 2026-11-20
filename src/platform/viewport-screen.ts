// 整屏几何（viewport-geom.ts 的首屏部分，11-12 首屏瘦身拆出）：横竖屏、整屏高，和冷启动高度校正也要用的两个门槛；另有根节点四样的名字和 SCALE_EPS（运行日志要读，11-21）。
// 冷启动高度校正（vh-gapfix-gate.ts）在首屏，只用这几样；其余视口几何（可视高度、键盘高度的算法）在 viewport-geom.ts，
// 不在首屏块里，跟着 viewport.ts 的分包按需下载（首屏画完以后；iOS 主屏幕版冷启动时随 vh-gapfix.ts）。viewport-geom.ts 照样转出这里的东西，别处照旧从 viewport-geom.ts 引（运行日志例外，直接引这里）。纯函数，不读 DOM、不记状态

/** viewport.ts 写到根节点的四样（停止监听时一起拿掉）：--vh-gap 冷启动少的高度、--kb 键盘压住的高度、data-kbo 手机上键盘弹着、data-kbhide 底栏藏起。
 *  名字不放 viewport.ts：运行日志（run-log.ts、run-log-layout.ts）要读，不静态引 viewport.ts。放这里（首屏块）不放 viewport-geom.ts（11-21 首屏瘦身）：
 *  运行日志在今天页出现之前就下载，原来为这几个常量还要多下载 viewport-geom.ts 整块（约 0.4 KB gzip）；放这里首屏块只多几十字节 */
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
