// 今天页顶部的纪念日一行（B5 S14；定稿线框 s1 ANNLINE）：挑哪一条（纯 TS，A1）
// • 用服务器算好的 next_date（push-dispatch、anniv-roll 写的系统列），今天页不加载农历推算（next-date.ts 带农历表，2.6 不进首屏）；
//   离线新建、还没同步回来的那一条没有 next_date，这一行先不出，同步回来就出
// • 7 天内（含今天）最近的一个；已删、撤销、已归档（已过去的倒数日）、next_date 早于今天（还没滚到下一次）的不算；同一天按名字
import { addDays, diffDays, type DateStr } from '../../../../shared/core/date.ts';

export const ANNIV_SOON_DAYS = 7;

export interface AnnivSoon {
  readonly row: Readonly<Record<string, unknown>> & { readonly id: string };
  readonly days: number;
}

export function annivSoon(rows: readonly (Readonly<Record<string, unknown>> & { readonly id: string })[], today: DateStr): AnnivSoon | null {
  const last = addDays(today, ANNIV_SOON_DAYS);
  let best: AnnivSoon | null = null;
  for (const row of rows) {
    const d = row['next_date'];
    if (typeof d !== 'string' || d < today || d > last) continue;
    if ((row['deleted_at'] ?? null) !== null || row['undone'] === true || (row['archived_at'] ?? null) !== null) continue;
    const days = diffDays(today, d);
    const name = typeof row['name'] === 'string' ? row['name'] : '';
    const bestName = typeof best?.row['name'] === 'string' ? best.row['name'] : '';
    if (!best || days < best.days || (days === best.days && name.localeCompare(bestName) < 0)) best = { row, days };
  }
  return best;
}
