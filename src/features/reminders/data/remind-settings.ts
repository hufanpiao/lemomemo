// 设置 › 提醒 的几项（B2 任务单 FA-4；数据字典第 9 节 remind.*；架构 5.3 第 2、4 步）：纯 TS
// • remind.show_title：true（默认）= 推送直接写标题和名字（R-46）；false = 锁屏只显示“有 1 项日程”（R-188 保留项，15.7 第 18 项）
// • remind.dnd：{start: 'HH:MM', end: 'HH:MM', enabled?: false}；认不出的按没开（和 push-dispatch 的 parseDnd 同一口径，
//   supabase/functions/push-dispatch/round-util.ts）。关掉时保留时段、写 enabled: false，再打开还是原来的时段
// • remind.default_time：全天日程“开始时再提醒”的时刻（startAtOf），没设 09:00
// • 读：本机 settings 集合里这个键“活着”的那一行（没软删、没撤销）的 value；写：有这一行就 patch（settingPatch 管恢复），没有就 insert；值一样不写
import type { Dnd } from '../../../../shared/logic/remind.ts';
import { settingPatch } from '../../../core/setting-patch.ts';

export const KEY_SHOW_TITLE = 'remind.show_title';
export const KEY_DND = 'remind.dnd';
export const KEY_DEFAULT_TIME = 'remind.default_time';

/** 打开免打扰时没设过时段的默认值（定稿线框 s13“免打扰 23:00 – 08:00”） */
export const DEFAULT_DND = { start: '23:00', end: '08:00' } as const;

export interface SettingRow {
  readonly id: string;
  readonly key?: unknown;
  readonly value?: unknown;
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}

const live = (r: SettingRow): boolean => (r.deleted_at === null || r.deleted_at === undefined) && r.undone !== true;

export function settingValue(rows: readonly SettingRow[], key: string): unknown {
  return rows.find((r) => r.key === key && live(r))?.value;
}

export type SettingWrite =
  | { readonly op: 'insert'; readonly data: { readonly key: string; readonly value: unknown } }
  | { readonly op: 'patch'; readonly id: string; readonly data: Readonly<Record<string, unknown>> };

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 把 key 改成 value 要写什么；已经是这个值时 null */
export function settingWrite(rows: readonly SettingRow[], key: string, value: unknown): SettingWrite | null {
  const row = rows.find((r) => r.key === key && live(r)) ?? rows.find((r) => r.key === key);
  if (!row) return { op: 'insert', data: { key, value } };
  if (live(row) && typeof value === 'object' && value !== null && sameJson(row.value, value)) return null;
  const data = settingPatch(row, value);
  return data ? { op: 'patch', id: row.id, data } : null;
}

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
