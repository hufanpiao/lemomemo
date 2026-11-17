// 待办行里的子任务卡片（R-350；R-442“今天页可以展开待办的子任务”，取代 R-350 Q5 的“今天页只显示进度、不摊开”）：
// 待办页、今天页两处都用它，勾子任务的写入只这一处（hooks/useSubtasks.ts 的 useTodoSubtasks）
// • 画的是 SubtaskCard（勾选清单 + 分段进度条 + 右边“2/4 · 展开 / 收起”按钮，aria-expanded，点按区 44），这里管三件事：
//   ① 收起没有：待办页给（collapsed、onCollapse，每台设备各记各的）；今天页不给，只记在这一行挂着期间（不持久化），默认收起；
//   ② 勾子任务：勾最后一项自动完成主待办、主待办已完成时取消勾某项改回未完成（Q1、Q2，规则在 data 层）；
//   ③ 运行日志记“subs <页> open|close n=<项数>”（不记标题）
// • 只读：主待办只读（readOnly）或这一项只读（todo_items 的只读 id）时方框变淡，点了交给页面 onBlock 拦下出“要新版本”
// • 页面接结果：onPlan 在写之前告诉页面会不会顺带改主待办（页面据此先留住列表）；onResult 写完回来，auto 为 true 时页面出“全部完成 · 撤销”，
//   撤销调回来的 undo（刚勾的那项和主待办一起撤回，Q1）；message 是这条撤销条的文案（词条在待办这一包里，不进今天页首屏）
// • 没有子任务时什么都不画。今天页经功能入口 ../index.ts（inline-subs.ts）懒加载，不进首屏
// • 放在行按钮外面（按钮里不能套按钮）；宿主行要能折行，见 Subtasks.module.css 的 .card
import { useState } from 'react';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useListT } from '../hooks/useTodoList.ts';
import { useTodoSubtasks, type SubTickResult } from '../hooks/useSubtasks.ts';
import { SubtaskCard } from './SubtaskCard.tsx';

export interface InlineSubtasksProps {
  id: string;
  title: string;
  /** 主待办只读 */
  readOnly: boolean;
  /** 测试 id 前缀、日志里的页名：todos、today */
  prefix: string;
  /** 待办页给（收起状态每台设备各记各的，hooks/useSubtasks.ts 的 useCollapsed）；不给就只记在这一行挂着期间，默认收起 */
  collapsed?: boolean | undefined;
  onCollapse?(v: boolean): void;
  /** 页面副行已经写了“1/3”（待办页 T-A）：卡片按钮只写“收起 / 展开” */
  counted?: boolean | undefined;
  onBlock(): void;
  onOpen(): void;
  onPlan?(plan: boolean | null): void;
  onResult(r: SubTickResult): void;
}

export default function InlineSubtasks(p: InlineSubtasksProps) {
  const t = useListT();
  const s = useTodoSubtasks(p.id);
  const roSubs = useReadonlyIds('todo_items');
  const [own, setOwn] = useState(true);
  const items = s.items;
  if (!items?.length) return null;
  const ro = (itemId: string) => p.readOnly || roSubs.has(itemId);
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
      counted={p.counted}
      onCollapse={(v) => {
        rlog(`subs ${p.prefix} ${v ? 'close' : 'open'} n=${items.length}`);
        if (p.onCollapse) p.onCollapse(v);
        else setOwn(v);
      }}
      onTick={tick}
      onOpen={p.onOpen}
      readOnly={ro}
    />
  );
}
