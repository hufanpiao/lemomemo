// 今天页（B2 FA-2；定稿线框 s1、皮肤视觉稿“现在”卡方案 K、R-118、R-131、R-133、R-134、R-136）
// 从上到下：日期一行 →“现在”卡（四种状态）→ 没赶上（逾期待办）→ 今天的安排（日程和今天截止的待办）
// • 字重：只有页顶日期、“现在”卡进行中那一件的标题加粗；普通日程和待办标题 400（R-134、R-136，TC-B2-06）
// • 固定时刻的日程换算成当前时区；和记录时的时区不同时加注“14:00（韩国时间 15:00）”（4.6）；全天不换算
// • 点一行进编辑页；打勾就保存；删除后出撤销条（8 秒）；写不进去时出提示条，只读行提示“要新版本才能修改”
// • 动效（17.1，B2 FA-5；设计审查 M1～M3 返工 11-04）：打勾时圆圈在原地填满（kit CheckCircle），列表先不动（useHoldView 留住
//   按下之前的两张列表 --dur-ui）；然后这一行淡出、同时下面的行收上来，挪到的地方等让开了再淡入（motion 的 AppearList）；第一次画不播
// • 提醒的几块（REMIND-wiring；reminders 的 index.ts 懒加载；外面包 kit 的 QuietBoundary，分包下不来时那一块不画、不把整页换成出错页）：
//   ① 日期下面、“现在”卡上面：“错过 N 条提醒 · 查看 ›”（MissedReminders，线框 MISSROW）。等提醒引擎 armed（读完本机“响过”的记录、
//      算出第一份快照，kit 的 armedSince）才挂，分包也那时才下载、不进首屏（REMIND-shown-persist 方案修订 1 P2，主持人 11-05 定，改掉 J1 的“一打开就挂”）：
//      - 只算这次打开（armedSince）之前到点的和响过的，打开后刚到点的那条留给横幅，
//        不会先算进“错过 1 条”再跳走（REMIND-missed-flash）
//      - 引擎出错了（kit 的 remindDown，RemindHost 出错或分包下不来，这次打开不再重试）：不按打开时刻筛、照旧全算——
//        引擎坏了提醒不响，这一行是页面上唯一的信号（今天页待办 代码审查 M1）
//      - 分包、本机数据晚到（页面已经画出来以后才有这一行），或者服务器回来发现别处已经处理、这一行要收起：外面的 GrowIn 让高度过渡，
//        手指按着时先不动、滚过的页面补滚动位置（见 GrowIn.tsx）
//   ② 再下面：“未同步，提醒可能不响”（UnsyncedRemindHint），浅灰条同日历页（R-346）；外面是常驻的 role="status" 空容器，内容后填进去读屏才播报，
//      没内容时不占位（.notice 里没有 p）；麦克风被拒时同一个容器里再出一行（MicDeniedNote，B3 S23、Q-22）
//   ③ 每行行尾“未同步”小标记（UnsyncedRemindMark，在行按钮里、标题和副行的右边；没有时那一格不画）
//   ②③ 只看本机待同步队列、和引擎无关，同日历页直接挂，不等引擎（M1）
// • 只读行（FA-2 只读行界面；架构 0.27 第 1 点）：行尾“要新版本”标记、圆圈变淡；点这一行、打勾、删除统一拦下，
//   出“这条要新版本才能修改 · 更新”提示条（kit 的 useReadonlyGuard、ReadonlyToast）。
// • 待办子任务（R-350 方案 5.2，Q5）：待办行副行下面一行“已勾/总数”和细进度条，不摊开、不在这里勾（点进编辑页勾）；todos 的 TodaySubtasks 按需下载。顶部（日期下面）有带重复的只读行时出
//   “有 N 条重复事项要新版本才能完整显示 · 更新”（kit 的 RepeatBanner；4.1.0 的重复事项 4.0.x 只显示第一次）
// • 纪念日一行（B5 S14；线框 s1 ANNLINE）：提示块下面、“现在”卡上面，7 天内最近的一个“3 天后 김지민 生日”；用服务器算好的 next_date（hooks/useAnnivSoon.ts → data/anniv-soon.ts），
//   开关开着、有纪念日才下载 AnnivLine（useAnnivAny；挑哪一条在 AnnivLine 里算，不进首屏；分包下不来那一行不画）
// • 液态玻璃底栏、“＋”、时间河、提醒按钮条不在这一段（FA-4、FA-7）
// • 电脑版（B6，5.9b；有侧栏的宽度）：交给按需下载的 TodayDesk 排成可拖动的块；提示、“现在”卡、没赶上、今天的安排合成一块时间河
//   （块标题“今天的安排”，里面不再画这个小标题；B6 返工 11-14）。页顶日期行固定不动：日期后面加农历（TodayDesk 的 Lunar），下面是纪念日胶囊（同手机的 AnnivLine）。
//   点一行不换页，在详情抽屉里编辑（选中哪一条记在这里的 sel；窗口变窄、电脑版卸下时清掉）。电脑版分包没到、下不来时照手机的排法画
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { navigate } from '../../../app/router.ts';
import { CheckCircle, type CheckCircleProps } from '../../../kit/components/CheckCircle.tsx';
import list from '../../../kit/components/List.module.css';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { useListActions } from '../../../kit/hooks/useListActions.ts';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { useRemindQueue } from '../../../kit/state/remind-queue.ts';
import { opensKeyboard } from '../../../platform/env.ts';
import { afterAppPainted, isAppPainted } from '../../../platform/root-paint.ts';
import { AppearItem, AppearList, Pressable, useHoldView, useSwapWhenSafe } from '../../../motion/components.ts';
import { useLocale, useTodayT, zoneName } from '../hooks/useTodayT.ts';
import { useToday } from '../hooks/useToday.ts';
import { MissedReminders, UnsyncedRemindHint, UnsyncedRemindMark } from '../../reminders/index.ts';
import { loadTodayDesk, TodayRo } from '../index.ts';
import { useAnnivAny } from '../hooks/useAnnivAny.ts';
import { TodaySubtasks } from '../../todos/index.ts';
import { GrowIn } from './GrowIn.tsx';
import MicDeniedNote from './MicDeniedNote.tsx';
import { NowCard } from './NowCard.tsx';
import styles from './TodayPage.module.css';
import type { TodaySel } from './TodayDesk.tsx';
import type { TodayRoProps } from './TodayToasts.tsx';

// 页底提示条、顶部重复事项横幅、只读行的行尾标记和打勾圆圈：同一个按需下载的文件，按 part 画哪一块；
// 懒加载写在功能入口 ../index.ts（预载名单和主包共用，首屏预算 150 KB，FA-2 返工）

/** 分包下不来时那一块不画（QuietBoundary），不把整页换成出错页 */
function Ro(p: TodayRoProps) {
  return (
    <QuietBoundary name="today-ro">
      <Suspense fallback={p.part === 'check' ? <CheckCircle {...p} /> : p.part === 'del' ? <RoDel {...p} /> : null}>
        <TodayRo {...p} />
      </Suspense>
    </QuietBoundary>
  );
}

/** 打勾圆圈：只读行用按需下载的那个（读屏名字后接“要更新到新版本才能修改”，词条不进首屏），下载完以前先画普通的。
 *  放在行首那一格（kit 的 List.module.css .lead，和日程行的时刻同宽，标题起点一致，B2-UI-a U4-2） */
function Check(p: CheckCircleProps) {
  return <span className={list.lead}>{p.readOnly ? <Ro part="check" {...p} /> : <CheckCircle {...p} />}</span>;
}

/** 只读行的 ×：变淡、aria-disabled，label 是最终的读屏名字（按需下载的那份接上“要更新到新版本才能修改”，下载完以前先用这份） */
export function RoDel(p: { label: string; onClick(): void; testId: string }) {
  return (
    <Pressable className={list.trail} aria-label={p.label} aria-disabled="true" onClick={p.onClick} data-testid={p.testId} data-no-proxy="">
      ×
    </Pressable>
  );
}

/** 待办的子任务进度“2/4 ▬▬▭▭”（R-350 方案 5.2，只看不摊开）：首屏画完以后才挂、才下载那一包（不算进首屏），没有子任务、分包下不来时不画 */
function Subs({ id }: { id: string }) {
  const [on, setOn] = useState(isAppPainted);
  useEffect(() => {
    if (on) return;
    let live = true;
    afterAppPainted(() => live && setOn(true));
    return () => {
      live = false;
    };
  }, [on]);
  if (!on) return null;
  return (
    <QuietBoundary name="todo-subs">
      <Suspense fallback={null}>
        <TodaySubtasks id={id} />
      </Suspense>
    </QuietBoundary>
  );
}

/** 行尾“未同步”小标记：没有时那一格是空的，CSS 里 :empty 不画 */
function RowMark({ table, id }: { table: 'events' | 'todos'; id: string }) {
  return (
    <span className={list.unsynced}>
      <QuietBoundary name="unsynced-mark">
        <Suspense fallback={null}>
          <UnsyncedRemindMark table={table} id={id} />
        </Suspense>
      </QuietBoundary>
    </span>
  );
}

/** 纪念日一行（B5）：有纪念日、开关开着才下载 */
const AnnivLine = lazy(() => import('./AnnivLine.tsx'));

export default function TodayPage() {
  const t = useTodayT();
  const locale = useLocale();
  const d = useToday();
  /** 引擎 armed 或出错（含 App 的看门狗：迟迟不 armed 也算出错）才挂“错过的提醒”（REMIND-shown-persist 修订 1 P2） */
  const missedOn = useRemindQueue((s) => s.armedSince !== null || s.remindDown);
  // 打勾先留住按下之前的两张列表 --dur-ui（圆圈在原地填满），再换成新的（没赶上 → 今天的安排）；只读行统一拦下，
  // 撤销条、出错条也在 g 里（kit 的 useListActions）
  const hv = useHoldView({ late: d.late, events: d.events, todos: d.todos });
  const v = hv.view;
  const a = useListActions('todos', { toggle: d.toggleDone, remove: (id, deleted) => d.remove('todos', id, deleted) }, hv);
  const { g, tick, shown, del } = a;
  const anniv = useAnnivAny();
  // 有侧栏的宽度（电脑版）：面板布局（5.9b）。面板那一块（DeskLayout、dnd-kit、zod 约 49 KB）首屏画完才下载（首屏预算 150 KB 按 1280 宽也量），
  // 下好了、这一页里没有焦点和按住的指针时才换上（motion 的 useSwapWhenSafe）；在那之前照原来的一列画
  const page = useRef<HTMLElement>(null);
  const loaded = useSwapWhenSafe(useMedia(MQ_SIDEBAR), page, loadTodayDesk, afterAppPainted, opensKeyboard);
  // 电脑版那一块画出错（QuietBoundary 退回手机排法）以后这一页按没换上算：点行进编辑页、不画农历（抽屉也在出错的那一块里，独立评审第 5 条）
  const [deskFailed, setDeskFailed] = useState(false);
  const failDesk = useCallback(() => setDeskFailed(true), []);
  const Desk = deskFailed ? null : loaded;
  /** 电脑版详情抽屉里开着的那一条 */
  const [sel, setSel] = useState<TodaySel | null>(null);
  const closeSel = useCallback(() => setSel(null), []);
  useEffect(() => {
    if (!Desk) setSel(null);
  }, [Desk]);
  const open = (kind: 'event' | 'todo', id: string) => (g.isRo(kind, id) ? g.block() : Desk ? setSel({ kind, id }) : void navigate(kind, id));
  /** 抽屉里开着的那一条：行按钮 aria-current（行按钮上的 data-open 给抽屉关上时找回焦点用） */
  const cur = (id: string) => (sel?.id === id ? ('true' as const) : undefined);

  const lateItem = v.late.length ? (
    <AppearItem as="section" key="late" className={`${list.panel} ${styles.late}`} aria-labelledby="today-late" data-testid="today-late">
      <h2 id="today-late" className={styles.h2}>{t('late.title', {})}</h2>
      <AppearList as="ul" className={list.list}>
        {v.late.map(({ todo, days }) => (
          <AppearItem key={todo.id} className={list.row} data-readonly={g.isRo('todo', todo.id) ? '' : undefined}>
            <Check
              checked={shown(todo.id, false)}
              label={shown(todo.id, false) ? t('list.undoDone', {}) : t('list.done', {})}
              onChange={(v) => tick(todo.id, v)}
              testId={`today-done-${todo.id}`}
              readOnly={g.isRo('todo', todo.id)}
            />
            <button type="button" className={list.main} onClick={() => open('todo', todo.id)} data-open={todo.id} aria-current={cur(todo.id)}>
              <span className={list.text}>
                <span className={list.title}>{todo.title}</span>
                <span className={`${list.meta} ${styles.lateTag}`}>{days > 0 ? t('late.days', { n: days }) : t('late.passed', { t: todo.dueTime ?? '' })}</span>
                <Subs id={todo.id} />
              </span>
              {g.isRo('todo', todo.id) ? <Ro part="mark" testId={`today-ro-${todo.id}`} /> : null}
              <RowMark table="todos" id={todo.id} />
            </button>
          </AppearItem>
        ))}
      </AppearList>
    </AppearItem>
  ) : null;
  const listItem = (titled: boolean) => (
    <AppearItem as="section" key="list" aria-labelledby={titled ? 'today-list' : undefined} data-testid="today-list">
      {titled ? <h2 id="today-list" className={styles.h2}>{t('list.title', {})}</h2> : null}
      {v.events.length === 0 && v.todos.length === 0 ? <p className={list.empty}>{t('list.empty', {})}</p> : null}
      <AppearList as="ul" className={list.list}>
        {v.events.map((o) => (
          <AppearItem key={`e:${o.id}`} className={list.row} data-readonly={g.isRo('event', o.id) ? '' : undefined} data-testid={`today-event-${o.id}`}>
            <span className={list.lead}>{o.time ?? t('list.allDay', {})}</span>
            <button type="button" className={list.main} onClick={() => open('event', o.id)} data-open={o.id} aria-current={cur(o.id)}>
              <span className={list.text}>
                <span className={list.title}>{o.title}</span>
                {o.origin ? <span className={list.meta}>{t('list.origin', { zone: zoneName(o.origin.tz, locale), t: o.origin.time })}</span> : null}
              </span>
              {g.isRo('event', o.id) ? <Ro part="mark" testId={`today-ro-${o.id}`} /> : null}
              <RowMark table="events" id={o.id} />
            </button>
            {/* 日程行没有 ×：补一个和 × 一样宽的空格子，“未同步”标记和待办行落在同一列（设计复审 今天页待办 M2）。
                只有这里日程、待办混排；不能点、不进 Tab、读屏不读 */}
            <span className={styles.delGap} aria-hidden="true" data-testid={`today-del-gap-${o.id}`} />
          </AppearItem>
        ))}
        {v.todos.map((td) => (
          <AppearItem
            key={`t:${td.id}`}
            className={list.row}
            data-testid={`today-todo-${td.id}`}
            data-done={td.done ? '' : undefined}
            data-readonly={g.isRo('todo', td.id) ? '' : undefined}
          >
            <Check
              readOnly={g.isRo('todo', td.id)}
              checked={shown(td.id, td.done)}
              label={shown(td.id, td.done) ? t('list.undoDone', {}) : t('list.done', {})}
              onChange={(v) => tick(td.id, v)}
              testId={`today-done-${td.id}`}
            />
            <button type="button" className={list.main} onClick={() => open('todo', td.id)} data-open={td.id} aria-current={cur(td.id)}>
              <span className={list.text}>
                <span className={list.title}>{td.title}</span>
                <span className={list.meta}>{td.dueTime ? t('list.due', { t: td.dueTime }) : t('list.dueDay', {})}</span>
                <Subs id={td.id} />
              </span>
              {g.isRo('todo', td.id) ? <Ro part="mark" testId={`today-ro-${td.id}`} /> : null}
              <RowMark table="todos" id={td.id} />
            </button>
            {/* 只读行的 × 和打勾圆圈一样（FA-2 视觉验收第二轮第 1 条、代码复查二）：变淡、aria-disabled、读屏名字后接“要更新到新版本才能修改”；
                点了照样由 del 里的 useReadonlyGuard 拦下出提示条、不写 */}
            {g.isRo('todo', td.id) ? (
              <Ro part="del" label={t('list.delete', {})} onClick={() => void del(td.id)} testId={`today-del-${td.id}`} />
            ) : (
              <Pressable className={list.trail} aria-label={t('list.delete', {})} onClick={() => void del(td.id)} data-testid={`today-del-${td.id}`} data-no-proxy="">
                ×
              </Pressable>
            )}
          </AppearItem>
        ))}
      </AppearList>
    </AppearItem>
  );
  const top = <TopNotices missedOn={missedOn} repeat={g.any ? <Ro part="repeat" onUpdate={g.update} /> : null} />;
  const nowCard = <NowCard card={d.card} now={d.now} tz={d.tz} today={d.today} tomorrowFirst={d.tomorrowFirst} />;
  const annivLine = anniv ? (
    <QuietBoundary name="anniv-line">
      <Suspense fallback={null}>
        <AnnivLine today={d.today} />
      </Suspense>
    </QuietBoundary>
  ) : null;
  const phone = (
    <>
      {top}
      {annivLine}
      {nowCard}
      {/* 两块放在同一个 AppearList 里：没赶上最后一条离开时整组跟着淡出（不然 section 一卸载，那一行的退出动画就被截断），
          下面“今天的安排”用 layout 平移收上来，不跳 */}
      <AppearList as="div">
        {lateItem}
        {listItem(true)}
      </AppearList>
    </>
  );

  return (
    <main ref={page} className={styles.page} data-feature="today" data-testid="today">
      <div className={styles.head}>
        {/* tabIndex=-1：弹层关上、打开按钮没了时焦点的退路（错过的提醒“全部知道了”以后，Dialog L-2），不进 Tab 顺序 */}
        <h1 className={styles.date} tabIndex={-1}>
          {fmtDay(d.today, locale, 'monthDayWeek')}
          {Desk ? (
            <QuietBoundary name="today-lunar">
              <Desk.Lunar today={d.today} />
            </QuietBoundary>
          ) : null}
        </h1>
        {/* 设置入口（负责人 11-05 ①；接手清单 NAV-today-no-settings）：右上角头像，名字第一个字；没有名字时是一个人形。
            点了交给路由压一条带本次编号的历史（R-372）：设置里“‹ 今天”和左滑都退回这一条，不再叠一条今天；新标签页打开照常 */}
        <MeLink testId="today-settings" />
      </div>
      {/* 电脑版面板没换上、画出错时照手机的排法画（一列） */}
      {Desk ? (
        <QuietBoundary name="today-desk" fallback={phone} onFail={failDesk}>
          {annivLine}
          <Desk.default
            today={d.today}
            river={
              <>
                {top}
                {nowCard}
                <AppearList as="div">
                  {lateItem}
                  {listItem(false)}
                </AppearList>
              </>
            }
            sel={sel}
            onClose={closeSel}
          />
        </QuietBoundary>
      ) : (
        phone
      )}

      {/* 页底提示条（撤销条、出错条、只读提示条）：真有一条时才下载（首屏预算，FA-2 返工）；分包下不来时不画、不把整页换成出错页 */}
      {g.toast !== null || g.toastAt !== null ? (
        <Ro part="toasts" g={g} t={t} onUndo={a.undo} />
      ) : null}
    </main>
  );
}

/** 页顶的几条提示：错过的提醒（引擎 armed 或出错以后才挂，晚到时高度展开，GrowIn）、只读行横幅、未同步和麦克风提示 */
function TopNotices({ missedOn, repeat }: { missedOn: boolean; repeat: ReactNode }) {
  return (
    <>
      {/* 外面包一层：有“错过 N 条提醒”那一行时下面留 8px（和日历页 .unsynced 同一个值；设计复审 今天页待办 M1），没有时不占位；没有登录会话时不挂 */}
      {missedOn ? (
        <GrowIn testId="today-missed">
          <QuietBoundary name="missed">
            <Suspense fallback={null}>
              <MissedReminders />
            </Suspense>
          </QuietBoundary>
        </GrowIn>
      ) : null}
      {/* 有只读行才下载横幅（条数在横幅里数，N 为 0 不画） */}
      {repeat}
      <div className={styles.notice} role="status" data-testid="today-notice">
        <QuietBoundary name="unsynced-hint">
          <Suspense fallback={null}>
            <UnsyncedRemindHint />
          </Suspense>
        </QuietBoundary>
        <QuietBoundary name="mic-denied">
          <MicDeniedNote />
        </QuietBoundary>
      </div>
    </>
  );
}
