// arch-fixture: path=src/features/notes/ui/Good.tsx expect=none
// 对照（应通过）：只拦 platform/files.ts，ui 引 platform 的其他文件照旧可以
import { buildInfo } from '../../../platform/env.ts';
export const v = buildInfo.version;
