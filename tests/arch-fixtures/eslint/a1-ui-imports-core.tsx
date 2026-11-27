// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=boundaries/dependencies rule=A1
// 违规：ui 不碰 core，数据经自己的 hooks
import { collection } from '../../../core/store.ts';
export const c = collection('notes');
