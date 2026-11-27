// 待办列表页
// • 顶部项目筛选条：“全部 / 各项目 + 条数”，只作用于这一页（不写 settings）
// • 分组：过期（标红：逾 N 天 / 已过 17:00）→ 今天 → 明天 → 7 天内按日期 → 以后 → 没有日期 → 已完成
// • 每行：打勾（就地保存）、标题、截止标签；点标题进编辑页。删除（软删 + 8 秒撤销条）：左滑露出“删除”，
//   一口气拉过大半行直接删（kit 的 SwipeRow，电脑上鼠标也能拖）；键盘、读屏进编辑页删
// • 只读行：行尾“要新版本”标记，方框变淡；点行、打勾、删除统一拦下（不进编辑页、不写），出提示条（kit 的 useReadonlyGuard、ReadonlyToast）。
//   只读 id 来自 core 的 readonlyIds；只读行不能左滑（SwipeRow disabled）；以后加多选也要先看 ro.has(id)
// • 行尾“未同步”小标记（reminders 的 UnsyncedRemindMark 懒加载）：带提醒、还没同步上的那条标，在标题和截止标签右边；
//   只看本机待同步队列，直接挂、不等提醒引擎，没有时那一格不画
// • 动效：打勾时方框原地填满（CSS，--dur-ui），列表先不动（useHoldView 留住按下之前的分组）；然后这一条从原组淡出、下面的行收上来，
//   “已完成”组让开位置后再淡入。删除：淡出和收拢同时；撤销恢复：先让开位置再淡入（不和别的行叠着）。第一次画列表不播。分组整组出现、消失同样淡入淡出
// • 已完成组折叠：最下面只留一行“已完成 N ›”（按钮，aria-expanded），默认收起；展开状态记在本机 meta 的 ui.todo_done_open
//   （hooks/useSubtasks.ts 的 useDoneOpen，每台设备各记各的）
// • 勾完的那一秒：打勾完成、勾完最后一个子任务自动完成走同一条路，时刻、时长全在动效令牌“勾选完成时间线”一段：
//   按下方框缩到 0.45、行尾 HML 藏起、标题变灰 → 回弹到 1.22 再落回、亮柠檬黄、14 个小点和一圈细正圆（kit CheckCircle）、删除线从左往右画（kit List 的 .strike）
//   → 停到 720ms → 这一行 100ms 收起、页底同时升起“已完成 · 撤销”（kit UndoToast，8 秒倒计时色带）→ 归进“已完成”组；
//   减弱动态效果时没有缩放、炸开，删除线直接画好、不收高度只淡出。计时在 kit/components/useDoneFlow.ts（日历日清单、今天页同一份），
//   分组时怎么留在原位在 data/todo-list.ts 的 linger
// • 行细节：有子任务的方框里按做到几成从下往上填、画小脸（kit CheckCircle 的 progress），副行最前面“起步 / 大半”小标签和等宽“1/3”；
//   行尾 H / M / L 三格并排（kit PrioCycle；点哪格设哪档、键盘读屏换下一档）；完成的灰字加删除线。
//   一行画在 kit TodoRow、动作在 kit/components/useTodoRows.ts（日历日清单、今天页同一份；词条和部件在 row-parts.tsx），这里只给副行和左滑删除
// • 子任务：行下面摊开勾选清单、行底分段进度条、左下“已勾/总数 · 收起 / 展开”（InlineSubtasks → SubtaskCard，今天页、日历日清单同一个；
//   收起状态每台设备各记各的，未完成默认展开、已完成默认收起）。列表页只能勾，加删改在编辑页。
//   勾子任务：主待办只读或这一项只读 → 拦下出“要新版本”；勾上最后一项 → 主待办自动完成，和打勾一样留在原位、出撤销条
//   （文案“全部完成，已完成这条待办”；撤销时刚勾的那项和主待办一起撤回）；
//   主待办已完成时取消勾某项 → 主待办改回未完成，先留住分组 --dur-ui 再挪回原来的组，不出撤销条。运行日志 todo sub auto done|undone 在 data 层记（不记标题）
// • “最近删除”入口不在本页：设置首页“最近删除”一组的“待办”一行进 #/trash/todos；设置里“完成 7 天后自动删除”说明后面也有链接
// • 下拉搜索：滚到顶再往下拉，标题下面露出扁搜索框（kit 的 usePullReveal、PullSlot + smart-search 的 PullSearch，和随手记、日历页同一套）；
//   打了字本页藏起来，结果在搜索框下面列（日程、待办、随手记混在一起），点一条打开；本页不做就地筛
// • 不能拖动排序，只用 HML 排：每组里按 H → M → L、同档按截止时刻（没时刻的在后）、再按创建时间
//   （shared/logic/todo-row.ts 的 compareTodos，今天页、日历日清单同一个）；长按什么都不拿起
import { Fragment, useCallback, type ReactNode } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { navigate } from '../../../app/router.ts';
import { dockOf } from '../../../app/router-levels.ts';
import list from '../../../kit/components/List.module.css';
import { ListToasts } from '../../../kit/components/ListToasts.tsx';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { groupRowClass } from '../../../kit/components/Form.tsx';
import { DelSwipe } from '../../../kit/components/SwipeRow.tsx';
import { DoneFold } from '../../../kit/components/DoneFold.tsx';
import type { DateStr } from '../../../../shared/core/date.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { usePullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { PullSlot } from '../../../kit/components/PullSlot.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList, Pressable } from '../../../motion/components.ts';
import { useListT, useTodoList, type DueTag, type Group, type TodoItem } from '../hooks/useTodoList.ts';
import { useLinger } from '../../../kit/components/useDoneFlow.ts';
import { useTodoRows, type TodoRows } from '../../../kit/components/useTodoRows.ts';
import { useLive } from '../../../kit/hooks/useLive.ts';
import { TodoRow, withStage } from '../../../kit/components/TodoRow.tsx';
import { preloadFold, setCollapsed, setDoneOpen, useCollapsed, useDoneOpen, useFoldReady } from '../hooks/useSubtasks.ts';
import { TODO_PARTS } from './row-parts.tsx';
import { PullSearch } from '../../smart-search/index.ts';
import styles from './TodosPage.module.css';
import chip from '../../../kit/components/Chip.module.css';
import refine from '../../../kit/components/Refine.module.css';
import { DeskHead, deskCard, deskFrameOf, deskGrid, deskTitle } from '../../../kit/components/Desk.tsx';
import { MQ_DESK_WIDE, useMedia } from '../../../kit/hooks/useMedia.ts';
import { TodosSide } from './TodosSide.tsx';

// 这一包一执行（冷启动后台预加载时）就去读子任务收起状态，第一次进待办时已经读好，下面的行不会飞上来
preloadFold();

export default function TodosPage() {
  const t = useListT();
  const locale = useUi((s) => s.locale);
  // 勾完先留在原位的那几条（kit/components/useDoneFlow.ts）：分组时按它们没完成时的组留着
  const lg = useLinger();
  const l = useTodoList(lg.ids);
  // 行的动作（日历日清单、今天页同一份，kit/components/useTodoRows.ts）：改回未完成时先留住按下之前的分组 --dur-ui；只读行统一拦下；
  // 撤销条、出错条在 r.a.g 里（kit 的 useListActions）；打勾、勾完子任务自动完成的停留、收起、“已完成 · 撤销”在 r.flow
  const r = useTodoRows(l.groups, lg, l, 'todos', TODO_PARTS);
  const { a } = r;
  const { isRo, del } = a;
  const open = (id: string) => (isRo(id) ? a.g.block() : void navigate('todo', id));
  const pull = usePullReveal('todos');
  const isCollapsed = useCollapsed();
  const fold = (id: string, v: boolean) => setCollapsed(id, v, l.ids);   // 全部待办的 id（不按项目筛选，免得剔掉别的项目点过的）
  // 行拿到的点行、收起、删除从头到尾是同一个函数（kit hooks/useLive.ts），调的是这一次渲染的 open、fold、del：行是 memo 的（kit TodoRow），别的行变了它不重画
  const act = useLive({ open, fold, del: (id: string) => void del(id) });
  const doneOpen = useDoneOpen();
  // 收起状态读好以前列表不画：不先按默认摊开子任务、再缩回去让下面的行飞上来
  const foldReady = useFoldReady();

  const { groupTitle, dueText } = labelsOf(t, locale);
  /** 网页版宽屏排法（kit useMedia 的 MQ_DESK_WIDE） */
  const desk = useMedia(MQ_DESK_WIDE);

  const title = <h1 className={desk ? deskTitle : refine.title}>{t('list.title', {})}</h1>;
  /** 标题下面一行等宽小字：今天的日期、这一页完成了几条 */
  const sub = t('list.sub', { date: fmtDay(l.today, locale, 'monthDayWeek'), done: l.count.done, total: l.count.total });
  const filter = l.projects.length ? (
    <div className={desk ? `${styles.filter} ${styles.dkFilter}` : styles.filter} role="group" aria-label={t('list.filter', {})} data-testid="todos-filter">
      <Chip on={l.project === null} onClick={() => l.setProject(null)} name={t('list.all', {})} n={l.count.all} testId="todos-filter-all" />
      {l.projects.map((p) => (
        <Chip key={p.project} on={l.project === p.project} onClick={() => l.setProject(p.project)} name={p.project} n={p.count} testId={`todos-filter-${p.project}`} />
      ))}
    </div>
  ) : null;
  const search = <PullSearch pull={pull} own={{ kind: 'todo', open }} />;
  const groups = (
    <>
      {foldReady && r.view.length === 0 ? <p className={list.empty}>{t('list.empty', {})}</p> : null}
      {foldReady && <AppearList as="div">
        {r.view.map((g) => (
          <AppearItem
            as="section"
            key={`${g.key}:${g.date ?? ''}`}
            className={g.key === 'late' ? `${styles.group} ${styles.late}` : styles.group} data-testid={`todos-g-${g.key}${g.date ? `-${g.date}` : ''}`}>
            {/* 已完成组：标题就是展开 / 收起按钮（“已完成 N”已带条数；kit DoneFold，网页版今天页同一个） */}
            {g.key === 'done' ? (
              <DoneFold title={groupTitle(g)} open={doneOpen} onToggle={() => setDoneOpen(!doneOpen)} testId="todos-done-fold" className={styles.h2} />
            ) : (
              <h2 className={`${groupRowClass} ${styles.h2}`}>
                {/* 分组名小字、加字距，右边条数；过期组带“!”、红字 */}
                <span>{g.key === 'late' ? <span aria-hidden="true">! </span> : null}{groupTitle(g)}</span>
                <span className={styles.cnt}>{g.items.length}</span>
              </h2>
            )}
            {g.key === 'done' && !doneOpen ? null : (
            <AppearList as="ul" className={`${list.list} ${list.roomy}${g.key === 'late' ? ` ${list.late}` : ''}`}>
              {g.items.map(({ todo, tag }) => (
                <TodosRow
                  key={todo.id}
                  r={r}
                  todo={todo}
                  progress={l.subs.get(todo.id)}
                  late={tag.kind === 'late'}
                  due={dueText(tag)}
                  collapsed={isCollapsed(todo.id, todo.done)}
                  ro={isRo(todo.id)}
                  delLabel={t('list.delete', {})}
                  act={act}
                />
              ))}
            </AppearList>
            )}
          </AppearItem>
        ))}
      </AppearList>}
    </>
  );
  /** 页底提示条只这一处（kit ListToasts）：删除的撤销条、出错条、只读提示条，加上打勾、自动完成的“已完成 · 撤销”（r.flow.undoOf） */
  const toasts = <ListToasts {...r.toasts} />;

  // 网页版宽屏：页头标题和副行，右边项目筛选胶囊；下面列表一张卡 + 右边 270 宽一列（今天进度、未来 7 天、按项目）。
  // 不画右上角头像（设置在侧栏）
  if (desk) {
    return (
      <main ref={pull.ref} className={`${styles.page} ${deskFrameOf(dockOf('todos'))}`} data-feature="todos" data-testid="todos">
        <DeskHead title={title} sub={<span data-testid="todos-sub">{sub}</span>} tools={filter} />
        <div className={`${deskGrid} ${styles.dkGrid}`}>
          <div className={`${deskCard} ${styles.dkList}`} data-testid="todos-list-card">
            <PullSlot pull={pull} keyLabel={t('list.pullKey', {})} search={search}>
              {groups}
            </PullSlot>
          </div>
          <TodosSide today={l.today} projects={l.projects} />
        </div>
        {toasts}
      </main>
    );
  }

  return (
    <main ref={pull.ref} className={styles.page} data-feature="todos" data-testid="todos">
      <header className={styles.top}>
        {title}
        {/* 新建待办在底栏的“＋”；右上角是设置入口头像（四页共用 MeLink） */}
        <span className={styles.topEnd}>
          <MeLink testId="todos-settings" />
        </span>
      </header>
      <p className={refine.sub} data-testid="todos-sub">
        {sub}
      </p>
      <PullSlot pull={pull} keyLabel={t('list.pullKey', {})} search={search}>
        {filter}
        {groups}
      </PullSlot>
      {toasts}
    </main>
  );
}

// 今天页、日历日清单的子任务就地展开和日历的待办组、编辑页的“子任务”区从这一包转出：功能入口 index.ts、TodoEditPage 都按名字懒加载这一个模块，
// 子任务界面不另拆分包（首屏里每多一个分包要多登记一个文件名）。今天页、日历经 inline-subs.ts、day-todos.ts 转一手（入口要求是 lazy(() => import('./…'))）；
// 今天页有待办时首屏画完就会下载这一包（不是点进待办页才下），换来不多占首屏
export { default as InlineSubtasks } from './InlineSubtasks.tsx';
export { default as DayTodos } from './DayTodos.tsx';
export { default as SubtaskEditor } from './SubtaskEditor.tsx';

/** “2026-11-13” → “11/13”（副行的日期，等宽数字；两种语言同一种写法） */
const md = (d: DateStr): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 组标题、截止标签的文字（从页面拆出来，只看词典和语言） */
function labelsOf(t: ReturnType<typeof useListT>, locale: Locale) {
  const groupTitle = (g: Group): string => {
    switch (g.key) {
      case 'late': return t('list.g.late', {});
      case 'today': return t('list.g.today', {});
      case 'tomorrow': return t('list.g.tomorrow', {});
      case 'day': return fmtDay(g.date ?? '', locale, 'monthDayWeek');
      case 'later': return t('list.g.later', {});
      case 'nodate': return t('list.g.nodate', {});
      case 'done': return t('list.g.doneN', { n: g.items.length });
    }
  };
  /** 副行的截止：日期一律“月/日”数字，有时刻跟在后面；逾期前面“过期”，今天、明天写字 */
  const dueText = (tag: DueTag): string => {
    if (tag.kind === 'none') return '';
    const at = tag.dueTime ? ` ${tag.dueTime}` : '';
    switch (tag.kind) {
      case 'late': return `${t('list.due.late', {})} ${md(tag.due)}${at}`;
      case 'today': return `${t('list.due.today', {})}${at}`;
      case 'tomorrow': return `${t('list.due.tomorrow', {})}${at}`;
      case 'date': return `${md(tag.date)}${at}`;
    }
  };
  return { groupTitle, dueText };
}

/** 副行的几段：逾期“过期 11/13 14:00 · 项目”，其余“项目 · 今天 14:00”；空的那段不画，中间用“ · ”连 */
function metaParts(late: boolean, project: string, due: ReactNode) {
  const parts = [{ k: 'p', v: project || null }, { k: 'd', v: due }].filter((x) => x.v);
  return (late ? parts.reverse() : parts).map((x, i) => <Fragment key={x.k}>{i > 0 ? ' · ' : null}{x.v}</Fragment>);
}

type TodosAct = Readonly<{ open(id: string): void; fold(id: string, v: boolean): void; del(id: string): void }>;

/**
 * 待办页的一行（kit TodoRow）：副行、左滑按这一行自己的值记住，点行、收起、删除用页面的 act（从头到尾同一个）——
 * 交给 TodoRow 的参数别的行变了都不变，memo 命中（传内联函数的话打勾一次每行都要重画好几次）
 */
function TodosRow({ r, todo, progress, late, due, collapsed, ro, delLabel, act }: {
  r: TodoRows; todo: TodoItem; progress: Readonly<{ done: number; total: number }> | undefined; late: boolean; due: string;
  collapsed: boolean; ro: boolean; delLabel: string; act: TodosAct;
}) {
  const { id, project } = todo;
  const onOpen = useCallback(() => act.open(id), [act, id]);
  const onCollapse = useCallback((v: boolean) => act.fold(id, v), [act, id]);
  // 副行：逾期“! 过期 11/13 14:00 · 项目”红字；其余“项目 · 今天 14:00”；日期、时刻等宽数字；
  // 有子任务的最前面“起步 / 大半”小标签和等宽“1/3”（逾期的“!”跟在它后面，标签本身不标红）；后面没有项目、日期时“1/3”后面不拼“ · ”
  // 连接点“ · ”是 kit withStage（三页同一份）；过期的“!”贴在项目、日期前面（后面没有项目、日期时没有“!”也没有点）
  const meta = useCallback(
    (stage: ReactNode) => {
      const rest = metaParts(late, project, due ? <span className={refine.num}>{due}</span> : null);
      return (
        <span className={late ? `${list.meta} ${styles.tagLate}` : list.meta} data-testid={`todos-tag-${id}`}>
          {withStage(stage, rest.length > 0 ? <>{late ? <span aria-hidden="true">! </span> : null}{rest}</> : null)}
        </span>
      );
    },
    [late, project, due, id],
  );
  // 左滑删除（和今天页同一份 kit DelSwipe）：只读行不能滑
  const wrap = useCallback(
    (face: ReactNode) => (
      <DelSwipe tid="todos" id={id} ro={ro} label={delLabel} onDel={() => act.del(id)} log={rlog}>
        {face}
      </DelSwipe>
    ),
    [id, ro, delLabel, act],
  );
  return <TodoRow r={r} todo={todo} progress={progress} tid="todos" onOpen={onOpen} late={late} collapsed={collapsed} onCollapse={onCollapse} meta={meta} wrap={wrap} />;
}

/** 筛选胶囊：名字 + 等宽淡色条数 */
function Chip({ on, onClick, name, n, testId }: { on: boolean; onClick(): void; name: string; n: number; testId: string }) {
  return (
    <Pressable className={on ? chip.chipOn : chip.chip} aria-pressed={on} onClick={onClick} data-testid={testId}>
      {name}
      <span className={chip.chipN}>{n}</span>
    </Pressable>
  );
}
