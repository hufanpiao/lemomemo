// 节假日（架构 5.12 第 1 点、5.4、R-97；第 9 节“holidays”；TC-B2-12）
// • holidayCountries：设置 cal.holidays 三选一（cn / kr / both），没选过时跟界面语言（zh-CN → cn、ko-KR → kr）；
// • holidayFetchPaths：要拉哪几份 holidays/<国家>/<年>.json（只拉需要的国家；翻到 11、12 月带上明年，1 月带上去年）；
// • parseHolidayFile：校验拉回来的 JSON（形状不对整份不用，不报错——月历照常显示，只是没有节假日）；
// • holidayMarks：几份文件合成“日期 → 当天的节假日”，同一天先排和界面语言同一国的，补班只在包含中国时出现。
// 拉文件、缓存、离线提示归界面一侧（features/calendar），这里只做纯计算。
// 数据归后端（架构审 Q3、D5），这里不带任何数据；JSON 的字段形状架构没写死，先按
// {country, year, days: [{date, kind, name: {zh?, ko?}}]} 定，是接口占位，等后端定稿后跟着改。
import { parseDate, type DateStr } from '../../core/date.ts';
import type { UiLocale } from '../../i18n/pick-locale.ts';

export type HolidayCountry = 'cn' | 'kr';
/** settings 里 cal.holidays 的取值 */
export type HolidaySetting = 'cn' | 'kr' | 'both';

/** 放假（off：法定节假日、临时公休日）还是调休补班（work：只有中国有） */
export type HolidayKind = 'off' | 'work';

/** JSON 里的一天。name 按界面语言各写一份，缺了用这个国家本国语言的那份 */
export interface HolidayDay {
  readonly date: DateStr;
  readonly kind: HolidayKind;
  readonly name: { readonly zh?: string; readonly ko?: string };
}

/** 一份 holidays/<国家>/<年>.json 校验后的内容 */
export interface HolidayFile {
  readonly country: HolidayCountry;
  readonly year: number;
  readonly days: readonly HolidayDay[];
}

/** 月历格子里的一条节假日 */
export interface HolidayMark {
  readonly country: HolidayCountry;
  readonly kind: HolidayKind;
  readonly name: string;
}

/** 界面语言对应的国家（check_backend F7：方括号里的键要追得到字面量，查表改用 switch） */
function countryOf(locale: UiLocale): HolidayCountry {
  switch (locale) {
    case 'zh-CN':
      return 'cn';
    case 'ko-KR':
      return 'kr';
  }
}

function otherCountry(c: HolidayCountry): HolidayCountry {
  return c === 'cn' ? 'kr' : 'cn';
}

/**
 * 要显示哪几国的节假日（R-97）。设置值认得就按设置；没存（null、undefined）或不认识时跟界面语言。
 * 返回顺序就是同一天的排列顺序：和界面语言同一国的在前（“两国都显示”时另一国排第二）。
 */
export function holidayCountries(setting: unknown, locale: UiLocale): HolidayCountry[] {
  const own = countryOf(locale);
  if (setting === 'cn' || setting === 'kr') return [setting];
  if (setting === 'both') return [own, otherCountry(own)];
  return [own];
}

/** 显示某年某月时要拉的年份：当年；11、12 月加明年；1 月加去年（5.12 第 3 点“数据预取”） */
export function holidayYears(y: number, m: number): number[] {
  if (m >= 11) return [y, y + 1];
  if (m === 1) return [y, y - 1];
  return [y];
}

/** 要拉的文件相对路径（相对 App 根目录，如 'holidays/cn/2027.json'），按国家、年份排 */
export function holidayFetchPaths(countries: readonly HolidayCountry[], years: readonly number[]): string[] {
  return countries.flatMap((c) => years.map((y) => `holidays/${c}/${y}.json`));
}

function isObj(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optName(v: unknown): string | undefined | false {
  if (v === undefined) return undefined;
  return typeof v === 'string' && v.trim() !== '' && v.length <= 40 ? v : false;
}

function parseDay(v: unknown, country: HolidayCountry, year: number): HolidayDay | null {
  if (!isObj(v) || typeof v['date'] !== 'string' || !isObj(v['name'])) return null;
  const date = v['date'];
  try {
    if (parseDate(date).y !== year) return null;
  } catch {
    return null;
  }
  const kind = v['kind'];
  // 补班只有中国有
  if (kind !== 'off' && !(kind === 'work' && country === 'cn')) return null;
  const zh = optName(v['name']['zh']);
  const ko = optName(v['name']['ko']);
  if (zh === false || ko === false || (zh === undefined && ko === undefined)) return null;
  return { date, kind, name: { ...(zh === undefined ? {} : { zh }), ...(ko === undefined ? {} : { ko }) } };
}

/**
 * 校验拉回来的 JSON：`{country, year, days: [{date, kind, name: {zh?, ko?}}]}`。
 * country、year 必须和请求的文件对得上；任何一条不对整份返回 null（宁可不显示，也不显示错的）。
 * 整份是 `[]`、或 days 是空数组，都当“这一年没有节假日”（代码审查 D），不当坏数据。
 */
export function parseHolidayFile(json: unknown, country: HolidayCountry, year: number): HolidayFile | null {
  if (Array.isArray(json) && json.length === 0) return { country, year, days: [] };
  if (!isObj(json) || json['country'] !== country || json['year'] !== year || !Array.isArray(json['days'])) return null;
  const days: HolidayDay[] = [];
  for (const d of json['days'] as readonly unknown[]) {
    const day = parseDay(d, country, year);
    if (!day) return null;
    days.push(day);
  }
  return { country, year, days };
}

/** 按界面语言取名字；没有就用本国语言（中国的默认中文，韩国的默认韩文）的那份（check_backend F7：方括号里的键要追得到字面量，查表改用 switch） */

function nameFor(day: HolidayDay, country: HolidayCountry, locale: UiLocale): string {
  const ui = locale === 'ko-KR' ? day.name.ko : day.name.zh;
  const native = country === 'kr' ? day.name.ko : day.name.zh;
  return ui ?? native ?? day.name.zh ?? day.name.ko ?? '';
}

/**
 * 把拉到的几份文件合成“日期 → 当天的节假日”。
 * • 只用 countries 里的国家（设置切到只看韩国后，内存里还留着的中国文件不显示，补班也就不出现）；
 * • 同一天按 countries 的顺序排（界面语言那国在前），同一国里放假在前、补班在后，再按文件里的先后；
 * • 名字按界面语言取，没有就用本国语言那份。
 */
export function holidayMarks(
  files: readonly HolidayFile[],
  countries: readonly HolidayCountry[],
  locale: UiLocale,
): Map<DateStr, HolidayMark[]> {
  const rank = (c: HolidayCountry): number => countries.indexOf(c);
  const out = new Map<DateStr, HolidayMark[]>();
  // 同一国同一年的文件传了两次（例如刷新后重拉）只用第一份，免得同一天出现两遍
  const seen = new Set<string>();
  for (const f of files) {
    const key = `${f.country}/${f.year}`;
    if (rank(f.country) < 0 || seen.has(key)) continue;
    seen.add(key);
    for (const day of f.days) {
      const list = out.get(day.date) ?? [];
      list.push({ country: f.country, kind: day.kind, name: nameFor(day, f.country, locale) });
      out.set(day.date, list);
    }
  }
  const kindRank = (k: HolidayKind): number => (k === 'off' ? 0 : 1);
  // Array.prototype.sort 是稳定排序：同国同类保持文件里的先后
  for (const list of out.values()) list.sort((a, b) => rank(a.country) - rank(b.country) || kindRank(a.kind) - kindRank(b.kind));
  return out;
}
