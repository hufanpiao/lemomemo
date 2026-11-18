// 原地模糊淡换（R-457 日历翻月“放慢4倍的C原地淡换”；11-18 负责人“底部导航切页动画直接套用日历的切页动画，做成一模一样的动效”）：
// 日历翻月（swipe-pager.ts）和底栏四个页签互切（page-swap.ts 的 fadeSwap）都只用这里的一份关键帧、时长和曲线，不各写一份。
// • 旧的一页（静态副本）：从手指停下的位置 x 回到原位、模糊到 BLUR_SWAP_PX、前 2/3 就淡没；
// • 新的一页：从模糊 BLUR_SWAP_PX、透明到清晰、不透明；
// • 时长 --dur-ui × CAL_FLIP_SLOW_RATIO（880 ms），曲线 --ease-out；
// • 减少动态效果：只留 --dur-ui 的淡出淡入，不模糊、不位移
import { bezierCss, CAL_FLIP_SLOW_RATIO, dur, ease } from './tokens.ts';

/** 淡换时模糊到几像素（方案页 C） */
export const BLUR_SWAP_PX = 4;

const blur = (px: number): string => `blur(${px}px)`;

/** 时长（ms）和曲线 */
export function blurSwapTiming(reduced: boolean): { duration: number; easing: string } {
  return { duration: dur.ui * 1000 * (reduced ? 1 : CAL_FLIP_SLOW_RATIO), easing: bezierCss(ease.out) };
}

/** 旧的一页（副本）的关键帧：从 x 处（px，日历跟手停下的位置；底栏为 0）起、透明度从 opacity 起（连点时上一次没放完） */
export function blurSwapOut(reduced: boolean, x = 0, opacity = 1): Keyframe[] {
  if (reduced) return [{ opacity }, { opacity: 0 }];
  return [
    { opacity, filter: blur(0), transform: `translateX(${x}px)` },
    { opacity: 0, filter: blur((BLUR_SWAP_PX * 2) / 3), transform: `translateX(${x / 3}px)`, offset: 2 / 3 },
    { opacity: 0, filter: blur(BLUR_SWAP_PX), transform: 'translateX(0px)' },
  ];
}

/** 新的一页的关键帧；withFilter 为 false 时只要透明度（模糊另加在别的元素上，见 blurSwapInFilter） */
export function blurSwapIn(reduced: boolean, withFilter = true): Keyframe[] {
  if (reduced || !withFilter) return [{ opacity: 0 }, { opacity: 1 }];
  return [
    { opacity: 0, filter: blur(BLUR_SWAP_PX) },
    { opacity: 1, filter: blur(0) },
  ];
}

/** 新的一页只要模糊那一半（加在不含 position: fixed 元素的子树上：filter 会让 fixed 后代改按它定位） */
export function blurSwapInFilter(): Keyframe[] {
  return [{ filter: blur(BLUR_SWAP_PX) }, { filter: blur(0) }];
}
