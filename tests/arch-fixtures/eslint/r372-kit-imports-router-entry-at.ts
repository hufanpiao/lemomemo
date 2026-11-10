// arch-fixture: path=src/kit/hooks/bad.ts expect=no-restricted-imports message=R-372 复审 M1 rule=A1
// 违规（R-372 复审 M1）：kit 也不准引 router.ts 的内部件（entryAt 是可改的 Map）
import { entryAt, stateFor } from '../../app/router.ts';
export const e = [entryAt, stateFor];
