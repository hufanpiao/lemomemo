// 待办行里的子任务卡片（R-350；R-442“今天页可以展开待办的子任务”、R-443“日历下面的待办…子任务可以展开”，取代 R-350 Q5 的“今天页只显示进度、不摊开”）：
// 待办页、今天页、日历日清单三处都用它，勾子任务的写入只这一处（hooks/useSubtasks.ts 的 useTodoSubtasks）
// • 画的是 SubtaskCard（勾选清单 + 分段进度条 + 左下“展开 / 收起”按钮，aria-expanded，点按区 44），这里管三件事：
//   ① 收起没有：待办页给（collapsed、onCollapse，每台设备各记各的）；今天页、日历不给，只记在这一行挂着期间（不持久化），默认收起；
//   ② 勾子任务：勾最后一项自动完成主待办、主待办已完成时取消勾某项改回未完成（Q1、Q2，规则在 data 层）；
//   ③ 运行日志记“subs <页> open|close n=<项数>”（不记标题）；
//   ④ 拖动排序（R-476）：放下走随手记同一套 kit useSortDropFlow（只读拦下、邻居变了当取消、写失败整批撤回并出提示），写 sort 用 data 层 moveSubtask（编辑页同一个）
// • 只读：主待办只读（readOnly）或这一项只读（todo_items 的只读 id）时方框变淡，点了交给页面 onBlock 拦下出“要新版本”
// • 页面接结果：onPlan 在写之前告诉页面会不会顺带改主待办（页面据此先留住列表）；onResult 写完回来，auto 为 true 时页面出“全部完成 · 撤销”，
//   撤销调回来的 undo（刚勾的那项和主待办一起撤回，Q1）；message 是这条撤销条的文案（词条在待办这一包里，不进今天页首屏）
// • 没有子任务时什么都不画。今天页、日历经功能入口 ../index.ts（inline-subs.ts、DayTodos）懒加载，不进首屏
// • 放在行按钮外面（按钮里不能套按钮）；宿主行要能折行，见 Subtasks.module.css 的 .card
import { useState } from 'react';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { useSortDropFlow } from '../../../kit/hooks/useSortDropFlow.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useListT } from '../hooks/useTodoList.ts';
import { useTodoSubtasks, type SubTickResult } from '../hooks/useSubtasks.ts';
import { SubtaskCard } from './SubtaskCard.tsx';

export interface InlineSubtasksProps {
  id: string;
  title: string;
  /** 主待办只读 */
  readOnly: boolean;
  /** 主待办现在完成了没有（数据里的值，行上本来就有；算勾这一项会不会顺带改主待办） */
  done: boolean;
  /** 测试 id 前缀、日志里的页名：todos、today、cal */
  prefix: string;
  /** 待办页给（收起状态每台设备各记各的，hooks/useSubtasks.ts 的 useCollapsed）；不给就只记在这一行挂着期间，默认收起 */
  collapsed?: boolean | undefined;
  onCollapse?: ((v: boolean) => void) | undefined;
  onBlock(): void;
  onOpen(): void;
  onPlan?(plan: boolean | null): void;
  onResult(r: SubTickResult): void;
}

export default function InlineSubtasks(p: InlineSubtasksProps) {
  const t = useListT();
  const s = useTodoSubtasks(p.id, p.done);
  const roSubs = useReadonlyIds('todo_items');
  const [own, setOwn] = useState(true);
  const items = s.items;
  const ro = (itemId: string) => p.readOnly || roSubs.has(itemId);
  const report = (res: SubTickResult['res']): void => p.onResult({ plan: null, res, auto: null, undo: () => Promise.resolve('ok'), message: '' });
  const dropped = useSortDropFlow<{ from: number; to: number }>({
    tag: `subs-${p.prefix}`,
    log: rlog,
    ro,
    block: p.onBlock,
    order: () => (items ?? []).map((x) => x.id),
    move: async (m) => {
      const from = (items ?? []).findIndex((x) => x.id === m.id);
      if (from < 0 || from === m.index) return null;
      return { res: await s.move(from, m.index), plan: { from, to: m.index } };
    },
    undo: (pl) => s.move(pl.to, pl.from),
    report,
    moved: () => undefined,
  });
  if (!items?.length) return null;
  const tick = (itemId: string, on: boolean) => {
    if (ro(itemId)) return p.onBlock();
    const plan = s.planAuto(itemId, on);
    p.onPlan?.(plan);
    void s.tick(itemId, on).then(({ res, auto }) => p.onResult({ plan, res, auto, undo: () => s.undoAuto(itemId), message: t('items.autoDone', {}) }));
  };
  return (
    <SubtaskCard
      prefix={p.prefix}
      todoId={p.id}
      todoTitle={p.title}
      items={items}
      collapsed={p.collapsed ?? own}
      onCollapse={(v) => {
        rlog(`subs ${p.prefix} ${v ? 'close' : 'open'} n=${items.length}`);
        if (p.onCollapse) p.onCollapse(v);
        else setOwn(v);
      }}
      onTick={tick}
      onOpen={p.onOpen}
      readOnly={ro}
      onDrop={dropped}
    />
  );
}
