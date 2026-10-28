// 每种进出场的起止状态和用哪个令牌（架构 17.2 第 4 点）：改手感只改这张表
// 只动 transform 和 opacity；写完整的 transform 字符串，走浏览器的硬件加速（17.2 第 6 点）
// 进场最小从 scale(0.95) 开始，不从 0 开始（17.3）
import { tr } from './tokens.ts';

export type AppearKind = 'toast' | 'sheet' | 'row' | 'page';

export interface Preset {
  initial: { opacity: number; transform: string };
  animate: { opacity: number; transform: string };
  exit: { opacity: number; transform: string };
  /** 进出场一律用时长 + 曲线（弹簧只给手势和 layout） */
  transition: { readonly duration: number; readonly ease: readonly [number, number, number, number] };
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
    reduced: { opacity: 0 },
  },
  row: {
    initial: { opacity: 0, transform: 'translateY(4px) scale(1)' },
    animate: { opacity: 1, transform: 'translateY(0px) scale(1)' },
    exit: { opacity: 0, transform: 'translateY(0px) scale(1)' },
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

/** 按下回弹：scale(0.97)（17.1、17.3） */
export const PRESS_SCALE = 0.97;
