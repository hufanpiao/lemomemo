// 待办列表页（B2 FA-2；定稿线框 s6；架构 5.9“项目筛选”；R-134、R-136）
// • 顶部项目筛选条：“全部 / 各项目 + 条数”，只作用于这一页（不写 settings）
// • 分组：过期（标红：逾 N 天 / 已过 17:00）→ 今天 → 明天 → 7 天内按日期 → 以后 → 没有日期 → 已完成
// • 每行：打勾（就地保存）、标题（常规字重）、截止标签（“今天 17:00 截止”）；点标题进编辑页。
//   删除（软删 + 8 秒撤销条）：左滑露出“删除”，一口气拉过大半行直接删（负责人 11-15 去掉行尾 ×，kit 的 SwipeRow，电脑上鼠标也能拖）；
//   键盘、读屏进编辑页在那里删（编辑页有“删除”）
// • 只读行（FA-2 只读行界面；架构 0.27 第 1 点）：行尾“要新版本”标记，方框变淡；点这一行、打勾、删除统一拦下（不进编辑页、不写），
//   出提示条“这条要新版本才能修改 · 更新”（kit 的 useReadonlyGuard、ReadonlyToast）。只读 id 来自 core 的 readonlyIds。
//   左滑：只读行不能滑（SwipeRow disabled）；多选这一页还没有，以后加的时候照样先看 ro.has(id)
// • 行尾“未同步”小标记（REMIND-wiring；TC-B2-69；reminders 的 UnsyncedRemindMark 懒加载）：带提醒、还没同步上的那条标，在行按钮里、
//   标题和截止标签的右边；只看本机待同步队列，同日历页直接挂、不等提醒引擎（今天页待办 代码审查 M1），没有时那一格不画
// • 动效（17.1“勾选完成”“列表增删”，B2 FA-5；设计审查 M1～M3 返工 11-04）：打勾时方框在原地填满（CSS，--dur-ui；R-433 圆圈改成圆角方框），
//   列表先不动（useHoldView 留住按下之前的分组）；然后这一条从原来的组淡出、同时下面的行收上来，“已完成”组让开位置后它再淡入。
//   删除：淡出和收拢同时；撤销恢复：先让开位置再淡入（不和别的行叠着）。第一次画列表不播。分组整组出现、消失同样淡入淡出。
// • 已完成组折叠（负责人 11-15“完成的待办怎么隐藏比较好”，已选方案）：列表最下面只留一行“已完成 N ›”（按钮，aria-expanded），点开展开、再点收起；
//   默认收起，展开没有记在本机 meta 的 ui.todo_done_open（hooks/useSubtasks.ts 的 useDoneOpen，每台设备各记各的）。
// • 勾完的那一秒（负责人 11-17 定的勾选特效分镜，取代 11-15 的“留在原位约 3 秒”）：打勾完成、勾完最后一个子任务自动完成走同一条路——
//   按下方框缩 0.92、勾上填充回弹加一圈小点、标题从左往右划线、整行变淡（kit CheckCircle、kit List 的 .fold）→ 停到 700ms → 这一行 280ms 收起、
//   页底同时升起“已完成 · 撤销”（kit UndoToast，8 秒柠檬黄倒计时色带，R-450）→ 归进“已完成”组；减弱动态效果时只变淡、不收高度。
//   计时在 hooks/useDoneFlow.ts（日历日清单的待办组同一份，R-443），分组时怎么留在原位在 data/todo-list.ts 的 linger
// • T-A 行细节（负责人 11-17 选 T-A）：有子任务的方框里按做到几成从下往上填、画小脸（kit CheckCircle 的 progress），副行最前面“起步 / 大半”小标签
//   和等宽“1/3”（SubtaskBar.tsx 的 SubStage）；行尾 H / M / L 三格并排（kit PrioCycle，推翻 R-434 的单格；点哪格设哪档、键盘读屏换下一档）；
//   完成的待办、子任务都变淡加删除线。一行画在 TodoRow.tsx、动作在 hooks/useTodoRowActions.ts（日历日清单同一份），这里只给副行和左滑删除
// • 子任务（R-350 方案 5.1、5.4、5.5）：有子任务的待办，行下面摊开勾选清单、底部分段进度条、右下“已勾/总数 · 收起 / 展开”
//   （T-A 起“收起 / 展开”在左下、进度条在行底；InlineSubtasks → SubtaskCard，今天页、日历日清单同一个；收起状态每台设备各记各的，未完成默认展开、已完成默认收起）。列表页只能勾，加删改在编辑页（Q10）。
//   勾子任务：主待办只读或这一项只读 → 拦下出“要新版本”；勾上最后一项 → 主待办自动完成，和打勾一样留在原位、出撤销条
//   （文案“全部完成，已完成这条待办”，方案 5.5；撤销时刚勾的那项和主待办一起撤回，Q1）；
//   主待办已完成时取消勾某项 → 主待办改回未完成，先留住分组 --dur-ui 再挪回原来的组，不出撤销条（Q2）。运行日志 todo sub auto done|undone 在 data 层记（不记标题）
// • “最近删除”入口不在本页（R-441 负责人 11-16“代办页跟随手记页的删除按钮去掉，删除确认放在设置页”，取代 R-438 的顶栏图标）：
//   设置首页“最近删除”一组的“待办”一行进 #/trash/todos；设置里“完成 7 天后自动删除”说明后面的链接照旧
// • 下拉搜索（R-437）：滚到顶再往下拉，标题下面露出一条扁搜索框（kit 的 usePullReveal、PullSlot + smart-search 的 PullSearch，和随手记、日历页同一套）；
//   R-447（负责人 11-17 选 S-B“原列表筛选”）：打了字原来的分组和行留着，只画命中的（按标题和子任务，kit 的 pull.shows），命中的字加短下划线（kit PullHit），
//   没有命中的组整组不画；项目胶囊照样筛。框下一行“3 未完成 · 全部未完成⌄”：默认已完成组不画，小下拉换成“含已完成”时已完成组展开画出命中的；
//   列表下面“用 AI 按意思找 ›”，一条都没有时居中提示（PullSearch 的 foot）。行还是原来的行：打勾、H/M/L、左滑删除、子任务都照常
// • 不能拖动排序（R-442 负责人“待办里面不需要拖动，只用HML来排序”，取代 R-429 的待办部分、R-433 的拖动 6 个点）：每组里按 H → M → L、
//   同档按截止时刻（没时刻的在后）、再按创建时间排（shared/logic/todo-row.ts 的 compareTodos，今天页、日历日清单同一个）；长按什么都不拿起
import { Fragment, useState, type ReactNode } from 'react';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { navigate } from '../../../app/router.ts';
import list from '../../../kit/components/List.module.css';
import { ListToasts } from '../../../kit/components/ListToasts.tsx';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { groupLabelClass } from '../../../kit/components/Form.tsx';
import { SwipeRow } from '../../../kit/components/SwipeRow.tsx';
import type { DateStr } from '../../../../shared/core/date.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { usePullReveal } from '../../../kit/hooks/usePullReveal.ts';
import { PullHit, PullSlot } from '../../../kit/components/PullSlot.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList, Pressable } from '../../../motion/components.ts';
import { useListT, useTodoList, type DueTag, type Group } from '../hooks/useTodoList.ts';
import { useLinger } from '../hooks/useDoneFlow.ts';
import { useTodoRowActions } from '../hooks/useTodoRowActions.ts';
import { setCollapsed, setDoneOpen, useCollapsed, useDoneOpen } from '../hooks/useSubtasks.ts';
import { TodoRow, type TodoRowIds } from './TodoRow.tsx';
import { PullSearch } from '../../smart-search/index.ts';
import styles from './TodosPage.module.css';
import chip from '../../../kit/components/Chip.module.css';
import refine from '../../../kit/components/Refine.module.css';

/** 行里各处的测试 id 前缀（ui/TodoRow.tsx） */
const IDS: TodoRowIds = { row: 'todos-row', done: 'todos-done', prio: 'todos-prio', stage: 'todos-stage', ro: 'todos-ro', subs: 'todos' };

export default function TodosPage() {
  const t = useListT();
  const locale = useUi((s) => s.locale);
  // 勾完先留在原位的那几条（hooks/useDoneFlow.ts）：分组时按它们没完成时的组留着
  const lg = useLinger();
  const l = useTodoList(lg.ids);
  // 行的动作（日历日清单同一份，hooks/useTodoRowActions.ts）：改回未完成时先留住按下之前的分组 --dur-ui；只读行统一拦下；
  // 撤销条、出错条在 r.a.g 里（kit 的 useListActions）；打勾、勾完子任务自动完成的停留、收起、“已完成 · 撤销”在 r.flow
  const r = useTodoRowActions(l.groups, lg, l, 'todos');
  const { a } = r;
  const { isRo, del } = a;
  const open = (id: string) => (isRo(id) ? a.g.block() : void navigate('todo', id));
  const pull = usePullReveal('todos');
  // 就地筛（R-447）：没打字时原样；打了字只留命中的行、没有命中的组不画，已完成组只在选了“含已完成”时画（选的值只在这一页记着）
  const [withDone, setWithDone] = useState(false);
  const view = pull.searching
    ? r.view.flatMap((g) => {
        const items = g.key === 'done' && !withDone ? [] : g.items.filter((x) => pull.shows(x.todo.id));
        return items.length ? [{ ...g, items }] : [];
      })
    : r.view;
  const found = view.reduce((n, g) => n + g.items.length, 0);
  const isCollapsed = useCollapsed();
  const fold = (id: string, v: boolean) => setCollapsed(id, v, l.ids);   // 全部待办的 id（不按项目筛选，免得剔掉别的项目点过的）
  const doneOpen = useDoneOpen();

  const { groupTitle, dueText } = labelsOf(t, locale);

  return (
    <main ref={pull.ref} className={styles.page} data-feature="todos" data-testid="todos">
      <header className={styles.top}>
        <h1 className={refine.title}>{t('list.title', {})}</h1>
        {/* 新建待办在底栏的“＋”（负责人 11-05 ③，原来右上角的“＋ 新建”去掉）；右上角是设置入口头像（R-381，四页共用 MeLink） */}
        <span className={styles.topEnd}>
          <MeLink testId="todos-settings" />
        </span>
      </header>
      {/* 标题下面一行等宽小字（R-436 第 2 条）：今天的日期、这一页完成了几条 */}
      <p className={refine.sub} data-testid="todos-sub">
        {t('list.sub', { date: fmtDay(l.today, locale, 'monthDayWeek'), done: l.count.done, total: l.count.total })}
      </p>
      <PullSlot
        pull={pull}
        keyLabel={t('list.pullKey', {})}
        search={(part) => <PullSearch part={part} pull={pull} scope="todo" found={found} done={{ all: withDone, set: setWithDone }} />}
      >

      {l.projects.length ? (
        <div className={styles.filter} role="group" aria-label={t('list.filter', {})} data-testid="todos-filter">
          <Chip on={l.project === null} onClick={() => l.setProject(null)} name={t('list.all', {})} n={l.count.all} testId="todos-filter-all" />
          {l.projects.map((p) => (
            <Chip key={p.project} on={l.project === p.project} onClick={() => l.setProject(p.project)} name={p.project} n={p.count} testId={`todos-filter-${p.project}`} />
          ))}
        </div>
      ) : null}

      {r.view.length === 0 && !pull.searching ? <p className={list.empty}>{t('list.empty', {})}</p> : null}
      <AppearList as="div">
        {view.map((g) => (
          <AppearItem
            as="section"
            key={`${g.key}:${g.date ?? ''}`}
            className={g.key === 'late' ? `${styles.group} ${styles.late}` : styles.group} data-testid={`todos-g-${g.key}${g.date ? `-${g.date}` : ''}`}>
            {/* 已完成组：平时标题就是展开 / 收起按钮；就地筛时整组摊开画命中的，标题只是一行字（“已完成 N”已带条数，右边不再写） */}
            {g.key === 'done' && !pull.searching ? (
              <DoneFold title={groupTitle(g)} open={doneOpen} onToggle={() => setDoneOpen(!doneOpen)} />
            ) : (
              <h2 className={`${groupLabelClass} ${styles.h2}`}>
                {/* 分组名小字、加字距，右边条数（R-436 第 4 条）；过期组带“!”、红字 */}
                <span>{g.key === 'late' ? <span aria-hidden="true">! </span> : null}{groupTitle(g)}</span>
                {g.key === 'done' ? null : <span className={styles.cnt}>{g.items.length}</span>}
              </h2>
            )}
            {g.key === 'done' && !doneOpen && !pull.searching ? null : (
            <AppearList as="ul" className={`${list.list} ${list.roomy}${g.key === 'late' ? ` ${list.late}` : ''}`}>
              {g.items.map(({ todo, tag }) => {
                const subs = l.subs.get(todo.id);
                const due = dueText(tag);
                return (
                  <TodoRow
                    key={todo.id}
                    r={r}
                    todo={todo}
                    subs={subs}
                    ids={IDS}
                    onOpen={() => open(todo.id)}
                    mark={(text) => <PullHit pull={pull} text={text} />}
                    collapsed={isCollapsed(todo.id, todo.done)}
                    onCollapse={(v) => fold(todo.id, v)}
                    // 副行（R-434、R-436 确认图）：逾期“! 过期 11/13 14:00 · 项目”红字；其余“项目 · 今天 14:00”；日期、时刻等宽数字；
                    // 有子任务的最前面“起步 / 大半”小标签和等宽“1/3”（负责人 11-17 选 T-A；逾期的“!”跟在它后面，标签本身不标红）
                    // 后面没有项目、日期时，“1/3”后面不拼“ · ”（负责人 11-17 截图里没日期的待办副行写成“0/1 ·”）
                    meta={(stage) => {
                      const rest = metaParts(tag.kind === 'late', todo.project, due ? <span className={refine.num}>{due}</span> : null);
                      return (
                        <span className={tag.kind === 'late' ? `${list.meta} ${styles.tagLate}` : list.meta} data-testid={`todos-tag-${todo.id}`}>
                          {stage ? <>{stage}{rest.length > 0 ? ' · ' : null}</> : null}
                          {tag.kind === 'late' ? <span aria-hidden="true">! </span> : null}
                          {rest}
                        </span>
                      );
                    }}
                    // 左滑删除（负责人 11-15 去掉行尾 ×）：露出“删除”点了删，一口气拉过大半行直接删（kit SwipeRow 的 full）；只读行不能滑
                    wrap={(face) => (
                      <SwipeRow
                        className={list.swp}
                        disabled={isRo(todo.id)}
                        full="del"
                        log={rlog}
                        actions={[{ key: 'del', label: t('list.delete', {}), danger: true, onClick: () => void del(todo.id), testId: `todos-swipe-del-${todo.id}` }]}
                        data-testid={`todos-swipe-${todo.id}`}
                      >
                        {face}
                      </SwipeRow>
                    )}
                  />
                );
              })}
            </AppearList>
            )}
          </AppearItem>
        ))}
      </AppearList>
      </PullSlot>

      {/* 页底提示条只这一处（kit ListToasts）：删除的撤销条、出错条、只读提示条，加上打勾、自动完成的“已完成 · 撤销”（r.flow.undoOf） */}
      <ListToasts {...r.toasts} />
    </main>
  );
}

// 今天页、日历日清单的子任务就地展开和日历的待办组、编辑页的“子任务”区从这一包转出（R-350、R-442、R-443）：功能入口 index.ts、TodoEditPage 都按名字懒加载这一个模块，
// 子任务界面不另拆分包（首屏里每多一个分包要多登记一个文件名）。今天页、日历经 inline-subs.ts、day-todos.ts 转一手（A27 要求入口是 lazy(() => import('./…'))）；
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
  /** 副行的截止（R-434、R-436 确认图）：日期一律“月/日”数字，有时刻跟在后面；逾期前面“过期”，今天、明天写字 */
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

/** 副行的几段（R-434）：逾期“过期 11/13 14:00 · 项目”，其余“项目 · 今天 14:00”；空的那段不画，中间用“ · ”连 */
function metaParts(late: boolean, project: string, due: ReactNode) {
  const parts = [{ k: 'p', v: project || null }, { k: 'd', v: due }].filter((x) => x.v);
  return (late ? parts.reverse() : parts).map((x, i) => <Fragment key={x.k}>{i > 0 ? ' · ' : null}{x.v}</Fragment>);
}

/** “已完成 N ›”：组标题本身就是展开 / 收起的按钮（负责人 11-15 方案）；› 的朝向跟着 data-open 转 */
function DoneFold({ title, open, onToggle }: { title: string; open: boolean; onToggle(): void }) {
  return (
    <h2 className={`${groupLabelClass} ${styles.h2}`}>
      <button type="button" className={styles.fold} aria-expanded={open} onClick={onToggle} data-testid="todos-done-fold">
        {title}
        <span className={styles.chev} data-open={open ? '' : undefined} aria-hidden="true">›</span>
      </button>
    </h2>
  );
}

/** 筛选胶囊（R-436 第 3 条）：名字 + 等宽淡色条数 */
function Chip({ on, onClick, name, n, testId }: { on: boolean; onClick(): void; name: string; n: number; testId: string }) {
  return (
    <Pressable className={on ? chip.chipOn : chip.chip} aria-pressed={on} onClick={onClick} data-testid={testId}>
      {name}
      <span className={chip.chipN}>{n}</span>
    </Pressable>
  );
}
