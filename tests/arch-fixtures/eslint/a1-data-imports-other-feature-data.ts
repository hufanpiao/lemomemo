// arch-fixture: path=src/features/todos/data/bad.ts expect=boundaries/dependencies rule=A1
// 违规（架构 2.1、2.3 A1；QA D-07）：功能之间不能互相用 data——todos 的 data 直接引 calendar 的 data（跨功能的数据经 core）
// 引用目标是 tests/arch-fixtures/eslint-targets/ 里的真文件（路径以 src/features/calendar/data/ 结尾，边界规则按它认类型）
import { listEvents } from '../../../../tests/arch-fixtures/eslint-targets/src/features/calendar/data/events.ts';
export const l = listEvents;
