// 待办编辑页（B2 FA-2 第一段；定稿线框 s6 右侧编辑栏；架构 0.29 续第 124 条③、第 136 条；TC-B2-01、74）
// 地址：#/todo/<id>（编辑）、#/todo/new（新建）。改了就自动保存（文本失焦、选择即存），不弹窗
// • 截止日期下面是“截止时刻”（可空）；选了时刻才出现“提前提醒”：不提醒 / 准时 / 10 分钟 / 30 分钟 / 1 小时（第一次设时默认）/ 2 小时 / 1 天；
//   清掉截止时刻回到“当天 / 前一天 + 提醒时刻”；清掉截止日期时同一个 patch 清掉截止时刻和提前量（逻辑在 data/todo-edit.ts）
// • 只读行（带不认识的值，0.27①“只读显示”）：一进来就按 core 的只读 id 判断（kit 的 useReadonlyIds），顶部出“这条要新版本才能修改 · 更新”，
//   输入框全部禁用、不出“删除”、右上不写“改了就自动保存”（FA-2 视觉验收第 2 条）；写入被拒（status readonly）时同样
// • 删除：软删，页内出“已删除”和“撤销”（ADR-006）；“最近删除”页在 FA-2 后面一段
import { canGoBack, goBack, replaceAddress, replaceRoute, useRoute } from '../../../app/router.ts';
import { useCallback, useReducer, useRef } from 'react';
import { EditShell } from '../../../kit/components/EditShell.tsx';
import { Check, Field, FormButton, FormGroup, Select, TextArea, TextInput } from '../../../kit/components/Form.tsx';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { Pressable } from '../../../motion/components.ts';
import { requestAppUpdate } from '../../../platform/native-bridge.ts';
import { NOTE_MAX, PROJECT_MAX, REMIND_BEFORE_OPTIONS, TITLE_MAX, useTodoEdit } from '../hooks/useTodoEdit.ts';
import { useTodosT, type TodosMsgKey } from '../hooks/useTodosT.ts';
import type { EditStatus } from '../../../kit/hooks/useEditRecord.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATUS_KEY: Record<EditStatus, TodosMsgKey | null> = {
  idle: 'todo.edit.st.idle',
  saving: 'todo.edit.st.saving',
  saved: 'todo.edit.st.saved',
  empty_title: 'todo.edit.st.empty',
  missing: 'todo.edit.st.missing',
  local_unavailable: 'todo.edit.st.unavailable',
  closing: 'todo.edit.st.failed',
  switching: null,
  readonly: 'todo.edit.st.readonly',
  rejected: 'todo.edit.st.rejected',
};
// “写上标题才会保存”（empty_title）是提示不是报错，用中性灰（负责人 11-06 真机截图 6：只选了日期就出红字，看着像报错）
const BAD: ReadonlySet<EditStatus> = new Set(['missing', 'local_unavailable', 'closing', 'readonly', 'rejected']);

const beforeKey = (v: number | null): TodosMsgKey => (v === null ? 'todo.edit.before.none' : (`todo.edit.before.${v}` as TodosMsgKey));

/** 直接打开的子页（推送、书签）没有上一页：退回待办列表 */
function back(): void {
  if (canGoBack()) goBack();
  else void replaceRoute('todos');
}

export default function TodoEditPage() {
  const route = useRoute();
  const raw = route.params[0] ?? 'new';
  const id = raw === 'new' || UUID.test(raw) ? raw : 'missing';
  // 新建保存后地址换成这一条的 id（代码审查 S7），编辑器不重挂（key 不变，焦点里的草稿不丢）；换别的记录、再点“新建”才换一张
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const slot = useRef<{ id: string; key: string; created: string | null } | null>(null);
  if (slot.current === null || (id !== slot.current.id && id !== slot.current.created)) {
    slot.current = { id, key: id === 'new' ? `new:${++newSeq}` : id, created: null };
  }
  const key = slot.current.key;
  const onCreated = useCallback((cid: string) => {
    // N2（代码审查）：slot.id 也换成新 id（key 不变）——之后再点“新建”路由回到 'new'，和 slot.id 不同，才会换一张空表
    if (slot.current) {
      slot.current.created = cid;
      slot.current.id = cid;
    }
    replaceAddress('todo', cid);
    // replaceAddress 不通知路由的订阅者：外层重画一次，记下新地址（不然再 navigate 到 new 时地址看起来没变，不会重画）
    bump();
  }, []);
  return <TodoEditor key={key} id={id} onCreated={onCreated} />;
}

let newSeq = 0;

function TodoEditor({ id, onCreated }: { id: string; onCreated(id: string): void }) {
  const t = useTodosT();
  const ed = useTodoEdit(id, onCreated);
  const { form, change, status } = ed;
  const statusKey = STATUS_KEY[status];
  const roIds = useReadonlyIds('todos');
  const readonly = status === 'readonly' || roIds.has(id);
  const off = status === 'missing' || ed.deleted || readonly;
  const rawText = typeof ed.row?.['raw_text'] === 'string' ? ed.row['raw_text'] : '';

  return (
    <EditShell
      data-testid="todo-edit"
      kind={t(ed.isNew ? 'todo.edit.newKind' : 'todo.edit.kind', {})}
      backLabel={t('todo.edit.back', {})}
      onBack={back}
      status={statusKey && (status !== 'idle' || !readonly) ? t(statusKey, {}) : ''}
      statusBad={BAD.has(status)}
      noticeTone={readonly ? 'quiet' : undefined}
      notice={
        readonly ? (
          <>
            <span>{t('todo.edit.st.readonly', {})}</span>
            <Pressable onClick={() => void requestAppUpdate()} data-testid="todo-edit-update">
              {t('todo.edit.update', {})}
            </Pressable>
          </>
        ) : ed.deleted ? (
          <>
            {t('todo.edit.deleted', {})}{' '}
            <FormButton onClick={() => void ed.setDeleted(false)} data-testid="todo-edit-undo">
              {t('todo.edit.undo', {})}
            </FormButton>
          </>
        ) : undefined
      }
      actions={
        ed.row && !ed.deleted && !readonly ? (
          <FormButton danger onClick={() => void ed.setDeleted(true)} data-testid="todo-edit-delete" data-no-proxy="">
            {t('todo.edit.delete', {})}
          </FormButton>
        ) : undefined
      }
    >
      <FormGroup>
        <TextInput
          title
          aria-label={t('todo.edit.titleLabel', {})}
          placeholder={t('todo.edit.titlePh', {})}
          value={form.title}
          maxLength={TITLE_MAX}
          disabled={off}
          onCommit={(v) => change({ title: v })}
          data-testid="todo-edit-title"
        />
        <Field label="">
          <Check label={readonly ? t('todo.edit.doneShort', {}) : t('todo.edit.done', {})} checked={form.done} disabled={off} look="circle" onChange={(v) => change({ done: v })} data-testid="todo-edit-done" />
          <Check label={t('todo.edit.important', {})} checked={form.important} disabled={off} onChange={(v) => change({ important: v })} />
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
          <Field label={t('todo.edit.remind', {})} htmlFor="todo-days" hint={form.due === null ? t('todo.edit.needDue', {}) : undefined}>
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
