// 设置 › 提醒 的几项（B2 任务单 FA-4；数据字典第 9 节 remind.*；架构 5.3 第 2、4 步）：纯 TS
// • remind.show_title：true（默认）= 推送直接写标题和名字（R-46）；false = 锁屏只显示“有 1 项日程”（R-188 保留项，15.7 第 18 项）
// • remind.dnd：{start: 'HH:MM', end: 'HH:MM', enabled?: false}；认不出的按没开（和 push-dispatch 的 parseDnd 同一口径，
//   supabase/functions/push-dispatch/round-util.ts）。关掉时保留时段、写 enabled: false，再打开还是原来的时段
// • remind.default_time：全天日程“开始时再提醒”的时刻（startAtOf），没设 09:00
// • 读写一个键在 core/setting-read.ts（settingValue、SettingRow）、core/setting-write.ts（settingWrite），和日历共用一份（REMIND-settings-core、FA-4 代码审查 L7），这里只转出读的
import { ANNIV_KEY_OFFSETS as KEY_ANNIV_OFFSETS, ANNIV_KEY_TIME as KEY_ANNIV_TIME } from '../../../../shared/logic/anniv/keys.ts';
import type { Dnd } from '../../../../shared/logic/remind.ts';

// 只转出读的（core/setting-read.ts）：首屏算提醒列表要用，不带写设置那一套（首屏瘦身 H1 第三轮）；要写的直接用 core/setting-write.ts
export { settingValue, type SettingRow } from '../../../core/setting-read.ts';

export const KEY_SHOW_TITLE = 'remind.show_title';
export const KEY_DND = 'remind.dnd';
export const KEY_DEFAULT_TIME = 'remind.default_time';
/** 纪念日默认提前几天（数组，1～4 个、每个 0～60）、默认时刻（HH:MM）（B5 S16；数据字典第 9 节 anniv.*；纪念日页 hooks/useAnniv.ts 读同两个键） */
// 键名只在 shared/logic/anniv/keys.ts 一份（整块评审第 21 条）
export { KEY_ANNIV_OFFSETS, KEY_ANNIV_TIME };

/** 打开免打扰时没设过时段的默认值（定稿线框 s13“免打扰 23:00 – 08:00”） */
export const DEFAULT_DND = { start: '23:00', end: '08:00' } as const;

/** 推送写不写标题（设置一级；条目自己的 push_show_title 另算） */
export function showTitleOf(v: unknown): boolean {
  return typeof v === 'boolean' ? v : true;
}

const HM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface DndSetting {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
}

/** 存的值 → 界面要的（认不出的按没开、时段用默认） */
export function dndSettingOf(v: unknown): DndSetting {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { enabled: false, ...DEFAULT_DND };
  const o = v as Record<string, unknown>;
  const s = o['start'];
  const e = o['end'];
  if (typeof s !== 'string' || typeof e !== 'string' || !HM.test(s) || !HM.test(e) || s === e) return { enabled: false, ...DEFAULT_DND };
  return { enabled: o['enabled'] !== false, start: s, end: e };
}

/** 生效的免打扰（给 remind.ts 的 applyDnd / actionsFor）：和 push-dispatch 的 parseDnd 同一结果 */
export function dndOf(v: unknown): Dnd {
  const d = dndSettingOf(v);
  return d.enabled ? { start: d.start, end: d.end } : null;
}

/** 界面改了以后要存的值 */
export function dndValue(d: DndSetting): Record<string, unknown> {
  return d.enabled ? { start: d.start, end: d.end } : { start: d.start, end: d.end, enabled: false };
}

/** HH:MM 合不合格（时间输入框给的值） */
export function isHm(s: string): boolean {
  return HM.test(s);
}

export function defaultTimeOf(v: unknown): string {
  return typeof v === 'string' && HM.test(v) ? v : '09:00';
}
