// arch-fixture: path=shared/logic/bad.ts expect=boundaries/dependencies
// 违规：shared 不能 import src
import { collection } from '../../src/core/store.ts';
export const c = collection('notes');
