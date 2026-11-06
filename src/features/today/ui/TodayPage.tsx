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
//      没内容时不占位（.notice 里没有 p）
//   ③ 每行行尾“未同步”小标记（UnsyncedRemindMark，在行按钮里、标题和副行的右边；没有时那一格不画）
//   ②③ 只看本机待同步队列、和引擎无关，同日历页直接挂，不等引擎（M1）
// • 液态玻璃底栏、“＋”、时间河、提醒按钮条不在这一段（FA-4、FA-7）
import { Suspense, useState } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { hrefOf, navigate } from '../../../app/router.ts';
import { CheckCircle } from '../../../kit/components/CheckCircle.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { useT } from '../../../kit/hooks/useT.ts';
import { useRemindQueue } from '../../../kit/state/remind-queue.ts';
import { AppearItem, AppearList, Pressable, useHoldView } from '../../../motion/components.ts';
import { useLocale, useTodayT, zoneName } from '../hooks/useTodayT.ts';
import { useMeInitial } from '../hooks/useMeInitial.ts';
import { useToday, type ActionResult } from '../hooks/useToday.ts';
import { MissedReminders, UnsyncedRemindHint, UnsyncedRemindMark } from '../../reminders/index.ts';
import { GrowIn } from './GrowIn.tsx';
import { NowCard } from './NowCard.tsx';
import styles from './TodayPage.module.css';


/** 行尾“未同步”小标记：没有时那一格是空的，CSS 里 :empty 不画 */
function RowMark({ table, id }: { table: 'events' | 'todos'; id: string }) {
  return (
    <span className={styles.unsynced}>
      <QuietBoundary name="unsynced-mark">
        <Suspense fallback={null}>
          <UnsyncedRemindMark table={table} id={id} />
        </Suspense>
      </QuietBoundary>
    </span>
  );
}

type Toast = { kind: 'undo'; id: string } | { kind: 'error'; readonly: boolean } | null;

export default function TodayPage() {
  const tApp = useT();
  const initial = useMeInitial();
  const t = useTodayT();
  const locale = useLocale();
  const d = useToday();
  /** 引擎 armed 或出错（含 App 的看门狗：迟迟不 armed 也算出错）才挂“错过的提醒”（REMIND-shown-persist 修订 1 P2） */
  const missedOn = useRemindQueue((s) => s.armedSince !== null || s.remindDown);
  const [toast, setToast] = useState<Toast>(null);
  // 打勾：先留住按下之前的两张列表 --dur-ui（圆圈在原地填满），再换成新的（没赶上 → 今天的安排）；
  // 留着的期间圆圈按“刚点成什么”画（picked），几条连着点就一起挪
  const hv = useHoldView({ late: d.late, events: d.events, todos: d.todos });
  const v = hv.view;
  const [picked, setPicked] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const tick = (id: string, on: boolean) => {
    setPicked((m) => new Map(hv.holding ? m : []).set(id, on));
    hv.hold();
    void d.toggleDone(id, on).then(report);
  };
  const shown = (id: string, done: boolean) => (hv.holding ? (picked.get(id) ?? done) : done);

  const report = (r: ActionResult) => {
    if (r === 'failed' || r === 'readonly') setToast({ kind: 'error', readonly: r === 'readonly' });
  };
  const del = async (id: string) => {
    hv.release();
    const r = await d.remove('todos', id, true);
    if (r === 'ok') setToast({ kind: 'undo', id });
    else report(r);
  };

  return (
    <main className={styles.page} data-feature="today" data-testid="today">
      <div className={styles.head}>
        {/* tabIndex=-1：弹层关上、打开按钮没了时焦点的退路（错过的提醒“全部知道了”以后，Dialog L-2），不进 Tab 顺序 */}
        <h1 className={styles.date} tabIndex={-1}>{fmtDay(d.today, locale, 'monthDayWeek')}</h1>
        {/* 设置入口（负责人 11-05 ①；接手清单 NAV-today-no-settings）：右上角头像，名字第一个字；没有名字时是一个人形 */}
        <a className={styles.me} href={hrefOf('settings')} aria-label={tApp('app.settings', {})} data-testid="today-settings">
          {initial ?? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0" />
            </svg>
          )}
        </a>
      </div>

      {/* 外面包一层：有“错过 N 条提醒”那一行时下面留 8px（和日历页 .unsynced 同一个值；设计复审 今天页待办 M1），没有时不占位 */}
      {/* 引擎 armed 或出错以后才挂（P2），晚到时高度展开、不一下子把下面推开（GrowIn）；没有登录会话时不挂 */}
      {missedOn ? (
        <GrowIn testId="today-missed">
          <QuietBoundary name="missed">
            <Suspense fallback={null}>
              <MissedReminders />
            </Suspense>
          </QuietBoundary>
        </GrowIn>
      ) : null}
      <div className={styles.notice} role="status" data-testid="today-notice">
        <QuietBoundary name="unsynced-hint">
          <Suspense fallback={null}>
            <UnsyncedRemindHint />
          </Suspense>
        </QuietBoundary>
      </div>

      <NowCard card={d.card} now={d.now} tz={d.tz} today={d.today} tomorrowFirst={d.tomorrowFirst} />

      {/* 两块放在同一个 AppearList 里：没赶上最后一条离开时整组跟着淡出（不然 section 一卸载，那一行的退出动画就被截断），
          下面“今天的安排”用 layout 平移收上来，不跳 */}
      <AppearList as="div">
        {v.late.length ? (
          <AppearItem as="section" key="late" className={styles.late} aria-labelledby="today-late" data-testid="today-late">
            <h2 id="today-late" className={styles.h2}>{t('late.title', {})}</h2>
            <AppearList as="ul" className={styles.list}>
              {v.late.map(({ todo, days }) => (
                <AppearItem key={todo.id} className={styles.row} data-ghost="">
                  <CheckCircle checked={shown(todo.id, false)} label={shown(todo.id, false) ? t('list.undoDone', {}) : t('list.done', {})} onChange={(v) => tick(todo.id, v)} testId={`today-done-${todo.id}`} />
                  <button type="button" className={styles.main} onClick={() => void navigate('todo', todo.id)}>
                    <span className={styles.mainText}>
                      <span className={styles.title}>{todo.title}</span>
                      <span className={styles.lateTag}>{days > 0 ? t('late.days', { n: days }) : t('late.passed', { t: todo.dueTime ?? '' })}</span>
                    </span>
                    <RowMark table="todos" id={todo.id} />
                  </button>
                </AppearItem>
              ))}
            </AppearList>
          </AppearItem>
        ) : null}

        <AppearItem as="section" key="list" aria-labelledby="today-list" data-testid="today-list">
          <h2 id="today-list" className={styles.h2}>{t('list.title', {})}</h2>
          {v.events.length === 0 && v.todos.length === 0 ? <p className={styles.empty}>{t('list.empty', {})}</p> : null}
          <AppearList as="ul" className={styles.list}>
            {v.events.map((o) => (
              <AppearItem key={`e:${o.id}`} className={styles.row} data-ghost="" data-testid={`today-event-${o.id}`}>
                <span className={styles.time}>{o.time ?? t('list.allDay', {})}</span>
                <button type="button" className={styles.main} onClick={() => void navigate('event', o.id)}>
                  <span className={styles.mainText}>
                    <span className={styles.title}>{o.title}</span>
                    {o.origin ? <span className={styles.sub}>{t('list.origin', { zone: zoneName(o.origin.tz, locale), t: o.origin.time })}</span> : null}
                  </span>
                  <RowMark table="events" id={o.id} />
                </button>
                {/* 日程行没有 ×：补一个和 × 一样宽的空格子，“未同步”标记和待办行落在同一列（设计复审 今天页待办 M2）。
                    只有这里日程、待办混排；不能点、不进 Tab、读屏不读 */}
                <span className={styles.delGap} aria-hidden="true" data-testid={`today-del-gap-${o.id}`} />
              </AppearItem>
            ))}
            {v.todos.map((td) => (
              <AppearItem key={`t:${td.id}`} className={styles.row} data-ghost="" data-testid={`today-todo-${td.id}`} data-done={td.done ? '' : undefined}>
                <CheckCircle
                  checked={shown(td.id, td.done)}
                  label={shown(td.id, td.done) ? t('list.undoDone', {}) : t('list.done', {})}
                  onChange={(v) => tick(td.id, v)}
                  testId={`today-done-${td.id}`}
                />
                <button type="button" className={styles.main} onClick={() => void navigate('todo', td.id)}>
                  <span className={styles.mainText}>
                    <span className={styles.title}>{td.title}</span>
                    <span className={styles.sub}>{td.dueTime ? t('list.due', { t: td.dueTime }) : t('list.dueDay', {})}</span>
                  </span>
                  <RowMark table="todos" id={td.id} />
                </button>
                <Pressable className={styles.del} aria-label={t('list.delete', {})} onClick={() => void del(td.id)} data-testid={`today-del-${td.id}`} data-no-proxy="">
                  ×
                </Pressable>
              </AppearItem>
            ))}
          </AppearList>
        </AppearItem>
      </AppearList>

      {toast?.kind === 'undo' ? (
        <UndoToast
          key={toast.id}
          message={t('toast.deleted', {})}
          undoLabel={t('toast.undo', {})}
          onUndo={() => void d.remove('todos', toast.id, false).then(report)}
          onClose={() => setToast((x) => (x === toast ? null : x))}
          data-testid="today-toast"
        />
      ) : toast?.kind === 'error' ? (
        <p className={styles.error} role="alert" data-testid="today-error">
          {toast.readonly ? t('err.readonly', {}) : t('err.save', {})}
        </p>
      ) : null}
    </main>
  );
}
