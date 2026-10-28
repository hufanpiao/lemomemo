// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=no-restricted-imports
// 违规（0.31 第 6 条）：src/motion 以外只准引 motion/index.ts、motion/components.ts，不能引 motion 里的其他文件
import { Appear } from '../../../motion/Appear.tsx';
export const A = Appear;
