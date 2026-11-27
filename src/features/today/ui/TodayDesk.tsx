// 网页版宽屏今天页（参考 本机资料/01-设计方案/2026-11-24_网页端日历待办改善/web-layout-plan.html）：
// 宽屏（kit useMedia 的 MQ_DESK_WIDE）才由 TodayPage 懒加载，手机宽度不下载。排法固定：
// • 页头（kit DeskHead）：日期大标题（TodayPage 给的 h1）、下一行小字“农历十月初四 · 3 天后 김지민 生日”（农历只在中文界面；纪念日 7 天内最近一个）；
//   右边天气胶囊（weather 功能的 WeatherChip slot="desk"，首屏画完才下载；没地方可看时是“设置城市看天气”）
// • 第一行：“现在”卡（TodayPage 给的 NowCard）+ 今日运势卡（宽 270，calendar 的 FortuneTile 同一套生日、算法、详情弹层，只换外形 shape="card"）
// • 第二行：周历卡（周日到周六七格，每格星期、日期、最多 3 条日程）+ 本周柱体卡（宽 270，和运势卡右边对齐成一列；柱子越高那天事越多）
// • 第三行：这天的日程、这天的待办、快到了（纪念日）三张卡；点周历或柱子的某一天，日程、待办两张卡换成那一天（默认今天）。
//   今天的待办是 TodayPage 画好的（没赶上的在前、今天截止的在后，打勾、左滑删除、子任务和手机同一套）；已做完的收进“已完成 N ›”（kit DoneFold，同待办页，
//   默认收起）；别的天用 todos 的 DayTodos（日历日清单同一个）
// • 页顶的提示（错过的提醒、未同步、只读横幅）放在今天的日程卡最上面
// • 选中一条：详情抽屉从右边盖上来（kit DetailDrawer，× / Esc 关）；里面是待办、日程编辑器（todos、calendar 的 index.ts 懒加载）；选中哪一条由 TodayPage 管
// • 键盘：J / K 在今天页各行之间移焦点，E 勾选焦点所在的待办，Enter 是按钮自带的打开（焦点在输入框里时单字母键不生效，kit 的 useKeys）
import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { dockOf } from '../../../app/router-levels.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { projectColorIndex } from '../../../../shared/logic/project-color.ts';
import { DeskCard, DeskHead, deskCard, deskFrameOf, deskGrid, deskTitle } from '../../../kit/components/Desk.tsx';
import { DetailDrawer } from '../../../kit/components/DetailDrawer.tsx';
import { DoneFold } from '../../../kit/components/DoneFold.tsx';
import list from '../../../kit/components/List.module.css';
import { Later } from '../../../kit/components/QuietBoundary.tsx';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { AppearList } from '../../../motion/components.ts';
import { EventDrawerEditor, FortuneTile } from '../../calendar/index.ts';
import { DayTodos, TodoDrawerEditor } from '../../todos/index.ts';
import { WeatherChip } from '../../weather/index.ts';
import { ANNIV_SOON_DAYS, annivLabel, annivWhen, useAnnivUpcoming } from '../hooks/useAnnivUpcoming.ts';
import { useLunarToday, useWeekBusy, type DayBusy } from '../hooks/useTodayDesk.ts';
import { useTodayDeskT } from '../hooks/useTodayDeskT.ts';
import { useLocale, useTodayT } from '../hooks/useTodayT.ts';
import type { EventOcc } from '../hooks/today-types.ts';
import SoonCard from './SoonCard.tsx';
import styles from './TodayDesk.module.css';

/** 抽屉里开着的是哪一条 */
export interface TodaySel {
  kind: 'event' | 'todo';
  id: string;
}

export interface TodayDeskProps {
  today: DateStr;
  /** 页头的日期大标题（TodayPage 画的 h1） */
  title: ReactNode;
  /** 页顶提示（错过的提醒、只读横幅、未同步） */
  notices: ReactNode;
  /** “现在”卡 */
  now: ReactNode;
  /** 今天的待办（没赶上的在前，不含已做完的）；todayTodoN 是件数（含已做完的），0 时这里画占位字、不用 todayTodos */
  todayTodos: ReactNode;
  /** 今天已做完的待办行：收进“已完成 N ›”，默认收起、点开才显示 */
  doneTodos: readonly ReactNode[];
  todayTodoN: number;
  /** 日程一行（TodayPage 的 TodayEventRow，带只读、选中、点开） */
  eventRow(o: EventOcc, day: DateStr): ReactNode;
  sel: TodaySel | null;
  onOpen(sel: TodaySel): void;
  onClose(): void;
}

const noop = (): void => undefined;

/** 宽屏时 TodayPage 的 main 加的外框、日期大标题的类名（从这个按需下载的模块里取，kit Desk 的样式不进首屏） */
export const frame = deskFrameOf(dockOf('today'));
/** “快到了”卡：宽屏日历页经 today 的 index.ts 的 loadTodayDesk 从这一块取（不另开懒加载出口，见 CalendarPage.tsx 的 SoonCard） */
export { SoonCard };
export const title = deskTitle;

export default function TodayDesk({ today, title, notices, now, todayTodos, doneTodos, todayTodoN, eventRow, sel, onOpen, onClose }: TodayDeskProps) {
  const t = useTodayDeskT();
  const locale = useLocale();
  const week = useWeekBusy(today);
  const [picked, setPicked] = useState<DateStr | null>(null);
  // 选的那天翻出这一周（过了零点）就回到今天
  const day = picked !== null && week.some((x) => x.date === picked) ? picked : today;
  const isToday = day === today;
  const label = isToday ? t('desk.today', {}) : fmtDay(day, locale, 'monthDay');
  // 这天的日程取周历那一份（data/week-busy.ts）：每天都是 today-model 的 eventsOn(日程, 那天, 时区, 语言)，
  // 和手机一列“今天的安排”（hooks/useToday.ts 的 v.events）同一个函数、同样的参数，今天这一天两边逐条相同；不另从 TodayPage 递一份（首屏的今天页不多带）
  const events = week.find((x) => x.date === day)?.events ?? [];
  useJk();
  return (
    <>
      <DeskHead
        title={title}
        sub={<HeadSub today={today} />}
        tools={
          <Later name="weather" afterPaint>
            <WeatherChip slot="desk" />
          </Later>
        }
      />
      <div className={`${deskGrid} ${styles.rows}`}>
        <div className={`${deskGrid} ${styles.pair}`}>
          {now}
          <Later name="today-fortune">
            <FortuneTile today={today} className={deskCard} shape="card" />
          </Later>
        </div>
        <div className={`${deskGrid} ${styles.pair}`}>
          <WeekStrip week={week} today={today} day={day} onPick={setPicked} />
          <WeekBars week={week} today={today} day={day} onPick={setPicked} />
        </div>
        <div className={`${deskGrid} ${styles.three}`}>
          <DeskCard title={t('desk.sched', { d: label })} end={events.length} data-testid="today-sched">
            {isToday ? notices : null}
            {events.length ? (
              <AppearList as="ul" className={`${list.list} ${styles.flat}`}>
                {events.map((o) => eventRow(o, day))}
              </AppearList>
            ) : (
              <p className={styles.none}>{t('desk.schedNone', {})}</p>
            )}
          </DeskCard>
          <DeskCard title={t('desk.todos', { d: label })} end={isToday ? todayTodoN : undefined} data-testid="today-todos">
            {isToday ? (
              todayTodoN ? (
                <>
                  {todayTodos}
                  <TodayDone rows={doneTodos} />
                </>
              ) : (
                <p className={styles.none}>{t('desk.todosNone', {})}</p>
              )
            ) : (
              <Later name="today-day-todos">
                <DayTodos date={day} onOpen={(_, id) => onOpen({ kind: 'todo', id })} openId={sel?.id ?? null} />
              </Later>
            )}
          </DeskCard>
          <SoonCard today={today} />
        </div>
      </div>
      {sel ? <TodayDrawer sel={sel} onClose={onClose} /> : null}
    </>
  );
}

/** 页头小字（参考 .hd small“农历十月初四 · 3 天后 김지민 生日”）：农历中文界面才有（农历表按需加载，没好时不写）；纪念日 7 天内最近一个 */
function HeadSub({ today }: { today: DateStr }) {
  const t = useTodayDeskT();
  const tt = useTodayT();
  const lunar = useLunarToday(today);
  const soon = useAnnivUpcoming(today, ANNIV_SOON_DAYS, 1)[0];
  const parts = [lunar ? t('desk.lunar', { d: lunar }) : '', soon ? `${annivWhen(soon.days, tt)} ${annivLabel(soon.row, tt)}` : ''].filter(Boolean);
  return parts.length ? <span data-testid="today-head-sub">{parts.join(' · ')}</span> : null;
}

/** 今天的待办卡里已做完的那几条：照待办页的“已完成 N ›”（kit DoneFold）收成一行，默认收起、点开才列出；
 *  展开没有不存（这次打开记着，同手机今天页的“已过去”）。0 件不画 */
function TodayDone({ rows }: { rows: readonly ReactNode[] }) {
  const t = useTodayDeskT();
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <section data-testid="today-done-group">
      <DoneFold title={t('desk.doneN', { n: rows.length })} open={open} onToggle={() => setOpen(!open)} testId="today-done-fold" />
      {open ? (
        <AppearList as="ul" className={`${list.list} ${list.roomy}`}>
          {rows}
        </AppearList>
      ) : null}
    </section>
  );
}

/** 详情抽屉（kit 的 DetailDrawer：Esc、×、焦点还回去，关上时按行按钮的 data-open 找回这一行）：待办、日程编辑器按需下载时挂起在这一层 */
function TodayDrawer({ sel, onClose }: { sel: TodaySel; onClose(): void }) {
  const t = useTodayDeskT();
  const Editor = sel.kind === 'todo' ? TodoDrawerEditor : EventDrawerEditor;
  return (
    <DetailDrawer id={sel.id} label={t('desk.drawer', {})} onClose={onClose} side="right" data-testid="today-drawer">
      <Later name="today-drawer">
        <Editor key={sel.id} id={sel.id} onCreated={noop} />
      </Later>
    </DetailDrawer>
  );
}

/** J / K / E：今天页里可点的行（kit List 的 .main 按钮）之间移焦点；E 勾选焦点那一行的待办 */
function useJk(): void {
  const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`main[data-feature="today"] li .${list.main}`)];
  const step = (d: 1 | -1) => (): boolean => {
    const all = rows();
    if (!all.length) return false;
    const cur = all.findIndex((el) => el === document.activeElement || el.parentElement?.contains(document.activeElement));
    all[cur < 0 ? (d > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, cur + d))]?.focus();
    return true;
  };
  useKeys({
    j: step(1),
    k: step(-1),
    e: () => {
      const li = (document.activeElement as HTMLElement | null)?.closest('main[data-feature="today"] li');
      const box = li?.querySelector<HTMLElement>('[data-testid^="today-done-"]');
      if (!box) return false;
      box.click();
      return true;
    },
  });
}

interface WeekProps {
  week: readonly DayBusy[];
  today: DateStr;
  day: DateStr;
  onPick(d: DateStr): void;
}

/** 日程小条的底色：项目色（同月历的 projectColorIndex），没有项目用浅灰 */
const evColor = (project: string): CSSProperties => {
  const i = projectColorIndex(project);
  return { '--ev': i ? `var(--p${i})` : 'var(--panel-2)' } as CSSProperties;
};

/**
 * 周历格、柱子的读屏名：先按显示顺序念看得见的字（WCAG 2.5.3 名字里要含看得见的字，axe label-content-name-mismatch；同 calendar 的 cal-ui.ts labelInName），
 * 再接“11月22日 星期日 3 件”。DOM 里几段字之间也放 {' '}（格子是 flex / grid，空格不画出来），否则 axe 把“日”“22”连成一个词，和名字对不上
 */
const dayName = (t: ReturnType<typeof useTodayDeskT>, locale: ReturnType<typeof useLocale>, x: DayBusy, shown: ReadonlyArray<string | number>): string =>
  t('desk.weekDay', { s: shown.filter((s) => s !== '').join(' '), w: fmtDay(x.date, locale, 'monthDayWeek'), n: x.n });

/** 周历（参考 weekCard .wst .wd）：七格，每格上面星期和日期（今天的日期柠檬黄底），下面最多 3 条日程；
 *  点了选这一天：选中那天的日期变深色小方块（同手机月格 .sel .dayNum 的 --cal-sel-*）；选中的是今天时照旧柠檬黄 */
function WeekStrip({ week, today, day, onPick }: WeekProps) {
  const t = useTodayDeskT();
  const locale = useLocale();
  const wd = Array.from(t('desk.wd', {}));
  return (
    <div className={`${deskCard} ${styles.weekCard}`} role="group" aria-label={t('desk.week', {})} data-testid="today-week">
      {week.map((x, i) => (
        <button
          key={x.date}
          type="button"
          className={styles.wd}
          aria-pressed={x.date === day}
          aria-label={dayName(t, locale, x, [wd[i] ?? '', Number(x.date.slice(8)), ...x.events.slice(0, 3).map((o) => o.title)])}
          data-today={x.date === today ? '' : undefined}
          onClick={() => onPick(x.date)}
          data-testid={`today-wd-${x.date}`}
        >
          <span className={styles.wn} aria-hidden="true">
            {wd[i]}{' '}
            <b>{Number(x.date.slice(8))}</b>
          </span>
          {x.events.slice(0, 3).map((o) => (
            <Fragment key={o.id}>
              {' '}
              <span className={styles.ev} style={evColor(o.project)} aria-hidden="true">
                {o.title}
              </span>
            </Fragment>
          ))}
        </button>
      ))}
    </div>
  );
}

/** 本周柱体（参考 barCard .bc .bi）：标题“本周 · N 项”，七根柱子（上面件数、下面星期；高度按 3 件封顶的比例，今天那根柠檬黄）；点了选这一天（星期反白） */
function WeekBars({ week, today, day, onPick }: WeekProps) {
  const t = useTodayDeskT();
  const locale = useLocale();
  const wd = Array.from(t('desk.wd', {}));
  const total = week.reduce((s, x) => s + x.n, 0);
  const max = Math.max(3, ...week.map((x) => x.n));
  return (
    <DeskCard title={t('desk.week', {})} end={t('desk.weekN', { n: total })} data-testid="today-bars">
      <div className={styles.bc}>
        {week.map((x, i) => (
          <button
            key={x.date}
            type="button"
            className={styles.bi}
            aria-pressed={x.date === day}
            aria-label={dayName(t, locale, x, [x.n || '', wd[i] ?? ''])}
            data-today={x.date === today ? '' : undefined}
            onClick={() => onPick(x.date)}
          >
            <span aria-hidden="true">{x.n || ''}</span>{' '}
            <span className={styles.bt} aria-hidden="true">
              <i style={{ height: `${x.n ? Math.max(16, (x.n / max) * 100) : 4}%` }} />
            </span>{' '}
            <span className={styles.bl} aria-hidden="true">
              {wd[i]}
            </span>
          </button>
        ))}
      </div>
    </DeskCard>
  );
}
