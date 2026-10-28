// arch-fixture: path=src/features/calendar/data/ok.ts expect=none
// 对照组（QA D-07）：同一个功能的 data 引自己的 data 可以——证明 a1-data-imports-other-feature-data.ts 被拦是因为“别的功能”
import { listEvents } from '../../../../tests/arch-fixtures/eslint-targets/src/features/calendar/data/events.ts';
export const l = listEvents;
