// arch-fixture: path=src/features/notes/ui/Good.tsx expect=none
// 对照组（0.31 第 6 条）：功能的 ui 经三个出口引 motion（gestures.ts 11-05 主持人定加，首屏体积）
import { Appear } from '../../../motion/components.ts';
import { useSwipePager } from '../../../motion/gestures.ts';
import { transition } from '../../../motion/index.ts';
export const x = [Appear, transition, useSwipePager];
