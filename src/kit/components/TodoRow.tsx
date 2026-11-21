// 一条待办行（T-A，负责人 11-17 选定；主持人 11-17 评审去重）：待办页、日历日清单的待办组（R-443）、今天页（11-17 负责人“今天页待办带子任务的跟其他页面不一样”）
// 三处同一个。11-17 从 features/todos/ui 挪进 kit：今天页的待办行在首屏，只能静态引 kit（待办那一包带 zod，按 A27 只能懒加载）。
// 三页不同的只有数据：词条和三个部件（子任务卡片、未同步标记、只读标记和方框）在 r（kit/components/useTodoRows.ts），副行（meta）、行按钮多出来的属性（main）、
// 行面外面要不要套左滑删除（wrap）、子任务卡片收起没有（collapsed、onCollapse，待办页才给）由页面给
// • 结构：li.row.fold（kit List.module.css；data-done、data-out、data-readonly 只打在这一层）> .foldBody（收起时淡出的那一层）> 行面 .swRow：
//   左边 kit 圆角方框（有子任务的按做到几成填、画小脸，kit CheckCircle 的 progress；只读行换成 r.parts.Ro）｜ 行按钮（彩点 + 标题、副行、只读标记、未同步标记）｜
//   行尾 H / M / L 三格（kit PrioCycle，勾上那一下就藏起来）｜ 有子任务时折到下一行的子任务卡片（r.parts.Subs，卡片认 data-subcard 让行折行）
// • 删除线是标题文字外面那层 .strike 里的一条 .line，它自己也带 data-done：要从左往右画（scaleX 过渡），会动的属性状态得写在元素自身上
//   （样式规则 lemo/reduced-motion-override），这是“data-done 只打在行上”的唯一例外；字色认行上的
// • 副行最前面“起步 / 大半”小标签和等宽“1/3”（stage）：分档同 kit CheckCircle 的 partStage；一项没做时只有“0/3”，全做完、主待办还没勾时只有“3/3”；
//   标签只是画给眼睛看的（aria-hidden），读屏由子任务卡片里的 progressbar 说
// • 过期没做完的（late，页面按 shared/logic/todo-row.ts 的 isLate 给：待办页过期组、今天页“没赶上”；日历不给）行尾 H / M / L 后面一个“推迟”小按钮
//   （负责人 11-21“没赶上的加一个推迟按钮，按一下把时间推迟到明天”，照他给的参考图：回转时钟图标 + “推迟”，细描边）：按一下 r.later（截止日改成明天、出撤销条），
//   在行按钮外面（不进编辑页），按下不往行面传（不起左滑）；刚勾上还在原位时不画；读屏名字“推迟到明天：标题”
// • data-row（前缀）、data-row-id：kit/components/useDoneFlow.ts 收完这一行前找下一行的方框、把焦点移过去
import type { ReactNode } from 'react';
import type { TodoRows } from './useTodoRows.ts';
import { AppearItem } from '../../motion/components.ts';
import type { Priority } from '../../../shared/logic/todo-row.ts';
import { CheckCircle, partStage } from './CheckCircle.tsx';
import list from './List.module.css';
import { PrioCycle, PrioDot } from './Priority.tsx';

export interface TodoRowProps {
  r: TodoRows;
  todo: Readonly<{ id: string; title: string; priority: Priority; done: boolean }>;
  /** 子任务做了几项、共几项（有子任务才给）：方框的进度、副行的“大半 · 3/4”、下面的卡片都按它 */
  progress: Readonly<{ done: number; total: number }> | undefined;
  /** 测试 id 前缀（todos、cal、today；独立评审 11-17 第 11 条，原来三页各写六个字段）：行 `<tid>-row-<id>`、方框 `-done-`、H/M/L `-prio-`、
   *  副行进度 `-stage-`、只读标记 `-ro-`，子任务卡片直接用 tid */
  tid: string;
  onOpen(): void;
  /** 子任务卡片收起没有：待办页给（每台设备各记各的），别的页不给 */
  collapsed?: boolean | undefined;
  onCollapse?: ((v: boolean) => void) | undefined;
  /** 副行：stage 是有子任务时的“大半 · 3/4”（没有子任务是 null），checked 是方框现在画成什么；回 null 就不出第二行 */
  meta(stage: ReactNode, checked: boolean): ReactNode;
  /** 行按钮多出来的几样：data-kind、data-open（日历页、今天页认行）、抽屉开着的那条 aria-current、测试 id；给了还带 data-readonly */
  main?: Readonly<{ kind: string; open: string; current: boolean; testId: string }> | undefined;
  /** 标题文字怎么画（待办页下拉搜索就地筛时给命中的字加短下划线，kit PullHit；不给原样） */
  mark?: ((text: string) => ReactNode) | undefined;
  /** 行面外面再包一层（待办页、今天页的左滑删除） */
  wrap?: ((face: ReactNode) => ReactNode) | undefined;
  /** 过期没做完（页面按 isLate 给）：行尾出“推迟”按钮 */
  late?: boolean | undefined;
}

export function TodoRow({ r, todo, progress, tid, onOpen, collapsed, onCollapse, meta, main, mark, wrap, late }: TodoRowProps) {
  const { words, parts, a, flow } = r;
  const id = todo.id;
  const ro = a.isRo(id);
  const checked = flow.shown(id, todo.done);
  const stage = progress ? partStage(progress.done, progress.total) : 0;
  // 只读行的方框换成页面给的只读部件（读屏名字后接“要更新到新版本才能修改”），别的都一样
  // fresh：刚勾上还在原位时方框画亮柠檬黄（负责人选“乙”）；按行的 linger 给，不靠方框自己的状态（今天页“已过去”里同一个 key 不重新挂载）
  const box = { checked, label: checked ? words.undoDone : words.done, progress, fresh: flow.fresh(id), onChange: (v: boolean) => flow.check(id, v), testId: `${tid}-done-${id}` };
  const face = (
    <div className={list.swRow}>
      <span className={list.lead}>
        {ro ? <parts.Ro part="check" readOnly {...box} /> : <CheckCircle {...box} />}
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
            <span className={list.strike}>
              {mark ? mark(todo.title) : todo.title}
              <span className={list.line} data-done={checked ? '' : undefined} aria-hidden="true" />
            </span>
          </span>
          {meta(
            progress ? (
              <span className={list.stage} aria-hidden="true" data-testid={`${tid}-stage-${id}`}>
                {stage === 1 || stage === 2 ? (
                  <span className={list.pill} data-stage={stage}>
                    <span className={list.bars}>
                      <i />
                      <i />
                      <i />
                    </span>
                    {words.stage(stage)}
                  </span>
                ) : null}
                <span className={list.frac}>{`${progress.done}/${progress.total}`}</span>
              </span>
            ) : null,
            checked,
          )}
        </span>
        {ro ? <parts.Ro part="mark" testId={`${tid}-ro-${id}`} /> : null}
        {/* 行尾“未同步”小标记：没有时那一格是空的，CSS 里 :empty 不画 */}
        <span className={list.unsynced}>
          <parts.Mark id={id} />
        </span>
      </button>
      {/* 行尾 H / M / L（T-A）：在行按钮外面（按钮里不能套按钮）；勾上那一下藏起来（kit List 的 .prio）。
          过期没做完的只出“推迟”、不出 H / M / L，推迟以后不再过期，H / M / L 自然回来（负责人 11-21“过期的项目不显示HML，只有推迟，推迟完了回复HML”） */}
      {late && !checked ? null : (
        <span className={list.prio}>
          <PrioCycle p={todo.priority} label={r.prioLabel(todo.priority)} onChange={(p) => r.prio(id, p)} testId={`${tid}-prio-${id}`} />
        </span>
      )}
      {late && !checked ? (
        <button
          type="button"
          className={list.later}
          onClick={() => r.later(id)}
          // 按下不传给行面：不起左滑（SwipeRow 在行面上接按下）
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={words.laterLabel(todo.title)}
          data-testid={`${tid}-later-${id}`}
        >
          <LaterIcon />
          {words.later}
        </button>
      ) : null}
      {progress ? (
        <parts.Subs
          prefix={tid}
          id={id}
          title={todo.title}
          readOnly={ro}
          done={todo.done}
          collapsed={collapsed}
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
      data-testid={`${tid}-row-${id}`}
    >
      <div className={list.foldBody}>{wrap ? wrap(face) : face}</div>
    </AppearItem>
  );
}

/** 回转时钟（参考图“推迟”前面的图标）：逆时针箭头绕一圈 + 时针分针，线条用字色 */
function LaterIcon() {
  return (
    <svg className={list.laterIcon} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8.27M3 3.5v4.77h4.77M12 7.5V12l3 2" />
    </svg>
  );
}
