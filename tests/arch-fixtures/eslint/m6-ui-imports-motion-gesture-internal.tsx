// arch-fixture: path=src/features/notes/ui/Bad2.tsx expect=no-restricted-imports message=motion/gestures.ts rule=A1
// 违规（0.31 第 6 条）：手势要经 motion/gestures.ts 引，不能直接引 motion/swipe-pager.ts（11-05 加出口时补的反例）
import { useSwipePager } from '../../../motion/swipe-pager.ts';
export const S = useSwipePager;
