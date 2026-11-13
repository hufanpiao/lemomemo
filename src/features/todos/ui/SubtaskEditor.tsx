// 待办编辑页的“子任务”区（R-350 方案 5.3、5.5、6.1、6.2；负责人 11-07 定“简单勾选清单”）：TodoEditPage 懒加载它，放在标题那一组下面
// 写入、上限、提示的规则在 hooks/useSubtaskEditor.ts；这里只管画和拖动。
// 和列表卡片、今天页进度同在待办列表页那一包（TodosPage.tsx 转出；不另拆分包，首屏里少登记几个文件，R-350 首屏额度）
// • 每项一行：拖动把手 + 勾选框 + 可直接改的标题 + 删除 ×；最底下“添加子任务”：回车加一项、焦点留在框里接着加；粘贴多行按行拆成多项
// • 改标题失焦即存；清空后失焦不保存、恢复原来的字（不当删除）
// • 删除：软删、不进“最近删除”（Q7），页底出“已删除子任务 · 撤销”（同删除撤销条的 UndoToast，8 秒）
// • 排序：拖左边把手（手机、电脑一样；把手上 touch-action: none，不触发页面滚动）；拖动中按 Esc 放回原位。键盘：聚焦把手按 Alt + ↑ / ↓；
//   读屏：每行还有“上移 / 下移”两个按钮，平时不占位、聚焦时才出现；到头了用 aria-disabled 不用 disabled（挪到第一位时焦点不丢）
// • 新建页标题还没保存（主待办还没建）：整块灰掉，提示“写上标题才能加子任务”；只读、已删除（off）：只看不改，不出添加行、把手和 ×
// • 不播动画：圆圈去掉过渡（Subtasks.module.css 的 .subs）；拖动只画放下位置的一条线
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CheckCircle } from '../../../kit/components/CheckCircle.tsx';
import { enterCommits, FormGroup, TextInput } from '../../../kit/components/Form.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { ITEMS_MAX, TODO_ITEM_TITLE_MAX, useSubtaskEditor } from '../hooks/useSubtaskEditor.ts';
import type { Subtask } from '../hooks/useSubtasks.ts';
import { useListT } from '../hooks/useTodoList.ts';
import { SubtaskBar } from './SubtaskBar.tsx';
import s from './Subtasks.module.css';

export interface SubtaskEditorProps {
  /** 主待办的 id；新建页还没保存时为 null */
  todoId: string | null;
  /** 主待办现在的行（自动完成、撤销要按它算提醒标记）；还没有为 undefined */
  todo: Readonly<Record<string, unknown>> | undefined;
  /** 只读、已删除、找不到：只看不改 */
  off: boolean;
}

/** 拖动中：from 是拖的那一项，to 是放下后的位置 */
interface Drag {
  from: number;
  to: number;
}

export default function SubtaskEditor({ todoId, todo, off }: SubtaskEditorProps) {
  const t = useListT();
  const ed = useSubtaskEditor(todoId, todo, off);
  const { items, toast } = ed;
  const [add, setAdd] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const rows = useRef<(HTMLLIElement | null)[]>([]);

  // 拖动：按指针所在位置找放下的位置（按各行原来的中线），松手才写
  const slotAt = (y: number, from: number): number => {
    let slot = items.length;
    for (let k = 0; k < items.length; k++) {
      const r = rows.current[k]?.getBoundingClientRect();
      if (r && y < r.top + r.height / 2) {
        slot = k;
        break;
      }
    }
    return slot > from ? slot - 1 : slot;
  };
  const dragOf = (i: number): RowDrag => ({
    onPointerDown(e) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ from: i, to: i });
    },
    onPointerMove(e) {
      if (!drag) return;
      const to = slotAt(e.clientY, drag.from);
      if (to !== drag.to) setDrag({ ...drag, to });
    },
    onPointerUp() {
      if (!drag) return;
      setDrag(null);
      ed.move(drag.from, drag.to);
    },
    onPointerCancel: () => setDrag(null),
    onKeyDown(e) {
      if (e.key === 'Escape' && drag) {
        e.preventDefault();
        setDrag(null);
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        ed.move(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
      }
    },
  });

  const done = items.filter(ed.shown).length;
  const total = items.length;
  return (
    <FormGroup>
      <div className={`${s.subs} ${s.edit}`} data-testid="todo-subs">
        <div className={s.editHead}>
          <span>{t('items.title', {})}</span>
          {total ? (
            <>
              <span aria-hidden="true">{t('items.progress', { done, total })}</span>
              <SubtaskBar done={done} total={total} label={t('items.progress.a11y', { done, total })} testId="todo-subs-bar" />
            </>
          ) : null}
        </div>
        <ul className={s.editList}>
          {items.map((it, i) => (
            <EditRow
              key={it.id}
              it={it}
              done={ed.shown(it)}
              first={i === 0}
              last={i === items.length - 1}
              off={ed.rowOff(it.id)}
              dragging={drag?.from === i}
              over={drag !== null && drag.to === i && drag.from !== i ? (drag.to > drag.from ? 'after' : 'before') : undefined}
              rowRef={(el) => {
                rows.current[i] = el;
              }}
              drag={dragOf(i)}
              onTick={(v) => ed.tick(it.id, v)}
              onRename={(v) => ed.rename(it.id, v)}
              onDelete={() => ed.remove(it.id)}
              onMove={(d) => ed.move(i, i + d)}
            />
          ))}
        </ul>
        {off ? null : (
          <div className={s.addRow}>
            <input
              className={s.addInput}
              value={add}
              maxLength={TODO_ITEM_TITLE_MAX}
              disabled={ed.blocked || ed.full}
              placeholder={t('items.add', {})}
              aria-label={t('items.add', {})}
              onChange={(e) => setAdd(e.target.value)}
              onKeyDown={(e) => {
                if (!enterCommits(e)) return;
                e.preventDefault();
                if (ed.addOne(add)) setAdd('');
              }}
              onPaste={(e) => {
                if (!ed.paste(e.clipboardData.getData('text'))) return;
                e.preventDefault();
                setAdd('');
              }}
              data-testid="todo-sub-add"
            />
          </div>
        )}
        {off ? null : todoId === null ? (
          <p className={s.editHint} data-testid="todo-sub-hint">{t('items.needTitle', {})}</p>
        ) : ed.full ? (
          <p className={s.editHint} data-testid="todo-sub-hint">{t('items.max', { n: ITEMS_MAX })}</p>
        ) : null}
      </div>
      {toast?.kind === 'deleted' || toast?.kind === 'auto' ? (
        <UndoToast
          key={`${toast.kind}:${toast.id}`}
          message={t(toast.kind === 'deleted' ? 'items.deleted' : 'items.autoDone', {})}
          undoLabel={t('list.undo', {})}
          onUndo={() => ed.undo(toast)}
          onClose={() => ed.closeToast(toast)}
          data-testid={`todo-sub-${toast.kind}-toast`}
        />
      ) : toast ? (
        <p className={s.editHint} data-bad="" role="alert" data-testid="todo-sub-error">
          {toast.kind === 'quota' ? t('items.err.quota', { n: ITEMS_MAX }) : t('list.err.save', {})}
        </p>
      ) : null}
    </FormGroup>
  );
}

interface RowDrag {
  onPointerDown(e: PointerEvent<HTMLButtonElement>): void;
  onPointerMove(e: PointerEvent<HTMLButtonElement>): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void;
}

interface EditRowProps {
  it: Subtask;
  done: boolean;
  first: boolean;
  last: boolean;
  off: boolean;
  dragging: boolean;
  /** 放下以后排在这一行的前面还是后面（拖动中才有；画一条线） */
  over: 'before' | 'after' | undefined;
  rowRef(el: HTMLLIElement | null): void;
  drag: RowDrag;
  onTick(v: boolean): void;
  onRename(v: string): void;
  onDelete(): void;
  onMove(d: -1 | 1): void;
}

function EditRow({ it, done, first, last, off, dragging, over, rowRef, drag, onTick, onRename, onDelete, onMove }: EditRowProps) {
  const t = useListT();
  const title = { title: it.title };
  return (
    <li
      ref={rowRef}
      className={s.editRow}
      data-done={done ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      data-over={over}
      data-testid={`todo-sub-${it.id}`}
    >
      {off ? null : (
        <button
          type="button"
          className={s.handle}
          aria-label={t('items.move', title)}
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerCancel}
          onKeyDown={drag.onKeyDown}
          data-testid={`todo-sub-handle-${it.id}`}
        >
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
            <circle cx="2" cy="3" r="1.5" />
            <circle cx="8" cy="3" r="1.5" />
            <circle cx="2" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="2" cy="13" r="1.5" />
            <circle cx="8" cy="13" r="1.5" />
          </svg>
        </button>
      )}
      <CheckCircle checked={done} label={it.title} readOnly={off} onChange={(v) => (off ? undefined : onTick(v))} testId={`todo-sub-done-${it.id}`} />
      <TextInput
        className={s.editInput}
        aria-label={t('items.itemLabel', title)}
        value={it.title}
        maxLength={TODO_ITEM_TITLE_MAX}
        disabled={off}
        onCommit={onRename}
        data-testid={`todo-sub-title-${it.id}`}
      />
      {off ? null : (
        <>
          <button type="button" className={s.mv} aria-disabled={first || undefined} onClick={() => (first ? undefined : onMove(-1))}>
            {t('items.moveUp', title)}
          </button>
          <button type="button" className={s.mv} aria-disabled={last || undefined} onClick={() => (last ? undefined : onMove(1))}>
            {t('items.moveDown', title)}
          </button>
          <button type="button" className={s.del} aria-label={t('items.delete', title)} onClick={onDelete} data-testid={`todo-sub-del-${it.id}`} data-no-proxy="">
            ×
          </button>
        </>
      )}
    </li>
  );
}
