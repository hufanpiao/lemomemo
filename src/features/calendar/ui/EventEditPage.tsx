// 日程编辑页（B2 FA-2 第一段；定稿线框 s1 / s2 右侧编辑栏；架构 4.6 时区规则、5.9 地点 / 链接；TC-B2-01、02）
// 地址：#/event/<id>（编辑）、#/event/new（新建）。改了就自动保存（文本失焦、选择即存），不弹窗
// • 全天 / 有时刻：有时刻是固定时刻，按“时区”（只让选 Intl 支持的，D7）；和当前时区不同时写出“在你这里是哪天几点”
// • 地点 / 链接：输入框下面用 kit 的 LocationText 显示，能过 safeHref 的才是可点的链接（SAFE-link-real）
// • 只读行、删除和撤销：和待办编辑页同一套（kit 的 useEditRecord、EditShell）
import { canGoBack, goBack, replaceAddress, replaceRoute, useRoute } from '../../../app/router.ts';
import { useCallback, useReducer, useRef } from 'react';
import { EditShell } from '../../../kit/components/EditShell.tsx';
import { Check, Field, FormGroup, Select, TextArea, TextInput } from '../../../kit/components/Form.tsx';
import { LocationText } from '../../../kit/components/LocationText.tsx';
import type { EditStatus } from '../../../kit/hooks/useEditRecord.ts';
import { Pressable } from '../../../motion/components.ts';
import { requestAppUpdate } from '../../../platform/native-bridge.ts';
import { useCalendarT, type CalendarMsgKey } from '../hooks/useCalendarT.ts';
import { LOCATION_MAX, NOTE_MAX, PROJECT_MAX, REMIND_MIN_OPTIONS, TITLE_MAX, useEventEdit, type EventForm } from '../hooks/useEventEdit.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 不带参数的那些键（t 的第二个参数要能写成 {}） */
type PlainKey = Exclude<CalendarMsgKey, 'event.edit.tzLocal'>;

const STATUS_KEY: Record<EditStatus, PlainKey | null> = {
  idle: 'event.edit.st.idle',
  saving: 'event.edit.st.saving',
  saved: 'event.edit.st.saved',
  empty_title: 'event.edit.st.empty',
  missing: 'event.edit.st.missing',
  local_unavailable: 'event.edit.st.unavailable',
  closing: 'event.edit.st.failed',
  switching: null,
  readonly: 'event.edit.st.readonly',
  rejected: 'event.edit.st.rejected',
};
const BAD: ReadonlySet<EditStatus> = new Set(['empty_title', 'missing', 'local_unavailable', 'closing', 'readonly', 'rejected']);

const minKey = (v: EventForm['remind_min']): PlainKey => (v === null ? 'event.edit.min.none' : (`event.edit.min.${v}` as PlainKey));
const toMin = (v: string): EventForm['remind_min'] => (v === '0' || v === '15' || v === '30' || v === '60' || v === '1440' ? (Number(v) as EventForm['remind_min']) : null);

function back(): void {
  if (canGoBack()) goBack();
  else void replaceRoute('today');
}

export default function EventEditPage() {
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
    replaceAddress('event', cid);
    // replaceAddress 不通知路由的订阅者：外层重画一次，记下新地址（不然再 navigate 到 new 时地址看起来没变，不会重画）
    bump();
  }, []);
  return <EventEditor key={key} id={id} onCreated={onCreated} />;
}

let newSeq = 0;

function EventEditor({ id, onCreated }: { id: string; onCreated(id: string): void }) {
  const t = useCalendarT();
  const ed = useEventEdit(id, onCreated);
  const { form, change, status } = ed;
  const statusKey = STATUS_KEY[status];
  const off = status === 'missing' || ed.deleted;
  const rawText = typeof ed.row?.['raw_text'] === 'string' ? ed.row['raw_text'] : '';

  return (
    <EditShell
      data-testid="event-edit"
      kind={t(ed.isNew ? 'event.edit.newKind' : 'event.edit.kind', {})}
      backLabel={t('event.edit.back', {})}
      onBack={back}
      status={statusKey ? t(statusKey, {}) : ''}
      statusBad={BAD.has(status)}
      notice={
        status === 'readonly' ? (
          <>
            {t('event.edit.st.readonly', {})}
            {' · '}
            <Pressable onClick={() => void requestAppUpdate()} data-testid="event-edit-update">
              {t('event.edit.update', {})}
            </Pressable>
          </>
        ) : ed.deleted ? (
          <>
            {t('event.edit.deleted', {})}{' '}
            <Pressable onClick={() => void ed.setDeleted(false)} data-testid="event-edit-undo">
              {t('event.edit.undo', {})}
            </Pressable>
          </>
        ) : undefined
      }
      actions={
        ed.row && !ed.deleted ? (
          <Pressable onClick={() => void ed.setDeleted(true)} data-testid="event-edit-delete" data-no-proxy="">
            {t('event.edit.delete', {})}
          </Pressable>
        ) : undefined
      }
    >
      <FormGroup>
        <TextInput
          title
          aria-label={t('event.edit.titleLabel', {})}
          placeholder={t('event.edit.titlePh', {})}
          value={form.title}
          maxLength={TITLE_MAX}
          disabled={off}
          onCommit={(v) => change({ title: v })}
          data-testid="event-edit-title"
        />
      </FormGroup>

      <FormGroup>
        <Field label={t('event.edit.date', {})} htmlFor="event-date">
          <TextInput id="event-date" type="date" value={form.date} disabled={off} onCommit={(v) => v !== '' && change({ date: v })} data-testid="event-edit-date" />
          <Check
            label={t('event.edit.allDay', {})}
            checked={form.time === null}
            disabled={off}
            onChange={(all) => ed.setAllDay(all)}
            data-testid="event-edit-allday"
          />
        </Field>
        {form.time !== null ? (
          <>
            <Field label={t('event.edit.start', {})} htmlFor="event-start">
              <TextInput id="event-start" type="time" value={form.time} disabled={off} onCommit={(v) => v !== '' && change({ time: v })} data-testid="event-edit-start" />
              <TextInput
                type="time"
                aria-label={t('event.edit.end', {})}
                value={ed.end ?? ''}
                disabled={off}
                onCommit={(v) => ed.setEnd(v)}
                data-testid="event-edit-end"
              />
            </Field>
            <Field
              label={t('event.edit.tz', {})}
              htmlFor="event-tz"
              hint={ed.local ? t('event.edit.tzLocal', { date: ed.local.date, time: ed.local.time }) : undefined}
            >
              <Select
                id="event-tz"
                value={form.tz ?? ''}
                disabled={off}
                options={ed.tzList.map((z) => ({ value: z, label: z }))}
                onChange={(v) => change({ tz: v })}
                data-testid="event-edit-tz"
              />
            </Field>
            <Field label={t('event.edit.remind', {})} htmlFor="event-remind">
              <Select
                id="event-remind"
                value={String(form.remind_min)}
                disabled={off}
                options={REMIND_MIN_OPTIONS.map((v) => ({ value: String(v), label: t(minKey(v), {}) }))}
                onChange={(v) => change({ remind_min: toMin(v) })}
                data-testid="event-edit-remind"
              />
            </Field>
          </>
        ) : (
          <Field label={t('event.edit.remind', {})} htmlFor="event-days">
            <Select
              id="event-days"
              value={String(form.remind_days)}
              disabled={off}
              options={[
                { value: 'null', label: t('event.edit.days.none', {}) },
                { value: '0', label: t('event.edit.days.0', {}) },
                { value: '1', label: t('event.edit.days.1', {}) },
              ]}
              onChange={(v) => change({ remind_days: v === '0' ? 0 : v === '1' ? 1 : null })}
              data-testid="event-edit-days"
            />
          </Field>
        )}
      </FormGroup>

      <FormGroup>
        <Field
          label={t('event.edit.location', {})}
          htmlFor="event-location"
          hint={form.location ? <LocationText text={form.location} /> : undefined}
        >
          <TextInput
            id="event-location"
            value={form.location}
            maxLength={LOCATION_MAX}
            disabled={off}
            onCommit={(v) => change({ location: v.trim() })}
            data-testid="event-edit-location"
          />
        </Field>
        <Field label={t('event.edit.project', {})} htmlFor="event-project">
          <TextInput id="event-project" value={form.project} maxLength={PROJECT_MAX} disabled={off} onCommit={(v) => change({ project: v.trim() })} />
        </Field>
        <Field label={t('event.edit.note', {})} htmlFor="event-note">
          <TextArea id="event-note" value={form.note} maxLength={NOTE_MAX} disabled={off} onCommit={(v) => change({ note: v })} />
        </Field>
        {rawText ? (
          <Field label={t('event.edit.raw', {})}>
            <span data-testid="event-edit-raw">{rawText}</span>
          </Field>
        ) : null}
      </FormGroup>
    </EditShell>
  );
}
