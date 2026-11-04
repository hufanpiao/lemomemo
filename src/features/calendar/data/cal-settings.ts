// 设置 › 日历 的两项（B2 FA-3 第二段，架构 5.12 第 1 点、R-97、数据字典第 9 节）：纯 TS
// • cal.holidays：'cn' | 'kr' | 'both'；没选过时不存这一行，按界面语言推导（中文 → cn、韩文 → kr），选过后固定（holidayCountries）
// • cal.week_start：0–6 的整数（0 周日、1 周一）；没设时按界面语言取默认（resolveWeekStart）
// • 读：本机 settings 集合里这个键“活着”的那一行（没软删、没撤销）的 value；没有就是 undefined
// • 写：有这一行就 patch（patch 内容由 core/setting-patch.ts 的 settingPatch 给，被软删、撤销过的顺带恢复，安全审查 FA3-2：恢复写法只在那一处），
//   没有就 insert；值一样不写
import type { HolidaySetting } from '../../../../shared/logic/calendar/holidays.ts';
import { settingPatch } from '../../../core/setting-patch.ts';

export const KEY_HOLIDAYS = 'cal.holidays';
export const KEY_WEEK_START = 'cal.week_start';

export interface SettingRow {
  readonly id: string;
  readonly key?: unknown;
  readonly value?: unknown;
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}

const live = (r: SettingRow): boolean => (r.deleted_at === null || r.deleted_at === undefined) && r.undone !== true;

/** 这个键现在生效的值；没有、被删、被撤销都是 undefined */
export function settingValue(rows: readonly SettingRow[], key: string): unknown {
  return rows.find((r) => r.key === key && live(r))?.value;
}

export type SettingWrite =
  | { readonly op: 'insert'; readonly data: { readonly key: string; readonly value: unknown } }
  | { readonly op: 'patch'; readonly id: string; readonly data: Readonly<Record<string, unknown>> };

/** 把 key 改成 value 要写什么；已经是这个值时 null（不写） */
export function settingWrite(rows: readonly SettingRow[], key: string, value: unknown): SettingWrite | null {
  const row = rows.find((r) => r.key === key && live(r)) ?? rows.find((r) => r.key === key);
  if (!row) return { op: 'insert', data: { key, value } };
  const data = settingPatch(row, value);
  return data ? { op: 'patch', id: row.id, data } : null;
}

/** 设置页上“节假日”该亮哪一个：存过的值有效就用它，没存过按界面语言（和 holidayCountries 同一口径） */
export function holidayChoice(v: unknown, locale: 'zh-CN' | 'ko-KR'): HolidaySetting {
  if (v === 'cn' || v === 'kr' || v === 'both') return v;
  return locale === 'ko-KR' ? 'kr' : 'cn';
}
