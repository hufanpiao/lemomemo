// 选中那一天的清单（B2 FA-3；定稿线框 s2、s3：点月历某天、点周视图某条泳道，下面列出当天全部日程和待办，含没定时间的；设计审查 M2、M3）
// • 排序同月历（compareEntries：有时刻的日程按时刻、全天日程、待办）；数据来自前端 B 的 dayEntries
// • 每行：左边时刻（有时刻的日程写开始时刻；全天日程写“全天”；待办有截止时刻写时刻、没有写“待办”）、项目色竖线、完整标题；
//   整行是按钮（44 高），点了打开那一条的编辑页（#/event/<id>、#/todo/<id>）
// • 标题行：“10月24日 周六 · 农历九月十五”（中文界面有农历时），右边“6 项”
// • 跨午夜的日程（代码复审 N6）：dayEntries 只把它放在开始那天；这里给后面的日子补一行续段，排在最前，时刻写“至 01:00”
//   （和周视图泳道次日的续段一致）；点了同样打开那条日程
// • “往上拖列表、月历收成一周一行”的拖动柄在 CalNav.tsx 的 FoldHandle，这里只管列表
// • 行尾“未同步”小标记（REMIND-wiring；TC-B2-69、架构 4.2）：带提醒、还没同步上的那一条才标，同步上自动消失；
//   由 reminders 功能懒加载提供（UnsyncedRemindMark），没标时那一格不占位。周视图泳道、月格不标（定稿线框 s2、s3 没有这个标记）
import { Suspense } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { minOfDay, msAt, todayOf, weekdayOf } from '../../../../shared/core/date.ts';
import { isLiveRow, placeEvent, type CalItems, type DayEntry } from '../../../../shared/logic/calendar/cal-items.ts';
import { projectColorIndex } from '../../../../shared/logic/project-color.ts';
import { dayEntries } from '../../../../shared/logic/calendar/month-grid.ts';
import { navigate } from '../../../app/router.ts';
import { UnsyncedRemindMark } from '../../reminders/index.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarPage.module.css';
import { colorClass, hm, weekdayKey } from './cal-ui.ts';

function titleOf(items: CalItems, e: DayEntry): string {
  const row = e.kind === 'todo' ? items.todos.find((x) => x.id === e.itemId) : items.events.find((x) => x.id === e.itemId);
  return row?.title || e.short;
}

/** 前一两天开始、跨进 date 的有时刻日程（按设备时区）：续段条目和结束时刻（date 当天第几分钟，过了午夜还没完的写 24:00） */
export function carryOver(date: DateStr, items: CalItems, tz: string): { entry: DayEntry; endMin: number }[] {
  const dayStart = msAt(date, 0, tz);
  const out: { entry: DayEntry; endMin: number }[] = [];
  for (const ev of items.events) {
    if (!isLiveRow(ev) || ev.date > date) continue;
    const p = placeEvent(ev, tz);
    if (!p || p.allDay || p.date >= date || p.endMs <= dayStart) continue;
    const endMin = todayOf(p.endMs, tz) === date ? minOfDay(p.endMs, tz) : 24 * 60;
    out.push({
      entry: { itemId: ev.id, kind: 'timed', project: ev.project, colorIndex: projectColorIndex(ev.project), short: ev.short ?? ev.title, startMs: p.startMs, createdAt: ev.created_at },
      endMin,
    });
  }
  return out.sort((a, b) => (a.entry.startMs ?? 0) - (b.entry.startMs ?? 0));
}

/** 行尾的“未同步”小标记（没有时整格不画，见 .dayUnsynced:empty） */
function RowMark({ table, id }: { table: 'events' | 'todos'; id: string }) {
  return (
    <span className={styles.dayUnsynced}>
      <Suspense fallback={null}>
        <UnsyncedRemindMark table={table} id={id} />
      </Suspense>
    </span>
  );
}

export function DayList({
  date,
  items,
  tz,
  dueMins,
  t,
  lunarText,
}: {
  date: DateStr;
  items: CalItems;
  tz: string;
  dueMins: ReadonlyMap<string, number>;
  t: CalViewT;
  /** 中文界面的农历完整写法（“农历九月十五”）；没有时不写 */
  lunarText?: string | undefined;
}) {
  let entries: DayEntry[] = [];
  let cont: { entry: DayEntry; endMin: number }[] = [];
  try {
    entries = dayEntries(date, items, tz);
    cont = carryOver(date, items, tz);
  } catch {
    entries = [];
  }
  const total = entries.length + cont.length;
  const [, m = '1', d = '1'] = date.split('-');
  const head = t('cal.day.title', { m: Number(m), d: Number(d), wd: t('cal.wdFull', { wd: t(weekdayKey(weekdayOf(date)), {}) }) });
  const timeOf = (e: DayEntry): string => {
    if (e.kind === 'timed' && e.startMs !== null) return hm(minOfDay(e.startMs, tz));
    if (e.kind === 'allDay') return t('cal.allDay', {});
    const due = dueMins.get(e.itemId);
    return due === undefined ? t('cal.day.todo', {}) : hm(due);
  };
  return (
    <section className={styles.dayList} aria-labelledby="cal-day-title" data-ghost="" data-testid="cal-day-list" data-date={date}>
      <h2 id="cal-day-title" className={styles.dayListHead}>
        <span>
          {head}
          {lunarText ? ` · ${lunarText}` : ''}
        </span>
        <span className={styles.dayListN}>{t('cal.day.count', { n: total })}</span>
      </h2>
      {total === 0 ? (
        <p className={styles.dayEmpty}>{t('cal.day.empty', {})}</p>
      ) : (
        <ul className={styles.dayRows}>
          {cont.map(({ entry: e, endMin }) => (
            <li key={`cont-${e.itemId}`}>
              <button type="button" className={styles.dayRow} onClick={() => void navigate('event', e.itemId)} data-kind="cont">
                <span className={styles.dayTime}>{t('cal.day.until', { t: endMin >= 24 * 60 ? '24:00' : hm(endMin) })}</span>
                <span className={`${styles.dayMk} ${colorClass(e.colorIndex)}`} aria-hidden="true" />
                <span className={styles.dayTitle}>{titleOf(items, e)}</span>
                <RowMark table="events" id={e.itemId} />
              </button>
            </li>
          ))}
          {entries.map((e) => (
            <li key={`${e.kind}-${e.itemId}`}>
              <button type="button" className={styles.dayRow} onClick={() => void navigate(e.kind === 'todo' ? 'todo' : 'event', e.itemId)} data-kind={e.kind}>
                <span className={styles.dayTime}>{timeOf(e)}</span>
                <span className={`${styles.dayMk} ${colorClass(e.colorIndex)} ${e.kind === 'todo' ? styles.dayMkTodo : ''}`} aria-hidden="true" />
                <span className={styles.dayTitle}>{titleOf(items, e)}</span>
                <RowMark table={e.kind === 'todo' ? 'todos' : 'events'} id={e.itemId} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
