// 待办列表页（B2 FA-2；定稿线框 s6；架构 5.9“项目筛选”；R-134、R-136）
// • 顶部项目筛选条：“全部 / 各项目 + 条数”，只作用于这一页（不写 settings）
// • 分组：过期（标红：逾 N 天 / 已过 17:00）→ 今天 → 明天 → 7 天内按日期 → 以后 → 没有日期 → 已完成
// • 每行：打勾（就地保存）、标题（常规字重）、截止标签（“今天 17:00 截止”）、删除（软删 + 8 秒撤销条）；点标题进编辑页
// • 只读行（FA-2 只读行界面；架构 0.27 第 1 点）：行尾“要新版本”标记，圆圈变淡；点这一行、打勾、删除统一拦下（不进编辑页、不写），
//   出提示条“这条要新版本才能修改 · 更新”（kit 的 useReadonlyGuard、ReadonlyToast）。只读 id 来自 core 的 readonlyIds。
//   左滑和多选这一页还没有，以后加的时候照样先看 ro.has(id)
// • 行尾“未同步”小标记（REMIND-wiring；TC-B2-69；reminders 的 UnsyncedRemindMark 懒加载）：带提醒、还没同步上的那条标，在行按钮里、
//   标题和截止标签的右边；只看本机待同步队列，同日历页直接挂、不等提醒引擎（今天页待办 代码审查 M1），没有时那一格不画
// • 动效（17.1“勾选完成”“列表增删”，B2 FA-5；设计审查 M1～M3 返工 11-04）：打勾时圆圈在原地填满（CSS，--dur-ui），
//   列表先不动（useHoldView 留住按下之前的分组）；然后这一条从原来的组淡出、同时下面的行收上来，“已完成”组让开位置后它再淡入。
//   删除：淡出和收拢同时；撤销恢复：先让开位置再淡入（不和别的行叠着）。第一次画列表不播。分组整组出现、消失同样淡入淡出。
//   打勾没有撤销条（只有删除有）：点错了在圆圈填满的那 --dur-ui 里还能再点回去，开始离开以后要到“已完成”组里再点
// • 子任务（R-350 方案 5.1、5.4、5.5）：有子任务的待办，副行最前面是“已勾/总数”，行下面摊开勾选清单、底部分段进度条、右下“收起 / 展开”
//   （SubtaskCard；收起状态每台设备各记各的，未完成默认展开、已完成默认收起）。列表页只能勾，加删改在编辑页（Q10）。
//   勾子任务：主待办只读或这一项只读 → 拦下出“要新版本”；勾上最后一项 → 主待办自动完成，先留住分组 --dur-ui（看到满格）再挪到“已完成”组，
//   页底出“全部完成，已完成这条待办 · 撤销”（对“打勾没有撤销条”开的例外，方案 5.5；撤销时刚勾的那项和主待办一起撤回，Q1）；
//   主待办已完成时取消勾某项 → 主待办改回未完成、卡片挪回原来的组，不出撤销条（Q2）。运行日志 todo sub auto done|undone 在 data 层记（不记标题）
import { Suspense } from 'react';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { navigate } from '../../../app/router.ts';
import list from '../../../kit/components/List.module.css';
import { ListToasts } from '../../../kit/components/ListToasts.tsx';
import { ReadonlyMark, RoCheckCircle } from '../../../kit/components/ReadonlyRow.tsx';
import { MeLink } from '../../../kit/components/MeLink.tsx';
import { useRoT } from '../../../kit/hooks/useRoT.ts';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { useListActions } from '../../../kit/hooks/useListActions.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { AppearItem, AppearList, Pressable, useHoldView } from '../../../motion/components.ts';
import { useListT, useTodoList, type DueTag, type Group } from '../hooks/useTodoList.ts';
import { setCollapsed, useCollapsed } from '../hooks/useSubtasks.ts';
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
  const tRo = useRoT();
  const locale = useUi((s) => s.locale);
  const l = useTodoList();
  // 打勾先留住按下之前的分组 --dur-ui（圆圈在原地填满，17.1 勾选完成）；只读行统一拦下；撤销条、出错条也在 a.g 里（kit 的 useListActions）
  const hv = useHoldView(l.groups);
  const a = useListActions<AutoToast>('todos', { toggle: l.toggleDone, remove: l.remove }, hv);
  const { isRo, tick, shown, del } = a;
  const open = (id: string) => (isRo(id) ? a.g.block() : void navigate('todo', id));
  const roSubs = useReadonlyIds('todo_items');
  const isCollapsed = useCollapsed();
  const fold = (id: string, v: boolean) => setCollapsed(id, v, l.ids);   // 全部待办的 id（不按项目筛选，免得剔掉别的项目点过的）
  const tickSub = (todoId: string, itemId: string, on: boolean) => {
    if (isRo(todoId) || roSubs.has(itemId)) return a.g.block();
    // 会顺带改主待办（挪组）：先留住按下之前的分组 --dur-ui，满格看清了再挪
    if (l.planAuto(todoId, itemId, on) !== null) hv.hold();
    void l.tickSub(todoId, itemId, on).then(({ res, auto }) => {
      if (res === 'ok' && auto === true) a.g.show({ kind: 'auto', todoId, itemId });
      else a.report(res);
    });
  };

  // 自动完成的撤销条（方案 5.5）：和删除的撤销条同一组件、同一位置，同时只出一条
  // 是函数不是组件：页面每次重画都返回同一种元素，撤销条的 8 秒计时不重来
  const autoToast = (x: AutoToast) => (
    <UndoToast
      key={`${x.todoId}:${x.itemId}`}
      message={t('items.autoDone', {})}
      undoLabel={t('list.undo', {})}
      onUndo={() => void l.undoAuto(x.todoId, x.itemId).then(a.report)}
      onClose={() => a.g.dismiss(x)}
      data-testid="todos-auto-toast"
    />
  );

  const groupTitle = (g: Group): string => {
    switch (g.key) {
      case 'late': return t('list.g.late', {});
      case 'today': return t('list.g.today', {});
      case 'tomorrow': return t('list.g.tomorrow', {});
      case 'day': return fmtDay(g.date ?? '', locale, 'monthDayWeek');
      case 'later': return t('list.g.later', {});
      case 'nodate': return t('list.g.nodate', {});
      case 'done': return t('list.g.done', {});
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

  return (
    <main className={styles.page} data-feature="todos" data-testid="todos">
      <header className={styles.top}>
        <h1 className={styles.h1}>{t('list.title', {})}</h1>
        {/* 新建待办在底栏的“＋”（负责人 11-05 ③，原来右上角的“＋ 新建”去掉）；右上角是设置入口头像（R-381，四页共用 MeLink） */}
        <MeLink testId="todos-settings" />
      </header>

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
            <h2 className={styles.h2}>{groupTitle(g)}</h2>
            <AppearList as="ul" className={list.list}>
              {g.items.map(({ todo, tag }) => {
                const subs = l.subs.get(todo.id);
                const prog = subs ? t('items.progress', { done: subs.filter((x) => x.done).length, total: subs.length }) : '';
                return (
                <AppearItem
                  key={todo.id}
                  className={subs ? `${list.row} ${styles.hasSubs}` : list.row}
                  data-done={todo.done ? '' : undefined}
                  data-readonly={isRo(todo.id) ? '' : undefined}
                  data-testid={`todos-row-${todo.id}`}
                >
                  <span className={list.lead}>
                    <RoCheckCircle
                      readOnly={isRo(todo.id)}
                      checked={shown(todo.id, todo.done)}
                      label={shown(todo.id, todo.done) ? t('list.undoDone', {}) : t('list.done', {})}
                      onChange={(v) => tick(todo.id, v)}
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
                  {/* 只读行的 × 和打勾圆圈一样（FA-2 视觉验收第二轮第 1 条、代码复查二）：变淡、aria-disabled、读屏名字后接“要更新到新版本才能修改”；
                      点了照样由 del 里的 useReadonlyGuard 拦下出提示条、不写 */}
                  <Pressable
                    className={list.trail}
                    aria-label={isRo(todo.id) ? tRo('ro.named', { label: t('list.delete', {}) }) : t('list.delete', {})}
                    aria-disabled={isRo(todo.id) || undefined}
                    onClick={() => void del(todo.id)}
                    data-testid={`todos-del-${todo.id}`}
                    data-no-proxy=""
                  >
                    ×
                  </Pressable>
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
                </AppearItem>
                );
              })}
            </AppearList>
          </AppearItem>
        ))}
      </AppearList>

      {a.g.toast?.kind === 'auto' ? (
        autoToast(a.g.toast)
      ) : null}
      <ListToasts
        g={a.g}
        onUndo={a.undo}
        text={{ deleted: t('list.deleted', {}), undo: t('list.undo', {}), error: t('list.err.save', {}), readonly: t('list.err.readonly', {}) }}
        prefix="todos"
      />
    </main>
  );
}

/** 勾上最后一项、主待办自动完成以后的撤销条里带的东西（R-350 方案 5.5） */
type AutoToast = { kind: 'auto'; todoId: string; itemId: string };

// 今天页的子任务进度、编辑页的“子任务”区从这一包转出（R-350）：功能入口 index.ts、TodoEditPage 都按名字懒加载这一个模块，
// 子任务界面不另拆分包（首屏里每多一个分包要多登记一个文件名）。今天页经 today-subs.ts 转一手（A27 要求入口是 lazy(() => import('./…'))）；
// 今天页有待办时首屏画完就会下载这一包（不是点进待办页才下），换来不多占首屏
export { default as TodaySubtasks } from './TodaySubtasks.tsx';
export { default as SubtaskEditor } from './SubtaskEditor.tsx';

function Chip({ on, onClick, label, testId }: { on: boolean; onClick(): void; label: string; testId: string }) {
  return (
    <Pressable className={on ? styles.chipOn : styles.chip} aria-pressed={on} onClick={onClick} data-testid={testId}>
      {label}
    </Pressable>
  );
}
