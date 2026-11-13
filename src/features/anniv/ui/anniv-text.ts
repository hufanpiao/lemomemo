// 纪念日页面上拼出来的几句话（列表副行、大卡、编辑页“下一次”、提醒摘要）：只拼词条和数字，不碰 React
// 农历的月日名、提醒默认值经 annivLib()（data/anniv-lib.ts 按需加载，农历表不进首屏，2.6）：页面加载好 lib 以后才调
import { parseDate, type DateStr } from '../../../../shared/core/date.ts';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import type { AnnivRec, AnnivState } from '../../../../shared/logic/anniv/next-date.ts';
import { annivLib } from '../hooks/anniv-view.ts';
import type { AnnivT } from '../hooks/useAnnivT.ts';

/** '09:00' → '9:00'（视觉稿的写法） */
export const hm = (s: string): string => s.replace(/^0(\d):/, '$1:');

/** 这一条自己的阴历月日（“十月初八”“闰三月初十”） */
export function lunarMd(r: Pick<AnnivRec, 'month' | 'day' | 'is_leap'>, locale: UiLocale): string {
  return annivLib().lunarText({ year: 2000, month: r.month, day: r.day, isLeap: r.is_leap }, locale);
}

/** 阴历日子那一列的选项文字（“初一”“十五”/“1일”）：月名之后那一段 */
export function lunarDayName(day: number, locale: UiLocale): string {
  const L = annivLib();
  return L.lunarText({ year: 2000, month: 1, day, isLeap: false }, locale).slice(L.lunarMonthName(1, false, locale).length).trim();
}

/** “满 29 周岁”“第 6 年”；没有（倒数日、不知道年份）回 null */
export function ageText(r: AnnivRec, st: AnnivState, t: AnnivT): string | null {
  if (st.age === null) return null;
  if (r.kind === 'birthday') return t('anniv.age.birthday', { n: st.age });
  if (r.kind === 'anniversary') return t('anniv.age.anniversary', { n: st.age });
  return null;
}

/** 下一次的公历日期，阴历的带“今年 / 明年 / 某年” */
function solarWhen(next: DateStr, today: DateStr, locale: UiLocale, t: AnnivT): string {
  const day = fmtDay(next, locale, 'monthDayWeek');
  const dy = parseDate(next).y - parseDate(today).y;
  return dy === 0 ? t('anniv.thisYear', { date: day }) : dy === 1 ? t('anniv.nextYear', { date: day }) : t('anniv.inYear', { y: parseDate(next).y, date: day });
}

/** 列表行的副行：阳历“10月27日 周二 · 阳历 · 满 29 周岁”；阴历“阴历十月初八 · 今年 11月16日 周一 · 满 58 周岁”；倒数日“11月30日 周一” */
export function metaText(r: AnnivRec, st: AnnivState, today: DateStr, locale: UiLocale, t: AnnivT): string {
  const age = ageText(r, st, t) ?? (r.kind !== 'countdown' && r.year === null ? t('anniv.noYear', {}) : null);
  const parts =
    r.calendar === 'lunar'
      ? [t('anniv.lunar', { text: lunarMd(r, locale) }), solarWhen(st.next.date, today, locale, t)]
      : r.kind === 'countdown'
        ? [fmtDay(st.next.date, locale, 'monthDayWeek')]
        : [fmtDay(st.next.date, locale, 'monthDayWeek'), t('anniv.solar', {})];
  if (age) parts.push(age);
  if (st.past) parts.push(t('anniv.ago', { n: -st.days }));
  return parts.join(' · ');
}

/**
 * 提前天数 → 短行“提前 7 天、前一天”（设置那一行、编辑页提醒一行、选项）；句子里（and = true：大卡最后一行、弹层说明）
 * 最后两项用“和”：“提前 7 天和前一天”（视觉稿 anniv、annedit 弹层）
 */
export function offsText(offs: readonly number[], t: AnnivT, and = false): string {
  const xs = offs.map((n) => (n === 0 ? t('anniv.rm.off.0', {}) : n === 1 ? t('anniv.rm.off.1', {}) : t('anniv.rm.off.n', { n })));
  const last = and ? xs.pop() : undefined;
  const head = xs.join(t('anniv.rm.sep', {}));
  return last === undefined ? head : head ? `${head}${t('anniv.rm.and', {})}${last}` : last;
}

/** 编辑页“再往后：…”：不在今年的带年份（“2027年 11月14日”） */
export function laterText(dates: readonly DateStr[], today: DateStr, locale: UiLocale, t: AnnivT): string {
  const y0 = parseDate(today).y;
  return dates
    .map((d) => (parseDate(d).y === y0 ? fmtDay(d, locale, 'monthDay') : t('anniv.inYear', { y: parseDate(d).y, date: fmtDay(d, locale, 'monthDay') })))
    .join(t('anniv.rm.sep', {}));
}

/** 提醒摘要（编辑页提醒一行）：“提前 7 天、前一天 · 9:00（默认）” */
export function remindLine(r: Pick<AnnivRec, 'remind_offsets' | 'remind_time'>, settings: Readonly<Record<string, unknown>>, t: AnnivT): string {
  const L = annivLib();
  const line = t('anniv.rm.line', { offs: offsText(L.offsetsOf(r, settings), t), time: hm(L.remindTimeOf(r, settings)) });
  return r.remind_offsets === null && r.remind_time === null ? `${line}${t('anniv.rm.default', {})}` : line;
}

/** 大卡最后一行：“10月27日 周二 · 提前 7 天、前一天 9:00 提醒” */
export function cardRemindLine(r: AnnivRec, st: AnnivState, settings: Readonly<Record<string, unknown>>, locale: UiLocale, t: AnnivT): string {
  const L = annivLib();
  return t('anniv.rm.cardLine', { date: fmtDay(st.next.date, locale, 'monthDayWeek'), offs: offsText(L.offsetsOf(r, settings), t, true), time: hm(L.remindTimeOf(r, settings)) });
}

/** 编辑页“下一次：…”：阳历“10月27日 周二 · 满 29 周岁”；阴历“2027年 三月初十 → 公历 4月15日 周四 · 满 72 周岁” */
export function nextText(r: AnnivRec, st: AnnivState, today: DateStr, locale: UiLocale, t: AnnivT): string {
  const date = fmtDay(st.next.date, locale, 'monthDayWeek');
  const age = ageText(r, st, t);
  let head = date;
  if (r.calendar === 'lunar') {
    const L = annivLib();
    const l = L.toLunar(st.next.date, 'cn');
    const lunar = l ? `${t('anniv.edit.yearOpt', { y: l.year })} ${L.lunarText(l, locale)}` : '';
    head = t('anniv.edit.nextLunar', { lunar, date });
  } else if (parseDate(st.next.date).y !== parseDate(today).y) {
    head = t('anniv.inYear', { y: parseDate(st.next.date).y, date });
  }
  return age ? `${head} · ${age}` : head;
}
