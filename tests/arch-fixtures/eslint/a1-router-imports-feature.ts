// arch-fixture: path=src/app/router.ts expect=no-restricted-imports
// 违规（0.31 第 3 条）：router.ts 不能 import 任何功能（连功能的 index.ts 也不行）
import { routes } from '../features/notes/index.ts';
export const r = routes;
