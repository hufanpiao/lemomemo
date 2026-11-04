// 月历、周视图界面共用的小工具（B2 FA-3）：项目色的样式类、星期几的词典键、事项的标题和简称
import { CN_WORKDAY_TAILS } from './holiday-tail-data.ts';
import type { CalItems } from '../../../../shared/logic/calendar/cal-items.ts';
import type { ProjectColor } from '../../../../shared/logic/project-color.ts';
import { displayShort } from '../../../../shared/logic/short.ts';
import styles from './CalendarPage.module.css';

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

/** 当天第几分钟 → “HH:MM”（1440 写成 24:00，色块到当天末尾时用） */
export function hm(min: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

type ItemKind = 'allDay' | 'todo' | 'timed';

function rowOf(items: CalItems, kind: ItemKind, id: string) {
  return kind === 'todo' ? items.todos.find((x) => x.id === id) : items.events.find((x) => x.id === id);
}

/** 事项的简称（R-106：用户写的简称，没有就自动截） */
export function itemShort(items: CalItems, kind: ItemKind, id: string): string {
  const row = rowOf(items, kind, id);
  return row ? displayShort(row) : '';
}

/** 事项的完整标题（找不到时空串） */
export function itemTitle(items: CalItems, kind: ItemKind, id: string): string {
  return rowOf(items, kind, id)?.title ?? '';
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

export function holText(
  h: { readonly kind: 'off' | 'work'; readonly name: string },
  workday: string,
  narrow?: { readonly full: string; readonly short: string },
): string {
  if (h.kind !== 'work') return narrow ? narrowHolName(h.name, narrow) : h.name;
  const base = stripWorkdayTail(h.name);
  return base === '' ? workday : `${workday}·${base}`;
}

/**
 * 窄处（手机月格、手机泳道）的节日短写（负责人 11-04 定 L1）：名字以 full 开头的（韩国补休日“대체공휴일(개천절)”）显示成 short（“대체휴일”），括号部分去掉。
 * 数据文件保留官方全称；日清单、电脑周表头、读屏文字照旧用全称。full / short 是数据语言（韩国节假日文件只有韩文名），放在词条 cal.subHolFull / cal.subHolShort
 */
export function narrowHolName(name: string, narrow: { readonly full: string; readonly short: string }): string {
  return narrow.full !== '' && name.startsWith(narrow.full) ? narrow.short : name;
}
