// 月历和周视图页面（B2 FA-3，架构 5.12）：#/calendar（底栏，本月）、#/cal/month/<年-月>、#/cal/week/<日期>
// • 页顶按 R-101 摆法 B（定稿线框 s2、s3）：第一行标题胶囊“2026年10月 ⌄”/“10月19日–25日 ⌄”，点了弹出年月选择器（MonthPicker，Radix Popover）；
//   第二行左边“周 / 月 / 纪念日”分段，右边“‹ 今天 ›”（CalNav.tsx）。“纪念日”是 B5 的功能，没做好之前置灰、不跳占位页，点了在页顶提示条里出“纪念日即将推出”，几秒后收起（B2 全站视觉审查 A2）
// • 正文左右滑动翻页、跟手（motion 的 useSwipePager）；电脑键盘 ← → 翻页、T 回今天（焦点在输入框、浮层打开时不生效；日历内部一律原地换、不记历史，R-372）
// • 离线、又没拉到要显示的节假日：月历上方提示“联网后显示节假日”（5.12 第 1 点）
// • 点月格某天 / 周视图某条泳道：选中那一天，下面列出当天全部日程和待办（DayList）；默认选中今天（在这一页里时）
// • 月历底部常驻一行图例（线框 s3）
// • 翻页的动画（架构 5.12，代码复审 N1）：同一页内换地址一律不起整页 View Transition（useCalendar 走 replaceInPage，日历内部算同一层不记历史，R-372）；
//   ‹ › 按钮翻页和滑动一样，新的一页从那一侧横滑进来（swipe.slideIn，--dur-ui + --ease-standard）；键盘 ← →、“今天”、年月选择直接切换
// • 上拖收起（线框 s3、架构 17、R-326）：月视图日清单顶上的拖动柄（FoldHandle）往上拖，月历收成一周一行（hooks/useMonthFold）；
//   收起后 ‹ ›、← →、左右滑翻的是周
// • 手机上年月选择器打开时，后面加一层半透明遮罩把内容压暗（设计复审 N1）；电脑不压暗
// • 页面有一个视觉隐藏的 h1（代码复审 N7）
// • 有带提醒、还没同步上的记录时，翻页按钮下面出一行“未同步，提醒可能不响”（REMIND-wiring；TC-B2-69；reminders 的 UnsyncedRemindHint，懒加载）；
//   浅灰条是负责人 11-04 定的（R-346）。和“联网后显示节假日”放在同一块浅灰提示里（两条同时出时是一块里的两行，不叠成两块，代码审查 L3）；
//   这一块常驻、带 role="status"，内容后填进去读屏才会播报；两条都没有时不占位（.notice 里没有 p）
// • 只读行（FA-2 只读行界面；架构 0.27 第 1 点）：日清单行尾“要新版本”标记；点日清单的行、电脑周视图的全天行和时间块都经 open() 拦下，
//   出“这条要新版本才能修改 · 更新”提示条（kit 的 useReadonlyGuard、ReadonlyToast）；页顶（提示条上面）有带重复的只读行时出
//   “有 N 条重复事项要新版本才能完整显示 · 更新”（kit 的 RepeatBanner）
import { Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DateStr } from '../../../../shared/core/date.ts';
import { monthOf, weekDates } from '../../../../shared/logic/calendar/cal-nav.ts';
import { navigate, useRoute } from '../../../app/router.ts';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { ReadonlyToast, RepeatBanner } from '../../../kit/components/ReadonlyRow.tsx';
import { useReadonlyGuard } from '../../../kit/hooks/useReadonly.ts';
import { Appear } from '../../../motion/components.ts';
import { opensKeyboard } from '../../../platform/env.ts';
import { UnsyncedRemindHint } from '../../reminders/index.ts';
import { useSwipePager } from '../../../motion/gestures.ts';
import { useCalendar } from '../hooks/useCalendar.ts';
import { useCalHolidayChoice } from '../hooks/useCalSettings.ts';
import { useCalViewT, type CalViewT } from '../hooks/useCalViewT.ts';
import { useMonthFold } from '../hooks/useMonthFold.ts';
import { watchAddClick } from '../hooks/new-date.ts';
import { weekTitle } from './week-axis.ts';
import styles from './CalendarPage.module.css';
import { CalNav, FoldHandle } from './CalNav.tsx';
import { DayList } from './DayList.tsx';
import { MonthGrid, MonthLegend } from './MonthGrid.tsx';
import { MonthPicker } from './MonthPicker.tsx';
import { WeekView } from './WeekView.tsx';

function weekTitleText(start: DateStr, t: CalViewT): string {
  const w = weekTitle(start);
  switch (w.kind) {
    case 'same':
      return t('cal.weekTitle', { m1: w.m1, d1: w.d1, d2: w.d2 });
    case 'month':
      return t('cal.weekTitleM', { m1: w.m1, d1: w.d1, m2: w.m2, d2: w.d2 });
    case 'year':
      return t('cal.weekTitleY', { y1: w.y1, m1: w.m1, d1: w.d1, y2: w.y2, m2: w.m2, d2: w.d2 });
  }
}

function holShortKey(v: 'cn' | 'kr' | 'both'): 'cal.set.holShort.cn' | 'cal.set.holShort.kr' | 'cal.set.holShort.both' {
  switch (v) {
    case 'cn':
      return 'cal.set.holShort.cn';
    case 'kr':
      return 'cal.set.holShort.kr';
    case 'both':
      return 'cal.set.holShort.both';
  }
}

/** 键盘翻页不该生效的时候：焦点在能打字的地方、页面上有浮层或弹窗、按着修饰键 */
function keyBlocked(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return true;
  if (opensKeyboard(e.target)) return true;
  return document.querySelector('[role="dialog"]') !== null;
}

const GRID_ID = 'cal-month-grid';

/** 挂一个 keydown 监听（只挂一次），处理函数每次渲染换成最新的 */
function useKeydown(fn: (e: KeyboardEvent) => void): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => ref.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** 手机上年月选择器后面的遮罩（挂在 body 上，比浮层低一层；设计复审 N1） */
function PickScrim() {
  return createPortal(
    <Appear kind="scrim" show className={styles.pickScrim}>
      <div data-testid="cal-picker-scrim" aria-hidden="true" />
    </Appear>,
    document.body,
  );
}

/** 页顶提示：离线时“联网后显示节假日”、有没同步上的提醒时“未同步，提醒可能不响”（reminders 提供）；常驻的 status 容器，没内容时不占位 */
/**
 * 页顶的提示：重复事项横幅（FA-2，在浅灰提示块上面）、浅灰提示块（纪念日即将推出、联网后显示节假日、未同步）；
 * 只读行被拦下的提示条也挂在这里（贴底 fixed，位置不跟着 DOM 走）
 */
function Notice({ offline, ro, t }: { offline: boolean; ro: CalGuard; t: CalViewT }) {
  return (
    <>
      {ro.g.any ? <RepeatBanner onUpdate={ro.g.update} testId="cal-repeat" /> : null}
      <ReadonlyToast guard={ro.g} message={t('cal.readonly', {})} testId="cal-ro-toast" />
      <NoticeBlock offline={offline} annivSoon={ro.anniv.on} t={t} />
    </>
  );
}

function NoticeBlock({ offline, annivSoon, t }: { offline: boolean; annivSoon: boolean; t: CalViewT }) {
  return (
    <div className={styles.notice} role="status" data-testid="cal-notice">
      {annivSoon ? <p data-testid="cal-anniv-soon">{t('cal.annivSoon', {})}</p> : null}
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

/** “纪念日即将推出”留多久 */
const ANNIV_SOON_MS = 4000;

/** “纪念日”还没做好（A2）：点了出“纪念日即将推出”，几秒后收起；再点重新计时 */
function useAnnivSoon(): { on: boolean; show(): void } {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!at) return undefined;
    const id = setTimeout(() => setAt(0), ANNIV_SOON_MS);
    return () => clearTimeout(id);
  }, [at]);
  return { on: at !== 0, show: () => setAt(Date.now()) };
}

/** 只读行（FA-2）和“纪念日即将推出”（A2）：open 打开一条之前先看是不是只读，是就出提示条、不进编辑页 */
function useCalGuard() {
  const g = useReadonlyGuard();
  const anniv = useAnnivSoon();
  const open = (kind: 'event' | 'todo', id: string): void => (g.isRo(kind, id) ? g.block() : void navigate(kind, id));
  return { g, anniv, open };
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
  const holChoice = useCalHolidayChoice();
  // 只读行（FA-2）：打开一条之前先看是不是只读，是就出提示条、不进编辑页
  const ro = useCalGuard();

  // 这一页里有哪几天：选中的那天不在这一页（翻走了）就回到今天（今天也不在就不选）
  const inView = (d: DateStr): boolean =>
    model.view.mode === 'month' ? (model.cells?.some((c) => c.inMonth && c.date === d) ?? false) : weekDates(model.view.start).includes(d);
  const selected = picked !== null && inView(picked) ? picked : inView(model.today) ? model.today : null;
  const fold = useMonthFold(cal, selected, setPicked);
  // 底栏“＋”新建日程带上选中的那天（FA-7 第 5 项，hooks/new-date.ts）
  const sel0 = useRef(selected);
  sel0.current = selected;
  useEffect(() => watchAddClick(() => sel0.current), []);

  /** 翻一页（收起时翻一周）；翻不动返回 false */
  const turn = (n: -1 | 1): boolean => {
    if (fold.byWeek) return fold.step(n);
    if (n < 0 ? !model.canPrev : !model.canNext) return false;
    if (n < 0) cal.prev();
    else cal.next();
    return true;
  };
  const swipe = useSwipePager((dir) => void turn(dir));
  const pagerRef = useRef<HTMLDivElement>(null);
  /** ‹ › 按钮：翻页后新的一页从那一侧横滑进来（和滑动一样，5.12） */
  const button = (n: -1 | 1): void => {
    if (turn(n)) swipe.slideIn(n, pagerRef.current?.getBoundingClientRect().width ?? 0);
  };
  /** “今天”、T：选回今天；不在本月 / 本周时换过去（直接切换） */
  const goToday = (): void => {
    setPicked(null);
    if (!model.isCurrent) cal.goToday();
  };

  // 键盘：← → 翻页、T 回今天（5.12 第 3 点；线框 s3 电脑版说明）；直接切换，不横滑
  useKeydown((e) => {
    if (picking || keyBlocked(e)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const n = e.key === 'ArrowLeft' ? -1 : 1;
      if (fold.byWeek) fold.step(n);
      else cal.keyShift(n);
    } else if (e.key === 't' || e.key === 'T') {
      goToday();
    }
  });

  const lunarShort = model.lunar ? (d: DateStr) => model.lunar?.dayInfo(d).solarTerm ?? model.lunar?.dayInfo(d).lunar : undefined;
  const sel = selected;
  const { p } = fold;

  return (
    <main className={styles.page} data-feature="calendar" data-testid="calendar-page" data-mode={model.view.mode} data-folded={fold.byWeek || undefined}>
      <h1 className={styles.srOnly}>{t('cal.h1', {})}</h1>
      {picking && !model.wide ? <PickScrim /> : null}
      <div className={styles.top}>
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
            <button type="button" className={styles.pill} data-testid="cal-title">
              <span>{title}</span>
              <span className={styles.pillChev} aria-hidden="true" />
            </button>
          }
        />
        <MeLink testId="cal-settings" />
      </div>
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
        onAnniv={ro.anniv.show}
      />
      <Notice offline={model.holidaysOffline} ro={ro} t={t} />
      {/* 正文挂着左右滑动（触摸、笔，跟手）；键盘、鼠标用上面的按钮和 ← → */}
      <div
        ref={pagerRef}
        className={[styles.pager, swipe.settling ? styles.settling : ''].filter(Boolean).join(' ')}
        style={swipe.offset !== 0 ? { transform: `translateX(${swipe.offset}px)` } : undefined}
        onPointerDown={swipe.onPointerDown}
        onPointerMove={swipe.onPointerMove}
        onPointerUp={swipe.onPointerUp}
        onPointerCancel={swipe.onPointerCancel}
        onClickCapture={swipe.onClickCapture}
        data-testid="cal-pager"
      >
        {model.view.mode === 'month' ? (
          model.cells ? (
            <>
              <MonthGrid
                cells={model.cells}
                weekStart={model.weekStart}
                t={t}
                label={t('cal.grid', { y: model.header.y, m: model.header.m })}
                selected={sel}
                onSelect={setPicked}
                lunarSay={model.lunar?.fullText}
                fold={{ row: fold.row, p, shiftY: fold.geo.top, collapsed: fold.byWeek }}
                gridRef={fold.gridRef}
                gridId={GRID_ID}
              />
              <MonthLegend t={t} country={t(holShortKey(holChoice), {})} fade={1 - p} />
            </>
          ) : null
        ) : (
          <WeekView
            start={model.view.start}
            items={model.items}
            tz={model.tz}
            today={model.today}
            nowMin={model.nowMin}
            holidays={model.holidays}
            dueMins={model.dueMins}
            lunarOf={lunarShort}
            wide={model.wide}
            selected={sel}
            onSelect={setPicked}
            onOpen={ro.open}
            isRo={ro.g.isRo}
            t={t}
            label={t('cal.weekGrid', { from: t('cal.a11y.date', { m: Number(model.view.start.slice(5, 7)), d: Number(model.view.start.slice(8)) }) })}
          />
        )}
      </div>
      <div className={styles.dayWrap} ref={fold.dayRef} style={fold.dayStyle}>
        {fold.active ? <FoldHandle t={t} collapsed={fold.collapsed} controls={GRID_ID} drag={fold.drag} /> : null}
        {sel ? (
          <DayList
            date={sel}
            items={model.items}
            tz={model.tz}
            dueMins={model.dueMins}
            t={t}
            lunarText={model.lunar?.fullText(sel) ? t('cal.a11y.lunar', { text: model.lunar.fullText(sel) ?? '' }) : undefined}
            onOpen={ro.open} isRo={ro.g.isRo}
          />
        ) : null}
      </div>
    </main>
  );
}
