// 今天页的一行：日程行、待办行，和它们用到的几个按需下载的部件（只读标记和方框、未同步小标记、子任务卡片、左滑删除）
// • 为什么单独成组件：行多时勾一条有七八次重画，不拆开就整页连同动画组件都重画、每行都量一遍位置。
//   日程行是 memo 的（参数都是这一行自己的值和页面给的稳定函数）；待办行这一层只把页面的参数整理成稳定的 onOpen、main、meta、wrap，
//   交给 kit TodoRow（memo，比较见 TodoRow.tsx 的 same），别的行变了它不重画
// • 量位置：外层列表给了 layoutKey（TodayPage 的 lk，motion/layout-key.ts），这些行只在列表数据变了、进出场时才量
// • 页面给的 onOpen、onRemove 必须从头到尾是同一个函数（TodayPage 经 kit/hooks/useLive.ts 给，调的是最新的那一份）
import { lazy, memo, useCallback, useMemo, type ReactNode } from 'react';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import list from '../../../kit/components/List.module.css';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { CheckCircle } from '../../../kit/components/CheckCircle.tsx';
import { Later } from '../../../kit/components/QuietBoundary.tsx';
import type { ReadonlyPartProps } from '../../../kit/components/ReadonlyMark.tsx';
import { TodoRow, withStage } from '../../../kit/components/TodoRow.tsx';
import type { SubsPartProps, TodoRowParts, TodoRows } from '../../../kit/components/useTodoRows.ts';
import { AppearItem } from '../../../motion/components.ts';
import type TodaySwipe from './TodaySwipe.tsx';
import type { TodaySwipeProps } from './TodaySwipe.tsx';
import { eventSpanText, zoneName, type useTodayT } from '../hooks/useTodayT.ts';
import type { useToday } from '../hooks/useToday.ts';
import type { useSpanT } from '../../../kit/hooks/useSpanT.ts';
import { UnsyncedRemindMark } from '../../reminders/index.ts';
import { InlineSubtasks } from '../../todos/index.ts';
import type { TodaySel } from './TodayDesk.tsx';
import type { TodayRoProps } from './TodayToasts.tsx';
import styles from './TodayPage.module.css';

type TodayT = ReturnType<typeof useTodayT>;
// ui 不直接引 data（架构）：行的类型从 hooks 取
type EventOcc = Parameters<typeof eventSpanText>[0];
type TodoOcc = ReturnType<typeof useToday>['todos'][number];

// 页底提示条、顶部重复事项横幅、只读行的行尾标记和打勾圆圈：同一个按需下载的文件（TodayToasts.tsx），按 part 画哪一块。
// 懒加载写在今天页的块里、不写在功能入口 ../index.ts：写在入口时 import() 由主包发起，主包的预加载表只给首屏名单列 JS
//（vite.config.ts 的 preloadDeps），这一块的依赖要三层往返一层层下，机器忙时横幅 5 秒出不来（e2e b2-readonly-rows 会挂）。
// 写在这里由今天页的块发起，预加载表照常列它的 JS，一层并发下完
const TodayRo = lazy(() => import('./TodayToasts.tsx'));

/** 分包下不来时那一块不画（kit Later），不把整页换成出错页 */
export function Ro(p: TodayRoProps) {
  return (
    <Later name="today-ro">
      <TodayRo {...p} />
    </Later>
  );
}

/** 待办的子任务卡片（就地展开、勾选；kit TodoRow 的部件）：首屏画完以后才挂、才下载那一包（不算进首屏），没有子任务、分包下不来时不画 */
function Subs(p: SubsPartProps) {
  return (
    <Later name="todo-subs" afterPaint>
      <InlineSubtasks {...p} />
    </Later>
  );
}

/** 待办行的左滑删除：Impl 是首屏画完、页里没焦点时才交出的 TodaySwipe（index.ts 的 loadTodaySwipe，useSwapWhenSafe）；
 *  没交出、分包下不来时照原样画一行（同 kit DelSwipe 的 .swp 外框和测试 id，滑不开，点行进编辑页照旧能删） */
function SwipeDel({ Impl, ...p }: TodaySwipeProps & { Impl: typeof TodaySwipe | undefined }) {
  return Impl ? <Impl {...p} /> : <div className={list.swp} data-testid={`today-swipe-${p.id}`}>{p.children}</div>;
}

/** 行尾“未同步”小标记（放进 .unsynced 那一格；没有时那一格是空的，CSS 里 :empty 不画）。
 *  首屏画完以后才挂、才下载那一包（同 Subs；不算进首屏预算） */
function RowMark({ table = 'todos', id }: { table?: 'events' | 'todos'; id: string }) {
  return (
    <Later name="unsynced-mark" afterPaint>
      <UnsyncedRemindMark table={table} id={id} />
    </Later>
  );
}

/** 只读行的标记和方框（kit TodoRow 的 parts.Ro）：按需下载（只读词典不进首屏）；方框下载完以前先画普通的，标记先不画 */
function RoPart(p: ReadonlyPartProps) {
  if (p.part === 'mark') return <Ro {...p} />;
  const { part: _, ...c } = p;
  return (
    <Later name="today-ro" fallback={<CheckCircle {...c} />}>
      <TodayRo {...p} />
    </Later>
  );
}

/** kit TodoRow 的三个部件：子任务卡片、行尾未同步小标记（都首屏画完才挂）、只读标记和方框（按需下载） */
export const PARTS: TodoRowParts = { Subs, Mark: RowMark, Ro: RoPart };

export interface TodayEventRowProps {
  o: EventOcc;
  day: Parameters<typeof eventSpanText>[1];
  tz: Parameters<typeof eventSpanText>[2];
  ro: boolean;
  /** 电脑版抽屉里开着的就是这一条 */
  current: boolean;
  onOpen(s: TodaySel): void;
  t: TodayT;
  spanT: ReturnType<typeof useSpanT>;
  locale: Locale;
}

/**
 * 日程行：跨天的日程前几天开始的行首写“持续”/“至 18:00”，没到最后一天的标题下面写“至 11月20日 18:00”，跨天的全天日程写“第 2/3 天”（同日清单）；
 * 换了时区的加注“14:00（韩国时间 15:00）”
 */
export const TodayEventRow = memo(function TodayEventRow({ o, day, tz, ro, current, onOpen, t, spanT, locale }: TodayEventRowProps) {
  const s = eventSpanText(o, day, tz);
  const lead = s.lead !== 'start' ? spanT(s.lead) : (o.time ?? '');
  const meta = s.meta === null ? null : spanT(s.meta);
  return (
    <AppearItem className={list.row} data-readonly={ro ? '' : undefined} data-testid={`today-event-${o.id}`}>
      <span className={list.lead}>{lead}</span>
      <button type="button" className={list.main} onClick={() => onOpen({ kind: 'event', id: o.id })} data-open={o.id} aria-current={current ? 'true' : undefined}>
        <span className={list.text}>
          <span className={list.title}>{o.title}</span>
          {meta !== null ? <span className={list.meta} data-testid={`today-span-${o.id}`}>{meta}</span> : null}
          {o.origin ? <span className={list.meta}>{t('list.origin', { zone: zoneName(o.origin.tz, locale), t: o.origin.time })}</span> : null}
        </span>
        {ro ? <Ro part="mark" testId={`today-ro-${o.id}`} /> : null}
        <span className={list.unsynced}>
          <RowMark table="events" id={o.id} />
        </span>
      </button>
    </AppearItem>
  );
});

export interface TodayTodoRowProps {
  r: TodoRows;
  td: TodoOcc;
  progress: Readonly<{ done: number; total: number }> | undefined;
  current: boolean;
  /** “没赶上”里的：副行写逾期几天 / 几点过的，红字；不能左滑；行尾出“推迟”。不给是“今天的安排”里的 */
  late?: { days: number } | undefined;
  /** 左滑的实现（首屏画完、安全时机才交出） */
  swipe: typeof TodaySwipe | undefined;
  onOpen(s: TodaySel): void;
  onRemove(id: string): unknown;
  t: TodayT;
}

/** 一条待办行（kit TodoRow）：两张列表只差副行和左滑；点标题同日程行（只读拦下，电脑版开抽屉）；data-open、aria-current 给抽屉认行 */
export function TodayTodoRow({ r, td, progress, current, late, swipe, onOpen, onRemove, t }: TodayTodoRowProps) {
  const id = td.id;
  const days = late?.days;
  const ro = r.a.isRo(id);
  const open = useCallback(() => onOpen({ kind: 'todo', id }), [onOpen, id]);
  const main = useMemo(() => ({ kind: 'todo', open: id, current, testId: `today-open-${id}` }), [id, current]);
  const meta = useCallback(
    (stage: ReactNode) =>
      days === undefined ? (
        <span className={list.meta}>{withStage(stage, td.dueTime ? <NumIn text={t('list.due', { t: td.dueTime })} num={td.dueTime} /> : t('list.dueDay', {}))}</span>
      ) : (
        <span className={`${list.meta} ${styles.lateTag}`}>
          {withStage(
            stage,
            days > 0 ? <NumIn text={t('late.days', { n: days })} num={String(days)} /> : <NumIn text={t('late.passed', { t: td.dueTime ?? '' })} num={td.dueTime ?? ''} />,
          )}
        </span>
      ),
    [days, td.dueTime, t],
  );
  // 左滑删除（和待办页同一份 kit DelSwipe）：只读行不能滑；“没赶上”里不滑
  const wrap = useMemo(
    () =>
      days !== undefined
        ? undefined
        : (face: ReactNode) => (
            <SwipeDel Impl={swipe} id={id} ro={ro} label={t('list.delete', {})} onDel={() => void onRemove(id)}>
              {face}
            </SwipeDel>
          ),
    [days, swipe, ro, t, onRemove, id],
  );
  // “没赶上”都是过期没做完的（today-model 按 isLate 挑）：行尾出“推迟”、不出 H / M / L
  return <TodoRow r={r} todo={td} progress={progress} tid="today" onOpen={open} main={main} meta={meta} wrap={wrap} late={days !== undefined} />;
}
