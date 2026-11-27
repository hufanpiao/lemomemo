// arch-fixture: path=src/features/notes/ui/Ok.tsx expect=none
// 对照组（R-372）：功能层引 router.ts 的公开函数、router-sub.ts、router-levels.ts 都不报
import { backTo, navigate } from '../../../app/router.ts';
import { navigateSub } from '../../../app/router-sub.ts';
import { replaceInPage } from '../../../app/router-levels.ts';
export const fns = [backTo, navigate, navigateSub, replaceInPage];
