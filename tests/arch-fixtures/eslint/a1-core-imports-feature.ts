// arch-fixture: path=src/core/bad.ts expect=boundaries/dependencies rule=A1
// 违规：core 不能 import 任何功能
import { routes } from '../features/notes/index.ts';
export const r = routes;
