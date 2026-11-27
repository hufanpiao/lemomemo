// 待办编辑页的“子任务”区（简单勾选清单）：TodoEditPage 懒加载它，放在标题那一组下面
// 写入、上限、提示的规则在 hooks/useSubtaskEditor.ts；这里只管画和拖动。
// 和列表卡片、今天页进度同在待办列表页那一包（TodosPage.tsx 转出；不另拆分包，首屏里少登记几个文件）
// • 每项一行：拖动把手 + 勾选框 + 可直接改的标题 + 删除 ×；最底下“添加子任务”：回车加一项、焦点留在框里接着加；粘贴多行按行拆成多项
// • 改标题失焦即存；清空后失焦不保存、恢复原来的字（不当删除）
// • 删除：软删、不进“最近删除”，页底出“已删除子任务 · 撤销”（同删除撤销条的 UndoToast，8 秒）
// • 排序：和随手记拖动同一套 kit useSortDrag——按住左边把手一挪就拿起（不用等 0.4 秒；轻点不拿起、不震）
//   （手机、电脑一样；把手上 touch-action: none，不触发页面滚动），浮层放大加阴影、跟手倾斜，其他项弹簧让位，放下落到占位；拖动中按 Esc 放回原位。
//   拿起震一下，放到新位置响一声加震。键盘：聚焦把手按 Alt + ↑ / ↓；
//   读屏：每行还有“上移 / 下移”两个按钮，平时不占位、聚焦时才出现；到头了用 aria-disabled 不用 disabled（挪到第一位时焦点不丢）
// • 新建页标题还没保存（主待办还没建）：整块灰掉，提示“写好标题就能拆步骤啦”；只读、已删除（off）：只看不改，不出添加行、把手和 ×
// • 圆圈去掉过渡（Subtasks.module.css 的 .subs）；增删、让位走 motion 的 AppearList（同随手记）
import { useState, type KeyboardEvent } from 'react';
import { CheckCircle } from '../../../kit/components/CheckCircle.tsx';
import { enterCommits, FormGroup, groupLabelClass, TextInput } from '../../../kit/components/Form.tsx';
import { SortBox, sortRowClass, useSortDrag } from '../../../kit/components/SortDrag.tsx';
import { useSortDropFlow } from '../../../kit/hooks/useSortDropFlow.ts';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { AppearItem, AppearList } from '../../../motion/components.ts';
import { fx } from '../../../platform/fx-api.ts';
import { rlog } from '../../../platform/run-log-api.ts';
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

/** 拖动把手（按住一挪就拿起，不用等；轻点不拿起） */
const GRIP = '[data-sort-grip]';

export default function SubtaskEditor({ todoId, todo, off }: SubtaskEditorProps) {
  const t = useListT();
  const ed = useSubtaskEditor(todoId, todo, off);
  const { items, toast } = ed;
  const [add, setAdd] = useState('');
  // 放下走随手记同一套 kit useSortDropFlow；写和出错提示在 ed.move 里（同上移、下移按钮），这里不再撤回、不再报
  const dropped = useSortDropFlow<null>({
    tag: 'subs-edit',
    log: rlog,
    ro: () => off,
    block: () => undefined,
    order: () => items.map((x) => x.id),
    move: (m) => {
      const from = items.findIndex((x) => x.id === m.id);
      if (from >= 0 && from !== m.index) ed.move(from, m.index);
      return Promise.resolve(null);
    },
    undo: () => Promise.resolve('ok'),
    report: () => undefined,
    moved: () => undefined,
  });
  const sd = useSortDrag({ tag: 'subs-edit', axis: 'y', grip: GRIP, onDrop: dropped, log: rlog, fx });
  const shownItems = sd.preview(items, (x) => x.id);

  const done = items.filter(ed.shown).length;
  const total = items.length;
  return (
    <FormGroup>
      <div className={`${s.subs} ${s.edit}`} data-testid="todo-subs">
        <div className={s.editHead}>
          {/* “子任务”是小字分组名、“2/4”等宽小字（同待办页卡片的“2/4 · 收起”） */}
          <span className={groupLabelClass}>{t('items.title', {})}</span>
          {total ? (
            <>
              <span className={s.editN} aria-hidden="true">{t('items.progress', { done, total })}</span>
              <SubtaskBar done={done} total={total} label={t('items.progress.a11y', { done, total })} testId="todo-subs-bar" />
            </>
          ) : null}
        </div>
        <SortBox sd={sd}>
          <AppearList className={s.editList}>
            {shownItems.map((it) => {
              const i = items.indexOf(it);
              return (
                <EditRow
                  key={it.id}
                  it={it}
                  done={ed.shown(it)}
                  first={i === 0}
                  last={i === items.length - 1}
                  off={ed.rowOff(it.id)}
                  sort={sd.attrs(it.id, ed.rowOff(it.id))}
                  onTick={(v) => ed.tick(it.id, v)}
                  onRename={(v) => ed.rename(it.id, v)}
                  onDelete={() => ed.remove(it.id)}
                  onMove={(d) => ed.move(i, i + d)}
                />
              );
            })}
          </AppearList>
        </SortBox>
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
          // 删除类撤销条：和“＋”的“已记下”等撤销条同一时间只留一条（kit UndoToast 文件头 solo）
          solo="keep"
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

interface EditRowProps {
  it: Subtask;
  done: boolean;
  first: boolean;
  last: boolean;
  off: boolean;
  /** 拖动标记（kit SortDrag 的 attrs） */
  sort: Record<`data-${string}`, string | undefined>;
  onTick(v: boolean): void;
  onRename(v: string): void;
  onDelete(): void;
  onMove(d: -1 | 1): void;
}

function EditRow({ it, done, first, last, off, sort, onTick, onRename, onDelete, onMove }: EditRowProps) {
  const t = useListT();
  const title = { title: it.title };
  // 键盘挪位置：聚焦把手按 Alt + ↑ / ↓
  const key = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    onMove(e.key === 'ArrowUp' ? -1 : 1);
  };
  return (
    <AppearItem className={`${s.editRow} ${sortRowClass}`} {...sort} data-done={done ? '' : undefined} data-testid={`todo-sub-${it.id}`}>
      {off ? null : (
        <button
          type="button"
          className={s.handle}
          aria-label={t('items.move', title)}
          onKeyDown={key}
          data-sort-grip=""
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
      {/* 编辑页的子任务勾上也一样：soft 动效 + 音效甲 + 震，声音震动同主待办 */}
      <CheckCircle
        soft
        checked={done}
        label={it.title}
        readOnly={off}
        onChange={(v) => {
          if (off) return;
          if (v) fx('done');
          onTick(v);
        }}
        testId={`todo-sub-done-${it.id}`}
      />
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
    </AppearItem>
  );
}
