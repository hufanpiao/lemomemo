// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=boundaries/dependencies
// 违规（0.32、1.3b）：功能的 ui 不准直接用 platform/files.ts，照片和附件只经自己的 data 层
import { sign } from '../../../platform/files.ts';
export const s = sign;
