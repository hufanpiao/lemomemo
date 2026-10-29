// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=boundaries/dependencies rule=A1
// 违规（0.32、1.3b）：功能的 ui 也不准直接用 platform/files-url.ts（从 files.ts 拆出的地址核对），照片和附件只经自己的 data 层
import { checkSig } from '../../../platform/files-url.ts';
export const c = checkSig;
