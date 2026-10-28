// arch-fixture: path=shared/logic/bad.ts expect=boundaries/dependencies rule=A1
// 违规：shared 不能 import src
import { collection } from '../../src/core/store.ts';
export const c = collection('notes');
