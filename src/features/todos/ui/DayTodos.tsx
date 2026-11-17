// 日历日清单里的待办组（R-443 负责人“日历下面的待办可以点击完成，子任务可以展开”；主持人 11-17 转来的参考图“只参考待办那一行”）：
// • 日程行后面单独一组：组头一行小字“● 待办 · N”（kit 分组小标签，圆点是强调色，条数等宽），下面一块圆角面板（kit List 的 .panel）；
//   整组是一项进出场，最后一条收完离开时组头跟着淡出；组头 id 用 useId（同一页挂两份也不撞）
// • 每条一行，和待办页同一套 T-A 行（负责人 11-17 选 T-A，主持人 11-17 转来“日清单待办行和 T-A 风格对齐”）：
//   左边 kit 圆角方框勾选框（R-433；有子任务的方框里按做到几成从下往上填、画小脸，kit CheckCircle 的 progress），
//   中间两行——标题（正文色，前面优先级彩点）、副行（有子任务的最前面“起步 / 大半”标签和等宽“1/3”，SubtaskBar.tsx 的 SubStage；
//   再是截止时刻，等宽、次要色，过了截止没完成的红字，R-436；两样都没有不出第二行），行尾 H / M / L 三格并排（kit PrioCycle，点哪格设哪档）。
//   完成的变淡加删除线。不再有“待办”行首标签，时刻不放在左边时刻列。一行画在 TodoRow.tsx、动作在 hooks/useTodoRowActions.ts（待办页同一份），这里只给副行和行按钮属性
// • 点标题照旧交给日历页的 onOpen（手机进编辑页，电脑开详情抽屉，R-130；只读行在那里拦下）；行按钮带 data-open、抽屉开着的那条 aria-current
// • 打勾就地完成：写入和待办页同一份（hooks/useTodoList.ts 的 useTodoWrites）；勾选特效和待办页同一套分镜（hooks/useDoneFlow.ts、kit List 的 .fold）：
//   勾上加划线 → 停 700ms → 这一行收起、页底升起“已完成 · 撤销”→ 从这一天的清单里拿掉；只读行方框变淡，点了拦下出“要新版本”（kit useListActions）
// • 有子任务的：InlineSubtasks 就地展开、收起、勾选（今天页同一个；勾最后一项自动完成主待办、出“全部完成 · 撤销”）
// • 组内先后：shared/logic/todo-row.ts 的 compareTodos（H → M → L，同档按截止时刻、没时刻的在后，再按创建时间；R-442，待办页、今天页同一个）
// • 哪些待办算这一天：截止日是这一天、没删、没完成（同月历的 todoDate）；完成了还留在原位的照画
// • 在待办列表页那一包里（经 day-todos.ts 懒加载，日历页不多带这一块的代码）
import { useId } from 'react';
import { parseHm, type DateStr } from '../../../../shared/core/date.ts';
import { groupLabelClass } from '../../../kit/components/Form.tsx';
import list from '../../../kit/components/List.module.css';
import { ListToasts } from '../../../kit/components/ListToasts.tsx';
import refine from '../../../kit/components/Refine.module.css';
import { AppearItem, AppearList } from '../../../motion/components.ts';
import { useLinger } from '../hooks/useDoneFlow.ts';
import { useDayTodos } from '../hooks/useTodoList.ts';
import { useSubtaskGroups } from '../hooks/useSubtasks.ts';
import { useTodoRowActions } from '../hooks/useTodoRowActions.ts';
import s from './DayTodos.module.css';
import { TodoRow, type TodoRowIds } from './TodoRow.tsx';

/** 行里各处的测试 id 前缀（ui/TodoRow.tsx） */
const IDS: TodoRowIds = { row: 'cal-todo', done: 'cal-done', prio: 'cal-prio', stage: 'cal-stage', ro: 'cal-ro', subs: 'cal' };

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
  const headId = useId();
  const lg = useLinger();
  const w = useDayTodos(date, lg.ids);
  // 行的动作（待办页同一份，hooks/useTodoRowActions.ts）：打勾、勾完子任务的停留、收起、撤销条，换档，只读拦截，出错条
  const r = useTodoRowActions(w.todos, lg, w, 'cal-todos');
  const subs = useSubtaskGroups();
  /** 过了截止、还没完成（R-436 红字）：那天已过，或者就是今天、截止时刻已到 */
  const late = (done: boolean, dueTime: string | null): boolean =>
    !done && today !== undefined && (date < today || (date === today && dueTime !== null && nowMin !== undefined && parseHm(dueTime) <= nowMin));

  return (
    <>
      {/* 整组也是一项进出场（motion AppearItem）：最后一条收完离开时，组头和面板一起淡出，不瞬间消失 */}
      <AppearList as="div">
        {r.view.length ? (
          <AppearItem as="section" key="todos" className={s.group} aria-labelledby={headId} data-testid="cal-todos">
            <h2 id={headId} className={`${groupLabelClass} ${s.head}`}>
              <span className={s.dot} aria-hidden="true" />
              {r.t('list.dayTodos', {})}
              <span aria-hidden="true"> · </span>
              <span className={refine.num}>{r.view.length}</span>
            </h2>
            <div className={list.panel}>
              <AppearList as="ul" className={list.list}>
                {r.view.map((td) => (
                  <TodoRow
                    key={td.id}
                    r={r}
                    todo={td}
                    subs={subs.get(td.id)}
                    ids={IDS}
                    onOpen={() => onOpen('todo', td.id)}
                    // 点标题交给日历页（手机进编辑页，电脑开详情抽屉，R-130）；data-open 给日历页认行，抽屉开着的那条 aria-current
                    main={{ kind: 'todo', open: td.id, current: openId === td.id, testId: `cal-day-row-${td.id}` }}
                    // 副行：有子任务的“起步 · 1/3”、截止时刻（等宽、次要色，过了截止没完成的红字）；两样都没有不出第二行
                    meta={(stage, checked) =>
                      stage || td.dueTime ? (
                        <span className={list.meta}>
                          {stage}
                          {stage && td.dueTime ? ' · ' : null}
                          {td.dueTime ? (
                            <span className={s.time} data-tone={late(checked, td.dueTime) ? 'late' : undefined} data-testid={`cal-todo-time-${td.id}`}>
                              {td.dueTime}
                            </span>
                          ) : null}
                        </span>
                      ) : null
                    }
                  />
                ))}
              </AppearList>
            </div>
          </AppearItem>
        ) : null}
      </AppearList>
      <ListToasts {...r.toasts} />
    </>
  );
}
