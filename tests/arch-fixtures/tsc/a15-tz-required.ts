// arch-fixture: expect=TS2554 rule=A15
// 违规：时刻函数的 tz 参数必填，少传编译不过
import { msAt } from '../../../shared/core/date.ts';

export const t = msAt('2026-10-28', 540);
