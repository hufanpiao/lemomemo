// 今天页。从上到下：日期一行 →“现在”卡（四种状态）→ 没赶上（逾期待办）→ 今天的安排（日程和今天截止的待办）
// • 字重：只有页顶日期、“现在”卡进行中那一件的标题加粗；普通日程和待办标题 400
// • 固定时刻的日程换算成当前时区；和记录时的时区不同时加注“14:00（韩国时间 15:00）”；全天不换算
// • 点一行进编辑页；打勾就保存；删除后出撤销条（8 秒）；写不进去时出提示条，只读行提示“要新版本才能修改”
// • 删除：待办行左滑露出“删除”，一口气拉过大半行直接删（kit 的 SwipeRow，full）；只读行滑不开；键盘、读屏进编辑页（电脑版是详情抽屉）删
// • 已过去：结束了的日程、做完的待办收成“已过去 N 件：… ›”一行，点了展开（data/today-model.ts 的 splitPast）；样式同待办页“已完成 N ›”
// • 待办行都是 kit TodoRow，和待办页、日历日清单同一个；动作和完成时序也同一份（kit/components/useTodoRows.ts、useDoneFlow.ts）：
//   打勾 → 放大、炸开、划线 → 留在原位停到 --dur-done-pop + --dur-done-rest（useLinger 留住，today-model 按 linger 照没完成排）
//   → 这一行收起、页底升起“已完成 · 撤销”→ 归进“已过去”；改回未完成时先留住按下之前的两张列表 --dur-ui 再挪回去。日程行用 AppearItem，第一次画不播
// • 提醒的几块（reminders 的 index.ts 懒加载，外面包 kit 的 Later，分包下不来时那一块不画、不把整页换成出错页）：
//   ① 日期下面、“现在”卡上面：“错过 N 条提醒 · 查看 ›”（MissedReminders）。等提醒引擎 armed（kit 的 armedSince）才挂、才下载，不进首屏：
//      - 只算 armedSince 之前到点的和响过的，打开后刚到点的那条留给横幅，不会先算进“错过 1 条”再跳走
//      - 引擎出错了（kit 的 remindDown）：不按打开时刻筛、照旧全算——引擎坏了提醒不响，这一行是页面上唯一的信号
//      - 晚到或要收起时外面的 GrowIn 让高度过渡，手指按着时先不动、滚过的页面补滚动位置（见 GrowIn.tsx）
//   ② 再下面：“未同步，提醒可能不响”（UnsyncedRemindHint）；外面是常驻的 role="status" 空容器，内容后填进去读屏才播报，
//      没内容时不占位（.notice 里没有 p）；麦克风被拒时同一个容器里再出一行（MicDeniedNote）
//   ③ 每行行尾“未同步”小标记（UnsyncedRemindMark，在行按钮里；没有时那一格不画）
//   ②③ 只看本机待同步队列，不等引擎；但等首屏画完（Later 的 afterPaint）才挂、才下载，不算进首屏预算
// • 只读行：行尾“要新版本”标记、圆圈变淡；点行、打勾统一拦下（左滑滑不开），出“这条要新版本才能修改 · 更新”提示条（kit 的 useReadonlyGuard、ReadonlyToast）
// • 待办子任务：有子任务的待办行下面一行进度条和“展开 / 收起”，点了就地摊开勾选清单（todos 的 InlineSubtasks，展开状态不存，默认收起）；
//   勾最后一项自动完成主待办，和打勾同一条路，撤销时刚勾的那项一起撤回。卡片那一包首屏画完才下载；方框进度和副行计数首屏就画（shared/logic/todo-row.ts 的 subProgress）
// • 待办的先后：按 H → M → L、同档按截止时刻、再按创建时间（和待办页同一个 compareTodos）；日程按时刻，日程在前、待办在后，不混成一条时间线。
//   有带重复的只读行时顶部出“有 N 条重复事项要新版本才能完整显示 · 更新”（kit 的 RepeatBanner）
// • 天气胶囊（weather 功能的 WeatherChip，首屏画完才下载）：日期下面、提示块上面；没地方可看时日期那一行头像左边出“设置城市看天气”
// • 纪念日一行：提示块下面、“现在”卡上面，7 天内最近的一个；用服务器算好的 next_date（hooks/useAnnivUpcoming.ts → data/anniv-soon.ts），
//   开关开着、有纪念日才下载 AnnivLine（useAnnivAny；不进首屏；分包下不来那一行不画）
// • 没日程时的组合区（TodayFun.tsx 按需下载）：“今天的安排 0”下面换成“顺手做 + 今日小运 + 这周做完”
// • 液态玻璃底栏、“＋”、时间河、提醒按钮条不在这一段
// • 网页版宽屏（MQ_DESK_WIDE）：交给按需下载的 TodayDesk 排成固定的三行卡片，这里只递提示、“现在”卡、待办行、日程行；右边 AI 助手栏是 ai-chat 的 ChatHost 挂的。
//   点一行在详情抽屉里编辑（kit 的 useDrawerSel；窗口变窄、宽屏卸下或画出错时清掉）。宽屏分包没到、下不来时照手机的排法画
import { lazy, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { navigate } from '../../../app/router.ts';
import list from '../../../kit/components/List.module.css';
import refine from '../../../kit/components/Refine.module.css';
// 分组名只要 kit 的类名：直接引样式表，不引 Form.tsx（那份 JS 会进首屏）
import form from '../../../kit/components/Form.module.css';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { Later, QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { useLinger } from '../../../kit/components/useDoneFlow.ts';
import { useDrawerSel } from '../../../kit/hooks/useListActions.ts';
import { useLive } from '../../../kit/hooks/useLive.ts';
import { useTodoRows } from '../../../kit/components/useTodoRows.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { MQ_DESK_WIDE, useMedia } from '../../../kit/hooks/useMedia.ts';
import { useRemindQueue } from '../../../kit/state/remind-queue.ts';
import { opensKeyboard } from '../../../platform/env.ts';
import { afterAppPainted } from '../../../platform/root-paint.ts';
import { AppearItem, AppearList, useSwapWhenSafe } from '../../../motion/components.ts';
import { splitPast, useLocale, useTodayT } from '../hooks/useTodayT.ts';
import { useToday } from '../hooks/useToday.ts';
import { MissedReminders, UnsyncedRemindHint } from '../../reminders/index.ts';
import { loadTodayDesk, loadTodaySwipe, TodayWeather } from '../index.ts';
import { useAnnivAny } from '../hooks/useAnnivAny.ts';
import { GrowIn } from './GrowIn.tsx';
import MicDeniedNote from './MicDeniedNote.tsx';
import { NowCard } from './NowCard.tsx';
import styles from './TodayPage.module.css';
import type { TodaySel } from './TodayDesk.tsx';
import { PARTS, Ro, TodayEventRow, TodayTodoRow } from './TodayRows.tsx';
import { useSpanT } from '../../../kit/hooks/useSpanT.ts';

// 一行怎么画（日程行、待办行）和行用到的几个按需下载的部件在 ./TodayRows.tsx

/** 纪念日一行：有纪念日、开关开着才下载 */
const AnnivLine = lazy(() => import('./AnnivLine.tsx'));
/** 今天没日程时“今天的安排”下面的组合区：首屏画完才下载；下载中、下不来时照旧画“今天没有安排”一行 */
const TodayFun = lazy(() => import('./TodayFun.tsx'));
/** 天气胶囊（weather 功能，经 today/index.ts 的 TodayWeather 首屏画完才下载，weather 那一包不进首屏）：手机日期那一行只出“设置城市看天气”，日期下面只出有天气的胶囊；宽屏在 TodayDesk 页头 */
const wx = (slot: 'head' | 'below') => (
  <Later name="weather" afterPaint>
    <TodayWeather slot={slot} />
  </Later>
);
/** 分组名“没赶上”“今天的安排”的类：kit 的小字分组名 + 分组标题行（左名字右条数，和待办页同一份）+ 本页的“没赶上”红字覆盖 */
const GROUP_H2 = `${form.groupLabel} ${form.groupRow} ${styles.h2}`;

export default function TodayPage() {
  const t = useTodayT();
  const spanT = useSpanT();
  const locale = useLocale();
  // 刚勾完、还留在原位的待办（kit/components/useDoneFlow.ts）：两张列表按它们没完成时的位置留着，收起以后才归进“已过去”
  const lg = useLinger();
  const d = useToday(lg.ids);
  /** 引擎 armed 或出错（含 App 的看门狗：迟迟不 armed 也算出错）才挂“错过的提醒” */
  const missedOn = useRemindQueue((s) => s.armedSince !== null || s.remindDown);
  // 待办行的动作（待办页、日历日清单同一份，kit/components/useTodoRows.ts）：改回未完成时先留住按下之前的两张列表 --dur-ui（没赶上 → 今天的安排）；
  // 只读行统一拦下；撤销条、出错条在 r.a.g 里；打勾、勾完子任务自动完成的停留、收起、“已完成 · 撤销”在 r.flow；词条是 kit 自己的（useTodoRowWords）
  const r = useTodoRows({ late: d.late, events: d.events, todos: d.todos }, lg, d.writes, 'today', PARTS);
  const v = r.view;
  const { g, del } = r.a;
  const anniv = useAnnivAny();
  // 有侧栏的宽度（电脑版）：面板那一块首屏画完才下载（首屏预算按 1280 宽也量），
  // 下好了、这一页里没有焦点和按住的指针时才换上（motion 的 useSwapWhenSafe）；在那之前照一列画
  const page = useRef<HTMLElement>(null);
  const loaded = useSwapWhenSafe(useMedia(MQ_DESK_WIDE), page, loadTodayDesk, afterAppPainted, opensKeyboard);
  const swipe = useSwapWhenSafe(true, page, loadTodaySwipe, afterAppPainted, opensKeyboard);   // 待办行左滑，同一个守卫
  // 电脑版详情抽屉开着的那一条（kit 的 useDrawerSel）：电脑版那一块画出错（退回手机排法）以后按没换上算，
  // 点行进编辑页、不画农历（抽屉也在出错的那一块里）
  const ds = useDrawerSel<TodaySel>(!!loaded);
  const Desk = ds.on ? loaded : null;
  /** 点一行：只读的先拦下，宽屏开抽屉，不然进编辑页 */
  const open = (s: TodaySel) => (g.isRo(s.kind, s.id) ? g.block() : ds.open(s, () => void navigate(s.kind, s.id)));
  const remove = (id: string) => {
    ds.forget(id);
    return del(id);
  };
  // 行拿到的点行、删除从头到尾是同一个函数，调的是最新这一次渲染的 open、remove（行是 memo 的，别的行变了它不重画；kit hooks/useLive.ts）
  const act = useLive({ open, remove });
  const [pastOpen, setPastOpen] = useState(false);
  const todoRow = (td: (typeof v.todos)[number], key: string, late?: { days: number }) => (
    <TodayTodoRow
      key={key}
      r={r}
      td={td}
      progress={d.subs.get(td.id)}
      current={ds.sel?.id === td.id}
      late={late}
      swipe={swipe?.default}
      onOpen={act.open}
      onRemove={act.remove}
      t={t}
    />
  );

  const lateItem = v.late.length ? (
    <AppearItem as="section" key="late" className={styles.late} aria-labelledby="today-late" data-testid="today-late">
      {/* 分组名小字加字距、右边条数；逾期带“!”、红字（同待办页的过期组） */}
      <h2 id="today-late" className={GROUP_H2}>
        <span><span aria-hidden="true">! </span>{t('late.title', {})}</span>
        <span>{v.late.length}</span>
      </h2>
      <AppearList as="ul" className={`${list.list} ${list.roomy} ${list.late}`}>
        {/* “没赶上”都是过期没做完的（today-model 按 isLate 挑）：给了 late，行尾出“推迟”（./TodayRows.tsx） */}
        {v.late.map(({ todo, days }) => todoRow(todo, todo.id, { days }))}
      </AppearList>
    </AppearItem>
  ) : null;
  // 日程行、待办行：“今天的安排”里照常画，展开“已过去”时过去的那几行也用它（key 不变，打勾挪进挪出“已过去”时行走 AppearList 的离开、进场）
  const evRow = (o: (typeof v.events)[number], day: DateStr = d.today) => (
    <TodayEventRow
      key={`e:${o.id}`}
      o={o}
      day={day}
      tz={d.tz}
      ro={g.isRo('event', o.id)}
      current={ds.sel?.id === o.id}
      onOpen={act.open}
      t={t}
      spanT={spanT}
      locale={locale}
    />
  );
  const tdRow = (td: (typeof v.todos)[number]) => todoRow(td, `t:${td.id}`);
  // 已过去：点一下展开、再点收起（这次打开记着，不存）；展开时过去的那几行排在最前面，照原来的行画。
  // 变成 0 件时展开状态一起收回（画的时候就收，不多等一拍）
  const past = useMemo(() => splitPast(v.events, v.todos, d.now, lg.ids), [v.events, v.todos, d.now, lg.ids]);
  const pastN = past.pastEvents.length + past.pastTodos.length;
  if (!pastN && pastOpen) setPastOpen(false);
  const pastText = [...past.pastEvents.map((o) => `${o.time ?? ''} ${o.title}`), ...past.pastTodos.map((x) => `${x.title} ✓`)].join(' · ');
  // 两张列表什么时候量位置（motion/layout-key.ts）：下面这些会让行挪位置的东西换了才换一个新对象；
  // 只是方框亮了、划线、收起、撤销条这类行自己的状态变了不量
  const lk = useMemo(
    () => ({ late: v.late, events: v.events, todos: v.todos, past, pastOpen, subs: d.subs, card: d.card, now: d.now, missedOn, ro: g.any, anniv, Desk, locale }),
    [v.late, v.events, v.todos, past, pastOpen, d.subs, d.card, d.now, missedOn, g.any, anniv, Desk, locale],
  );
  const listItem = () => (
    <AppearItem as="section" key="list" aria-labelledby="today-list" data-testid="today-list">
      <h2 id="today-list" className={GROUP_H2}>
        <span>{t('list.title', {})}</span>
        <span>{v.events.length + v.todos.length}</span>
      </h2>
      {pastN ? (
        <button type="button" className={styles.past} aria-expanded={pastOpen} onClick={() => setPastOpen((x) => !x)} data-testid="today-past">
          <span className={styles.pastText}><NumIn text={t('list.past', { n: pastN, items: '' })} num={String(pastN)} />{pastText}</span>
          <span className={styles.chev} data-open={pastOpen ? '' : undefined} aria-hidden="true">›</span>
        </button>
      ) : null}
      <AppearList as="ul" className={`${list.list} ${list.roomy}`}>
        {pastOpen ? past.pastEvents.map((o) => evRow(o)) : null}
        {pastOpen ? past.pastTodos.map(tdRow) : null}
        {past.events.map((o) => evRow(o))}
        {past.todos.map(tdRow)}
      </AppearList>
      {/* 组合区：今天没有还没结束的日程、也没有还没做完的待办就出（勾完的不算），排在“已过去 N 件”下面。
          占位字“今天没有安排”只在今天真的一件都没有时给。“已过去”展开时上面多一张清单卡，隔开 12（同组合区卡片之间） */}
      {past.events.length === 0 && past.todos.length === 0 ? (
        <div className={pastOpen ? styles.funGap : undefined}>
          <Later name="today-fun" afterPaint fallback={pastN ? null : <p className={list.empty}>{t('list.empty', {})}</p>}>
            <TodayFun today={d.today} />
          </Later>
        </div>
      ) : null}
    </AppearItem>
  );
  const annivLine = anniv ? (
    <Later name="anniv-line">
      <AnnivLine today={d.today} />
    </Later>
  ) : null;
  // 提示、“现在”卡手机一列和宽屏卡片各用一次，同一份
  const notices = <TopNotices missedOn={missedOn} repeat={g.any ? <Ro part="repeat" onUpdate={g.update} /> : null} />;
  const now = <NowCard card={d.card} today={d.today} />;
  /** 手机的一列：提示、纪念日一行、“现在”卡、没赶上、今天的安排 */
  const column = () => (
    <>
      {notices}
      {annivLine}
      {now}
      {/* 两块放在同一个 AppearList 里：没赶上最后一条离开时整组跟着淡出（不然 section 一卸载，那一行的退出动画就被截断），
          下面“今天的安排”用 layout 平移收上来，不跳 */}
      <AppearList as="div" layoutKey={lk}>
        {lateItem}
        {listItem()}
      </AppearList>
    </>
  );
  /** tabIndex=-1：弹层关上、打开按钮没了时焦点的退路（错过的提醒“全部知道了”以后），不进 Tab 顺序 */
  const title = (cls: string) => (
    <h1 className={cls} tabIndex={-1}>
      {fmtDay(d.today, locale, 'monthDayWeek')}
    </h1>
  );
  const phone = (
    <>
      <div className={styles.head}>
        {title(`${refine.title} ${styles.date}`)}
        {wx('head')}
        {/* 设置入口：右上角头像，名字第一个字；没有名字时是一个人形。
            点了交给路由，今天压进返回栈：设置里“‹ 今天”和左滑都退回这一条，不再叠一条今天。宽屏不画（设置在侧栏底下） */}
        <MeLink testId="today-settings" />
      </div>
      {wx('below')}
      {column()}
    </>
  );
  // 宽屏：TodayDesk 排成固定的三行卡片，这里只递现成的几块；今天的待办 = 没赶上（和手机同一块：红字组头“! 没赶上 N”、逾期红字）+ 今天截止的
  // （卡片标题写件数）。已经做完的（勾完还留在原位的照没完成算，同 splitPast）另递 doneTodos，TodayDesk 收进“已完成 N ›”
  const todoN = v.late.length + v.todos.length;
  // 一件都没有时 TodayDesk 按 todayTodoN 换成占位字，这里不判
  const todayTodos = (
    <AppearList as="div" layoutKey={lk}>
      {lateItem}
      <AppearItem as="div" key="due">
        <AppearList as="ul" className={`${list.list} ${list.roomy}`}>
          {past.todos.map(tdRow)}
        </AppearList>
      </AppearItem>
    </AppearList>
  );

  return (
    <main ref={page} className={Desk ? `${styles.page} ${Desk.frame}` : styles.page} data-feature="today" data-testid="today">
      {/* 宽屏那一块没换上、画出错时照手机的排法画（一列） */}
      {Desk ? (
        <QuietBoundary name="today-desk" fallback={phone} onFail={ds.fail}>
          <Desk.default
            today={d.today}
            title={title(Desk.title)}
            notices={notices}
            now={now}
            todayTodos={todayTodos}
            doneTodos={past.pastTodos.map(tdRow)}
            todayTodoN={todoN}
            eventRow={evRow}
            sel={ds.sel}
            onOpen={open}
            onClose={ds.close}
          />
        </QuietBoundary>
      ) : (
        phone
      )}

      {/* 页底提示条（撤销条、出错条、只读提示条）：真有一条时才下载（首屏预算）；分包下不来时不画、不把整页换成出错页 */}
      {g.toast !== null || g.toastAt !== null ? (
        <Ro part="toasts" {...r.toasts} />
      ) : null}
    </main>
  );
}

/** 页顶的几条提示：错过的提醒（引擎 armed 或出错以后才挂，晚到时高度展开，GrowIn）、只读行横幅、未同步和麦克风提示 */
function TopNotices({ missedOn, repeat }: { missedOn: boolean; repeat: ReactNode }) {
  // “未同步”提示条首屏画完以后才挂（同 RowMark），不算进首屏预算；常驻的 role="status" 容器照旧一开始就在
  return (
    <>
      {/* 外面包一层：有“错过 N 条提醒”那一行时下面留 8px（和日历页 .unsynced 同一个值），没有时不占位；没有登录会话时不挂 */}
      {missedOn ? (
        <GrowIn inner={styles.missed} testId="today-missed">
          <Later name="missed">
            <MissedReminders />
          </Later>
        </GrowIn>
      ) : null}
      {/* 有只读行才下载横幅（条数在横幅里数，N 为 0 不画） */}
      {repeat}
      <div className={styles.notice} role="status" data-testid="today-notice">
        <Later name="unsynced-hint" afterPaint>
          <UnsyncedRemindHint />
        </Later>
        <QuietBoundary name="mic-denied">
          <MicDeniedNote />
        </QuietBoundary>
      </div>
    </>
  );
}
