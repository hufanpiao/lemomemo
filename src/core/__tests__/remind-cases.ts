// 提醒标记的对照用例（代码结构审查 11-25 第 1 条：同一行经几条路径要算出同一个标记）。
// 日程编辑页、今天页“最近删除”、冲突卡恢复、打字条新建、提醒列表各自的测试都拿这一张表比，期望值只写这里一份。
// now 是首尔 2026-11-05 10:00：全天日程当天提醒按 23:59 判断（架构 5.3 第 4 步）时“当天”还会响，按出厂 09:00 就已经过了，两种口径分得出来
import { msAt } from '../../../shared/core/date.ts';

export const CASE_TZ = 'Asia/Seoul';
export const CASE_NOW = msAt('2026-11-05', 10 * 60, CASE_TZ);

const ev = (over: Record<string, unknown>) => ({
  id: '00000000-0000-4000-8000-0000000000e1', title: '会', date: '2026-11-06', time: '10:00', tz: CASE_TZ, duration_min: 60,
  remind_min: 15, remind_days: null, location: '', project: '', note: '', deleted_at: null, ...over,
});

/** 日程：live = 按字段算的提醒还会不会响（新建、恢复用）；pendingBefore = 删之前还会不会响（删除用，含服务器上的稍后） */
export const EVENT_CASES: readonly { name: string; row: Record<string, unknown> & { id: string }; live: boolean; pendingBefore: boolean }[] = [
  { name: '有时刻、明天、提前 15 分钟', row: ev({}), live: true, pendingBefore: true },
  { name: '有时刻、早就过了', row: ev({ date: '2026-11-01' }), live: false, pendingBefore: false },
  { name: '有时刻、不提醒', row: ev({ remind_min: null }), live: false, pendingBefore: false },
  { name: '全天、当天提醒（09:00 已过，按 23:59 还会响）', row: ev({ date: '2026-11-05', time: null, tz: null, remind_min: null, remind_days: 0 }), live: true, pendingBefore: true },
  { name: '全天、昨天', row: ev({ date: '2026-11-04', time: null, tz: null, remind_min: null, remind_days: 0 }), live: false, pendingBefore: false },
  { name: '全天、不提醒', row: ev({ date: '2026-11-07', time: null, tz: null, remind_min: null, remind_days: null }), live: false, pendingBefore: false },
];

/** 按过“稍后”、按字段算不出来的日程：只有删除那一路看服务器上的 snooze_at */
export const EVENT_SNOOZED = ev({ date: '2026-11-01', snooze_at: CASE_NOW + 60_000 });

const an = (over: Record<string, unknown>) => ({
  id: '00000000-0000-4000-8000-0000000000a1', kind: 'birthday', name: '妈妈', calendar: 'solar', month: 11, day: 6, is_leap: false, year: null,
  remind_offsets: null, remind_time: null, after_due: 'archive', lunar_variant: 'cn', note: '', created_at: CASE_NOW - 86_400_000, deleted_at: null, ...over,
});

/** 纪念日：live = 按字段（出厂默认提醒）算的这一次还会不会响 */
export const ANNIV_CASES: readonly { name: string; row: Record<string, unknown> & { id: string }; live: boolean }[] = [
  { name: '生日（每年都有下一次）', row: an({}), live: true },
  { name: '倒数日、目标日已过', row: an({ kind: 'countdown', name: '考试', year: 2026, month: 10, day: 1 }), live: false },
  { name: '月日不存在', row: an({ month: 2, day: 30 }), live: false },
];
