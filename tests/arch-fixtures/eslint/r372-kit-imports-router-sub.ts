// arch-fixture: path=src/kit/components/bad.ts expect=boundaries/dependencies rule=A1
// 违规（R-372 复审建议）：router-sub.ts、router-levels.ts 只给功能层用，kit 只准引 router.ts
import { navigateSub } from '../../app/router-sub.ts';
export const n = navigateSub;
