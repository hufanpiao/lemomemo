// “看另一台设备的版本”对话框里每一列怎么写（K8 冲突提示，方案 3.3，H3、L8）
// • 白名单五张表的每个 clientWritable 列（shared/manifests）要么在这里有字段名和格式，要么标 'hidden'；
//   __tests__/fields.test.ts 逐表核对，以后加列漏写会红
// • 不认识的列、格式化抛错（值的类型不对）一律写“（已改过）”，不露原始 JSON；同一张卡里多列不认识只写一行
// • 字段名文案在 ../i18n（同各编辑页的标签）；日期用 shared 的 fmtDay；不 import 任何别的功能
// • 时刻（events.time、todos.due_time、remind_time）是“HH:MM”墙上时间，按原样写；日程的时区单独一列（tz）
// • 分类的颜色、随手记的分类、纪念日的类型和历法这类只存 id 或枚举的列，写“（已改过）”（字段名照写）
// 纯 TS
import type { DateStr } from '../../../../shared/core/date.ts';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import type { NoticeTable } from './notice-tables.ts';

type Fmt = 'text' | 'date' | 'hm' | 'bool' | 'num' | 'mins' | 'days' | 'offsets' | 'list' | 'changed';
/** 字段名词条（sn.f.*，都不带占位符；__tests__/fields.test.ts 查每个都在词典里） */
type LabelKey = `sn.f.${string}`;
export type FieldSpec = { label: LabelKey; fmt: Fmt } | 'hidden';
/** 查词典：data 层不碰 hooks、i18n（架构分层），由 hooks 传进来（sync-notice 的 tSn 按当前语言） */
export type FieldT = (key: string, params: Readonly<Record<string, string | number>>) => string;

const H = 'hidden' as const;
const f = (label: LabelKey, fmt: Fmt): FieldSpec => ({ label, fmt });
/** 几张表共有、界面上不显示的列 */
const META = { id: H, created_at: H, updated_at: H, deleted_at: H, undone: H, source: H, batch_id: H } as const;
const REMIND_META = { notified_for: H, snooze_at: H, push_show_title: f('sn.f.showTitle', 'changed') } as const;

export const FIELDS: Readonly<Record<NoticeTable, Readonly<Record<string, FieldSpec>>>> = {
  events: {
    ...META, ...REMIND_META,
    title: f('sn.f.title', 'text'), date: f('sn.f.date', 'date'), time: f('sn.f.time', 'hm'), tz: f('sn.f.tz', 'text'),
    duration_min: f('sn.f.duration', 'num'), project: f('sn.f.project', 'text'), note: f('sn.f.note', 'text'),
    raw_text: f('sn.f.raw', 'text'), location: f('sn.f.location', 'text'), short: H, short_by: H,
    remind_min: f('sn.f.remind', 'mins'), remind_days: f('sn.f.remindDays', 'days'),
  },
  todos: {
    ...META, ...REMIND_META,
    title: f('sn.f.title', 'text'), done: f('sn.f.done', 'bool'), due: f('sn.f.due', 'date'), important: f('sn.f.important', 'bool'),
    project: f('sn.f.project', 'text'), note: f('sn.f.note', 'text'), raw_text: f('sn.f.raw', 'text'),
    from_note_id: H, from_anniv_id: H, short: H, short_by: H, done_at: H,
    remind_days: f('sn.f.remindDays', 'days'), remind_time: f('sn.f.remindTime', 'hm'), due_time: f('sn.f.dueTime', 'hm'),
    remind_before_min: f('sn.f.remindBefore', 'mins'),
  },
  categories: {
    id: H, deleted_at: H, undone: H, created_by: H, merged_into: H, sort: H,
    name: f('sn.f.name', 'text'), color: f('sn.f.color', 'changed'),
  },
  notes: {
    ...META,
    title: f('sn.f.title', 'text'), body: f('sn.f.body', 'text'), is_private: f('sn.f.private', 'bool'),
    category_id: f('sn.f.category', 'changed'), category_source: H, category_seen: H, tags: f('sn.f.tags', 'list'),
    converted_to: H, raw_text: f('sn.f.raw', 'text'),
  },
  anniversaries: {
    id: H, created_at: H, updated_at: H, deleted_at: H, undone: H, ...REMIND_META,
    kind: f('sn.f.kind', 'changed'), name: f('sn.f.name', 'text'), calendar: f('sn.f.calendar', 'changed'), lunar_variant: H,
    month: f('sn.f.month', 'num'), day: f('sn.f.day', 'num'), is_leap: f('sn.f.leap', 'bool'), year: f('sn.f.year', 'num'),
    remind_offsets: f('sn.f.remindOffsets', 'offsets'), remind_time: f('sn.f.remindTime', 'hm'), after_due: f('sn.f.afterDue', 'changed'),
    note: f('sn.f.note', 'text'), avatar_id: f('sn.f.avatar', 'changed'), avatar_bytes: H,
  },
};

class BadValue extends Error {}
function need(ok: boolean): asserts ok {
  if (!ok) throw new BadValue('bad value');
}

function mins(v: unknown, tr: FieldT): string {
  if (v === null) return tr('sn.v.none', {});
  need(typeof v === 'number' && Number.isInteger(v) && v >= 0);
  if (v === 0) return tr('sn.v.atStart', {});
  if (v % 1440 === 0) return tr('sn.v.dayBefore', { n: v / 1440 });
  if (v % 60 === 0) return tr('sn.v.hourBefore', { n: v / 60 });
  return tr('sn.v.minBefore', { n: v });
}

function days(v: unknown, tr: FieldT): string {
  if (v === null) return tr('sn.v.none', {});
  need(v === 0 || v === 1);
  return tr(v === 0 ? 'sn.v.sameDay' : 'sn.v.dayEarlier', {});
}

const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isDayList = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0);

function value(fmt: Fmt, v: unknown, loc: Locale, tr: FieldT): string {
  if (fmt === 'changed') return tr('sn.changed', {});
  if (fmt === 'mins') return mins(v, tr);
  if (fmt === 'days') return days(v, tr);
  if (v === null || v === '') return tr('sn.v.empty', {});
  const sep = tr('sn.v.sep', {});
  switch (fmt) {
    case 'text':
      need(typeof v === 'string');
      return v;
    case 'date':
      need(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
      return fmtDay(v as DateStr, loc, 'monthDayWeek');
    case 'hm':
      need(typeof v === 'string' && /^\d{2}:\d{2}$/.test(v));
      return v;
    case 'bool':
      need(typeof v === 'boolean');
      return tr(v ? 'sn.v.yes' : 'sn.v.no', {});
    case 'num':
      need(typeof v === 'number' && Number.isFinite(v));
      return String(v);
    case 'list':
      need(isStrList(v));
      return v.length === 0 ? tr('sn.v.empty', {}) : v.join(sep);
    case 'offsets':
      need(isDayList(v));
      if (v.length === 0) return tr('sn.v.none', {});
      return v.map((d) => (d === 0 ? tr('sn.v.sameDay', {}) : tr('sn.v.dayBefore', { n: d }))).join(sep);
  }
}

export interface FieldLine {
  /** 字段名；null = 不认识的列（只写“（已改过）”一行） */
  field: string | null;
  value: string;
}

/**
 * 对话框里的各行：按 conflicts 的顺序，hidden 的不写；值取合并后的 old（另一台设备上的值），old 里没有这一列也写“（已改过）”。
 * 不认识的列（字段描述里没有）合成一行“（已改过）”放在最后；格式化抛错的那一列写“（已改过）”
 */
export function describeConflict(
  table: NoticeTable, conflicts: readonly string[], old: Readonly<Record<string, unknown>> | null, loc: Locale, tr: FieldT,
): FieldLine[] {
  const spec = FIELDS[table];
  const lines: FieldLine[] = [];
  let unknown = false;
  for (const col of conflicts) {
    const s = Object.hasOwn(spec, col) ? spec[col] : undefined;
    if (s === undefined) {
      unknown = true;
      continue;
    }
    if (s === 'hidden') continue;
    let v: string;
    try {
      v = old && Object.hasOwn(old, col) ? value(s.fmt, old[col], loc, tr) : tr('sn.changed', {});
    } catch {
      v = tr('sn.changed', {});
    }
    lines.push({ field: tr(s.label, {}), value: v });
  }
  if (unknown) lines.push({ field: null, value: tr('sn.changed', {}) });
  return lines;
}
