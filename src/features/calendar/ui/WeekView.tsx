// 周视图
// • 时间轴范围按当周事项自动伸缩：默认 8～22 点，有更早、更晚的事扩到那个整点（week-axis.ts）
// • 手机（窄屏）：时间轴泳道，套月格的样式。一天一条泳道（--cal-lane-h 高），左边“周一 / 19 / 农历或节日”，右边横向时间轴
//   （不画“当天共几项、逾”那一列，读屏照旧念）
//   – 周末、放假、补班、今天、选中和月格同一套类（.wkend .holiday .workday .today .sel .dayNum）
//   – 顶部刻度数字、每 2 小时一条刻度线；今天那条泳道上一条竖线是“现在”
//   – 全部直接画出来，不收成“+N”：轨道里一排一排往下堆，全天日程每件一整条占一排，时刻块和待办接着往下（buildWeek 排号 row），
//     排多了泳道变高（WeekView.module.css .trk）
//   – 日程色块：底色项目块色、左侧 2 px 深色竖线、--on-p 字（排布交给 buildWeek）；跨天的右端写“2/3”
//   – 色块和全天条写完整标题：从开始时刻起画，宽度按 useTextPx 量的字宽撑开、写到轨道末端为止，再放不下才省略号（.wevTx）；
//     撑开后撞上的往下一排放
//   – 跨天的续条：被切开的一端画直角，头从前一天接过来的不画左侧深色竖线（cal-ui.ts contClass，和月格同一套）
//   – 待办：“○ 标题”小条（圆圈边色是项目色），有截止时刻的和时刻块一起排在那个时刻，没有的在最下面从左往右排
//   – 整条泳道是一个按钮：点了选中那一天，下面的清单列出当天全部日程和待办；色块、待办小条不单独接点按
//     （挨得近、高度不到 44：先选天、再在清单里点具体哪一条）
// • 电脑（宽屏）：7 列时间格（纵向时间轴，每小时 40 px），表头星期、日期、农历，顶部“全天”行放全天日程和当天截止的待办；
//   重叠的并排分列（buildWeek layout 'desk' 的 column / columns）；色块点了打开编辑页；点表头选中那一天
// • 节假日：放假、补班的泳道（电脑是表头和那一列）和月格同一套斜纹（cal-ui.ts dayKind / dayKindClass）；
//   连续放假只在第一天写节日名，后面几天照写农历（namedHolidays），读屏照旧念节日名
// • 量宽：用回调 ref 量第一条轨道，翻周后轨道换了新元素会重新挂 ResizeObserver
// • 读屏：泳道按钮的名字先按显示顺序念看得见的字（WCAG 2.5.3，cal-ui.ts labelInName），再接日期、今天、节日、共几项、有逾期
//   （打头几段和月格同一份 cal-ui.ts dayA11y）。共几项、逾期、时间轴范围都按 weekEntries（和月历、日清单同一份 collectEntries）算，
//   不按宽度，量到宽度之前也对；电脑布局只在 DeskWeek 里排。
//   这一份只收一遍、时区只在 weekOf 查一次，手机、电脑的 buildWeek 直接用它
import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import { weekDates } from '../../../../shared/logic/calendar/cal-nav.ts';
import type { CalItems, DayEntry } from '../../../../shared/logic/calendar/cal-items.ts';
import type { HolidayMark } from '../../../../shared/logic/calendar/holidays.ts';
import { buildWeek, segmentOn, weekEntries, type DayOf, type PhoneDay, type WeekEntries } from '../../../../shared/logic/calendar/month-grid.ts';
import { axisFrac, axisTicks, inRange, phoneScale, weekHourRange, type HourRange } from './week-axis.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import common from './cal-common.module.css';
import styles from './WeekView.module.css';
import { colorClass, contClass, dayA11y, dayKind, dayKindClass, dayLines, dayNo, labelInName, namedHolidays, ofText, spanOfText, wdFull, weekendClass } from './cal-ui.ts';
import { DayNum } from './DayNum.tsx';
import { DeskWeek } from './DeskWeek.tsx';

/** 色块最短长度（px） */
export const MIN_BLOCK_PX = 28;
/** 待办小条前面圆圈占的宽（圆 8 + 和字之间 4，.wtodo::before） */
const TODO_RING_PX = 12;

/** 色块左右内边距（.allDay / .wev 的 padding-left / padding-right）和跨天“2/3”前面的空隙（.wevOf 的 padding-left）：
 *  量字宽和画色块用同一个数，只写在这里，由 PhoneWeek 写进 --wev-pl / --wev-pr / --wev-of-gap 给 WeekView.module.css 读 */
const WEV_PL_PX = 6;
const WEV_PR_PX = 4;
const OF_GAP_PX = 4;
/** 左右内边距再留 2 px 余量：量出来的字宽加上它就是写得下完整标题的色块宽 */
const BLOCK_PAD_PX = WEV_PL_PX + WEV_PR_PX + 2;
const WEV_VARS = { '--wev-pl': `${WEV_PL_PX}px`, '--wev-pr': `${WEV_PR_PX}px`, '--wev-of-gap': `${OF_GAP_PX}px` } as CSSProperties;

/**
 * 量过的字宽（px，不含内边距）：键是“字体 | 语言 | 字”，换了字体（切语言 :lang(ko)、换字体设置、换皮肤）不会拿到旧字体量的结果；
 * 网页字体加载完一批（document.fonts 的 loadingdone）整个清空，之前按后备字体量的作废
 */
const textCache = new Map<string, number>();

/**
 * 量字的环境：“语言~第几代”。<html> 的 lang 变了换语言部分；data-skin、data-font 变了，或者网页字体加载完一批（同时清空 textCache），代数加一。
 * 进缓存键，也让 useTextPx 重新取一次计算后的字体
 */
function useFontEnv(): string {
  const [n, setN] = useState(0);
  const [lang, setLang] = useState(() => document.documentElement.lang);
  useEffect(() => {
    const bump = (): void => {
      setLang(document.documentElement.lang);
      setN((x) => x + 1);
    };
    const onFonts = (): void => {
      textCache.clear();
      bump();
    };
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(bump) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'data-skin', 'data-font'] });
    // jsdom 没有 document.fonts
    const fonts = 'fonts' in document ? document.fonts : undefined;
    fonts?.addEventListener('loadingdone', onFonts);
    return () => {
      mo?.disconnect();
      fonts?.removeEventListener('loadingdone', onFonts);
    };
  }, []);
  return `${lang}~${n}`;
}

/**
 * 量完整标题要多宽：按轨道里色块的实际字体用 canvas measureText——标题是 .wev 的字号 --fs-11、字体跟页面走；
 * 跨天的这一段右端还有“2/3”（.wevOf：等宽字 --f-mono、--fs-10，前面空 OF_GAP_PX），一起算进去，只量标题会被截。
 * 没有 OffscreenCanvas 时（旧版 iOS Safari、Windows 上的 Playwright WebKit）改用普通 <canvas> 量；
 * 两样都拿不到 2D 上下文的环境（jsdom 单测）返回 undefined，buildWeek 按不量字宽的规则排
 */
function useTextPx(el: HTMLElement | null): ((title: string, of?: DayOf) => number) | undefined {
  const env = useFontEnv();
  return useMemo(() => {
    if (el === null) return undefined;
    const ctx = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('2d') : document.createElement('canvas').getContext('2d');
    if (!ctx) return undefined;
    const cs = getComputedStyle(el);
    const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
    const titleFont = `${v('--fs-11', '11px')} ${cs.fontFamily}`;
    const ofFont = `${v('--fs-10', '10px')} ${v('--f-mono', 'monospace')}`;
    const measure = (font: string, text: string): number => {
      const k = `${font}|${env}|${text}`;
      let px = textCache.get(k);
      if (px === undefined) {
        ctx.font = font;
        px = ctx.measureText(text).width;
        textCache.set(k, px);
      }
      return px;
    };
    return (title: string, of?: DayOf): number => Math.ceil(measure(titleFont, title) + (of ? OF_GAP_PX + measure(ofFont, ofText(of)) : 0)) + BLOCK_PAD_PX;
  }, [el, env]);
}

/** 量一条轨道的宽度：回调 ref，换了元素（翻周后 key 变了）就重新挂 ResizeObserver；也把元素交出来给 useTextPx 取字体 */
export function useTrackWidth(): [(el: HTMLElement | null) => void, number, HTMLElement | null] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const read = (): void => setW(Math.floor(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  const ref = useCallback((x: HTMLElement | null) => setEl(x), []);
  return [ref, w, el];
}

export interface WeekProps {
  start: DateStr;
  items: CalItems;
  tz: string;
  today: DateStr;
  nowMin: number;
  holidays: ReadonlyMap<DateStr, readonly HolidayMark[]>;
  /** 待办截止时刻是当天第几分钟（useCalendar 给，读行和待办页同一份 todoOf）；没有截止时刻的 undefined */
  dueMin: (todoId: string) => number | undefined;
  /** 这几条待办里有没有逾期没做完的（useCalendar 给，和待办页同一个 isLate） */
  anyLate: (todoIds: readonly string[]) => boolean;
  /** 中文界面的农历短写法 / 节气（没有时 undefined） */
  lunarOf?: ((date: DateStr) => string | undefined) | undefined;
  wide: boolean;
  selected: DateStr | null;
  onSelect: (date: DateStr) => void;
  t: CalViewT;
  label: string;
  /** 打开一条（电脑周视图的全天行、时间块）；页面传进来，只读行在那里拦下 */
  onOpen: (kind: 'event' | 'todo', id: string) => void;
  /** 这一条是不是只读行：电脑周视图的全天行、时间块据它加斜纹底、读屏名字后接“要更新到新版本才能修改” */
  isRo: (kind: 'event' | 'todo', id: string) => boolean;
  /** 电脑版详情抽屉里开着的那一条：电脑周表的时间块、全天行据它加 aria-current；没开时 null */
  openId: string | null;
}

/**
 * 这一周每天的事项（weekEntries：月历、日清单同一份 collectEntries；删掉的待办不在里面、不撑宽时间轴；已完成的留着划删除线）
 * 和时间轴范围（有时刻的日程按设备时区切好的段 segmentOn、待办截止时刻）。手机泳道、电脑周表的排布（buildWeek）直接用这一份，不再收第二遍。
 * 设备时区坏了（weekEntries 抛 bad_tz）：byDay 为 null，整周空着；周视图只在这里兜这一次
 */
function weekOf(start: DateStr, items: CalItems, tz: string, dueMin: (todoId: string) => number | undefined): { range: HourRange; byDay: WeekEntries | null } {
  let byDay: WeekEntries | null;
  try {
    byDay = weekEntries(start, items, tz);
  } catch {
    byDay = null;
  }
  const spans: [number, number][] = [];
  for (const [d, list] of byDay ?? []) {
    for (const e of list) {
      const seg = segmentOn(e, d, tz);
      const due = e.kind === 'todo' ? dueMin(e.itemId) : undefined;
      if (seg) spans.push([seg.startMin, seg.endMin]);
      else if (due !== undefined) spans.push([due, due]);
    }
  }
  return { range: weekHourRange(spans), byDay };
}

// ───────── 手机：泳道 ─────────

function Lane({
  date,
  day,
  entries,
  w,
  range,
  p,
  trackRef,
}: {
  date: DateStr;
  day: PhoneDay | null;
  /** 这一天的全部事项（件数、待办；不按宽度，量到宽度之前也有） */
  entries: readonly DayEntry[];
  w: number;
  range: HourRange;
  p: WeekProps;
  trackRef: ((el: HTMLElement | null) => void) | null;
}) {
  const { t, today, nowMin } = p;
  const hol = p.holidays.get(date) ?? [];
  const kind = dayKind(hol);
  const isToday = date === today;
  const sel = p.selected === date;
  // 当天共几项（读屏念）：已完成的待办留在泳道上划线留痕，不算件数
  const total = entries.filter((e) => !e.done).length;
  const todoIds = entries.filter((e) => e.kind === 'todo').map((e) => e.itemId);
  // 这一天有没有逾期没做完的待办：逐条用待办页同一个 isLate（useCalendar 的 anyLate）
  const overdue = p.anyLate(todoIds);
  // 和月格同一套（cal-ui.ts dayLines）：补班的“班”放进数字旁的小圆标，那一行写节日名；连休只在第一天写节日名，后几天照常写农历或节气
  const { badge, line: sub } = dayLines(kind, namedHolidays(date, hol, p.holidays), p.lunarOf?.(date) ?? '', t);
  const shift = w > 0 ? phoneScale(w, range).shiftPx : 0;
  // 全天日程每件一排；手机排布里全天这一组只有全天日程（待办另放在 todos）
  const allDay = day?.allDay.entries ?? [];
  const wd = wdFull(weekdayOf(date), t);
  const endOf = (e: DayEntry): string => spanOfText(e.span, date);
  // 看得见的字，和下面画的顺序一致：星期、日期数字、“班”、农历或节日、全天条、时刻块、待办
  const shown = [
    wd,
    String(dayNo(date)),
    badge,
    sub,
    ...allDay.flatMap((e) => [e.title, endOf(e)]),
    ...(day?.blocks.flatMap((b) => [b.title, ofText(b.dayOf)]) ?? []),
    ...(day?.todos.map((x) => x.entry.title) ?? []),
  ];
  // 当天共几项、有没有逾期不画在泳道上，读屏照旧念
  const a11y = labelInName(
    shown,
    [
      ...dayA11y(date, hol, isToday, t),
      total === 0 ? t('cal.a11y.none', {}) : t('cal.a11y.total', { n: total }),
      ...(overdue ? [t('cal.a11y.overdue', {})] : []),
    ],
    t('cal.a11y.sep', {}),
  );
  const cls = [styles.lane, weekendClass(weekdayOf(date)), dayKindClass(kind), isToday ? common.today : '', sel ? common.sel : ''].filter(Boolean).join(' ');
  // 轨道里一排一排往下堆：全天日程占前 nAll 排，时刻块和待办接着往下（排号 r），轨道高度、上下居中都由 WeekView.module.css 按排数算
  const nAll = allDay.length;
  const trkVars = { '--n': nAll + (day?.rows ?? 0) } as CSSProperties;
  const at = (r: number, left?: number, width?: number): CSSProperties => ({ '--r': r, ...(left === undefined ? {} : { left, width }) }) as CSSProperties;
  return (
    <li className={cls} data-date={date}>
      <button type="button" className={styles.laneBtn} aria-pressed={sel} aria-label={a11y} onClick={() => p.onSelect(date)}>
        <span className={styles.laneWd} aria-hidden="true">
          {/* 几段字之间的 {' '}：laneWd、DayNum 外层是 flex，laneBtn 是 grid，轨道里全是绝对定位，空格都不画出来；给 axe 和读屏分词用（cal-ui.ts labelInName） */}
          <small>{wd}</small>{' '}
          <DayNum date={date} badge={badge} look="lane" />{' '}
          <small className={styles.laneSub}>{sub}</small>
        </span>{' '}
        <span className={styles.trk} style={trkVars} ref={trackRef ?? undefined} aria-hidden="true">
          {/* 轨道里不画整点竖线；整点只在顶上刻度尺 .wrul 写数字 */}
          {/* 现在线排在日程块前面：画在块下面，不压块上的字 */}
          {isToday && inRange(nowMin, range) ? (
            <i className={styles.wnow} style={{ left: `${axisFrac(nowMin, range) * 100}%` }} data-testid="cal-now" />
          ) : null}
          {allDay.map((e, i) => (
            <Fragment key={`all-${e.itemId}`}>
              {' '}
              <span className={[styles.allDay, colorClass(e.colorIndex), contClass(e.span?.cont)].filter(Boolean).join(' ')} style={at(i)} data-item={e.itemId}>
                <span className={styles.wevTx}>{e.title}</span>
                {endOf(e) !== '' ? (
                  <>
                    {' '}
                    <span className={styles.wevOf}>{endOf(e)}</span>
                  </>
                ) : null}
              </span>
            </Fragment>
          ))}
          {day?.blocks.map((b) => (
            <Fragment key={`${b.itemId}-${b.startMin}`}>
              {' '}
              <span className={[styles.wev, colorClass(b.colorIndex), contClass(b.cont)].filter(Boolean).join(' ')} style={at(nAll + b.row, b.startPx - shift, b.widthPx)} data-item={b.itemId}>
                <span className={styles.wevTx}>{b.title}</span>
                {b.dayOf ? (
                  <>
                    {' '}
                    <span className={styles.wevOf}>{ofText(b.dayOf)}</span>
                  </>
                ) : null}
              </span>
            </Fragment>
          ))}
          {/* 待办：“○ 标题”小条；有截止时刻的在那个时刻，没有的在下面从左往右排 */}
          {day?.todos.map((x) => (
            <Fragment key={x.entry.itemId}>
              {' '}
              <span
                className={`${styles.wtodo} ${colorClass(x.entry.colorIndex)}`}
                style={at(nAll + x.row, x.startPx - shift, x.widthPx)}
                data-todo={x.entry.itemId}
                data-done={x.entry.done ? '' : undefined}
              >
                <span className={styles.wevTx}>{x.entry.title}</span>
              </span>
            </Fragment>
          ))}
        </span>
      </button>
    </li>
  );
}

function PhoneWeek(p: WeekProps & { range: HourRange; byDay: WeekEntries | null }) {
  const [trackRef, w, trackEl] = useTrackWidth();
  const textPx = useTextPx(trackEl);
  const { start, tz, range, dueMin, byDay } = p;
  const dates = useMemo(() => weekDates(start), [start]);
  const days = useMemo<(PhoneDay | null)[]>(() => {
    // 还没量到宽度（第一次画）、设备时区坏了（byDay 为 null）：画空的七条泳道，量到以后再排色块
    if (w <= 0 || byDay === null) return dates.map(() => null);
    // w > 0 时 dayPx 一定大于 0，buildWeek 的 bad_week_opts 抛不出来；时区 weekOf 已经查过，这里不再套 try
    const { dayPx, shiftPx } = phoneScale(w, range);
    // 色块写完整标题、写到轨道右端为止（endPx = 显示范围的末端，时间轴只到 22 点时不出轨道）
    // 待办：有截止时刻的从那个时刻起画；小条宽 = 标题字宽 + 圆圈（没量到字宽时按最短长度）
    return buildWeek(start, byDay, {
      layout: 'phone',
      tz,
      minBlockPx: MIN_BLOCK_PX,
      dayPx,
      startPx: shiftPx,
      endPx: shiftPx + w,
      dueMin,
      ...(textPx ? { textPx, todoPx: (title: string) => textPx(title) + TODO_RING_PX } : {}),
    });
  }, [start, dates, byDay, tz, w, range, textPx, dueMin]);
  return (
    <section aria-label={p.label} data-testid="cal-week" data-layout="phone" data-range={`${range.h0}-${range.h1}`} className={`${common.card} ${styles.pweek}`} style={WEV_VARS}>
      <div className={styles.wrul} aria-hidden="true">
        {axisTicks(range).map((h) => (
          <span key={h} style={{ left: `${axisFrac(h * 60, range) * 100}%` }}>
            {h}
          </span>
        ))}
      </div>
      <ol className={styles.lanes}>
        {dates.map((date, i) => (
          <Lane key={date} date={date} day={days[i] ?? null} entries={byDay?.get(date) ?? []} w={w} range={range} p={p} trackRef={i === 0 ? trackRef : null} />
        ))}
      </ol>
    </section>
  );
}

export function WeekView(p: WeekProps) {
  const { start, items, tz, dueMin } = p;
  const { range, byDay } = useMemo(() => weekOf(start, items, tz, dueMin), [start, items, tz, dueMin]);
  return p.wide ? <DeskWeek {...p} range={range} byDay={byDay} /> : <PhoneWeek {...p} range={range} byDay={byDay} />;
}
