// arch-fixture: path=src/features/notes/ui/Good.tsx expect=none
// 对照组（0.31 第 6 条）：功能的 ui 经两个出口引 motion
import { Appear } from '../../../motion/components.ts';
import { press } from '../../../motion/index.ts';
export const x = [Appear, press];
