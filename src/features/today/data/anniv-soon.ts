// 今天页顶部的纪念日一行（B5 S14；定稿线框 s1 ANNLINE）：挑哪一条（纯 TS，A1）
// • 用服务器算好的 next_date（push-dispatch、anniv-roll 写的系统列），今天页不加载农历推算（next-date.ts 带农历表，2.6 不进首屏）；
//   离线新建、还没同步回来的那一条没有 next_date，这一行先不出，同步回来就出
// • 以服务器为准（整块评审第 19 条核过，不改成本机现算）：离线改了日期、还没同步回来时这里还是旧的 next_date；
//   本机现算要在首屏画完前加载农历表，今天页首屏预算不允许。纪念日页、提醒、月历菱形才按需现算（core/anniv-lib.ts）
// • 7 天内（含今天）最近的一个；已删、撤销、已归档（已过去的倒数日）、next_date 早于今天（还没滚到下一次）的不算；同一天按名字
// • 电脑版“快到了”块（30 天内最多 3 个）用同一个 annivUpcoming；两处显示的名字（annivLabel，生日加“生日”）、还有几天（annivWhen）也只在这里算
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

/** 显示文字要的几句（today 的 useTodayT；data 层不写文字） */
export interface AnnivT {
  (k: 'today.anniv.in', p: { n: number }): string;
  (k: 'today.anniv.today' | 'today.anniv.tomorrow' | 'today.anniv.bday', p: Record<string, never>): string;
}

/** 显示的名字：生日那一种后面写“生日”（线框 ANNLINE“3 天后 김지민 生日”）；名字里已经写了（“妈妈生日”）不再加。
 *  纪念日、倒数日的名字本身就是事情（“结婚纪念日”），不加。手机纪念日一行、电脑“快到了”块共用 */
export function annivLabel(row: AnnivRow, t: AnnivT): string {
  const name = nameOf(row);
  const bday = t('today.anniv.bday', {});
  return row['kind'] === 'birthday' && !name.includes(bday) ? `${name} ${bday}` : name;
}

/** 还有几天：“今天”“明天”“3 天后” */
export const annivWhen = (days: number, t: AnnivT): string =>
  days === 0 ? t('today.anniv.today', {}) : days === 1 ? t('today.anniv.tomorrow', {}) : t('today.anniv.in', { n: days });
