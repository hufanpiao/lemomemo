// 每种进出场的起止状态和用哪个令牌（架构 17.2 第 4 点）：改手感只改这张表
// 只动 transform 和 opacity；写完整的 transform 字符串，走浏览器的硬件加速（17.2 第 6 点）
// 进场最小从 scale(0.95) 开始，不从 0 开始（17.3）
import { tr } from './tokens.ts';

export type AppearKind = 'toast' | 'sheet' | 'page' | 'scrim' | 'popover';

export interface Preset {
  initial: { opacity: number; transform: string };
  animate: { opacity: number; transform: string };
  exit: { opacity: number; transform: string };
  /** 进出场一律用时长 + 曲线（弹簧只给手势和 layout） */
  transition: { readonly duration: number; readonly ease: readonly [number, number, number, number] };
  /** 退场单独的时长曲线（不写就和进场一样）：弹层“快收”（MOTION-sheet-exit） */
  exitTransition?: { readonly duration: number; readonly ease: readonly [number, number, number, number] };
  /** 减少动态效果时：只淡入淡出，时长减半（17.2 第 5 点） */
  reduced: { opacity: number };
}

export const presets: Record<AppearKind, Preset> = {
  toast: {
    initial: { opacity: 0, transform: 'translateY(12px) scale(1)' },
    animate: { opacity: 1, transform: 'translateY(0px) scale(1)' },
    exit: { opacity: 0, transform: 'translateY(12px) scale(1)' },
    transition: tr.ui,
    reduced: { opacity: 0 },
  },
  sheet: {
    initial: { opacity: 1, transform: 'translateY(100%) scale(1)' },
    animate: { opacity: 1, transform: 'translateY(0%) scale(1)' },
    exit: { opacity: 1, transform: 'translateY(100%) scale(1)' },
    transition: tr.sheet,
    exitTransition: tr.sheetExit,
    reduced: { opacity: 0 },
  },
  // 弹层的背景遮罩（17.1“背景遮罩淡入”；UI-4 L-2，B2）：只淡入淡出，不动位置
  scrim: {
    initial: { opacity: 0, transform: 'translateY(0px) scale(1)' },
    animate: { opacity: 1, transform: 'translateY(0px) scale(1)' },
    exit: { opacity: 0, transform: 'translateY(0px) scale(1)' },
    transition: tr.ui,
    reduced: { opacity: 0 },
  },
  // 浮层（年月选择器，架构 5.12 第 3 点“弹出用 Appear 的 popover”）：从触发处略微下移、放大一点点淡入
  popover: {
    initial: { opacity: 0, transform: 'translateY(-4px) scale(0.97)' },
    animate: { opacity: 1, transform: 'translateY(0px) scale(1)' },
    exit: { opacity: 0, transform: 'translateY(-4px) scale(0.97)' },
    transition: tr.ui,
    reduced: { opacity: 0 },
  },
  page: {
    initial: { opacity: 0, transform: 'translateY(0px) scale(0.98)' },
    animate: { opacity: 1, transform: 'translateY(0px) scale(1)' },
    exit: { opacity: 0, transform: 'translateY(0px) scale(1)' },
    transition: tr.page,
    reduced: { opacity: 0 },
  },
};

/**
 * 只有进场、没有退场的几种（Appear.tsx 的 useEnter；改善报告第三节第 4 块从各组件自己写的 CSS 关键帧收过来，数值照原样）：
 * 关掉时直接卸载、不播退场（要不要补退场等负责人定）。from 是起点，终点就是元素自己的样式（同 CSS 只写 from 的关键帧）；
 * 减少动态效果时只淡入、时长不减半（和原来的 CSS 一样，不同于上面 Appear 的减半）
 */
export type EnterKind = 'lift' | 'sheetUp' | 'drawerRight' | 'drawerLeft' | 'mist';

export interface EnterPreset {
  from: Record<string, string | number>;
  /** 减少动态效果时的起点 */
  reducedFrom: { opacity: number };
  transition: { readonly duration: number; readonly ease: readonly [number, number, number, number] };
  /**
   * 播完以后留不留终点（同原 CSS 的 animation-fill-mode）：原来写了 both 的这里也写 both。
   * 为什么照搬：带 both 时播完 transform 停在单位矩阵（不是 none），单位矩阵会给里面 position: fixed 的子元素当定位参照。
   * 11-21 核过：纪念日编辑层、抽屉里眼下没有 fixed 子元素（提醒弹窗挂在层外面），改前和省掉 both 画面逐像素相同；
   * 照搬是为了播完以后的状态和原来一字不差，以后有人往层里放 fixed 的东西也不会因为这里悄悄变样
   */
  fill: 'both' | 'none';
}

export const enters: Record<EnterKind, EnterPreset> = {
  // 撤销条从下方 12px 升起并淡入（负责人 11-17 勾选特效分镜第 ⑤ 段，所有撤销条一起；原 UndoToast.module.css undo-rise）。
  // 用独立的 translate 属性、不用 transform：打字条（TypeBar .noticeSlot）拿 transform 把撤销条抬到打字条上面，
  // 动 transform 会在动画期间盖掉抬升量（位移变成 12 + lift）；translate 和 transform 分开叠加，互不干扰
  lift: { from: { opacity: 0, translate: '0 12px' }, reducedFrom: { opacity: 0 }, transition: tr.ui, fill: 'none' },
  // 纪念日编辑层从底部滑上来（原 AnnivPage.module.css anniv-sheet-in；同上面 sheet 的进场，但不带退场）
  sheetUp: { from: { transform: 'translateY(100%)' }, reducedFrom: { opacity: 0 }, transition: tr.sheet, fill: 'both' },
  // 电脑版详情抽屉从右边（换到左边时从左边）滑进来 24px 并淡入（R-376 最基本的滑入；原 DetailDrawer.module.css drawer-in）
  drawerRight: { from: { opacity: 0, transform: 'translateX(24px)' }, reducedFrom: { opacity: 0 }, transition: tr.ui, fill: 'both' },
  drawerLeft: { from: { opacity: 0, transform: 'translateX(-24px)' }, reducedFrom: { opacity: 0 }, transition: tr.ui, fill: 'both' },
  // 输入时那层液态模糊只淡入、不动位置，110ms（--dur-ui 的一半，不超过 200ms）；减少动态效果时也一样（原 Mist.module.css mist-in）
  mist: { from: { opacity: 0 }, reducedFrom: { opacity: 0 }, transition: { duration: tr.ui.duration / 2, ease: tr.ui.ease }, fill: 'both' },
};
