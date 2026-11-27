// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=no-restricted-imports message=R-372 复审 M1 rule=A1
// 违规（R-372 复审 M1）：功能层不准引 router.ts 的内部件（commit 能绕开 navigate 自己拼历史），只准 router-sub.ts、router-levels.ts 和测试引
import { commit } from '../../../app/router.ts';
export const c = commit;
