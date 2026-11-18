// 待办卡片里的子任务（待办页；今天页、日历日清单经 InlineSubtasks.tsx 用同一个，R-442、R-443）（R-350 方案 5.1、5.4、6.2；负责人 11-07 定“简单勾选清单”）：摊开的勾选清单 + 左下“收起 / 展开” + 行底整宽分段进度条
// • 负责人 11-17 选 T-A：子任务勾上变淡加删除线（推翻 R-350 方案 5.1 的“只变淡”）；“收起 / 展开”挪到左下；进度条挪到行底、占满整行
//   （“起步 · 1/3”在宿主行的副行里（kit TodoRow，三页同一个；11-17 今天页也换上以后按钮只写“收起 / 展开”，不再有带“1/3”的那一种）
// • 列表页能勾、能拖动排序（R-476 负责人 11-18“在这里子代办也可以拖动”，推翻 R-350 Q10 的“列表页不能排序”）：按住一项 0.4 秒拿起，
//   随手记同一套 kit useSortDrag（浮层、让位、放下、震动一样）；只读的那一项不能拖；不能加删改（Q10）。
//   点子任务的字和点主标题一样进编辑页（那个按钮不进 Tab、读屏不读，读屏走勾选框，名字就是子任务标题）
// • 勾下去当下就按“刚点的值”画（不等保存回来，同主待办的 shown），集合跟上以后丢掉
// • 主待办只读（或这一项只读）：圆圈变淡，点了由页面拦下出“这条要新版本才能修改 · 更新”
// • 勾上的动效（负责人 11-18“代办子任务点击完成时也加一个动效，用乙2（新）”“声音震动跟正常待办一样”）：方框传 soft（按下、回弹同主待办，10 个淡点、没有细圆线），
//   声音震动由 InlineSubtasks 的 tick 调 fx('done')；进度段直接变色、收起展开直接切换照旧
import { useId } from 'react';
import listCss from '../../../kit/components/List.module.css';
import { RoCheckCircle } from '../../../kit/components/ReadonlyRow.tsx';
import { SortBox, sortRowClass, useSortDrag, type SortDrop } from '../../../kit/components/SortDrag.tsx';
import { AppearItem, AppearList } from '../../../motion/components.ts';
import { fx } from '../../../platform/fx-api.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useListT } from '../hooks/useTodoList.ts';
import { usePicked, type Subtask } from '../hooks/useSubtasks.ts';
import { SubtaskBar } from './SubtaskBar.tsx';
import s from './Subtasks.module.css';

export interface SubtaskCardProps {
  /** 测试 id 前缀：待办页 todos（默认），今天页 today，日历 cal */
  prefix?: string;
  todoId: string;
  todoTitle: string;
  items: readonly Subtask[];
  collapsed: boolean;
  onCollapse(v: boolean): void;
  onTick(itemId: string, on: boolean): void;
  onOpen(): void;
  readOnly(itemId: string): boolean;
  /** 拖动排序放下（InlineSubtasks 用随手记同一套 kit useSortDropFlow：只读拦下、出错整批撤回、失败出提示）；不给就不能拖 */
  onDrop?(d: SortDrop): void;
}

export function SubtaskCard(p: SubtaskCardProps) {
  const t = useListT();
  const listId = useId();
  const { shown, pick } = usePicked(p.items);
  const done = p.items.filter(shown).length;
  const total = p.items.length;
  const px = p.prefix ?? 'todos';
  const drop = p.onDrop;
  const sd = useSortDrag({ tag: `subs-${px}`, axis: 'y', onDrop: (d) => drop?.(d), log: rlog, fx });
  const list = sd.preview(p.items, (x) => x.id);
  return (
    <div className={`${s.subs} ${s.card}`} data-subcard="" data-testid={`${px}-subs-${p.todoId}`}>
      <div id={listId} hidden={p.collapsed}>
        <SortBox sd={sd}>
          <AppearList className={s.items}>
        {list.map((i) => (
          <AppearItem key={i.id} className={`${s.item} ${sortRowClass}`} {...sd.attrs(i.id, !drop || p.readOnly(i.id))} data-done={shown(i) ? '' : undefined}>
            <RoCheckCircle
              soft
              readOnly={p.readOnly(i.id)}
              checked={shown(i)}
              label={i.title}
              onChange={(v) => {
                if (!p.readOnly(i.id)) pick(i.id, v);
                p.onTick(i.id, v);
              }}
              testId={`${px}-sub-${i.id}`}
            />
            <button type="button" className={s.itemText} tabIndex={-1} aria-hidden="true" onClick={p.onOpen}>
              {/* 删除线照乙2 从左往右画（同主待办 kit TodoRow 的 .strike / .line：勾上当下起 --dur-strike 画满，取消直接收回） */}
              <span className={listCss.strike}>
                {i.title}
                <span className={listCss.line} data-done={shown(i) ? '' : undefined} />
              </span>
            </button>
          </AppearItem>
        ))}
          </AppearList>
        </SortBox>
      </div>
      <button
        type="button"
        className={s.toggle}
        aria-expanded={!p.collapsed}
        aria-controls={listId}
        aria-label={t(p.collapsed ? 'items.expand.a11y' : 'items.collapse.a11y', { title: p.todoTitle })}
        onClick={() => p.onCollapse(!p.collapsed)}
        data-testid={`${px}-fold-${p.todoId}`}
      >
        {t(p.collapsed ? 'items.expand' : 'items.collapse', {})}
      </button>
      <SubtaskBar done={done} total={total} label={t('items.progress.a11y', { done, total })} testId={`${px}-bar-${p.todoId}`} />
    </div>
  );
}
