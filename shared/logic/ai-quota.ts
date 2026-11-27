// AI 每天次数的计数日和恢复时刻（架构“每天 50 次 AI 额度”，R-187；B3 任务单 FA-2、FA-4 共用）
// • 服务器按太平洋时间的日期计数（_shared/ai/gate.ts 的 pacificDate、迁移 20261107100000 的 my_ai_usage_impl）；
//   恢复时刻 = 下一个太平洋午夜（同 gate.ts 的 nextPacificMidnight），显示时换成 current_tz 的墙上时间（夏令时自动从 17:00 变 16:00）。
// • 原来在 src/features/plus/data/quota.ts，11-07 挪到这里，加号页（FA-2）和设置 › 语音与 AI（FA-4）都从这里引。
// • 和服务器口径一致由 tests/shared/ai-quota.test.ts 钉住（跨夏令时切换的那几天逐小时比）。
// 纯 TS，只引 shared/core（前端、Deno 都能引）。
import { addDays, fmtHm, minOfDay, msAt, todayOf, type DateStr } from '../core/date.ts';
import type { Tz } from '../core/tz.ts';

export const QUOTA_TZ: Tz = 'America/Los_Angeles';

/** 今天（按太平洋时间）的 AI 计数日 */
export const quotaDay = (now: number): DateStr => todayOf(now, QUOTA_TZ);

/** 下一次恢复的时刻（毫秒） */
export const quotaResetAt = (now: number): number => msAt(addDays(quotaDay(now), 1), 0, QUOTA_TZ);

/** 恢复时刻在 tz 里的“HH:MM” */
export function quotaResetClock(now: number, tz: Tz): string {
  return fmtHm(minOfDay(quotaResetAt(now), tz));
}

/** 恢复时刻在 tz 里是不是今天（首尔恢复在 17:00：上午用完是“今天 17:00”，晚上用完是“明天 17:00”；按住说话挡住时的提示用） */
export const quotaResetsToday = (now: number, tz: Tz): boolean => todayOf(quotaResetAt(now), tz) === todayOf(now, tz);
