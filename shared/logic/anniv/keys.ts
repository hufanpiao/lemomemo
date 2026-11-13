// 纪念日默认提醒的两个设置键（数据字典第 9 节 anniv.*；R-94）：只有这一份（整块评审第 21 条：原来前端两处、推算、push-dispatch、anniv-roll 各写一遍）。
// 不引农历表（next-date.ts 带农历表、不进首屏，2.6）：设置页、提醒列表、服务器函数都可以静态引这个文件
/** 提前几天（数组，出厂 [7, 1]） */
export const ANNIV_KEY_OFFSETS = 'anniv.default_offsets';
/** 几点（'HH:MM'，出厂 09:00） */
export const ANNIV_KEY_TIME = 'anniv.default_time';
