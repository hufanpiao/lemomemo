// 电脑版布局拖面板时“撑开空位”的位移过渡（架构 5.9b 第 5 点、17.2）：给 kit/components/DeskLayout 的 dnd-kit useSortable 用，经 ./gestures.ts 导出
// 时长、曲线只取令牌（A24）：--dur-ui、--ease-out；减少动态效果时返回 null（直接到位，不做位移动画）
import { bezierCss, dur, ease } from './tokens.ts';

export interface SortTransition {
  duration: number;
  easing: string;
}

export function deskSortTransition(reduced: boolean): SortTransition | null {
  return reduced ? null : { duration: dur.ui * 1000, easing: bezierCss(ease.out) };
}
