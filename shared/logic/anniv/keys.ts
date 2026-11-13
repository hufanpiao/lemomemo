// 纪念日默认提醒的两个设置键（数据字典第 9 节 anniv.*；R-94）：只有这一份（整块评审第 21 条：原来前端两处、推算、push-dispatch、anniv-roll 各写一遍）。
// 不引农历表（next-date.ts 带农历表、不进首屏，2.6）：设置页、提醒列表、服务器函数都可以静态引这个文件
/** 提前几天（数组，出厂 [7, 1]） */
export const ANNIV_KEY_OFFSETS = 'anniv.default_offsets';
/** 几点（'HH:MM'，出厂 09:00） */
export const ANNIV_KEY_TIME = 'anniv.default_time';
/** anniv.default_time 没设（或不合格）时的出厂时刻 */
export const DEFAULT_TIME = '09:00';
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 纪念日提醒的时刻（HH:MM）：这一条的 remind_time ?? 设置 anniv.default_time ?? 09:00，不合格的跳过。
 * 只有这一份（整块评审第 22 条）：推算（next-date.ts 转出）、提醒页“明天再提醒”、设置页都用它
 */
export function remindTimeOf(r: { readonly remind_time: string | null }, settings: Readonly<Record<string, unknown>>): string {
  const d = settings[ANNIV_KEY_TIME];
  return r.remind_time !== null && HM_RE.test(r.remind_time) ? r.remind_time : typeof d === 'string' && HM_RE.test(d) ? d : DEFAULT_TIME;
}
