// arch-fixture: path=src/features/notes/hooks/useBad.ts expect=boundaries/dependencies
// 违规（0.32、1.3b）：功能的 hooks 也不准直接用 platform/files.ts，经自己的 data 层
import { upload } from '../../../platform/files.ts';
export const u = upload;
