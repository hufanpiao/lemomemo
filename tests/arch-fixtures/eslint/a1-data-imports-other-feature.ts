// arch-fixture: path=src/features/todos/data/bad.ts expect=boundaries/dependencies rule=A1
// 违规：功能的 data 不能用别的功能（跨功能的数据经 core）
import { routes } from '../../calendar/index.ts';
export const r = routes;
