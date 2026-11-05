// 周视图（B2 FA-3，架构 5.12 第 2 点、0.51、R-101～R-110；定稿线框 s2、皮肤视觉稿 .wlane / .dwkv）
// • 时间轴范围按当周事项自动伸缩（负责人 11-04）：默认 8～22 点，有更早、更晚的事扩到那个整点（data/week-axis.ts）
// • 手机（窄屏）：一天一条泳道（58 高），左边“周一 / 19 / 农历或节日”和“全天 N”小标签，中间横向时间轴，右边当天共几项（有逾期待办加“逾”）
//   – 顶部刻度数字、每 2 小时一条刻度线；今天那条泳道上一条竖线是“现在”
//   – 日程色块：底色项目块色、左侧 2 px 深色竖线、--on-p 字、9.5 px 简称（R-104、R-107、R-109、R-110 的排布交给前端 B 的 buildWeek）
//   – 待办：泳道上的空心圆（有截止时刻画在那个时刻，没有的画在末端；同一处几个依次往左错开），不占上下两排、不算进“+N”
//   – 整条泳道是一个按钮：点了选中那一天（灰底 + 墨色圈），下面的清单列出当天全部日程和待办；色块、“+N”不单独接点按
//     （色块挨得近、高度不到 44，设计审查 M7 的做法：先选天、再在清单里点具体哪一条）
// • 电脑（宽屏）：7 列时间格（纵向时间轴，每小时 40 px），表头星期、日期、农历，顶部“全天”行放全天日程和当天截止的待办（○ 标题）；
//   重叠的并排分列（buildWeek layout 'desk' 的 column / columns）；色块点了打开编辑页；点表头选中那一天
// • 量宽：用回调 ref 量第一条轨道，翻周后轨道换了新元素会重新挂 ResizeObserver（代码审查 M1）
// • 读屏：泳道按钮的名字是“10月19日，周一，今天，节日，共 3 项，有逾期的待办”；完整标题在下面的清单里
import { useCallback, useEffect, useMemo, useState } from 'react';
import { weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import { weekDates } from '../../../../shared/logic/calendar/cal-nav.ts';
import { todoDate, type CalItems } from '../../../../shared/logic/calendar/cal-items.ts';
import type { HolidayMark } from '../../../../shared/logic/calendar/holidays.ts';
import { buildWeek, dayEntries, type DeskDay, type PhoneDay } from '../../../../shared/logic/calendar/month-grid.ts';
import { projectColorIndex, type ProjectColor } from '../../../../shared/logic/project-color.ts';
import { axisFrac, axisTicks, phoneScale, weekHourRange, type HourRange } from './week-axis.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarPage.module.css';
import { colorClass, holText, itemShort, weekdayKey, workdayA11y } from './cal-ui.ts';
import { DeskWeek } from './DeskWeek.tsx';

/** 色块最短长度（px，5.12：约 28 px，视觉稿 --wmin） */
export const MIN_BLOCK_PX = 28;
/** 同一处几个待办空心圆依次往左错开多少 */
const TODO_STEP_PX = 10;

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

function dayTotal(date: DateStr, items: CalItems, tz: string): number {
  try {
    return dayEntries(date, items, tz).length;
  } catch {
    return 0;
  }
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

function dateLabel(date: DateStr, t: CalViewT): string {
  const [, m = '1', d = '1'] = date.split('-');
  return t('cal.a11y.date', { m: Number(m), d: Number(d) });
}

// ───────── 手机：泳道 ─────────

function Lane({
  date,
  day,
  w,
  range,
  p,
  trackRef,
}: {
  date: DateStr;
  day: PhoneDay | null;
  w: number;
  range: HourRange;
  p: WeekProps;
  trackRef: ((el: HTMLElement | null) => void) | null;
}) {
  const { t, items, today, nowMin, dueMins } = p;
  const hol = p.holidays.get(date) ?? [];
  const off = hol.some((h) => h.kind === 'off');
  const isToday = date === today;
  const sel = p.selected === date;
  const total = dayTotal(date, items, p.tz);
  const todoIds = day?.todos.map((e) => e.itemId) ?? [];
  const overdue = hasOverdue(date, todoIds, today, nowMin, dueMins);
  const sub = hol[0] ? holText(hol[0], t('cal.workday', {}), { full: t('cal.subHolFull', {}), short: t('cal.subHolShort', {}) }) : (p.lunarOf?.(date) ?? '');
  const shift = w > 0 ? phoneScale(w, range).shiftPx : 0;
  const allDay = day?.allDay;
  const allDayIds = allDay?.itemIds.filter((_, i) => allDay.kinds[i] !== 'todo') ?? [];
  const allDayFirst = allDayIds[0];
  const a11y = [
    dateLabel(date, t),
    t('cal.wdFull', { wd: t(weekdayKey(weekdayOf(date)), {}) }),
    ...(isToday ? [t('cal.a11y.todayMark', {})] : []),
    ...hol.map((h) => (h.kind === 'work' ? workdayA11y(h.name, (name) => t('cal.a11y.workday', { name })) : h.name)),
    total === 0 ? t('cal.a11y.none', {}) : t('cal.a11y.total', { n: total }),
    ...(overdue ? [t('cal.a11y.overdue', {})] : []),
  ].join(t('cal.a11y.sep', {}));
  // 同一处的待办依次往左错开：按位置分桶数
  const seen = new Map<number, number>();
  return (
    <li className={[styles.lane, sel ? styles.laneSel : '', off ? styles.laneOff : ''].filter(Boolean).join(' ')} data-date={date}>
      <button type="button" className={styles.laneBtn} aria-pressed={sel} aria-label={a11y} onClick={() => p.onSelect(date)}>
        <span className={styles.laneWd} aria-hidden="true">
          <small>{t('cal.wdFull', { wd: t(weekdayKey(weekdayOf(date)), {}) })}</small>
          <b className={isToday ? styles.laneToday : undefined}>{Number(date.slice(8))}</b>
          <small className={styles.laneSub}>{sub}</small>
          {allDayFirst !== undefined ? (
            <span className={`${styles.allDay} ${colorClass(colorOfAllDay(items, allDayFirst))}`}>
              {allDayIds.length === 1 ? itemShort(items, 'allDay', allDayFirst) : `${t('cal.allDay', {})} ${allDayIds.length}`}
            </span>
          ) : null}
        </span>
        <span className={styles.trk} ref={trackRef ?? undefined} aria-hidden="true">
          {axisTicks(range).map((h) => (
            <i key={h} className={styles.tick} style={{ left: `${axisFrac(h * 60, range) * 100}%` }} />
          ))}
          {/* 现在线排在日程块前面：画在块下面，不压块上的字（设计复审 N2） */}
          {isToday && nowMin >= range.h0 * 60 && nowMin <= range.h1 * 60 ? (
            <i className={styles.wnow} style={{ left: `${axisFrac(nowMin, range) * 100}%` }} data-testid="cal-now" />
          ) : null}
          {day?.blocks.map((b) => (
            <span
              key={`${b.itemId}-${b.startMin}`}
              className={[
                styles.wev,
                colorClass(b.colorIndex),
                b.rows === 2 ? (b.row === 1 ? styles.r1 : styles.r0) : '',
                b.cont === 'start' || b.cont === 'both' ? styles.contStart : '',
                b.cont === 'end' || b.cont === 'both' ? styles.contEnd : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ left: b.startPx - shift, width: b.widthPx }}
              data-item={b.itemId}
            >
              {b.short}
            </span>
          ))}
          {day?.groups
            .filter((g) => g.more > 0)
            .map((g) => (
              <span key={`more-${g.hiddenIds.join(',')}`} className={styles.wmore} style={{ left: g.moreAtPx - shift }}>
                {t('cal.more', { n: g.more })}
              </span>
            ))}
          {day?.todos.map((e) => {
            const due = dueMins.get(e.itemId);
            const at = due === undefined ? w - 8 : axisFrac(due, range) * w;
            const k = Math.round(at);
            const n = seen.get(k) ?? 0;
            seen.set(k, n + 1);
            return <i key={e.itemId} className={`${styles.wtd} ${colorClass(e.colorIndex)}`} style={{ left: at - n * TODO_STEP_PX }} data-todo={e.itemId} />;
          })}
        </span>
        <span className={styles.tdn} aria-hidden="true">
          {total}
          {overdue ? <em>{t('cal.overdue', {})}</em> : null}
        </span>
      </button>
    </li>
  );
}

/** 全天那个小标签的颜色：第一件全天日程的项目色 */
function colorOfAllDay(items: CalItems, id: string): ProjectColor {
  const ev = items.events.find((x) => x.id === id);
  return ev ? projectColorIndex(ev.project) : 0;
}

function PhoneWeek(p: WeekProps & { range: HourRange }) {
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
    <section aria-label={p.label} data-ghost="" data-testid="cal-week" data-layout="phone" data-range={`${range.h0}-${range.h1}`} className={styles.card}>
      <div className={styles.wrul} aria-hidden="true">
        {axisTicks(range).map((h) => (
          <span key={h} style={{ left: `${axisFrac(h * 60, range) * 100}%` }}>
            {h}
          </span>
        ))}
      </div>
      <ol className={styles.lanes}>
        {dates.map((date, i) => (
          <Lane key={date} date={date} day={days[i] ?? null} w={w} range={range} p={p} trackRef={i === 0 ? trackRef : null} />
        ))}
      </ol>
    </section>
  );
}

export function WeekView(p: WeekProps) {
  const { start, items, tz, dueMins } = p;
  const { range, desk } = useMemo(() => rangeOf(start, items, tz, dueMins), [start, items, tz, dueMins]);
  return p.wide ? <DeskWeek {...p} range={range} desk={desk} /> : <PhoneWeek {...p} range={range} />;
}
