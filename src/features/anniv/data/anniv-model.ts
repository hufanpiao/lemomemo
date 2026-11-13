// 纪念日列表的数据（B5 S14；架构 5.4；定稿线框 s4、皮肤视觉稿 anniv / annko）：纯 TS，不碰 React 和 DOM（A1）
// • 行 → 列表项：推算一律经 shared/logic/anniv/next-date.ts（和服务器 push-dispatch、anniv-roll 同一份）；“还有几天”“满几周岁 / 第几年”现算，
//   不靠服务器的 next_date、archived_at（离线新建的也立刻排对位置）
// • 只读行（0.27 第 1 点；代定 D1）：枚举认不出、月日不合格（annivRecOf 回 null）、韩国阴历（lunar_variant = 'kr'，这一版算不出）、
//   同步层标了只读的（core 的 readonlyIds）。只读行照样列出来（排在最后），点了提示“这一条要新版本才能显示”，不进编辑
// • 排序：生日、纪念日、倒数日合在一起按“还有几天”从近到远（同一天按名字），只读行排最后；已过去的倒数日单独一组（折叠），最近过去的在前
// • 筛选：全部 / 生日 / 纪念日 / 倒数日；数字只数没过去的（视觉稿“全部 6”不含已过去的 2 条）
import type { DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { annivRecOf, annivState, createdDayOf, upcoming, type AnnivKind, type AnnivRec, type AnnivState } from '../../../../shared/logic/anniv/next-date.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';

export type Row = Readonly<Record<string, unknown>> & { readonly id: string };
export type AnnivFilter = 'all' | AnnivKind;
export const FILTERS: readonly AnnivFilter[] = ['all', 'birthday', 'anniversary', 'countdown'];

export interface AnnivItem {
  readonly id: string;
  readonly row: Row;
  readonly name: string;
  /** 只读行为 null */
  readonly rec: AnnivRec | null;
  /** 算得出的状态；只读行、超出农历表范围的为 null */
  readonly state: AnnivState | null;
  readonly ro: boolean;
}

export interface AnnivList {
  /** 按“还有几天”排好的（不含已过去的倒数日），已按筛选过滤 */
  readonly items: readonly AnnivItem[];
  /** 已过去的倒数日（筛选为全部或倒数日时才有） */
  readonly past: readonly AnnivItem[];
  /** “最近的一个”大卡：items 里第一条算得出的 */
  readonly nearest: AnnivItem | null;
  /** 各筛选的条数（不含已过去的） */
  readonly counts: Readonly<Record<AnnivFilter, number>>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 一行 → 列表项（roIds：同步层标了只读的 id） */
export function itemOf(row: Row, today: DateStr, tz: Tz, roIds: ReadonlySet<string> = new Set()): AnnivItem {
  const rec = annivRecOf(row);
  const ro = rec === null || rec.lunar_variant !== 'cn' || roIds.has(row.id);
  const state = ro || rec === null ? null : annivState(rec, today, createdDayOf(row, tz, today));
  return { id: row.id, row, name: str(row['name']), rec: ro ? null : rec, state, ro };
}

const byDays = (a: AnnivItem, b: AnnivItem): number => {
  if (a.state === null || b.state === null) return a.state === null ? (b.state === null ? a.name.localeCompare(b.name) : 1) : -1;
  return a.state.days - b.state.days || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
};

/** 列表（filter 之外的条数也算出来给筛选胶囊） */
export function annivList(rows: readonly Row[], today: DateStr, tz: Tz, filter: AnnivFilter, roIds: ReadonlySet<string> = new Set()): AnnivList {
  const all = rows.filter((r) => isLiveRow(r)).map((r) => itemOf(r, today, tz, roIds));
  const live = all.filter((x) => !x.state?.past).sort(byDays);
  const pastAll = all.filter((x) => x.state?.past === true).sort((a, b) => (b.state?.days ?? 0) - (a.state?.days ?? 0));
  const kindOf = (x: AnnivItem): unknown => x.row['kind'];
  const counts = { all: live.length, birthday: 0, anniversary: 0, countdown: 0 } as Record<AnnivFilter, number>;
  for (const x of live) {
    const k = kindOf(x);
    if (k === 'birthday' || k === 'anniversary' || k === 'countdown') counts[k]++;
  }
  const items = filter === 'all' ? live : live.filter((x) => kindOf(x) === filter);
  const past = filter === 'all' || filter === 'countdown' ? pastAll : [];
  return { items, past, nearest: items.find((x) => x.state !== null) ?? null, counts };
}

/** 接下来几次（电脑详情“接下来 3 次”；只读行回空） */
export function nextFew(x: AnnivItem, today: DateStr, tz: Tz, n = 3): readonly DateStr[] {
  return x.rec ? upcoming(x.rec, today, n, createdDayOf(x.row, tz, today)) : [];
}

