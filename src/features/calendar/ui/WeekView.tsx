// 周视图（B2 FA-3，架构 5.12 第 2 点、0.51、R-101～R-110；定稿线框 s2、皮肤视觉稿 .wlane / .dwkv）
// • 时间轴范围按当周事项自动伸缩（负责人 11-04）：默认 8～22 点，有更早、更晚的事扩到那个整点（data/week-axis.ts）
// • 手机（窄屏）：R-445 周视图 A“时间轴泳道”（负责人 11-17 选定，定稿图 定稿_周视图A_浅.png），套已定月格的样式：
//   一天一条泳道（--cal-lane-h 高），左边“周一 / 19 / 农历或节日”，右边横向时间轴（定稿没有原来右边“当天共几项、逾”那一列，读屏照旧念）
//   – 周六周日淡底加灰字、放假斜纹、补班点阵加数字旁“班”标、今天淡黄小框、选中数字深色小方块：和月格同一套类（.wkend .holiday .workday .today .sel .dayNum）
//   – 顶部刻度数字、每 2 小时一条刻度线；今天那条泳道上一条竖线是“现在”
//   – 全天日程画成轨道顶上一整条（跨天的每天都画，右端写“2/3”；当天还有别的全天日程再写“+N”），有它时时刻块往下让一排（CSS .trkAll 换 --trk-top）
//   – 日程色块：底色项目块色、左侧 2 px 深色竖线、--on-p 字（R-104、R-107、R-109、R-110 的排布交给前端 B 的 buildWeek）；跨天的同样右端写“2/3”
//   – 跨天的续条（全天条、时刻块）：被切开的一端画直角，头从前一天接过来的不画左侧深色竖线（cal-ui.ts contClass，和月格同一套；字色不变，对比度照 --on-p）
//   – 待办：泳道上的空心圆（有截止时刻画在那个时刻，没有的画在末端；同一处几个依次往左错开），不占上下两排、不算进“+N”
//   – 整条泳道是一个按钮：点了选中那一天（数字深色小方块），下面的清单列出当天全部日程和待办；色块、“+N”不单独接点按
//     （色块挨得近、高度不到 44，设计审查 M7 的做法：先选天、再在清单里点具体哪一条）
// • 电脑（宽屏）：7 列时间格（纵向时间轴，每小时 40 px），表头星期、日期、农历，顶部“全天”行放全天日程和当天截止的待办（○ 标题）；
//   重叠的并排分列（buildWeek layout 'desk' 的 column / columns）；色块点了打开编辑页；点表头选中那一天
// • 节假日（R-432）：放假、补班的泳道（电脑是表头和那一列）和月格同一套斜纹（cal-ui.ts dayKind / dayKindClass）；
//   连续放假只在第一天写节日名，后面几天照写农历（namedHolidays），读屏照旧念节日名（holA11y）
// • 量宽：用回调 ref 量第一条轨道，翻周后轨道换了新元素会重新挂 ResizeObserver（代码审查 M1）
// • 读屏：泳道按钮的名字先按显示顺序念看得见的字（“周一 19 十七 出差 2/3 会议 +1”，WCAG 2.5.3，cal-ui.ts labelInName），
//   再接“10月19日，今天，节日，共 3 项，有逾期的待办”（星期前面已经念过，不再重复）；完整标题在下面的清单里。
//   共几项、有没有逾期按电脑排布那一份（rangeOf 本来就算了，不按宽度，量到宽度之前也对）
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import { weekDates } from '../../../../shared/logic/calendar/cal-nav.ts';
import { todoDate, type CalItems } from '../../../../shared/logic/calendar/cal-items.ts';
import { dayOfSpan } from '../../../../shared/logic/calendar/event-span.ts';
import type { HolidayMark } from '../../../../shared/logic/calendar/holidays.ts';
import { buildWeek, type DeskDay, type PhoneDay } from '../../../../shared/logic/calendar/month-grid.ts';
import { axisFrac, axisTicks, phoneScale, weekHourRange, type HourRange } from './week-axis.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarPage.module.css';
import { colorClass, contClass, dateA11y, dayKind, dayKindClass, dayLines, holA11y, labelInName, namedHolidays, ofText, weekdayKey, weekendClass } from './cal-ui.ts';
import { DeskWeek } from './DeskWeek.tsx';

/** 色块最短长度（px，5.12：约 28 px，视觉稿 --wmin） */
export const MIN_BLOCK_PX = 28;
/** 同一处几个待办空心圆依次往左错开多少 */
const TODO_STEP_PX = 10;
/** 没有截止时刻的待办画在轨道末端往里多少（px）：空心圆 9 px 宽、居中，往里 8 不出轨道 */
const TODO_END_INSET_PX = 8;

/** 量一条轨道的宽度：回调 ref，换了元素（翻周后 key 变了）就重新挂 ResizeObserver */
export function useTrackWidth(): [(el: HTMLElement | null) => void, number] {
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
  return [ref, w];
}

export interface WeekProps {
  start: DateStr;
  items: CalItems;
  tz: string;
  today: DateStr;
  nowMin: number;
  holidays: ReadonlyMap<DateStr, readonly HolidayMark[]>;
  dueMins: ReadonlyMap<string, number>;
  /** 中文界面的农历短写法 / 节气（没有时 undefined） */
  lunarOf?: ((date: DateStr) => string | undefined) | undefined;
  wide: boolean;
  selected: DateStr | null;
  onSelect: (date: DateStr) => void;
  t: CalViewT;
  label: string;
  /** 打开一条（电脑周视图的全天行、时间块）；页面传进来，只读行在那里拦下（FA-2 只读行界面）。不传就直接打开编辑页 */
  onOpen?: ((kind: 'event' | 'todo', id: string) => void) | undefined;
  /** 这一条是不是只读行（FA-2）：电脑周视图的全天行、时间块据它加斜纹底、读屏名字后接“要更新到新版本才能修改” */
  isRo?: ((kind: 'event' | 'todo', id: string) => boolean) | undefined;
  /** 电脑版详情抽屉里开着的那一条（R-130）：电脑周表的时间块、全天行据它加 aria-current；没开时 null */
  openId?: string | null | undefined;
}

/** 这一周所有有时刻的日程段（按设备时区切好）和待办截止时刻 → 时间轴范围 */
function rangeOf(start: DateStr, items: CalItems, tz: string, dueMins: ReadonlyMap<string, number>): { range: HourRange; desk: DeskDay[] | null } {
  let desk: DeskDay[] | null = null;
  try {
    desk = buildWeek(start, items, { layout: 'desk', tz });
  } catch {
    desk = null;
  }
  const spans: [number, number][] = [];
  for (const d of desk ?? []) for (const b of d.blocks) spans.push([b.startMin, b.endMin]);
  const dates = new Set(weekDates(start));
  for (const td of items.todos) {
    const due = dueMins.get(td.id);
    // 删掉的、已完成的待办不画，也不撑宽时间轴（todoDate 对它们给 null；代码复审 N5）
    const d = todoDate(td);
    if (due !== undefined && d !== null && dates.has(d)) spans.push([due, due]);
  }
  return { range: weekHourRange(spans), desk };
}

/** 这一天有没有逾期没做完的待办：日子已过，或者是今天、截止时刻已过 */
function hasOverdue(date: DateStr, todoIds: readonly string[], today: DateStr, nowMin: number, dueMins: ReadonlyMap<string, number>): boolean {
  if (todoIds.length === 0) return false;
  if (date < today) return true;
  if (date > today) return false;
  return todoIds.some((id) => {
    const due = dueMins.get(id);
    return due !== undefined && due < nowMin;
  });
}

// ───────── 手机：泳道 ─────────

function Lane({
  date,
  day,
  desk,
  w,
  range,
  p,
  trackRef,
}: {
  date: DateStr;
  day: PhoneDay | null;
  /** 同一天的电脑排布（件数、待办；不按宽度，量到宽度之前也有） */
  desk: DeskDay | undefined;
  w: number;
  range: HourRange;
  p: WeekProps;
  trackRef: ((el: HTMLElement | null) => void) | null;
}) {
  const { t, today, nowMin, dueMins } = p;
  const hol = p.holidays.get(date) ?? [];
  const kind = dayKind(hol);
  const isToday = date === today;
  const sel = p.selected === date;
  const total = desk ? desk.allDay.count + desk.blocks.length : 0;
  const todoIds = desk?.allDay.entries.filter((e) => e.kind === 'todo').map((e) => e.itemId) ?? [];
  const overdue = hasOverdue(date, todoIds, today, nowMin, dueMins);
  // 和月格同一套（cal-ui.ts dayLines）：补班的“班”放进数字旁的小圆标，那一行写节日名；连休只在第一天写节日名，后几天照常写农历或节气
  const { badge, line: sub } = dayLines(kind, namedHolidays(date, hol, p.holidays), p.lunarOf?.(date) ?? '', t);
  const shift = w > 0 ? phoneScale(w, range).shiftPx : 0;
  // 手机排布里全天这一行只有全天日程（待办另放在 todos）：画第一件
  const allDay = day?.allDay.entries ?? [];
  const first = allDay[0];
  const wd = t('cal.wdFull', { wd: t(weekdayKey(weekdayOf(date)), {}) });
  // 全天条右端：跨天的写“2/3”，当天还有别的全天日程写“+N”
  const allDayEnd = [ofText(first?.span && dayOfSpan(first.span, date)), allDay.length > 1 ? t('cal.more', { n: allDay.length - 1 }) : ''].filter(Boolean).join(' ');
  const moreTexts = day?.groups.filter((g) => g.more > 0).map((g) => t('cal.more', { n: g.more })) ?? [];
  // 看得见的字，和下面画的顺序一致：星期、日期数字、“班”、农历或节日、全天条、色块简称、“+N”
  const shown = [
    wd,
    String(Number(date.slice(8))),
    badge,
    sub,
    first?.short ?? '',
    allDayEnd,
    ...(day?.blocks.flatMap((b) => [b.short, ofText(b.dayOf)]) ?? []),
    ...moreTexts,
  ];
  // 当天共几项、有没有逾期不再画在泳道右边（R-445 周视图 A 定稿没有这一列），读屏照旧念
  const a11y = labelInName(
    shown,
    [
      dateA11y(date, t),
      ...(isToday ? [t('cal.a11y.todayMark', {})] : []),
      ...hol.map((h) => holA11y(h, t)),
      total === 0 ? t('cal.a11y.none', {}) : t('cal.a11y.total', { n: total }),
      ...(overdue ? [t('cal.a11y.overdue', {})] : []),
    ],
    t('cal.a11y.sep', {}),
  );
  // 同一处的待办依次往左错开：按位置分桶数
  const seen = new Map<number, number>();
  const cls = [styles.lane, weekendClass(weekdayOf(date)), dayKindClass(kind), isToday ? styles.today : '', sel ? styles.sel : ''].filter(Boolean).join(' ');
  return (
    <li className={cls} data-date={date}>
      <button type="button" className={styles.laneBtn} aria-pressed={sel} aria-label={a11y} onClick={() => p.onSelect(date)}>
        <span className={styles.laneWd} aria-hidden="true">
          {/* 几段字之间的 {' '}：laneWd、laneNum 是 flex，laneBtn 是 grid，轨道里全是绝对定位，空格都不画出来；给 axe 和读屏分词用（cal-ui.ts labelInName） */}
          <small>{wd}</small>{' '}
          <span className={styles.laneNum}>
            <b className={styles.dayNum}>{Number(date.slice(8))}</b>
            {badge !== '' ? (
              <>
                {' '}
                <span className={styles.ban} data-testid="cal-ban">
                  {badge}
                </span>
              </>
            ) : null}
          </span>{' '}
          <small className={styles.laneSub}>{sub}</small>
        </span>{' '}
        <span className={first ? `${styles.trk} ${styles.trkAll}` : styles.trk} ref={trackRef ?? undefined} aria-hidden="true">
          {/* 轨道里不画整点竖线（负责人 11-17：“周历的竖向分割线去掉”）；整点只在顶上刻度尺 .wrul 写数字 */}
          {/* 现在线排在日程块前面：画在块下面，不压块上的字（设计复审 N2） */}
          {isToday && nowMin >= range.h0 * 60 && nowMin <= range.h1 * 60 ? (
            <i className={styles.wnow} style={{ left: `${axisFrac(nowMin, range) * 100}%` }} data-testid="cal-now" />
          ) : null}
          {first ? (
            <>
              {' '}
              <span className={[styles.allDay, colorClass(first.colorIndex), contClass(first.span?.cont)].filter(Boolean).join(' ')} data-item={first.itemId}>
                <span className={styles.wevTx}>{first.short}</span>
                {allDayEnd !== '' ? (
                  <>
                    {' '}
                    <span className={styles.wevOf}>{allDayEnd}</span>
                  </>
                ) : null}
              </span>
            </>
          ) : null}
          {day?.blocks.map((b) => (
            <Fragment key={`${b.itemId}-${b.startMin}`}>
              {' '}
              <span
                className={[styles.wev, colorClass(b.colorIndex), b.rows === 2 ? (b.row === 1 ? styles.r1 : styles.r0) : '', contClass(b.cont)].filter(Boolean).join(' ')}
                style={{ left: b.startPx - shift, width: b.widthPx }}
                data-item={b.itemId}
              >
                <span className={styles.wevTx}>{b.short}</span>
                {b.dayOf ? (
                  <>
                    {' '}
                    <span className={styles.wevOf}>{ofText(b.dayOf)}</span>
                  </>
                ) : null}
              </span>
            </Fragment>
          ))}
          {day?.groups
            .filter((g) => g.more > 0)
            .map((g) => (
              <Fragment key={`more-${g.hiddenIds.join(',')}`}>
                {' '}
                <span className={styles.wmore} style={{ left: g.moreAtPx - shift }}>
                  {t('cal.more', { n: g.more })}
                </span>
              </Fragment>
            ))}
          {day?.todos.map((e) => {
            const due = dueMins.get(e.itemId);
            const at = due === undefined ? w - TODO_END_INSET_PX : axisFrac(due, range) * w;
            const k = Math.round(at);
            const n = seen.get(k) ?? 0;
            seen.set(k, n + 1);
            return <i key={e.itemId} className={`${styles.wtd} ${colorClass(e.colorIndex)}`} style={{ left: at - n * TODO_STEP_PX }} data-todo={e.itemId} />;
          })}
        </span>
      </button>
    </li>
  );
}

function PhoneWeek(p: WeekProps & { range: HourRange; desk: DeskDay[] | null }) {
  const [trackRef, w] = useTrackWidth();
  const { start, items, tz, range } = p;
  const days = useMemo<(PhoneDay | null)[]>(() => {
    const dates = weekDates(start);
    // 还没量到宽度（第一次画）：先画空的七条泳道，量到以后再排色块
    if (w <= 0) return dates.map(() => null);
    try {
      return buildWeek(start, items, { layout: 'phone', tz, minBlockPx: MIN_BLOCK_PX, dayPx: phoneScale(w, range).dayPx });
    } catch {
      return dates.map(() => null);
    }
  }, [start, items, tz, w, range]);
  const dates = weekDates(start);
  return (
    <section aria-label={p.label} data-testid="cal-week" data-layout="phone" data-range={`${range.h0}-${range.h1}`} className={`${styles.card} ${styles.pweek}`}>
      <div className={styles.wrul} aria-hidden="true">
        {axisTicks(range).map((h) => (
          <span key={h} style={{ left: `${axisFrac(h * 60, range) * 100}%` }}>
            {h}
          </span>
        ))}
      </div>
      <ol className={styles.lanes}>
        {dates.map((date, i) => (
          <Lane key={date} date={date} day={days[i] ?? null} desk={p.desk?.[i]} w={w} range={range} p={p} trackRef={i === 0 ? trackRef : null} />
        ))}
      </ol>
    </section>
  );
}

export function WeekView(p: WeekProps) {
  const { start, items, tz, dueMins } = p;
  const { range, desk } = useMemo(() => rangeOf(start, items, tz, dueMins), [start, items, tz, dueMins]);
  return p.wide ? <DeskWeek {...p} range={range} desk={desk} /> : <PhoneWeek {...p} range={range} desk={desk} />;
}
