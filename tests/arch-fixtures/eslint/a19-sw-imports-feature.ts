// arch-fixture: path=src/sw/bad.ts expect=boundaries/dependencies
// 违规：sw 不能 import 功能
import { routes } from '../features/notes/index.ts';
export const r = routes;
