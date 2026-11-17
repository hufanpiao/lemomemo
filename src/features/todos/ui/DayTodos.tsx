// 日历日清单里的待办组（R-443 负责人“日历下面的待办可以点击完成，子任务可以展开”；主持人 11-17 转来的参考图“只参考待办那一行”）：
// • 日程行后面单独一组：组头一行小字“● 待办 · N”（kit 分组小标签，圆点是强调色，条数等宽），下面一块圆角面板（kit List 的 .panel）
// • 每条一行，和待办页同一套 T-A 行（负责人 11-17 选 T-A，主持人 11-17 转来“日清单待办行和 T-A 风格对齐”）：
//   左边 kit 圆角方框勾选框（R-433；有子任务的方框里按做到几成从下往上填、画小脸，kit CheckCircle 的 progress），
//   中间两行——标题（正文色，前面优先级彩点）、副行（有子任务的最前面“起步 / 大半”标签和等宽“1/3”，SubtaskBar.tsx 的 SubStage；
//   再是截止时刻，等宽、次要色，过了截止没完成的红字，R-436；两样都没有不出第二行），行尾 H / M / L 三格并排（kit PrioCycle，点一下换档）。
//   完成的变淡加删除线。不再有“待办”行首标签，时刻不放在左边时刻列
// • 点标题照旧交给日历页的 onOpen（手机进编辑页，电脑开详情抽屉，R-130；只读行在那里拦下）；行按钮带 data-open、抽屉开着的那条 aria-current
// • 打勾就地完成：写入和待办页同一份（hooks/useTodoList.ts 的 useTodoWrites）；勾选特效和待办页同一套分镜（hooks/useDoneFlow.ts、kit List 的 .fold）：
//   勾上加划线 → 停 700ms → 这一行收起、页底升起“已完成 · 撤销”→ 从这一天的清单里拿掉；只读行方框变淡，点了拦下出“要新版本”（kit useListActions）
// • 有子任务的：InlineSubtasks 就地展开、收起、勾选（今天页同一个；勾最后一项自动完成主待办、出“全部完成 · 撤销”）
// • 组内先后：shared/logic/todo-row.ts 的 compareTodos（H → M → L，同档按截止时刻、没时刻的在后，再按创建时间；R-442，待办页、今天页同一个）
// • 哪些待办算这一天：截止日是这一天、没删、没完成（同月历的 todoDate）；完成了还留在原位的照画
// • 在待办列表页那一包里（经 day-todos.ts 懒加载，日历页不多带这一块的代码）
import { Suspense } from 'react';
import { parseHm, type DateStr } from '../../../../shared/core/date.ts';
import { groupLabelClass } from '../../../kit/components/Form.tsx';
import list from '../../../kit/components/List.module.css';
import { ListToasts } from '../../../kit/components/ListToasts.tsx';
import { PrioCycle, PrioDot } from '../../../kit/components/Priority.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { ReadonlyMark, RoCheckCircle } from '../../../kit/components/ReadonlyRow.tsx';
import refine from '../../../kit/components/Refine.module.css';
import { useListActions } from '../../../kit/hooks/useListActions.ts';
import { AppearItem, AppearList, useHoldView } from '../../../motion/components.ts';
import { UnsyncedRemindMark } from '../../reminders/index.ts';
import { useDoneFlow, useLinger, type DoneToast } from '../hooks/useDoneFlow.ts';
import { useDayTodos, useListT } from '../hooks/useTodoList.ts';
import { useSubtaskGroups } from '../hooks/useSubtasks.ts';
import { nextPriority, type Priority } from '../../../../shared/logic/todo-row.ts';
import s from './DayTodos.module.css';
import InlineSubtasks from './InlineSubtasks.tsx';
import { SubStage } from './SubtaskBar.tsx';

export interface DayTodosProps {
  date: DateStr;
  /** 今天、现在是当天第几分钟（设备时区）：给了才把过了截止的时刻标红 */
  today?: DateStr | undefined;
  nowMin?: number | undefined;
  onOpen(kind: 'todo', id: string): void;
  /** 电脑版详情抽屉里开着的那一条（R-130） */
  openId?: string | null | undefined;
}

export default function DayTodos({ date, today, nowMin, onOpen, openId = null }: DayTodosProps) {
  const t = useListT();
  const lg = useLinger();
  const w = useDayTodos(date, lg.ids);
  const hv = useHoldView(w.todos);
  const a = useListActions<DoneToast>('todos', { toggle: w.toggleDone, remove: w.remove }, hv);
  const flow = useDoneFlow(a, lg, hv.hold, { done: t('list.doneToast', {}) }, 'cal-todos');
  const subs = useSubtaskGroups();
  const prioName = (p: Priority) => t(`list.prio.${p}`, {});
  const prio = (id: string, p: Priority) => (a.isRo(id) ? a.g.block() : void w.setPriority(id, p).then(a.report));
  /** 过了截止、还没完成（R-436 红字）：那天已过，或者就是今天、截止时刻已到 */
  const late = (done: boolean, dueTime: string | null): boolean =>
    !done && today !== undefined && (date < today || (date === today && dueTime !== null && nowMin !== undefined && parseHm(dueTime) <= nowMin));

  const toasts = (
    <ListToasts
      g={a.g}
      onUndo={a.undo}
      text={{ deleted: t('list.deleted', {}), undo: t('list.undo', {}), error: t('list.err.save', {}), readonly: t('list.err.readonly', {}) }}
      prefix="cal-todos"
      extra={flow.undoOf}
    />
  );
  if (hv.view.length === 0) return toasts;
  return (
    <section className={s.group} aria-labelledby="cal-todos-head" data-testid="cal-todos">
      <h2 id="cal-todos-head" className={`${groupLabelClass} ${s.head}`}>
        <span className={s.dot} aria-hidden="true" />
        {t('list.dayTodos', {})}
        <span aria-hidden="true"> · </span>
        <span className={refine.num}>{hv.view.length}</span>
      </h2>
      <div className={list.panel}>
        <AppearList as="ul" className={list.list}>
          {hv.view.map((td) => {
            const ro = a.isRo(td.id);
            const checked = a.shown(td.id, td.done);
            const items = subs.get(td.id);
            const subDone = items ? items.filter((x) => x.done).length : 0;
            return (
              <AppearItem
                key={td.id}
                className={`${list.row} ${list.fold}`}
                data-done={checked ? '' : undefined}
                data-out={flow.out.has(td.id) ? '' : undefined}
                data-readonly={ro ? '' : undefined}
                data-testid={`cal-todo-${td.id}`}
              >
                {/* 行（li）里只放这一层行面：kit .fold 收起时这一格 grid 收到 0 */}
                <div className={`${list.swRow} ${s.face}`}>
                <span className={list.lead}>
                  <RoCheckCircle
                    readOnly={ro}
                    checked={checked}
                    label={checked ? t('list.undoDone', {}) : t('list.done', {})}
                    progress={items ? { done: subDone, total: items.length } : undefined}
                    onChange={(v) => flow.check(td.id, v)}
                    testId={`cal-done-${td.id}`}
                  />
                </span>
                <button
                  type="button"
                  className={list.main}
                  onClick={() => onOpen('todo', td.id)}
                  data-kind="todo"
                  data-readonly={ro ? '' : undefined}
                  data-open={td.id}
                  aria-current={openId === td.id ? 'true' : undefined}
                  data-testid={`cal-day-row-${td.id}`}
                >
                  <span className={list.text}>
                    <span className={list.title} data-done={checked ? '' : undefined}><PrioDot p={td.priority} /><span className={list.strike} data-done={checked ? '' : undefined}>{td.title}</span></span>
                    {items || td.dueTime ? (
                      <span className={list.meta}>
                        {items ? <SubStage done={subDone} total={items.length} testId={`cal-stage-${td.id}`} /> : null}
                        {items && td.dueTime ? ' · ' : null}
                        {td.dueTime ? (
                          <span className={s.time} data-tone={late(checked, td.dueTime) ? 'late' : undefined} data-testid={`cal-todo-time-${td.id}`}>
                            {td.dueTime}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                  {ro ? <ReadonlyMark testId={`cal-ro-${td.id}`} /> : null}
                  <span className={list.unsynced}>
                    <QuietBoundary name="unsynced-mark">
                      <Suspense fallback={null}>
                        <UnsyncedRemindMark table="todos" id={td.id} />
                      </Suspense>
                    </QuietBoundary>
                  </span>
                </button>
                {/* 行尾 H / M / L（T-A，同待办页）：点一下换下一档，在行按钮外面（按钮里不能套按钮） */}
                <PrioCycle
                  p={td.priority}
                  label={t('list.prio', { p: prioName(td.priority), next: prioName(nextPriority(td.priority)) })}
                  onChange={(p) => prio(td.id, p)}
                  testId={`cal-prio-${td.id}`}
                />
                {items ? (
                  <InlineSubtasks
                    prefix="cal"
                    id={td.id}
                    title={td.title}
                    readOnly={ro}
                    counted
                    onBlock={() => a.g.block()}
                    onOpen={() => onOpen('todo', td.id)}
                    onPlan={(plan) => flow.plan(td.id, plan)}
                    onResult={(r) => flow.result(td.id, r)}
                  />
                ) : null}
                </div>
              </AppearItem>
            );
          })}
        </AppearList>
      </div>
      {toasts}
    </section>
  );
}
