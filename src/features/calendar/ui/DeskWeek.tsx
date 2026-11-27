// 周视图·电脑排布：7 列时间格，纵向时间轴每小时 40 px
// • 表头：星期、日期（和月格、泳道同一个 DayNum：今天淡黄小框、选中深色小方块、周末灰字；补班日数字旁“班”标）、节日或农历
//   （cal-ui.ts dayLines，和月格、泳道同一份，节日名写全称，不写“班·名字”），连休只在第一天写节日名；
//   放假、补班的表头和那一列画斜纹（和月格、手机泳道同一个类 .holiday / .workday）；
//   点表头选中那一天，下面清单列出当天全部
// • 顶部“全天”行：全天日程和当天截止的待办（○ 标题）；跨天的全天日程每天一块，被切开的那一端直角（cal-ui.ts contClass，和手机周视图、月格同一套），
//   点了打开编辑页（电脑版详情抽屉：页面的 onOpen 决定；按钮带 data-open、开着的那条 aria-current）
// • 时间格：范围同手机（按当周事项自动伸缩，ui/week-axis.ts）；重叠的并排分列（buildWeek layout 'desk' 的 column / columns）；
//   今天有现在线，画在日程块下面（DOM 里排在前面），不压字
import { useMemo, type CSSProperties } from 'react';
import { hm24, weekdayOf } from '../../../../shared/core/date.ts';
import { weekDates } from '../../../../shared/logic/calendar/cal-nav.ts';
import { buildWeek, type DeskDay, type WeekEntries } from '../../../../shared/logic/calendar/month-grid.ts';
import { useRoT } from '../../../kit/hooks/useRoT.ts';
import { useT } from '../../../kit/hooks/useT.ts';
import common from './cal-common.module.css';
import styles from './DeskWeek.module.css';
import { colorClass, contClass, dayKind, dayKindClass, dayLines, entryTitle, namedHolidays, spanOfText, wdFull, weekendClass } from './cal-ui.ts';
import { DayNum } from './DayNum.tsx';
import { inRange, type HourRange } from './week-axis.ts';
import type { WeekProps } from './WeekView.tsx';

/** 电脑时间格每小时多高（40 px）：色块位置用它算，DeskWeek.module.css 的 .dCol 网格线读这里写进内联样式的 --hour-px，只写这一处 */
export const DESK_HOUR_PX = 40;
const DESK_VARS = { '--hour-px': `${DESK_HOUR_PX}px` } as CSSProperties;

export function DeskWeek(p: WeekProps & { range: HourRange; byDay: WeekEntries | null }) {
  const { t, start, tz, today, nowMin, range, byDay } = p;
  // 电脑排布（重叠的并排分列）只在这里排，用 WeekView 收好的这一周（不再收第二遍）；设备时区坏了时 byDay 为 null，整周空着
  const desk = useMemo<DeskDay[] | null>(() => (byDay ? buildWeek(start, byDay, { layout: 'desk', tz }) : null), [start, byDay, tz]);
  // 打开一条：页面给的 onOpen 先拦只读行；只读行的块太小放不下“要新版本”字样，
  // 改成斜纹底（data-readonly），读屏名字后接“要更新到新版本才能修改”
  const { onOpen: open, isRo } = p;
  const tRo = useRoT();
  const tc = useT();
  const cur = (id: string) => (p.openId === id ? ('true' as const) : undefined);
  const roLabel = (ro: boolean, label: string): string => (ro ? tRo('ro.named', { label }) : label);
  const dates = weekDates(p.start);
  // 每天的斜纹类（表头和那一列同一个，和月格、手机泳道共用 .holiday / .workday）
  const kinds = dates.map((date) => dayKindClass(dayKind(p.holidays.get(date) ?? [])));
  const hours = Array.from({ length: range.h1 - range.h0 }, (_, i) => range.h0 + i);
  const colH = (range.h1 - range.h0) * DESK_HOUR_PX;
  const y = (min: number): number => ((min - range.h0 * 60) / 60) * DESK_HOUR_PX;
  return (
    <section aria-label={p.label} data-testid="cal-week" data-layout="desk" data-range={`${range.h0}-${range.h1}`} className={`${common.card} ${styles.dwk}`} style={DESK_VARS}>
      <div className={styles.dHead} />
      {dates.map((date, i) => {
        const sel = p.selected === date;
        const hol = p.holidays.get(date) ?? [];
        // 和月格、手机泳道同一份（cal-ui.ts dayLines）：补班日数字旁“班”标、那一行写节日名；
        // 连休只在第一天写节日名，后几天照常写农历或节气；表头宽，节日名写全称（wide）
        const { badge, line: sub } = dayLines(dayKind(hol), namedHolidays(date, hol, p.holidays), p.lunarOf?.(date) ?? '', t, true);
        // 日期数字和月格、手机泳道同一套：周末灰字、今天淡黄小框、选中深色小方块（.wkend .today .sel .dayNum）
        const cls = [styles.dHead, styles.dHeadBtn, kinds[i] ?? '', weekendClass(weekdayOf(date)), date === today ? common.today : '', sel ? common.sel : ''];
        return (
          <button key={date} type="button" className={cls.filter(Boolean).join(' ')} aria-pressed={sel} onClick={() => p.onSelect(date)} data-date={date}>
            <span>{wdFull(weekdayOf(date), t)}</span>{' '}
            <DayNum date={date} badge={badge} look="desk" />{' '}
            <small>{sub}</small>
          </button>
        );
      })}
      <div className={styles.dAllLab}>{tc('span.allDay', {})}</div>
      {dates.map((date, i) => {
        const ad = desk?.[i]?.allDay;
        return (
          <div key={`ad-${date}`} className={styles.dAll}>
            {ad?.entries.map((e) => {
              const { itemId: id, kind, span, done } = e;
              // 跨天的全天日程：电脑周表每天各一块，标题后面写“(2/3)”
              const of = spanOfText(span, date);
              const title = entryTitle(e) + (of ? ` (${of})` : '');
              const which = kind === 'todo' ? 'todo' : 'event';
              const ro = isRo(which, id);
              return (
                <button
                  key={id}
                  type="button"
                  className={[styles.dAllItem, contClass(span?.cont)].filter(Boolean).join(' ')}
                  onClick={() => open(which, id)}
                  aria-label={roLabel(ro, kind === 'todo' ? t(done ? 'cal.todoDoneMark' : 'cal.todoMark', { title }) : `${tc('span.allDay', {})} ${title}`)}
                  data-readonly={ro ? '' : undefined}
                  data-open={id}
                  aria-current={cur(id)}
                  data-testid={`cal-desk-all-${id}`}
                  data-done={done ? '' : undefined}
                >
                  {kind === 'todo' ? '○ ' : ''}
                  {title}
                </button>
              );
            })}
          </div>
        );
      })}
      <div className={styles.dHours} style={{ height: colH }} aria-hidden="true">
        {hours.map((h) => (
          <span key={h} style={{ top: y(h * 60) }}>
            {`${h}:00`}
          </span>
        ))}
      </div>
      {dates.map((date, i) => (
        <div
          key={`col-${date}`}
          className={[styles.dCol, kinds[i] ?? ''].filter(Boolean).join(' ')}
          style={{ height: colH }}
        >
          {date === today && inRange(nowMin, range) ? <i className={styles.dNow} style={{ top: y(nowMin) }} data-testid="cal-now" /> : null}
          {desk?.[i]?.blocks.map((b) => {
            const top = y(b.startMin);
            const h = Math.max(14, y(b.endMin) - top - 2);
            const ro = isRo('event', b.itemId);
            const title = entryTitle(b);
            // 块上画完整标题（和手机周视图一致），放得下就折行，名字就是看得见的标题
            const name = t('cal.a11y.block', { title, start: hm24(b.startMin), end: hm24(b.endMin) });
            return (
              <button
                key={`${b.itemId}-${b.startMin}`}
                type="button"
                className={`${styles.be} ${colorClass(b.colorIndex)}`}
                style={{ top, height: h, left: `${(b.column / b.columns) * 100}%`, width: `${100 / b.columns}%` }}
                aria-label={roLabel(ro, name)}
                onClick={() => open('event', b.itemId)}
                data-readonly={ro ? '' : undefined}
                data-open={b.itemId}
                aria-current={cur(b.itemId)}
                data-testid={`cal-desk-block-${b.itemId}`}
              >
                <span className={styles.beSh}>{title}</span>
              </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}
