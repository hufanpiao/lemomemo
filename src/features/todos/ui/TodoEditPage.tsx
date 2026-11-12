// 待办编辑页（B2 FA-2 第一段；定稿线框 s6 右侧编辑栏；架构 0.29 续第 124 条③、第 136 条；TC-B2-01、74）
// 地址：#/todo/<id>（编辑）、#/todo/new（新建）。改了就自动保存（文本失焦、选择即存），不弹窗
// • 截止日期下面是“截止时刻”（可空）；选了时刻才出现“提前提醒”：不提醒 / 准时 / 10 分钟 / 30 分钟 / 1 小时（第一次设时默认）/ 2 小时 / 1 天；
//   清掉截止时刻回到“当天 / 前一天 + 提醒时刻”；清掉截止日期时同一个 patch 清掉截止时刻和提前量（逻辑在 data/todo-edit.ts）
// • 只读行（带不认识的值，0.27①“只读显示”）：一进来就按 core 的只读 id 判断（kit 的 useReadonlyIds），顶部出“这条要新版本才能修改 · 更新”，
//   输入框全部禁用、不出“删除”、右上不写“改了就自动保存”（FA-2 视觉验收第 2 条）；写入被拒（status readonly）时同样
// • 删除：软删，页内出“已删除”和“撤销”（ADR-006）；“最近删除”页在 FA-2 后面一段
// • R-375：没有截止日期时改了提醒（当天 / 前一天、提醒时刻），截止日期自动填今天（规则在 data/todo-edit.ts ⑤），提醒那一行的灰字说明这一点；
//   填了今天以后“当天 / 前一天 + 时刻”已经过了的，同一处灰字改成“这个提醒时刻已经过了，不会再提醒”（不替用户挪日子）
import { backOr, useEditRoute } from '../../../app/router-levels.ts';
import { EditShell } from '../../../kit/components/EditShell.tsx';
import { Check, Field, FormButton, FormGroup, Select, TextArea, TextInput } from '../../../kit/components/Form.tsx';
import { ITEM_TITLE_MAX, NOTE_MAX, PROJECT_MAX, REMIND_BEFORE_OPTIONS, useTodoEdit } from '../hooks/useTodoEdit.ts';
import { useTodosT, type TodosMsgKey } from '../hooks/useTodosT.ts';

const beforeKey = (v: number | null): TodosMsgKey => (v === null ? 'todo.edit.before.none' : (`todo.edit.before.${v}` as TodosMsgKey));

/** 直接打开的子页（推送、书签）没有上一页：退回待办列表 */
const back = (): void => backOr('todos');

export default function TodoEditPage() {
  const { id, key, onCreated } = useEditRoute('todo');
  return <TodoEditor key={key} id={id} onCreated={onCreated} />;
}

function TodoEditor({ id, onCreated }: { id: string; onCreated(id: string): void }) {
  const t = useTodosT();
  const ed = useTodoEdit(id, onCreated);
  const { form, change, readonly, off } = ed;
  const rawText = typeof ed.row?.['raw_text'] === 'string' ? ed.row['raw_text'] : '';

  return (
    <EditShell
      prefix="todo-edit"
      kind={t(ed.isNew ? 'todo.edit.newKind' : 'todo.edit.kind', {})}
      backLabel={t('todo.edit.back', {})}
      onBack={back}
      rec={ed}
      own={{ empty: t('todo.edit.st.empty', {}), rejected: t('todo.edit.st.rejected', {}) }}
    >
      <FormGroup>
        <TextInput
          title
          aria-label={t('todo.edit.titleLabel', {})}
          placeholder={t('todo.edit.titlePh', {})}
          value={form.title}
          maxLength={ITEM_TITLE_MAX}
          disabled={off}
          onCommit={(v) => change({ title: v })}
          data-testid="todo-edit-title"
        />
        <Field label="">
          <Check label={readonly ? t('todo.edit.doneShort', {}) : t('todo.edit.done', {})} checked={form.done} disabled={off} look="circle" onChange={(v) => change({ done: v })} data-testid="todo-edit-done" />
          <Check label={t('todo.edit.important', {})} checked={form.important} disabled={off} look="switch" onChange={(v) => change({ important: v })} data-testid="todo-edit-important" />
        </Field>
      </FormGroup>

      <FormGroup>
        <Field label={t('todo.edit.due', {})} htmlFor="todo-due">
          <TextInput id="todo-due" type="date" value={form.due ?? ''} disabled={off} onCommit={(v) => change({ due: v === '' ? null : v })} data-testid="todo-edit-due" />
          {/* 只读时“清掉”和“删除”一样不出（FA-2 视觉验收第二轮第 3 条） */}
          {form.due !== null && !readonly ? (
            <FormButton onClick={() => change({ due: null })} disabled={off} data-testid="todo-edit-due-clear">
              {t('todo.edit.clear', {})}
            </FormButton>
          ) : null}
        </Field>
        {form.due !== null ? (
          <Field label={t('todo.edit.dueTime', {})} htmlFor="todo-due-time">
            <TextInput
              id="todo-due-time"
              type="time"
              value={form.due_time ?? ''}
              disabled={off}
              onCommit={(v) => change({ due_time: v === '' ? null : v })}
              data-testid="todo-edit-due-time"
            />
            {form.due_time !== null && !readonly ? (
              <FormButton onClick={() => change({ due_time: null })} disabled={off} data-testid="todo-edit-due-time-clear">
                {t('todo.edit.clear', {})}
              </FormButton>
            ) : null}
          </Field>
        ) : null}
        {form.due !== null && form.due_time !== null ? (
          <Field label={t('todo.edit.remindBefore', {})} htmlFor="todo-before">
            <Select
              id="todo-before"
              value={String(form.remind_before_min)}
              disabled={off}
              options={REMIND_BEFORE_OPTIONS.map((v) => ({ value: String(v), label: t(beforeKey(v), {}) }))}
              onChange={(v) => change({ remind_before_min: v === 'null' ? null : Number(v) })}
              data-testid="todo-edit-before"
            />
          </Field>
        ) : (
          <Field label={t('todo.edit.remind', {})} htmlFor="todo-days" hint={form.due === null ? t('todo.edit.needDue', {}) : ed.remindPassed ? t('todo.edit.remindPast', {}) : undefined}>
            <Select
              id="todo-days"
              value={String(form.remind_days)}
              disabled={off}
              options={[
                { value: 'null', label: t('todo.edit.days.none', {}) },
                { value: '0', label: t('todo.edit.days.0', {}) },
                { value: '1', label: t('todo.edit.days.1', {}) },
              ]}
              onChange={(v) => change({ remind_days: v === '0' ? 0 : v === '1' ? 1 : null })}
              data-testid="todo-edit-days"
            />
            {form.remind_days !== null ? (
              <TextInput
                type="time"
                aria-label={t('todo.edit.remindTime', {})}
                value={form.remind_time}
                disabled={off}
                onCommit={(v) => v !== '' && change({ remind_time: v })}
                data-testid="todo-edit-remind-time"
              />
            ) : null}
          </Field>
        )}
      </FormGroup>

      <FormGroup>
        <Field label={t('todo.edit.project', {})} htmlFor="todo-project">
          <TextInput id="todo-project" value={form.project} maxLength={PROJECT_MAX} disabled={off} placeholder={t('todo.edit.projectPh', {})} onCommit={(v) => change({ project: v.trim() })} />
        </Field>
        <Field label={t('todo.edit.note', {})} htmlFor="todo-note">
          <TextArea id="todo-note" value={form.note} maxLength={NOTE_MAX} disabled={off} placeholder={t('todo.edit.notePh', {})} onCommit={(v) => change({ note: v })} />
        </Field>
        {rawText ? (
          <Field label={t('todo.edit.raw', {})}>
            <span data-testid="todo-edit-raw">{rawText}</span>
          </Field>
        ) : null}
      </FormGroup>
    </EditShell>
  );
}
