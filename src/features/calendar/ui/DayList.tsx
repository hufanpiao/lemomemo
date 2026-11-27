// 选中那一天的清单：点月历某天、点周视图某条泳道，下面列出当天全部日程和待办，含没定时间的
// • 日程排序同月历（compareEntries：有时刻的日程按时刻、全天日程）；数据来自 dayEntries
// • 日程每行：左边时刻（有时刻的写开始时刻；全天的写“全天”）、项目色竖线、完整标题；整行是按钮（44 高），点了交给页面的 onOpen
// • 待办不混在日程行里、没有“待办”行首标签：单独一组“● 待办 · N”画在日程后面（todos 功能的 DayTodos，懒加载）：
//   勾选框就地完成、出撤销条，有子任务的就地展开；组内按 H/M/L。标题行的“N 项”仍是日程和待办合起来的条数
// • 标题行：“10月24日 周六”，右边“6 项”（不写农历）
// • 面板最上面的卡片（card 插槽）：页面给 fortune-slot.tsx 的 FortuneSlot（今日运势卡）。
//   卡片画不画由它自己定（算法下载失败、算不出来时什么都不渲染），这里不按 card 是否为 null 判断：
//   外层 .card 是空的就不占位，下面的分隔线也只在 .card 有内容时画（DayList.module.css）；
//   只有待办、没有日程行时，卡片单独一块面板（.cardOnly，空了同样不画），不画空面板
// • 跨午夜、跨多天的日程：dayEntries 在它占的每一天都放一条（带 span）；开始那天写开始时刻、标题下面“至 11月20日 18:00”，
//   中间整天写“持续”，最后一天写“至 01:00”（后面几天的那一段标 data-kind="cont"，和周视图泳道次日的续段一致）；全天的跨天日程标题下面写“第 2/3 天”
// • “往上拖列表、月历收成一周一行”的拖动柄在 CalNav.tsx 的 FoldHandle，这里只管列表
// • 行的样式（白面板、行、时刻那一格、标题、行尾标记、空状态）用 kit 的 List.module.css，和今天页、待办页同一份
// • 标题行在面板上方，挂 kit 的小字分组名 groupLabelClass；卡片和行在下面一块面板里。
//   行首时刻按状态上色（today、nowMin 由页面给）：已经过去的日程第三层灰，其余照常（过了截止没完成的待办红字在 DayTodos 里）
// • 行尾“未同步”小标记：带提醒、还没同步上的那一条才标，同步上自动消失；
//   由 reminders 功能懒加载提供（UnsyncedRemindMark），没标时那一格不占位。周视图泳道、月格不标
// • 只读行：行尾“要新版本”标记（kit 的 ReadonlyMark）；点了交给页面的 onOpen，由页面拦下、出提示条
// • 电脑版详情抽屉：行按钮带 data-open（抽屉关上时找回这一行），抽屉里开着的那条 aria-current（kit List 的左边柠檬黄一道，同今天页）
import { Suspense, type ReactNode } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { hm24, minOfDay, weekdayOf } from '../../../../shared/core/date.ts';
import type { CalItems, DayEntry } from '../../../../shared/logic/calendar/cal-items.ts';
import { spanTextOn, type SpanText } from '../../../../shared/logic/calendar/event-span.ts';
import { dayEntries } from '../../../../shared/logic/calendar/month-grid.ts';
import { groupLabelClass } from '../../../kit/components/Form.tsx';
import list from '../../../kit/components/List.module.css';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { ReadonlyMark } from '../../../kit/components/ReadonlyRow.tsx';
import { useSpanT } from '../../../kit/hooks/useSpanT.ts';
import { UnsyncedRemindMark } from '../../reminders/index.ts';
import { DayTodos } from '../../todos/index.ts';
import type { CalViewT } from '../hooks/useCalViewT.ts';
import './cal-common.module.css';
import styles from './DayList.module.css';
import { colorClass, dayNo, entryTitle, monthNo, wdFull } from './cal-ui.ts';

/**
 * 日程在 date 这一天怎么写（event-span.ts 的 spanTextOn）；待办为 null。
 * 跨天的（含跨午夜的）dayEntries 已经在它占的每一天各放了一条（带 span）：开始那天写开始时刻、标题下面“至 11月20日 18:00”；
 * 中间整天写“持续”；最后一天写“至 18:00”。全天的跨天日程照写“全天”，标题下面“第 2/3 天”
 */
function spanOf(e: DayEntry, date: DateStr, tz: string): SpanText | null {
  return e.place ? spanTextOn(e.place, date, tz) : null;
}

/** 行尾的“未同步”小标记（没有时整格不画，见 .dayUnsynced:empty） */
function RowMark({ table, id }: { table: 'events' | 'todos'; id: string }) {
  return (
    <span className={list.unsynced}>
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
  t,
  card = null,
  today,
  nowMin,
  onOpen,
  isRo,
  openId,
}: {
  date: DateStr;
  items: CalItems;
  tz: string;
  t: CalViewT;
  /** 面板最上面那张卡片（今日运势卡；CalendarPage 给 fortune-slot.tsx 的 FortuneSlot）；它什么都不渲染时不占位 */
  card?: ReactNode;
  /** 今天、现在是当天第几分钟（设备时区）：给了才按状态给行首时刻上色 */
  today?: DateStr | undefined;
  nowMin?: number | undefined;
  /** 打开一条：页面给，只读行在那里拦下 */
  onOpen: (kind: 'event' | 'todo', id: string) => void;
  /** 这一条是不是只读行 */
  isRo: (kind: 'event' | 'todo', id: string) => boolean;
  /** 电脑版详情抽屉里开着的那一条；没开时 null */
  openId: string | null;
}) {
  const cur = (id: string) => (openId === id ? ('true' as const) : undefined);
  let entries: DayEntry[] = [];
  try {
    entries = dayEntries(date, items, tz);
  } catch {
    entries = [];
  }
  const total = entries.length;
  const head = t('cal.day.title', { m: monthNo(date), d: dayNo(date), wd: wdFull(weekdayOf(date), t) });
  // 待办单独成一组画在日程后面（todos 的 DayTodos）；这里只画日程（跨天的在它占的每一天各一条）
  const events = entries.filter((e) => e.kind !== 'todo');
  const spanT = useSpanT();
  /** 行首：开始那天写开始时刻，后面几天写“持续”“至 18:00”，全天的写“全天”（spanTextOn） */
  const timeOf = (e: DayEntry, s: SpanText): string => {
    if (s.lead !== 'start') return spanT(s.lead);
    return e.startMs === null ? '' : hm24(minOfDay(e.startMs, tz));
  };
  /** 跨天日程标题下面那行小字 */
  const metaOf = (s: SpanText | null): string | null => (s === null || s.meta === null ? null : spanT(s.meta));
  /** 过去了：那天整天已过，或者就是今天、endMin（日程结束）已经到了；没有 endMin 的今天不算 */
  const passed = (endMin: number | null | undefined): boolean =>
    today !== undefined && (date < today || (date === today && nowMin !== undefined && typeof endMin === 'number' && endMin <= nowMin));
  /** 面板里的行：日程行，或者整天什么都没有时的空状态；只有待办时没有（卡片单独一块，见文件头） */
  const hasRows = total === 0 || events.length > 0;
  return (
    <section className={styles.dayList} aria-labelledby="cal-day-title" data-testid="cal-day-list" data-date={date}>
      <h2 id="cal-day-title" className={`${groupLabelClass} ${styles.dayListHead}`}>
        <span>{head}</span>
        <span>{t('cal.day.count', { n: total })}</span>
      </h2>
      {!hasRows ? (
        card === null ? null : <div className={`${list.panel} ${styles.dayPanel} ${styles.cardOnly}`}>{card}</div>
      ) : (
      <div className={`${list.panel} ${styles.dayPanel}`}>
      {card === null ? null : <div className={styles.card}>{card}</div>}
      {total === 0 ? (
        <p className={list.empty}>{t('cal.day.empty', {})}</p>
      ) : (
        <ul className={`${list.list} ${styles.dayListRows}`}>
          {events.map((e) => {
            const s = spanOf(e, date, tz);
            const meta = metaOf(s);
            // 有时刻的跨天日程在后面几天的那一段（续段）标 data-kind="cont"
            const contRow = e.kind === 'timed' && (e.span?.cont === 'start' || e.span?.cont === 'both');
            return (
              <li key={`${e.kind}-${e.itemId}`} className={list.row}>
                <button
                  type="button"
                  className={list.main}
                  onClick={() => onOpen('event', e.itemId)}
                  data-kind={contRow ? 'cont' : e.kind}
                  data-span={e.span?.cont}
                  data-readonly={isRo('event', e.itemId) ? '' : undefined}
                  data-open={e.itemId}
                  aria-current={cur(e.itemId)}
                  data-testid={`cal-day-row-${e.itemId}`}
                >
                  <span className={`${list.lead} ${styles.dayTime}`} data-tone={s !== null && passed(s.endMin) ? 'past' : undefined}>
                    {s === null ? '' : timeOf(e, s)}
                  </span>
                  <span className={`${styles.dayMk} ${colorClass(e.colorIndex)}`} aria-hidden="true" />
                  {meta === null ? (
                    <span className={list.title}>{entryTitle(e)}</span>
                  ) : (
                    <span className={list.text}>
                      <span className={list.title}>{entryTitle(e)}</span>
                      <span className={list.meta} data-testid={`cal-day-span-${e.itemId}`}>{meta}</span>
                    </span>
                  )}
                  {isRo('event', e.itemId) ? <ReadonlyMark testId={`cal-ro-${e.itemId}`} /> : null}
                  <RowMark table="events" id={e.itemId} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      </div>
      )}
      {/* 待办组“● 待办 · N”：就地完成、展开子任务；按需下载（待办列表页那一包），分包下不来时那一组不画、不把整页换成出错页。
          这一天没有待办时也挂着：刚勾完最后一条时它要留在原位、出撤销条 */}
      <QuietBoundary name="cal-day-todos">
        <Suspense fallback={null}>
          <DayTodos date={date} onOpen={onOpen} openId={openId} />
        </Suspense>
      </QuietBoundary>
    </section>
  );
}
