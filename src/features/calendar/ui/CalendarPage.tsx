// 月历和周视图页面：#/calendar（底栏，本月）、#/cal/month/<年-月>、#/cal/week/<日期>
// • 页顶第一行标题胶囊，点了弹出年月选择器（MonthPicker，Radix Popover）；
//   第二行左边“周 / 月 / 纪念日”分段，右边“‹ 今天 ›”（CalNav.tsx）。“纪念日”原地换成纪念日页 #/anniv（同一层）；纪念日开关关着时不出这一段
// • 正文左右滑动翻页、跟手（motion 的 useSwipePager）；电脑键盘 ← → 翻页、T 回今天（焦点在输入框、浮层打开时不生效；日历内部一律原地换、不记历史）
// • 离线、又没拉到要显示的节假日：月历上方提示“联网后显示节假日”
// • 点月格某天 / 周视图某条泳道：选中那一天，下面列出当天全部日程和待办（DayList）；默认选中今天（在这一页里时）
// • 清单标题行下面是今日运势卡（fortune-slot.tsx，按需下载，中韩界面都有）；标题行只写“11月21日 周六”、不写农历
// • 月历下面不放图例
// • 翻页：同一页内换地址一律不起整页 View Transition（useCalendar 走 replaceInPage，日历内部算同一层不记历史）；
//   左右滑、‹ › 按钮（和点上个月、下个月的灰色日期）都是“原地淡换”（swipe.flip）；
//   键盘 ← →、“今天”、年月选择直接切换。滑动、‹ ›、← → 翻页走同一个 turn（收起时按周翻在 useMonthFold 的 shift），
//   翻成了在那里记一行运行日志“cal page prev|next via=swipe|btn|key”
// • 上拖收起：月视图日清单顶上的拖动柄（FoldHandle）往上拖，月历收成一周一行（hooks/useMonthFold）；
//   收起后 ‹ ›、← →、左右滑翻的是周
// • 手机上年月选择器打开时，后面加一层半透明遮罩把内容压暗；电脑不压暗
// • 页面有一个视觉隐藏的 h1
// • 有带提醒、还没同步上的记录时，翻页按钮下面出一行“未同步，提醒可能不响”（reminders 的 UnsyncedRemindHint，懒加载）；
//   和“联网后显示节假日”放在同一块浅灰提示里（两条同时出时是一块里的两行，不叠成两块）；
//   这一块常驻、带 role="status"，内容后填进去读屏才会播报；两条都没有时不占位（.notice 里没有 p）
// • 只读行：日清单行尾“要新版本”标记；点日清单的行、电脑周视图的全天行和时间块都经 open() 拦下，
//   出“这条要新版本才能修改 · 更新”提示条（kit 的 useReadonlyGuard、ReadonlyToast）；页顶（提示条上面）有带重复的只读行时出
//   “有 N 条重复事项要新版本才能完整显示 · 更新”（kit 的 RepeatBanner）
// • 下拉搜索：页顶往下拉，标题行下面露出搜索框（kit 的 usePullReveal + smart-search 的 PullSearch，和随手记、待办页同一套）；
//   打了字就把切换行、月历 / 周视图和日清单藏起来（kit 的 PullSlot，不卸）、换成结果：日程、待办、随手记混在一起列；
//   点日程照旧经 ro.open（只读的拦下、电脑版进抽屉），点待办、随手记换到它的编辑页。日清单的拖动柄带 data-nopull，往下拖是展开月历、不算下拉
// • 电脑版详情抽屉：网页版宽屏（MQ_DESK_WIDE，同今天页、随手记页）点日清单的行、电脑周表的时间块和全天行、搜索结果，
//   不换页，在右边的详情抽屉里编辑（CalDrawer.tsx，外壳是 kit 的 DetailDrawer；开着哪一条由 kit useListActions.ts 的 useDrawerSel 管，同今天页）。
//   只读行照旧先拦下；窗口变窄、抽屉画出错时清掉、退回进编辑页。打开时运行日志记一行“cal drawer open kind= view=”（不记标题）。
//   页顶 h1 带 tabIndex=-1：抽屉里删了这一条、关上时那一行已经不在，焦点退到这里（DetailDrawer 的 rowOf），不掉到 body
// • 网页版宽屏（MQ_DESK_WIDE）：同一套部件换外层排法——kit DeskHead 页头、月格一张卡铺满一屏（没有 960 上限）、
//   下面日清单卡 + 快到了卡（today 的 SoonCard）；右边常驻 AI 助手栏是 ai-chat 的 ChatHost 挂的。见下面 if (desk) 那一段
import { lazy, Suspense, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { addDays, daysIn, fmtDateStr, type DateStr } from '../../../../shared/core/date.ts';
import { countEntries } from '../../../../shared/logic/calendar/cal-items.ts';
import refine from '../../../kit/components/Refine.module.css';
import { monthOf, weekDates } from '../../../../shared/logic/calendar/cal-nav.ts';
import { cellIndexOf, firstInMonth } from '../../../../shared/logic/calendar/month-grid.ts';
import { weekSpan } from '../../../../shared/logic/calendar/week-view.ts';
import { navigate, replaceRoute, useRoute } from '../../../app/router.ts';
import { dockOf } from '../../../app/router-levels.ts';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { annivOn } from '../../../kit/hooks/anniv-on.ts';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { DeskHead, deskCard, deskFrameOf, deskGrid, deskTitle } from '../../../kit/components/Desk.tsx';
import { Later, QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { useDrawerSel } from '../../../kit/hooks/useListActions.ts';
import { MQ_DESK_WIDE, useMedia } from '../../../kit/hooks/useMedia.ts';
import { usePullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { PullSlot } from '../../../kit/components/PullSlot.tsx';
import { ReadonlyToast, RepeatBanner } from '../../../kit/components/ReadonlyRow.tsx';
import { useReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';
import { Appear } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { UnsyncedRemindHint } from '../../reminders/index.ts';
import { PullSearch } from '../../smart-search/index.ts';
import { loadTodayDesk } from '../../today/index.ts';

/** “快到了”卡（today 的 SoonCard）：经宽屏今天页那一块（loadTodayDesk）取。不在 today 的 index.ts 另开一个懒加载出口：
 *  index.ts 每多一个 import()，主包的预加载表就多几条，首屏预算（150 KB，已贴线）放不下；宽屏日历页多下的那一块首屏画完以后才下 */
const SoonCard = lazy(() => loadTodayDesk().then((m) => ({ default: m.SoonCard })));
import { useSwipePager } from '../../../motion/gestures.ts';
import { useCalendar } from '../hooks/useCalendar.ts';
import { useCalViewT, type CalViewT } from '../hooks/useCalViewT.ts';
import type { LunarApi } from '../hooks/useLunar.ts';
import { useMonthFold } from '../hooks/useMonthFold.ts';
import { useNewDateSource } from '../hooks/new-date.ts';
// 只引不用（类名不再从这里取）：保住“先引公共一份、再引自己那份”的样式先后（见 cal-common.module.css 文件头）
import './cal-common.module.css';
import styles from './CalendarPage.module.css';
import { CalDrawer, type CalSel } from './CalDrawer.tsx';
import { CalNav, FoldHandle } from './CalNav.tsx';
import { dateA11y } from './cal-ui.ts';
import { DayList } from './DayList.tsx';
import { FortuneSlot } from './fortune-slot.tsx';
import { MonthGrid } from './MonthGrid.tsx';
import { MonthPicker } from './MonthPicker.tsx';
import { WeekView } from './WeekView.tsx';

function weekTitleText(start: DateStr, t: CalViewT): string {
  const w = weekSpan(start);
  switch (w.kind) {
    case 'same':
      return t('cal.weekTitle', { m1: w.m1, d1: w.d1, d2: w.d2 });
    case 'month':
      return t('cal.weekTitleM', { m1: w.m1, d1: w.d1, m2: w.m2, d2: w.d2 });
    case 'year':
      return t('cal.weekTitleY', { y1: w.y1, m1: w.m1, d1: w.d1, y2: w.y2, m2: w.m2, d2: w.d2 });
  }
}

const GRID_ID = 'cal-month-grid';

/** 手机上年月选择器后面的遮罩（挂在 body 上，比浮层低一层） */
function PickScrim() {
  return createPortal(
    <Appear kind="scrim" show className={styles.pickScrim}>
      <div data-testid="cal-picker-scrim" aria-hidden="true" />
    </Appear>,
    document.body,
  );
}

/** 周泳道、电脑表头那一行：节气优先，没有写农历（一天只查一次 dayInfo） */
const lunarLine = (l: LunarApi) => (d: DateStr): string | undefined => {
  const info = l.dayInfo(d);
  return info.solarTerm ?? info.lunar;
};

/**
 * 页顶的提示：重复事项横幅（在浅灰提示块上面）、浅灰提示块（NoticeBlock）；
 * 只读行被拦下的提示条也挂在这里（贴底 fixed，位置不跟着 DOM 走）
 */
function Notice({ offline, ro, t }: { offline: boolean; ro: CalGuard; t: CalViewT }) {
  return (
    <>
      {ro.g.any ? <RepeatBanner onUpdate={ro.g.update} testId="cal-repeat" /> : null}
      <ReadonlyToast guard={ro.g} message={t('cal.readonly', {})} testId="cal-ro-toast" />
      <NoticeBlock offline={offline} t={t} />
    </>
  );
}

/** 浅灰提示块：离线时“联网后显示节假日”、有没同步上的提醒时“未同步，提醒可能不响”（reminders 提供）；常驻的 status 容器，没内容时不占位 */
function NoticeBlock({ offline, t }: { offline: boolean; t: CalViewT }) {
  return (
    <div className={styles.notice} role="status" data-testid="cal-notice">
      {offline ? (
        <p data-testid="cal-offline">
          {t('cal.offline', {})}
        </p>
      ) : null}
      <Suspense fallback={null}>
        <UnsyncedRemindHint />
      </Suspense>
    </div>
  );
}

/** 只读行：open 打开一条之前先看是不是只读，是就出提示条、不进编辑页；
 *  网页版宽屏（MQ_DESK_WIDE，同今天页、随手记页）开详情抽屉，不然进编辑页。view 只给运行日志用 */
function useCalGuard(view: 'month' | 'week') {
  const g = useReadonlyGuard();
  const ds = useDrawerSel<CalSel>(useMedia(MQ_DESK_WIDE));
  const open = (kind: 'event' | 'todo', id: string): void => {
    if (g.isRo(kind, id)) return g.block();
    if (ds.on) rlog(`cal drawer open kind=${kind} view=${view}`);
    ds.open({ kind, id }, () => void navigate(kind, id));
  };
  return { g, open, ds };
}
type CalGuard = ReturnType<typeof useCalGuard>;

export default function CalendarPage() {
  const route = useRoute();
  const t = useCalViewT();
  const cal = useCalendar(route.name === 'cal' ? route.params : []);
  const { model } = cal;
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<DateStr | null>(null);
  const month = model.view.mode === 'month';
  const title = month ? t('cal.title', { y: model.header.y, m: model.header.m }) : weekTitleText(model.view.start, t);
  // 顶部大字只写“11月”；读屏念完整年月（周视图再接“11月16日–22日”），看得见的“11月”包含在里面（WCAG 2.5.3）
  const titleA11y = month ? title : `${t('cal.title', { y: model.header.y, m: model.header.m })} ${title}`;
  const [from, to] = month
    ? [fmtDateStr(model.header.y, model.header.m, 1), fmtDateStr(model.header.y, model.header.m, daysIn(model.header.y, model.header.m))]
    : [model.view.start, addDays(model.view.start, 6)];
  const count = useMemo(() => {
    try {
      return countEntries(model.items, from, to, model.tz);
    } catch {
      return 0;
    }
  }, [model.items, from, to, model.tz]);
  // 只读行：打开一条之前先看是不是只读，是就出提示条、不进编辑页
  const ro = useCalGuard(model.view.mode);
  /** 抽屉里开着的那一条（行按钮 aria-current；data-open 给抽屉关上时找回焦点用） */
  const openId = ro.ds.sel?.id ?? null;

  // 这一页里有哪几天：选中的那天不在这一页（翻走了）就回到今天（今天也不在就不选）
  const inView = (d: DateStr): boolean =>
    model.view.mode === 'month' ? cellIndexOf(model.cells, d) >= 0 : weekDates(model.view.start).includes(d);
  const selected = picked !== null && inView(picked) ? picked : inView(model.today) ? model.today : null;
  const fold = useMonthFold(cal, selected, setPicked);
  // 底栏“＋”、Ctrl+N 新建日程带上选中的那天（hooks/new-date.ts）
  useNewDateSource(selected);

  /** 翻一页：滑动、‹ ›、键盘 ← → 都走这一处（收起时按周翻在 useMonthFold 的 shift 里）；翻不动返回 false。
   *  翻成了记一行运行日志“cal page prev|next via=swipe|btn|key”，只在这里打 */
  const turn = (n: -1 | 1, via: 'swipe' | 'btn' | 'key'): boolean => {
    const ok = fold.shift(n);
    if (ok) rlog(`cal page ${n < 0 ? 'prev' : 'next'} via=${via}`);
    return ok;
  };
  // 滑动、‹ › 按钮翻页：原地淡换（motion/swipe-pager.ts）；翻不动（turn 返回 false）就回原位；
  // 跟手直接写 transform，不让这一页重画
  const swipe = useSwipePager(turn, rlog);
  const button = (n: -1 | 1): void => void swipe.flip(n, 'btn');
  /** 点月格某天：选中它；点的是上个月、下个月的灰色日期，就翻到那个月再选中。
   *  展开时和 ‹ › 一样横滑进来；收起成一周时直接换到那个月（这时翻页按钮是按周走的） */
  const choose = (d: DateStr): void => {
    setPicked(d);
    const first = firstInMonth(model.cells);
    if (first === undefined || cellIndexOf(model.cells, d) >= 0) return;
    rlog(`cal pick out ${d < first ? 'prev' : 'next'}`);
    if (fold.byWeek) cal.pick(monthOf(d));
    else button(d < first ? -1 : 1);
  };
  /** “今天”、T：选回今天；不在本月 / 本周时换过去（直接切换） */
  const goToday = (): void => {
    setPicked(null);
    if (!model.isCurrent) cal.goToday();
  };

  // 键盘：← → 翻页、T 回今天；直接切换，不横滑。
  // 走 kit 层栈的快捷键入口（页面的键）：焦点在能打字的地方、按着修饰键、有弹层（模态层）开着时都收不到；年月选择器开着时不翻
  const key = (act: () => void) => (): boolean => {
    if (picking) return false;
    act();
    return true;
  };
  useKeys({ ArrowLeft: key(() => void turn(-1, 'key')), ArrowRight: key(() => void turn(1, 'key')), t: key(goToday) });

  const lunarShort = model.lunar ? lunarLine(model.lunar) : undefined;
  const sel = selected;
  const pull = usePullReveal('calendar');
  /** 网页版宽屏排法（kit useMedia 的 MQ_DESK_WIDE） */
  const desk = useMedia(MQ_DESK_WIDE);

  const picker = (
    <MonthPicker
      value={model.header}
      today={monthOf(model.today)}
      week={!month}
      t={t}
      open={picking}
      onOpenChange={setPicking}
      onPick={cal.pick}
      onToday={goToday}
      trigger={
        <button type="button" className={desk ? styles.dkTitleBtn : styles.titleBtn} aria-label={titleA11y} data-testid="cal-title">
          <span className={desk ? deskTitle : `${refine.title} ${styles.titleTx}`}>
            {t('cal.titleBig', { m: model.header.m })}
            {desk ? null : <span className={styles.pillChev} aria-hidden="true" />}
          </span>
        </button>
      }
    />
  );
  /** 标题下一行等宽小字：年份和这一页共几项，同待办页 todos-sub */
  const sub = month ? t('cal.titleSub', { y: model.header.y, n: count }) : t('cal.titleSubW', { range: title, n: count });
  const nav = (
    <CalNav
      t={t}
      month={month}
      byWeek={!month || fold.byWeek}
      canPrev={fold.canPrev}
      canNext={fold.canNext}
      isCurrent={fold.isCurrent}
      onMode={cal.setMode}
      onPrev={() => button(-1)}
      onNext={() => button(1)}
      onToday={goToday}
      {...(annivOn() ? { onAnniv: () => void replaceRoute('anniv') } : {})}
    />
  );
  const day = sel ? (
    <DayList
      date={sel}
      items={model.items}
      tz={model.tz}
      t={t}
      // 宽屏日清单卡里没有今日运势卡（今天页第一行有）
      card={desk ? null : <FortuneSlot date={sel} today={model.today} />}
      onOpen={ro.open} isRo={ro.g.isRo} openId={openId} today={model.today} nowMin={model.nowMin}
    />
  ) : null;
  const search = <PullSearch pull={pull} own={{ kind: 'event', open: (id) => ro.open('event', id) }} />;
  // 电脑版详情抽屉：画出错时（QuietBoundary）按没开算，以后点行进编辑页
  const drawer = ro.ds.sel ? (
    <QuietBoundary name="cal-drawer-shell" onFail={ro.ds.fail}>
      <CalDrawer sel={ro.ds.sel} t={t} onClose={ro.ds.close} />
    </QuietBoundary>
  ) : null;
  /** 正文挂着左右滑动（触摸、笔，跟手）；键盘、鼠标用上面的按钮和 ← → */
  const pagerEl = (className: string | undefined) => (
    <div
      className={className}
      ref={swipe.bind.ref}
      onPointerDown={swipe.bind.onPointerDown}
      onPointerMove={swipe.bind.onPointerMove}
      onPointerUp={swipe.bind.onPointerUp}
      onPointerCancel={swipe.bind.onPointerCancel}
      data-testid="cal-pager"
    >
      {model.view.mode === 'month' ? (
        model.cells ? (
          <MonthGrid
            cells={model.cells}
            holidays={model.holidays}
            weekStart={model.weekStart}
            t={t}
            label={t('cal.grid', { y: model.header.y, m: model.header.m })}
            selected={sel}
            onSelect={choose}
            lunarSay={model.lunar?.fullText}
            fold={{ row: fold.row, collapsed: fold.byWeek, folded: fold.folded }}
            gridRef={fold.gridRef}
            gridId={GRID_ID}
            fill={desk}
          />
        ) : null
      ) : (
        <WeekView
          start={model.view.start}
          items={model.items}
          tz={model.tz}
          today={model.today}
          nowMin={model.nowMin}
          holidays={model.holidays}
          dueMin={model.dueMin}
          anyLate={model.anyLate}
          lunarOf={lunarShort}
          wide={model.wide}
          selected={sel}
          onSelect={setPicked}
          onOpen={ro.open}
          isRo={ro.g.isRo}
          openId={openId}
          t={t}
          label={t('cal.weekGrid', { from: dateA11y(model.view.start, t) })}
        />
      )}
    </div>
  );

  // 网页版宽屏：页头“11月 / 2026年 · 本月 9 项”，右边周 / 月 / 纪念日和 ‹ 今天 ›；
  // 月格一张卡铺满，下面一行 256 高：日清单（1.3）+ 快到了（1）。周视图：左边周表，右边一列日清单 + 快到了（宽 280）。
  // 不画拖动柄（宽屏不收起）、右上角头像（设置在侧栏）
  if (desk) {
    return (
      <main ref={pull.ref} className={`${styles.page} ${deskFrameOf(dockOf('calendar'))}`} data-feature="calendar" data-testid="calendar-page" data-mode={model.view.mode}>
        <h1 className={refine.srOnly} tabIndex={-1}>
          {t('cal.h1', {})}
        </h1>
        <DeskHead title={picker} sub={<span data-testid="cal-sub">{sub}</span>} tools={<div className={styles.dkNav}>{nav}</div>} />
        {/* 下拉占位、提示块平时高 0：包一层零间距的列，不各占一份页面间距（不然网格比 AI 栏低 24） */}
        <div className={styles.dkBody}>
          <PullSlot pull={pull} keyLabel={t('cal.pullKey', {})} search={search}>
            <Notice offline={model.holidaysOffline} ro={ro} t={t} />
            <div className={`${deskGrid} ${styles.dkRows}`} data-mode={model.view.mode}>
              {pagerEl(`${deskCard} ${styles.pager}`)}
              <div className={`${deskGrid} ${styles.dkSide}`}>
                <div className={`${deskCard} ${styles.dkDay}`} ref={fold.dayRef}>
                  {day}
                </div>
                <Later name="cal-soon">
                  <SoonCard today={model.today} />
                </Later>
              </div>
            </div>
          </PullSlot>
        </div>
        {drawer}
      </main>
    );
  }

  return (
    <main ref={pull.ref} className={styles.page} data-feature="calendar" data-testid="calendar-page" data-mode={model.view.mode} data-folded={fold.byWeek || undefined}>
      <h1 className={refine.srOnly} tabIndex={-1}>
        {t('cal.h1', {})}
      </h1>
      {picking && !model.wide ? <PickScrim /> : null}
      <div className={styles.top}>
        {picker}
        <MeLink testId="cal-settings" />
      </div>
      <p className={refine.sub} data-testid="cal-sub">
        {sub}
      </p>
      <PullSlot pull={pull} keyLabel={t('cal.pullKey', {})} search={search}>
        {nav}
        <Notice offline={model.holidaysOffline} ro={ro} t={t} />
        {pagerEl(styles.pager)}
        <div className={styles.dayWrap} ref={fold.dayRef}>
          {fold.active ? <FoldHandle t={t} collapsed={fold.collapsed} controls={GRID_ID} drag={fold.drag} /> : null}
          {day}
        </div>
      </PullSlot>
      {drawer}
    </main>
  );
}
