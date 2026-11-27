// 待办编辑页
// 地址：#/todo/<id>（编辑）、#/todo/new（新建）。改了就自动保存（文本失焦、选择即存），不弹窗
// • 截止日期下面是“截止时刻”（可空）；选了时刻才出现“提前提醒”：不提醒 / 准时 / 10 分钟 / 30 分钟 / 1 小时（第一次设时默认）/ 2 小时 / 1 天；
//   清掉截止时刻回到“当天 / 前一天 + 提醒时刻”；清掉截止日期时同一个 patch 清掉截止时刻和提前量（逻辑在 data/todo-edit.ts）
// • 只读行（带不认识的值）：一进来就按 core 的只读 id 判断（kit 的 useReadonlyIds），顶部出“这条要新版本才能修改 · 更新”，
//   输入框全部禁用、不出“删除”、右上不写“改了就自动保存”；写入被拒（status readonly）时同样
// • 删除：软删，页内出“已删除”和“撤销”
// • 没有截止日期时改了提醒（当天 / 前一天、提醒时刻），截止日期自动填今天（规则在 data/todo-edit.ts ⑤），提醒那一行的灰字说明这一点；
//   填了今天以后“当天 / 前一天 + 时刻”已经过了的，同一处灰字改成“这个提醒时刻已经过了，不会再提醒”（不替用户挪日子）
// • 随手记转来的待办，最后一组（项目、备注那一组）末尾加一行“来源 随手记 · 标题 ›”，同一种 Field 行，
//   右边的值用 kit 的 FieldLink（SourceRow）；原随手记不在（删了、隐私记、撤销了、本机没有）整行不出，恢复后自动出现
// • 优先级高、中、低三档（kit 的 PrioSeg），存的时候 priority 和旧列 important 双写（data/todo-edit.ts 的 patchOf）
// • 标题那一组下面是“子任务”区（SubtaskEditor，懒加载）：加删改、勾选、排序都在那里；新建页标题还没保存时灰掉
// • 截止日、截止时刻、提醒时刻、提前提醒、提醒（当天 / 前一天）都用 kit/components/Pick，不用 iOS 默认框；
//   点值按钮在这一行下面就地展开；截止日、截止时刻能清空（选择器左上“清空”，同右边的“清掉”），提醒时刻不能
import { lazy } from 'react';
import { backOr, useEditRoute } from '../../../app/router-levels.ts';
import { Later } from '../../../kit/components/QuietBoundary.tsx';
import { EditShell } from '../../../kit/components/EditShell.tsx';
import { PrioSeg } from '../../../kit/components/Priority.tsx';
import { Check, Field, FieldLink, FormGroup, GroupLabel, TextArea, TextInput } from '../../../kit/components/Form.tsx';
import { DateTimeField, PickTextButton, Select } from '../../../kit/components/Pick/Pick.tsx';
import { ITEM_TITLE_MAX, NOTE_MAX, PROJECT_MAX, REMIND_BEFORE_OPTIONS, useTodoEdit, type TodoSource } from '../hooks/useTodoEdit.ts';
import { useTodosT, type TodosMsgKey } from '../hooks/useTodosT.ts';
import { VoicePending } from '../../plus/index.ts';

type BeforeKey = Extract<TodosMsgKey, `todo.edit.before.${string}`>;
/** “子任务”区：懒加载，在待办列表页那一包里（多半已经下载过）；分包下不来时那一块不画，不把整页换成出错页 */
const SubtaskEditor = lazy(() => import('./TodosPage.tsx').then((m) => ({ default: m.SubtaskEditor })));

const beforeKey = (v: number | null): BeforeKey => (v === null ? 'todo.edit.before.none' : (`todo.edit.before.${v}` as BeforeKey));

/** 直接打开的子页（推送、书签）没有上一页：退回待办列表 */
const back = (): void => backOr('todos');

export default function TodoEditPage() {
  const { id, key, onCreated } = useEditRoute('todo');
  return <TodoEditor key={key} id={id} onCreated={onCreated} />;
}

/** 编辑器本身：整页（#/todo/<id>）和电脑今天页的详情抽屉（经 ./todo-drawer.ts 懒加载）共用；在不在抽屉里由 EditShell 自己看（kit useInDrawer） */
export function TodoEditor({ id, onCreated }: { id: string; onCreated(id: string): void }) {
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
      deleteLabel={t('todo.edit.delete', {})}
    >
      {/* 录音那一路先存的占位（plus）：本机还留着录音时出“正在整理 / 没整理成 · 重试”，别的待办不画 */}
      {!ed.isNew && typeof ed.row?.id === 'string' ? (
        <Later name="voice-pending">
          <VoicePending id={ed.row.id} />
        </Later>
      ) : null}
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
        </Field>
        {/* 优先级三档：kit 的 PrioSeg，和待办页行右边的 H / M / L 同一套小方块 */}
        <Field label={t('todo.edit.priority', {})}>
          <PrioSeg
            value={form.priority}
            label={t('todo.edit.priority', {})}
            names={{ high: t('todo.edit.prio.high', {}), mid: t('todo.edit.prio.mid', {}), low: t('todo.edit.prio.low', {}) }}
            disabled={off}
            onChange={(p) => change({ priority: p })}
            testId="todo-edit-prio"
          />
        </Field>
      </FormGroup>

      <Later name="todo-subs">
        <SubtaskEditor todoId={!ed.isNew && typeof ed.row?.id === 'string' ? ed.row.id : null} todo={ed.row} off={off} />
      </Later>

      {/* 时间、详情两组上面各一个小字分组名（同纪念日、日程编辑页） */}
      <GroupLabel>{t('todo.edit.groupTime', {})}</GroupLabel>
      <FormGroup>
        <Field label={t('todo.edit.due', {})}>
          <DateTimeField mode="date" date={form.due} disabled={off} onDone={(v) => change({ due: v.date })} onClear={() => change({ due: null })} testIds={{ date: 'todo-edit-due' }} />
          {/* 只读时“清掉”和“删除”一样不出 */}
          {form.due !== null && !readonly ? (
            <PickTextButton onClick={() => change({ due: null })} disabled={off} testId="todo-edit-due-clear">
              {t('todo.edit.clear', {})}
            </PickTextButton>
          ) : null}
        </Field>
        {form.due !== null ? (
          <Field label={t('todo.edit.dueTime', {})}>
            <DateTimeField
              mode="time"
              time={form.due_time}
              disabled={off}
              onDone={(v) => change({ due_time: v.time })}
              onClear={() => change({ due_time: null })}
              testIds={{ time: 'todo-edit-due-time' }}
            />
            {form.due_time !== null && !readonly ? (
              <PickTextButton onClick={() => change({ due_time: null })} disabled={off} testId="todo-edit-due-time-clear">
                {t('todo.edit.clear', {})}
              </PickTextButton>
            ) : null}
          </Field>
        ) : null}
        {form.due !== null && form.due_time !== null ? (
          <Field label={t('todo.edit.remindBefore', {})}>
            <Select
              value={String(form.remind_before_min)}
              disabled={off}
              options={REMIND_BEFORE_OPTIONS.map((v) => ({ value: String(v), label: t(beforeKey(v), {}) }))}
              onChange={(v) => change({ remind_before_min: v === 'null' ? null : Number(v) })}
              data-testid="todo-edit-before"
            />
          </Field>
        ) : (
          <Field label={t('todo.edit.remind', {})} hint={form.due === null ? t('todo.edit.needDue', {}) : ed.remindPassed ? t('todo.edit.remindPast', {}) : undefined}>
            <Select
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
              <DateTimeField
                mode="time"
                label={t('todo.edit.remindTime', {})}
                time={form.remind_time}
                disabled={off}
                onDone={(v) => change({ remind_time: v.time })}
                testIds={{ time: 'todo-edit-remind-time' }}
              />
            ) : null}
          </Field>
        )}
      </FormGroup>

      <GroupLabel>{t('todo.edit.groupDetail', {})}</GroupLabel>
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
        {ed.source?.state === 'ok' ? <SourceRow src={ed.source} /> : null}
      </FormGroup>
    </EditShell>
  );
}

/**
 * “来源 随手记 · 标题 ›”：点了打开那条随手记（#/note/<id>）。原条不在（删了、隐私记、撤销了、本机没有）整行不出，
 * 规则在 data/todo-edit.ts 的 sourceOf；读屏名称是“来源 随手记 · 标题”（FieldLink 的 label）
 */
function SourceRow({ src }: { src: Extract<TodoSource, { state: 'ok' }> }) {
  const t = useTodosT();
  const label = t('todo.edit.source', {});
  const text = `${t('todo.edit.sourceNote', {})}${src.title ? ` · ${src.title}` : ''}`;
  return (
    <Field label={label}>
      <FieldLink to={['note', src.id]} label={`${label} ${text}`} testId="todo-edit-source">
        {text}
      </FieldLink>
    </Field>
  );
}
