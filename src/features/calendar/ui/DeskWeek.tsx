// 周视图·电脑排布（B2 FA-3，皮肤视觉稿 .dwkv；从 WeekView.tsx 拆出来）：7 列时间格，纵向时间轴每小时 40 px
// • 表头：星期、日期（今天墨色细圈 / 柠檬黄底）、节日或农历；补班写“班·名字”、放假的表头和那一列灰底（和月格、手机泳道一致，代码复审 N4）；
//   点表头选中那一天，下面清单列出当天全部
// • 顶部“全天”行：全天日程和当天截止的待办（○ 标题），点了打开编辑页
// • 时间格：范围同手机（按当周事项自动伸缩，ui/week-axis.ts）；重叠的并排分列（buildWeek layout 'desk' 的 column / columns）；
//   今天有现在线，画在日程块下面（DOM 里排在前面），不压字（设计复审 N2）
import { weekdayOf } from '../../../../shared/core/date.ts';
import { weekDates } from '../../../../shared/logic/calendar/cal-nav.ts';
import type { DeskDay } from '../../../../shared/logic/calendar/month-grid.ts';
import { navigate } from '../../../app/router.ts';
import styles from './CalendarPage.module.css';
import { colorClass, hm, holText, itemShort, itemTitle, weekdayKey } from './cal-ui.ts';
import type { HourRange } from './week-axis.ts';
import type { WeekProps } from './WeekView.tsx';

/** 电脑时间格每小时多高（视觉稿 .dwkv 40 px；CalendarPage.module.css 的 .dCol 网格线同值） */
export const DESK_HOUR_PX = 40;

export function DeskWeek(p: WeekProps & { range: HourRange; desk: DeskDay[] | null }) {
  const { t, items, today, nowMin, range } = p;
  const dates = weekDates(p.start);
  const hours = Array.from({ length: range.h1 - range.h0 }, (_, i) => range.h0 + i);
  const colH = (range.h1 - range.h0) * DESK_HOUR_PX;
  const y = (min: number): number => ((min - range.h0 * 60) / 60) * DESK_HOUR_PX;
  return (
    <section aria-label={p.label} data-testid="cal-week" data-layout="desk" data-range={`${range.h0}-${range.h1}`} className={`${styles.card} ${styles.dwk}`}>
      <div className={styles.dHead} />
      {dates.map((date) => {
        const sel = p.selected === date;
        const hol = p.holidays.get(date) ?? [];
        const off = hol.some((h) => h.kind === 'off');
        const sub = hol[0] ? holText(hol[0], t('cal.workday', {})) : (p.lunarOf?.(date) ?? '');
        return (
          <button
            key={date}
            type="button"
            className={[styles.dHead, styles.dHeadBtn, off ? styles.dOff : '', sel ? styles.dHeadSel : ''].filter(Boolean).join(' ')}
            aria-pressed={sel}
            onClick={() => p.onSelect(date)}
            data-date={date}
          >
            <span>{t('cal.wdFull', { wd: t(weekdayKey(weekdayOf(date)), {}) })}</span>
            <b className={date === today ? styles.laneToday : undefined}>{Number(date.slice(8))}</b>
            <small>{sub}</small>
          </button>
        );
      })}
      <div className={styles.dAllLab}>{t('cal.allDay', {})}</div>
      {dates.map((date, i) => {
        const ad = p.desk?.[i]?.allDay;
        return (
          <div key={`ad-${date}`} className={styles.dAll}>
            {ad?.itemIds.map((id, k) => {
              const kind = ad.kinds[k] ?? 'allDay';
              const title = itemTitle(items, kind, id) || itemShort(items, kind, id);
              return (
                <button
                  key={id}
                  type="button"
                  className={styles.dAllItem}
                  onClick={() => void navigate(kind === 'todo' ? 'todo' : 'event', id)}
                  aria-label={kind === 'todo' ? t('cal.todoMark', { title }) : `${t('cal.allDay', {})} ${title}`}
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
          className={[styles.dCol, (p.holidays.get(date) ?? []).some((h) => h.kind === 'off') ? styles.dOff : ''].filter(Boolean).join(' ')}
          style={{ height: colH }}
        >
          {date === today && nowMin >= range.h0 * 60 && nowMin <= range.h1 * 60 ? <i className={styles.dNow} style={{ top: y(nowMin) }} data-testid="cal-now" /> : null}
          {p.desk?.[i]?.blocks.map((b) => {
            const top = y(b.startMin);
            const h = Math.max(14, y(b.endMin) - top - 2);
            return (
              <button
                key={`${b.itemId}-${b.startMin}`}
                type="button"
                className={`${styles.be} ${colorClass(b.colorIndex)}`}
                style={{ top, height: h, left: `${(b.column / b.columns) * 100}%`, width: `${100 / b.columns}%` }}
                aria-label={t('cal.a11y.block', { title: itemTitle(items, 'timed', b.itemId) || b.short, start: hm(b.startMin), end: hm(b.endMin) })}
                onClick={() => void navigate('event', b.itemId)}
              >
                <span className={styles.beSh}>{b.short}</span>
              </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}
