// 列表页待办卡片里的子任务（R-350 方案 5.1、5.4、6.2；负责人 11-07 定“简单勾选清单”）：摊开的勾选清单 + 分段进度条 + 右下“收起 / 展开”
// • 列表页只能勾，不能加删改排序（Q10）；点子任务的字和点主标题一样进编辑页（那个按钮不进 Tab、读屏不读，读屏走勾选框，名字就是子任务标题）
// • 勾下去当下就按“刚点的值”画（不等保存回来，同主待办的 shown），集合跟上以后丢掉
// • 主待办只读（或这一项只读）：圆圈变淡，点了由页面拦下出“这条要新版本才能修改 · 更新”
// • 不播动画：圆圈去掉过渡、进度段直接变色（Subtasks.module.css 的 .subs）；收起、展开直接切换
import { useId } from 'react';
import { RoCheckCircle } from '../../../kit/components/ReadonlyRow.tsx';
import { useListT } from '../hooks/useTodoList.ts';
import { usePicked, type Subtask } from '../hooks/useSubtasks.ts';
import { SubtaskBar } from './SubtaskBar.tsx';
import s from './Subtasks.module.css';

export interface SubtaskCardProps {
  todoId: string;
  todoTitle: string;
  items: readonly Subtask[];
  collapsed: boolean;
  onCollapse(v: boolean): void;
  onTick(itemId: string, on: boolean): void;
  onOpen(): void;
  readOnly(itemId: string): boolean;
}

export function SubtaskCard(p: SubtaskCardProps) {
  const t = useListT();
  const listId = useId();
  const { shown, pick } = usePicked(p.items);
  const done = p.items.filter(shown).length;
  const total = p.items.length;
  return (
    <div className={`${s.subs} ${s.card}`} data-testid={`todos-subs-${p.todoId}`}>
      <ul id={listId} className={s.items} hidden={p.collapsed}>
        {p.items.map((i) => (
          <li key={i.id} className={s.item} data-done={shown(i) ? '' : undefined}>
            <RoCheckCircle
              readOnly={p.readOnly(i.id)}
              checked={shown(i)}
              label={i.title}
              onChange={(v) => {
                if (!p.readOnly(i.id)) pick(i.id, v);
                p.onTick(i.id, v);
              }}
              testId={`todos-sub-${i.id}`}
            />
            <button type="button" className={s.itemText} tabIndex={-1} aria-hidden="true" onClick={p.onOpen}>
              {i.title}
            </button>
          </li>
        ))}
      </ul>
      <div className={s.foot}>
        <SubtaskBar done={done} total={total} label={t('items.progress.a11y', { done, total })} testId={`todos-bar-${p.todoId}`} />
        <button
          type="button"
          className={s.toggle}
          aria-expanded={!p.collapsed}
          aria-controls={listId}
          aria-label={t(p.collapsed ? 'items.expand.a11y' : 'items.collapse.a11y', { title: p.todoTitle })}
          onClick={() => p.onCollapse(!p.collapsed)}
          data-testid={`todos-fold-${p.todoId}`}
        >
          {t(p.collapsed ? 'items.expand' : 'items.collapse', {})}
        </button>
      </div>
    </div>
  );
}
