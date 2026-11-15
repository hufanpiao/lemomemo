// 待办列表页（B2 FA-2；定稿线框 s6；架构 5.9“项目筛选”；R-134、R-136）
// • 顶部项目筛选条：“全部 / 各项目 + 条数”，只作用于这一页（不写 settings）
// • 分组：过期（标红：逾 N 天 / 已过 17:00）→ 今天 → 明天 → 7 天内按日期 → 以后 → 没有日期 → 已完成
// • 每行：打勾（就地保存）、标题（常规字重）、截止标签（“今天 17:00 截止”）；点标题进编辑页。
//   删除（软删 + 8 秒撤销条）：左滑露出“删除”，一口气拉过大半行直接删（负责人 11-15 去掉行尾 ×，kit 的 SwipeRow，电脑上鼠标也能拖）；
//   键盘、读屏进编辑页在那里删（编辑页有“删除”）
// • 只读行（FA-2 只读行界面；架构 0.27 第 1 点）：行尾“要新版本”标记，圆圈变淡；点这一行、打勾、删除统一拦下（不进编辑页、不写），
//   出提示条“这条要新版本才能修改 · 更新”（kit 的 useReadonlyGuard、ReadonlyToast）。只读 id 来自 core 的 readonlyIds。
//   左滑：只读行不能滑（SwipeRow disabled）；多选这一页还没有，以后加的时候照样先看 ro.has(id)
// • 行尾“未同步”小标记（REMIND-wiring；TC-B2-69；reminders 的 UnsyncedRemindMark 懒加载）：带提醒、还没同步上的那条标，在行按钮里、
//   标题和截止标签的右边；只看本机待同步队列，同日历页直接挂、不等提醒引擎（今天页待办 代码审查 M1），没有时那一格不画
// • 动效（17.1“勾选完成”“列表增删”，B2 FA-5；设计审查 M1～M3 返工 11-04）：打勾时圆圈在原地填满（CSS，--dur-ui），
//   列表先不动（useHoldView 留住按下之前的分组）；然后这一条从原来的组淡出、同时下面的行收上来，“已完成”组让开位置后它再淡入。
//   删除：淡出和收拢同时；撤销恢复：先让开位置再淡入（不和别的行叠着）。第一次画列表不播。分组整组出现、消失同样淡入淡出。
// • 已完成组折叠（负责人 11-15“完成的待办怎么隐藏比较好”，已选方案）：列表最下面只留一行“已完成 N ›”（按钮，aria-expanded），点开展开、再点收起；
//   默认收起，展开没有记在本机 meta 的 ui.todo_done_open（hooks/useSubtasks.ts 的 useDoneOpen，每台设备各记各的）。
// • 完成以后离开原位（审查 11-15 第 4 条收成一套）：打勾完成、勾完最后一个子任务自动完成走同一条路——这一条记进 linger（集合），
//   页底出“已完成 · 撤销”（DONE_LINGER_MS 约 3 秒，solo keep，后出的顶掉前一条；鼠标停在条上时一起多留），两种只差文案和撤销做什么（onUndo）。
//   撤销条开着期间勾过的都留在原位，最后一条撤销条收起（到时、被删除的撤销条或出错条顶掉）时一起归进“已完成”组。
//   点了撤销、或自己把圆圈点回去：那一条等写入完成（promise 回来）才从 linger 里拿掉，不靠 useHoldView 停一拍的时机兜底。
//   分组时怎么留在原位在 data/todo-list.ts 的 linger
// • 子任务（R-350 方案 5.1、5.4、5.5）：有子任务的待办，副行最前面是“已勾/总数”，行下面摊开勾选清单、底部分段进度条、右下“收起 / 展开”
//   （SubtaskCard；收起状态每台设备各记各的，未完成默认展开、已完成默认收起）。列表页只能勾，加删改在编辑页（Q10）。
//   勾子任务：主待办只读或这一项只读 → 拦下出“要新版本”；勾上最后一项 → 主待办自动完成，和打勾一样留在原位、出撤销条
//   （文案“全部完成，已完成这条待办”，方案 5.5；撤销时刚勾的那项和主待办一起撤回，Q1）；
//   主待办已完成时取消勾某项 → 主待办改回未完成，先留住分组 --dur-ui 再挪回原来的组，不出撤销条（Q2）。运行日志 todo sub auto done|undone 在 data 层记（不记标题）
// • “最近删除”入口（审查 11-15 第 2 条）：标题下面居中一个（kit 的 TrashLink，同随手记页），去 #/trash
import { Suspense, useMemo, useRef, useState } from 'react';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { navigate } from '../../../app/router.ts';
import list from '../../../kit/components/List.module.css';
import { ListToasts, type ExtraUndo } from '../../../kit/components/ListToasts.tsx';
import { ReadonlyMark, RoCheckCircle } from '../../../kit/components/ReadonlyRow.tsx';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { SwipeRow } from '../../../kit/components/SwipeRow.tsx';
import { TrashLink } from '../../../kit/components/TrashLink.tsx';
import { rlog } from '../../../platform/run-log-api.ts';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { useListActions } from '../../../kit/hooks/useListActions.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList, Pressable, useHoldView } from '../../../motion/components.ts';
import { useListT, useTodoList, type DueTag, type Group } from '../hooks/useTodoList.ts';
import { setCollapsed, setDoneOpen, useCollapsed, useDoneOpen } from '../hooks/useSubtasks.ts';
import { SubtaskCard } from './SubtaskCard.tsx';
import { UnsyncedRemindMark } from '../../reminders/index.ts';
import styles from './TodosPage.module.css';

/** 行尾“未同步”小标记：没有时那一格是空的，CSS 里 :empty 不画 */
function RowMark({ id }: { id: string }) {
  return (
    <span className={list.unsynced}>
      <QuietBoundary name="unsynced-mark">
        <Suspense fallback={null}>
          <UnsyncedRemindMark table="todos" id={id} />
        </Suspense>
      </QuietBoundary>
    </span>
  );
}

export default function TodosPage() {
  const t = useListT();
  const locale = useUi((s) => s.locale);
  // 完成以后先留在原位的那几条：跟着页底“已完成 · 撤销”条走（条在 a.g 里，a 又要用 l，所以记一份、画的时候对上，见下面）
  const lg = useLinger();
  const l = useTodoList(lg.ids);
  // 打勾先留住按下之前的分组 --dur-ui（圆圈在原地填满，17.1 勾选完成）；只读行统一拦下；撤销条、出错条也在 a.g 里（kit 的 useListActions）
  const hv = useHoldView(l.groups);
  const a = useListActions<DoneToast>('todos', { toggle: l.toggleDone, remove: l.remove }, hv);
  const { isRo, tick, shown, del } = a;
  const doneToast = a.g.toast?.kind === 'done' ? a.g.toast : null;
  // 撤销条都收起了：留在原位的一起归进“已完成”。画的时候就对上（React 的“画时调整状态”，不等 effect、不闪一帧）
  if (!doneToast) lg.sweep();
  const seq = useRef(0);
  /** 完成了、先留在原位：记进 linger、出撤销条（打勾和自动完成同一条路；sub 是自动完成时刚勾的那一项） */
  const stay = (id: string, sub: string | null) => {
    lg.put(id, false);
    seq.current += 1;
    a.g.show({ kind: 'done', id, sub, n: seq.current });
  };
  // 打勾出撤销条；把留在原位的那一条自己点回去 = 撤销（撤销条是它的就一起收起；只读行 tick 里已拦下）
  const check = (id: string, v: boolean) => {
    const write = tick(id, v);
    if (isRo(id)) return;
    if (v) return stay(id, null);
    lg.settle(id, write);
    if (doneToast?.id === id) a.g.dismiss(doneToast);
  };
  const open = (id: string) => (isRo(id) ? a.g.block() : void navigate('todo', id));
  const roSubs = useReadonlyIds('todo_items');
  const isCollapsed = useCollapsed();
  const fold = (id: string, v: boolean) => setCollapsed(id, v, l.ids);   // 全部待办的 id（不按项目筛选，免得剔掉别的项目点过的）
  const doneOpen = useDoneOpen();
  const tickSub = (todoId: string, itemId: string, on: boolean) => {
    if (isRo(todoId) || roSubs.has(itemId)) return a.g.block();
    const plan = l.planAuto(todoId, itemId, on);
    // 会自动完成：写之前先记进 linger、标成写入还没回来（当场留在原位，写完出撤销条）；会改回未完成：先留住按下之前的分组 --dur-ui 再挪回去（Q2）
    if (plan === true) lg.put(todoId, true);
    else if (plan === false) hv.hold();
    void l.tickSub(todoId, itemId, on).then(({ res, auto }) => {
      if (res === 'ok' && auto === true) return stay(todoId, itemId);
      if (plan === true) lg.drop(todoId);   // 没自动完成（出错、被别处抢先改了）：不留
      a.report(res);
    });
  };
  /** 撤销条的文案和撤销做什么：打勾的撤销 = 再点一下圆圈（core/todo-done.ts 按撤销写回原来的 done_at）；自动完成的撤销连刚勾的那项一起撤回（Q1） */
  const undoOf = (x: DoneToast): ExtraUndo => ({
    key: `done:${x.n}`,
    message: t(x.sub === null ? 'list.doneToast' : 'items.autoDone', {}),
    onUndo: () => lg.settle(x.id, x.sub === null ? tick(x.id, false) : l.undoAuto(x.id, x.sub).then(a.report)),
    ms: DONE_LINGER_MS,
    testId: x.sub === null ? 'todos-done-toast' : 'todos-auto-toast',
  });

  const { groupTitle, tagText } = labelsOf(t, locale);

  return (
    <main className={styles.page} data-feature="todos" data-testid="todos">
      <header className={styles.top}>
        <h1 className={styles.h1}>{t('list.title', {})}</h1>
        {/* 新建待办在底栏的“＋”（负责人 11-05 ③，原来右上角的“＋ 新建”去掉）；右上角是设置入口头像（R-381，四页共用 MeLink） */}
        <MeLink testId="todos-settings" />
      </header>
      <TrashLink to={['trash']} label={t('list.trash', {})} testId="todos-open-trash" />

      {l.projects.length ? (
        <div className={styles.filter} role="group" aria-label={t('list.filter', {})} data-testid="todos-filter">
          <Chip on={l.project === null} onClick={() => l.setProject(null)} label={t('list.all', {})} testId="todos-filter-all" />
          {l.projects.map((p) => (
            <Chip key={p.project} on={l.project === p.project} onClick={() => l.setProject(p.project)} label={`${p.project} ${p.count}`} testId={`todos-filter-${p.project}`} />
          ))}
        </div>
      ) : null}

      {hv.view.length === 0 ? <p className={list.empty}>{t('list.empty', {})}</p> : null}
      <AppearList as="div">
        {hv.view.map((g) => (
          <AppearItem
            as="section"
            key={`${g.key}:${g.date ?? ''}`}
            className={g.key === 'late' ? `${styles.group} ${styles.late}` : styles.group} data-testid={`todos-g-${g.key}${g.date ? `-${g.date}` : ''}`}>
            {g.key === 'done' ? (
              <DoneFold title={groupTitle(g)} open={doneOpen} onToggle={() => setDoneOpen(!doneOpen)} />
            ) : (
              <h2 className={styles.h2}>{groupTitle(g)}</h2>
            )}
            {g.key === 'done' && !doneOpen ? null : (
            <AppearList as="ul" className={`${list.list} ${list.roomy}`}>
              {g.items.map(({ todo, tag }) => {
                const subs = l.subs.get(todo.id);
                const prog = subs ? t('items.progress', { done: subs.filter((x) => x.done).length, total: subs.length }) : '';
                return (
                <AppearItem
                  key={todo.id}
                  className={list.row}
                  data-done={todo.done ? '' : undefined}
                  data-readonly={isRo(todo.id) ? '' : undefined}
                  data-testid={`todos-row-${todo.id}`}
                >
                  {/* 左滑删除（负责人 11-15 去掉行尾 ×）：露出“删除”点了删，一口气拉过大半行直接删（kit SwipeRow 的 full）；只读行不能滑 */}
                  <SwipeRow
                    className={list.swp}
                    disabled={isRo(todo.id)}
                    full="del"
                    log={rlog}
                    actions={[{ key: 'del', label: t('list.delete', {}), danger: true, onClick: () => void del(todo.id), testId: `todos-swipe-del-${todo.id}` }]}
                    data-testid={`todos-swipe-${todo.id}`}
                  >
                  <div className={subs ? `${list.swRow} ${styles.hasSubs}` : list.swRow}>
                  <span className={list.lead}>
                    <RoCheckCircle
                      readOnly={isRo(todo.id)}
                      checked={shown(todo.id, todo.done)}
                      label={shown(todo.id, todo.done) ? t('list.undoDone', {}) : t('list.done', {})}
                      onChange={(v) => check(todo.id, v)}
                      testId={`todos-done-${todo.id}`}
                    />
                  </span>
                  <button type="button" className={list.main} onClick={() => open(todo.id)}>
                    <span className={list.text}>
                      <span className={list.title}>{todo.title}</span>
                      <span className={tag.kind === 'late' ? `${list.meta} ${styles.tagLate}` : list.meta} data-testid={`todos-tag-${todo.id}`}>
                        {[prog, todo.important ? t('list.important', {}) : '', todo.project, tagText(tag)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {isRo(todo.id) ? <ReadonlyMark testId={`todos-ro-${todo.id}`} /> : null}
                    <RowMark id={todo.id} />
                  </button>
                  {subs ? (
                    <SubtaskCard
                      todoId={todo.id}
                      todoTitle={todo.title}
                      items={subs}
                      collapsed={isCollapsed(todo.id, todo.done)}
                      onCollapse={(v) => fold(todo.id, v)}
                      onTick={(itemId, on) => tickSub(todo.id, itemId, on)}
                      onOpen={() => open(todo.id)}
                      readOnly={(itemId) => isRo(todo.id) || roSubs.has(itemId)}
                    />
                  ) : null}
                  </div>
                  </SwipeRow>
                </AppearItem>
                );
              })}
            </AppearList>
            )}
          </AppearItem>
        ))}
      </AppearList>

      {/* 页底提示条只这一处（kit ListToasts）：删除的撤销条、出错条、只读提示条，加上打勾、自动完成的“已完成 · 撤销”（undoOf） */}
      <ListToasts
        g={a.g}
        onUndo={a.undo}
        text={{ deleted: t('list.deleted', {}), undo: t('list.undo', {}), error: t('list.err.save', {}), readonly: t('list.err.readonly', {}) }}
        prefix="todos"
        extra={undoOf}
      />
    </main>
  );
}

/** 完成以后的撤销条（负责人 11-15 方案；R-350 方案 5.5 的自动完成同一种）：sub 是自动完成时刚勾的那一项（打勾完成是 null），n 每出一条加一（换一条重新计时） */
type DoneToast = { kind: 'done'; id: string; sub: string | null; n: number };
/** 撤销条开着期间勾过的在原位留多久（撤销条同样长；负责人 11-15 选的“约 3 秒”） */
const DONE_LINGER_MS = 3000;
const NO_LINGER: ReadonlyMap<string, boolean> = new Map();

/**
 * 完成以后先留在原位的那几条（id → 有写入还没回来；见文件头）：ids 给分组（data/todo-list.ts 的 linger）；
 * put 记进来（pending 为 true：写入还没回来，撤销条收起也先不放）；drop 拿掉；settle 撤销这一条，写完（promise 回来）才拿掉，这之前一直留在原位；
 * sweep 撤销条都收起时调，没有写入在等的一起放走
 */
function useLinger() {
  const [m, setM] = useState<ReadonlyMap<string, boolean>>(NO_LINGER);
  const ids = useMemo(() => new Set(m.keys()), [m]);
  const drop = (id: string) => setM((x) => (x.has(id) ? new Map([...x].filter(([k]) => k !== id)) : x));
  return {
    ids,
    put: (id: string, pending: boolean) => setM((x) => new Map(x).set(id, pending)),
    drop,
    settle(id: string, write: Promise<unknown>) {
      setM((x) => (x.has(id) ? new Map(x).set(id, true) : x));
      void write.then(() => drop(id));
    },
    sweep() {
      if ([...m.values()].some((pending) => !pending)) setM(new Map([...m].filter(([, pending]) => pending)));
    },
  };
}

// 今天页的子任务进度、编辑页的“子任务”区从这一包转出（R-350）：功能入口 index.ts、TodoEditPage 都按名字懒加载这一个模块，
// 子任务界面不另拆分包（首屏里每多一个分包要多登记一个文件名）。今天页经 today-subs.ts 转一手（A27 要求入口是 lazy(() => import('./…'))）；
// 今天页有待办时首屏画完就会下载这一包（不是点进待办页才下），换来不多占首屏
export { default as TodaySubtasks } from './TodaySubtasks.tsx';
export { default as SubtaskEditor } from './SubtaskEditor.tsx';

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
  const tagText = (tag: DueTag): string => {
    switch (tag.kind) {
      case 'none': return '';
      case 'late': return tag.days > 0 ? t('list.tag.late', { n: tag.days }) : t('list.tag.passed', { t: tag.dueTime ?? '' });
      case 'today': return tag.dueTime ? t('list.tag.todayAt', { t: tag.dueTime }) : t('list.tag.today', {});
      case 'tomorrow': return tag.dueTime ? t('list.tag.tomorrowAt', { t: tag.dueTime }) : t('list.tag.tomorrow', {});
      case 'date': {
        const date = fmtDay(tag.date, locale, 'monthDay');
        return tag.dueTime ? t('list.tag.dateAt', { date, t: tag.dueTime }) : t('list.tag.date', { date });
      }
    }
  };
  return { groupTitle, tagText };
}

/** “已完成 N ›”：组标题本身就是展开 / 收起的按钮（负责人 11-15 方案）；› 的朝向跟着 data-open 转 */
function DoneFold({ title, open, onToggle }: { title: string; open: boolean; onToggle(): void }) {
  return (
    <h2 className={styles.h2}>
      <button type="button" className={styles.fold} aria-expanded={open} onClick={onToggle} data-testid="todos-done-fold">
        {title}
        <span className={styles.chev} data-open={open ? '' : undefined} aria-hidden="true">›</span>
      </button>
    </h2>
  );
}

function Chip({ on, onClick, label, testId }: { on: boolean; onClick(): void; label: string; testId: string }) {
  return (
    <Pressable className={on ? styles.chipOn : styles.chip} aria-pressed={on} onClick={onClick} data-testid={testId}>
      {label}
    </Pressable>
  );
}
