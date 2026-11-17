// 月历、周视图界面共用的小工具（B2 FA-3）：项目色的样式类、星期几的词典键、节假日的画法和写法、一天看得见的字和读屏打头几段
// （事项标题直接用 DayEntry.title / BlockBase.title，不再回 items 里按 id 找，11-17 日历整块评审第 3 条）
import { addDays, type DateStr } from '../../../../shared/core/date.ts';
import { CN_WORKDAY_TAILS } from './holiday-tail-data.ts';
import type { Cont } from '../../../../shared/logic/calendar/event-span.ts';
import type { HolidayKind, HolidayMark } from '../../../../shared/logic/calendar/holidays.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import type { ProjectColor } from '../../../../shared/logic/project-color.ts';
import styles from './cal-common.module.css';

/** 项目色 0–6 → 样式类（check_backend F7：不用方括号查表，用 switch） */
export function colorClass(i: ProjectColor): string {
  switch (i) {
    case 1:
      return styles.c1 ?? '';
    case 2:
      return styles.c2 ?? '';
    case 3:
      return styles.c3 ?? '';
    case 4:
      return styles.c4 ?? '';
    case 5:
      return styles.c5 ?? '';
    case 6:
      return styles.c6 ?? '';
    case 0:
      return styles.c0 ?? '';
  }
}

export type WeekdayKey = 'cal.wd.0' | 'cal.wd.1' | 'cal.wd.2' | 'cal.wd.3' | 'cal.wd.4' | 'cal.wd.5' | 'cal.wd.6';

/** 星期几（0 = 周日）→ 词典键 */
export function weekdayKey(wd: number): WeekdayKey {
  switch (wd) {
    case 1:
      return 'cal.wd.1';
    case 2:
      return 'cal.wd.2';
    case 3:
      return 'cal.wd.3';
    case 4:
      return 'cal.wd.4';
    case 5:
      return 'cal.wd.5';
    case 6:
      return 'cal.wd.6';
    default:
      return 'cal.wd.0';
  }
}

/**
 * 节假日一行的文字：放假写名字；补班写“班·名字”（月格、手机泳道、电脑表头共用）。
 * “班”放在最前：手机月格一格只有约 45 px，放不下时省略号吃掉的是名字的尾巴，“班”总看得见（截图 11-04 发现“国庆节补班”被截成“国庆节…”）；
 * 节假日文件里的名字本来就带补班尾巴（“国庆节补班”“춘절 대체 근무일”）的，去掉这个尾巴再拼，免得写两遍（手机月格“근무·춘절”）。
 * 尾巴按实际取到的那份名字认（R-106 B2K-06、R-338、R-340）：holidayMarks 按界面语言取 name.zh / name.ko，缺了回落中文名，
 * 所以中文名去“补班”、韩文名去“ 대체 근무일”，哪个结尾对上去哪个，去掉后 trim；
 * 尾巴是数据常量 CN_WORKDAY_TAILS（ui/holiday-tail-data.ts，和 src/public/holidays/cn/*.json 的写法一致，__tests__/holiday-tail.test.ts 查），审校改了写法只改那里
 */

/** 名字去掉补班尾巴（连同前后空格）；对不上原样返回 */
export function stripWorkdayTail(name: string): string {
  for (const raw of Object.values(CN_WORKDAY_TAILS)) {
    const tail = raw.trim();
    if (tail !== '' && name.endsWith(tail)) return name.slice(0, -tail.length).trim();
  }
  return name;
}

/**
 * 补班日读屏（B2K-08）：名字里已经带了补班尾巴（“春节补班”“춘절 대체 근무일”）就直接读名字，
 * 不再套 cal.a11y.workday 的括号（原来读成“元旦补班（补班）”）；没带尾巴的才用 wrap 加括号
 */
export function workdayA11y(name: string, wrap: (name: string) => string): string {
  return stripWorkdayTail(name) !== name ? name : wrap(name);
}

/** 一条节假日的读屏写法：放假读名字，补班按 workdayA11y（月格、手机泳道共用） */
export function holA11y(h: HolidayMark, t: CalViewT): string {
  return h.kind === 'work' ? workdayA11y(h.name, (name) => t('cal.a11y.workday', { name })) : h.name;
}

/**
 * 这一天按哪种画（月格、手机泳道、电脑周表头和列共用一套斜纹类，cal-common.module.css .holiday / .workday）：
 * 有放假的按放假；只有补班的按补班；都没有 null
 */
export function dayKind(hols: readonly HolidayMark[]): HolidayKind | null {
  if (hols.some((h) => h.kind === 'off')) return 'off';
  return hols.length > 0 ? 'work' : null;
}

/** dayKind → 斜纹样式类 */
export function dayKindClass(kind: HolidayKind | null): string {
  if (kind === 'off') return styles.holiday ?? '';
  return kind === 'work' ? (styles.workday ?? '') : '';
}

/**
 * 这一天要写出名字的节假日（负责人 11-15“照参考图做”：连续放假只在第一天写节日名，后面几天照常显示节气或农历）：
 * 放假的、前一天同一国同名也放假的，算连休的后几天，不写；补班照旧写。读屏名字不用它，照旧念全部（月格 MonthGrid labelOf、手机泳道）
 */
export function namedHolidays(date: DateStr, hols: readonly HolidayMark[], all: ReadonlyMap<DateStr, readonly HolidayMark[]>): HolidayMark[] {
  const prev = all.get(addDays(date, -1)) ?? [];
  return hols.filter((h) => h.kind !== 'off' || !prev.some((p) => p.kind === 'off' && p.country === h.country && p.name === h.name));
}

export function holText(
  h: { readonly kind: 'off' | 'work'; readonly name: string },
  workday: string,
  narrow?: { readonly full: string; readonly short: string },
): string {
  if (h.kind !== 'work') return narrow ? narrowHolName(h.name, narrow) : h.name;
  const base = stripWorkdayTail(h.name);
  return base === '' ? workday : `${workday}·${base}`;
}

/** 一天看得见的那几段字（月格、手机周泳道共用，画格子和读屏名字用同一份）：右上角 / 数字旁“班”标、那一行（节假日 > fallback）、第二个节日名、那一行是不是放假的节日名 */
export interface DayLines {
  readonly badge: string;
  readonly line: string;
  readonly hol2: string;
  readonly offName: boolean;
}

/**
 * 只写 named 里的（连休后几天不写节日名，见 namedHolidays）；补班日（当天只有补班）的“班”放进小圆标，
 * 那一行和第二个名字都只写去掉补班尾巴的节日名。fallback：没有要写的节日时那一行写什么（节气或农历）。
 * 月格、手机泳道、电脑周表头三处共用（11-17 日历整块评审第 6 条）；wide 为 true（电脑周表头）时节日名写全称，不换窄处短写（narrowHolName）
 */
export function dayLines(kind: HolidayKind | null, named: readonly HolidayMark[], fallback: string, t: CalViewT, wide = false): DayLines {
  const sub = wide ? undefined : { full: t('cal.subHolFull', {}), short: t('cal.subHolShort', {}) };
  const [first, second] = named;
  const badge = kind === 'work' ? t('cal.workday', {}) : '';
  const text = (h: HolidayMark): string => (badge === '' ? holText(h, t('cal.workday', {}), sub) : stripWorkdayTail(h.name));
  return { badge, line: first ? text(first) : fallback, hol2: second ? text(second) : '', offName: first?.kind === 'off' };
}

/**
 * 一天的读屏补充说明里打头的那几段（月格、手机泳道共用；11-17 日历整块评审第 6 条）：“10月19日”、星期（月格要念，泳道前面已念过、不传）、
 * “今天”、这一天的全部节假日（连休后几天格子里不写名字，读屏照旧念，holA11y）。后面接什么由各自加（农历、件数、逾期……）
 */
export function dayA11y(date: DateStr, hols: readonly HolidayMark[], isToday: boolean, t: CalViewT, weekday?: string): string[] {
  return [dateA11y(date, t), ...(weekday === undefined ? [] : [weekday]), ...(isToday ? [t('cal.a11y.todayMark', {})] : []), ...hols.map((h) => holA11y(h, t))];
}

/** 跨天日程这一天是第几天、共几天的写法“2/3”（周泳道条右端、电脑周表全天行共用；R-444、R-445） */
export function ofText(of: { readonly index: number; readonly days: number } | undefined): string {
  return of ? `${of.index}/${of.days}` : '';
}

/** 被切开的一边 → 样式类（月格跨天色块、周泳道全天条和时刻块同一套 .contStart / .contEnd：那一端直角，头从前面接过来的不画左侧深色竖线） */
export function contClass(cont: Cont | undefined): string {
  const start = cont === 'start' || cont === 'both' ? (styles.contStart ?? '') : '';
  const end = cont === 'end' || cont === 'both' ? (styles.contEnd ?? '') : '';
  return [start, end].filter(Boolean).join(' ');
}

/** 读屏念的“10月19日”（月格、周泳道、周视图标题共用） */
export function dateA11y(date: DateStr, t: CalViewT): string {
  return t('cal.a11y.date', { m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) });
}

/** 周六、周日（0 = 周日）：月格、周泳道“周末淡底加灰字”（R-445） */
export function weekendClass(weekday: number): string {
  return weekday === 0 || weekday === 6 ? (styles.wkend ?? '') : '';
}

/**
 * 窄处（手机月格、手机泳道）的节日短写（负责人 11-04 定 L1）：名字以 full 开头的（韩国补休日“대체공휴일(개천절)”）显示成 short（“대체휴일”），括号部分去掉。
 * 数据文件保留官方全称；日清单、电脑周表头、读屏文字照旧用全称。full / short 是数据语言（韩国节假日文件只有韩文名），放在词条 cal.subHolFull / cal.subHolShort
 */
export function narrowHolName(name: string, narrow: { readonly full: string; readonly short: string }): string {
  return narrow.full !== '' && name.startsWith(narrow.full) ? narrow.short : name;
}

/**
 * 日期格、泳道按钮的读屏名字（WCAG 2.5.3 Label in Name，axe label-content-name-mismatch）：
 * 先按显示顺序念格子里看得见的字（空格隔开，空的跳过），再接补充说明（完整日期、星期、农历全称、件数……），用 cal.a11y.sep 连。
 * 这样语音控制照着屏幕说“点 26 十七”能点中；看得见的字由调用方从画格子的同一份数据取，农历加载前后都对得上。
 * DOM 里这几段字之间也要有空格（MonthGrid、WeekView 里的 {' '}；格子是 flex / grid、轨道里全是绝对定位，空格不画出来）：
 * 否则 axe 把相邻两段连成一个词（“26추석”“+13”），和名字里的词对不上
 */
export function labelInName(shown: readonly string[], rest: readonly string[], sep: string): string {
  return [shown.filter((s) => s !== '').join(' '), ...rest].filter((s) => s !== '').join(sep);
}
