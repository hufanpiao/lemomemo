// 今天页顶部的纪念日一行（B5 S14；定稿线框 s1 ANNLINE）：挑哪一条（纯 TS，A1）
// • 用服务器算好的 next_date（push-dispatch、anniv-roll 写的系统列），今天页不加载农历推算（next-date.ts 带农历表，2.6 不进首屏）；
//   离线新建、还没同步回来的那一条没有 next_date，这一行先不出，同步回来就出
// • 以服务器为准（整块评审第 19 条核过，不改成本机现算）：离线改了日期、还没同步回来时这里还是旧的 next_date；
//   本机现算要在首屏画完前加载农历表，今天页首屏预算不允许。纪念日页、提醒、月历菱形才按需现算（core/anniv-lib.ts）
// • 7 天内（含今天）最近的一个；已删、撤销、已归档（已过去的倒数日）、next_date 早于今天（还没滚到下一次）的不算；同一天按名字
import { addDays, diffDays, type DateStr } from '../../../../shared/core/date.ts';

export const ANNIV_SOON_DAYS = 7;

export interface AnnivSoon {
  readonly row: Readonly<Record<string, unknown>> & { readonly id: string };
  readonly days: number;
}

type AnnivRow = Readonly<Record<string, unknown>> & { readonly id: string };

/** 纪念日的名字（不是字符串当空） */
export const nameOf = (r: AnnivRow): string => (typeof r['name'] === 'string' ? r['name'] : '');

/** within 天内（含今天）的纪念日，近的在前、同一天按名字；最多 max 个（电脑版“快到了”块列几个，B6；手机这一行只要最近的一个） */
export function annivUpcoming(rows: readonly AnnivRow[], today: DateStr, within: number, max: number): AnnivSoon[] {
  const last = addDays(today, within);
  const out: AnnivSoon[] = [];
  for (const row of rows) {
    const d = row['next_date'];
    if (typeof d !== 'string' || d < today || d > last) continue;
    if ((row['deleted_at'] ?? null) !== null || row['undone'] === true || (row['archived_at'] ?? null) !== null) continue;
    out.push({ row, days: diffDays(today, d) });
  }
  return out.sort((a, b) => a.days - b.days || nameOf(a.row).localeCompare(nameOf(b.row))).slice(0, max);
}

export function annivSoon(rows: readonly AnnivRow[], today: DateStr): AnnivSoon | null {
  return annivUpcoming(rows, today, ANNIV_SOON_DAYS, 1)[0] ?? null;
}
