// 一条待办行（T-A，负责人 11-17 选定；主持人 11-17 评审去重）：待办页和日历日清单的待办组（R-443）原来各画一份，合成这一个，
// 两边不同的只有副行（meta 插槽）、行按钮多出来的属性（main）、行面外面要不要套左滑删除（wrap，待办页的 SwipeRow）
// • 结构：li.row.fold（kit List.module.css；data-done、data-out、data-readonly 只打在这一层）> .foldBody（收起时淡出的那一层）> 行面 .swRow：
//   左边 kit 圆角方框（有子任务的按做到几成填、画小脸，kit CheckCircle 的 progress）｜ 行按钮（彩点 + 标题、副行、只读标记、未同步标记）｜
//   行尾 H / M / L 三格（kit PrioCycle）｜ 有子任务时折到下一行的子任务卡片（InlineSubtasks，kit 认卡片的 data-subcard 让行折行）
// • 标题文字外面那层 .strike 也带 data-done：划线要从左往右画（背景线的 background-size 过渡），会动的属性状态得写在元素自身上
//   （样式规则 lemo/reduced-motion-override），这是“data-done 只打在行上”的唯一例外；字色、变淡都认行上的
// • data-row（前缀）、data-row-id：hooks/useDoneFlow.ts 收完这一行前找下一行的方框、把焦点移过去
// • 动作和文案都从 hooks/useTodoRowActions.ts 来（r），这里只画
import { Suspense, type ReactNode } from 'react';
import list from '../../../kit/components/List.module.css';
import { PrioCycle, PrioDot } from '../../../kit/components/Priority.tsx';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { ReadonlyMark, RoCheckCircle } from '../../../kit/components/ReadonlyRow.tsx';
import { AppearItem } from '../../../motion/components.ts';
import type { Priority } from '../../../../shared/logic/todo-row.ts';
import { UnsyncedRemindMark } from '../../reminders/index.ts';
import type { TodoRowActions } from '../hooks/useTodoRowActions.ts';
import InlineSubtasks from './InlineSubtasks.tsx';
import { SubStage } from './SubtaskBar.tsx';

/** 行里各处的测试 id 前缀（后面接 -<id>）；subs 是 InlineSubtasks 的前缀（todos、cal） */
export interface TodoRowIds {
  row: string;
  done: string;
  prio: string;
  stage: string;
  ro: string;
  subs: string;
}

export interface TodoRowProps {
  r: TodoRowActions;
  todo: Readonly<{ id: string; title: string; priority: Priority; done: boolean }>;
  /** 子任务（有才给）：方框的进度、副行的“起步 · 1/3”、下面的卡片都按它 */
  subs: readonly Readonly<{ done: boolean }>[] | undefined;
  ids: TodoRowIds;
  onOpen(): void;
  /** 子任务卡片收起没有：待办页给（每台设备各记各的），日清单不给 */
  collapsed?: boolean | undefined;
  onCollapse?: ((v: boolean) => void) | undefined;
  /** 副行：stage 是有子任务时的“起步 · 1/3”（没有子任务是 null），checked 是方框现在画成什么；回 null 就不出第二行 */
  meta(stage: ReactNode, checked: boolean): ReactNode;
  /** 日清单的行按钮多出来的几样：data-kind、data-open（日历页认行）、抽屉开着的那条 aria-current、测试 id；给了还带 data-readonly */
  main?: Readonly<{ kind: string; open: string; current: boolean; testId: string }> | undefined;
  /** 标题文字怎么画（待办页下拉搜索就地筛时给命中的字加短下划线，kit PullHit；不给原样） */
  mark?(text: string): ReactNode;
  /** 行面外面再包一层（待办页的左滑删除 SwipeRow） */
  wrap?(face: ReactNode): ReactNode;
}

export function TodoRow({ r, todo, subs, ids, onOpen, collapsed, onCollapse, meta, main, mark, wrap }: TodoRowProps) {
  const { t, a, flow } = r;
  const id = todo.id;
  const ro = a.isRo(id);
  const checked = flow.shown(id, todo.done);
  const subDone = subs ? subs.filter((x) => x.done).length : 0;
  const face = (
    <div className={list.swRow}>
      <span className={list.lead}>
        <RoCheckCircle
          readOnly={ro}
          checked={checked}
          label={checked ? t('list.undoDone', {}) : t('list.done', {})}
          progress={subs ? { done: subDone, total: subs.length } : undefined}
          onChange={(v) => flow.check(id, v)}
          testId={`${ids.done}-${id}`}
        />
      </span>
      <button
        type="button"
        className={list.main}
        onClick={onOpen}
        data-kind={main?.kind}
        data-readonly={main && ro ? '' : undefined}
        data-open={main?.open}
        aria-current={main?.current ? 'true' : undefined}
        data-testid={main?.testId}
      >
        <span className={list.text}>
          {/* 标题前一个优先级彩点（R-434）；划线只画在文字上 */}
          <span className={list.title}>
            <PrioDot p={todo.priority} />
            <span className={list.strike} data-done={checked ? '' : undefined}>{mark ? mark(todo.title) : todo.title}</span>
          </span>
          {meta(subs ? <SubStage done={subDone} total={subs.length} testId={`${ids.stage}-${id}`} /> : null, checked)}
        </span>
        {ro ? <ReadonlyMark testId={`${ids.ro}-${id}`} /> : null}
        {/* 行尾“未同步”小标记：没有时那一格是空的，CSS 里 :empty 不画 */}
        <span className={list.unsynced}>
          <QuietBoundary name="unsynced-mark">
            <Suspense fallback={null}>
              <UnsyncedRemindMark table="todos" id={id} />
            </Suspense>
          </QuietBoundary>
        </span>
      </button>
      {/* 行尾 H / M / L（T-A）：在行按钮外面（按钮里不能套按钮） */}
      <PrioCycle p={todo.priority} label={r.prioLabel(todo.priority)} onChange={(p) => r.prio(id, p)} testId={`${ids.prio}-${id}`} />
      {subs ? (
        <InlineSubtasks
          prefix={ids.subs}
          id={id}
          title={todo.title}
          readOnly={ro}
          done={todo.done}
          collapsed={collapsed}
          counted
          onCollapse={onCollapse}
          onBlock={() => a.g.block()}
          onOpen={onOpen}
          onPlan={(plan) => flow.plan(id, plan)}
          onResult={(x) => flow.result(id, x)}
        />
      ) : null}
    </div>
  );
  return (
    <AppearItem
      className={`${list.row} ${list.fold}`}
      data-done={checked ? '' : undefined}
      data-out={flow.out.has(id) ? '' : undefined}
      data-readonly={ro ? '' : undefined}
      data-row={r.prefix}
      data-row-id={id}
      data-testid={`${ids.row}-${id}`}
    >
      <div className={list.foldBody}>{wrap ? wrap(face) : face}</div>
    </AppearItem>
  );
}
