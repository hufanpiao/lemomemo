// arch-fixture: path=src/app/router.ts expect=no-restricted-imports
// 违规（0.31 第 3 条）：router.ts 不能 import platform（构建信息也不行）
import { buildInfo } from '../platform/env.ts';
export const v = buildInfo.version;
