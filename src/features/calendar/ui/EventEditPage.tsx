// 日程编辑页（B2 FA-2 第一段；定稿线框 s1 / s2 右侧编辑栏；架构 4.6 时区规则、5.9 地点 / 链接；TC-B2-01、02）
// 地址：#/event/<id>（编辑）、#/event/new（新建）。改了就自动保存（文本失焦、选择即存），不弹窗
// • 全天 / 有时刻：有时刻是固定时刻，按“时区”（只让选 Intl 支持的，D7）；和当前时区不同时写出“在你这里是哪天几点”
// • 地点 / 链接：输入框下面用 kit 的 LocationText 显示，能过 safeHref 的才是可点的链接（SAFE-link-real）
// • 只读行、删除和撤销：和待办编辑页同一套（kit 的 useEditRecord、EditShell）
import { backOr, useEditRoute } from '../../../app/router-levels.ts';
import { EditShell } from '../../../kit/components/EditShell.tsx';
import { Check, Field, FormGroup, Select, TextArea, TextInput } from '../../../kit/components/Form.tsx';
import { LocationText } from '../../../kit/components/LocationText.tsx';
import { useCalendarT, type CalendarMsgKey } from '../hooks/useCalendarT.ts';
import { ITEM_TITLE_MAX, LOCATION_MAX, NOTE_MAX, PROJECT_MAX, REMIND_MIN_OPTIONS, useEventEdit, type EventForm } from '../hooks/useEventEdit.ts';

/** 不带参数的那些键（t 的第二个参数要能写成 {}） */
type PlainKey = Exclude<CalendarMsgKey, 'event.edit.tzLocal'>;

const minKey = (v: EventForm['remind_min']): PlainKey => (v === null ? 'event.edit.min.none' : (`event.edit.min.${v}` as PlainKey));
const toMin = (v: string): EventForm['remind_min'] => (v === '0' || v === '15' || v === '30' || v === '60' || v === '1440' ? (Number(v) as EventForm['remind_min']) : null);

const back = (): void => backOr('today');

export default function EventEditPage() {
  const { id, key, onCreated } = useEditRoute('event');
  return <EventEditor key={key} id={id} onCreated={onCreated} />;
}

/** 编辑器本身：整页（#/event/<id>）和电脑今天页的详情抽屉（B6 返工；经 ./event-drawer.ts 懒加载）共用；在不在抽屉里由 EditShell 自己看（kit useInDrawer） */
export function EventEditor({ id, onCreated }: { id: string; onCreated(id: string): void }) {
  const t = useCalendarT();
  const ed = useEventEdit(id, onCreated);
  // 只读行（0.27①“只读显示”，FA-2 视觉验收第 2 条）：一进来就判断（useEditRecord），顶部出提示、输入全禁用、不出“删除”和“改了就自动保存”
  const { form, change, off } = ed;
  const rawText = typeof ed.row?.['raw_text'] === 'string' ? ed.row['raw_text'] : '';

  return (
    <EditShell
      prefix="event-edit"
      kind={t(ed.isNew ? 'event.edit.newKind' : 'event.edit.kind', {})}
      backLabel={t('event.edit.back', {})}
      onBack={back}
      rec={ed}
      own={{ empty: t('event.edit.st.empty', {}), rejected: t('event.edit.st.rejected', {}) }}
    >
      <FormGroup>
        <TextInput
          title
          aria-label={t('event.edit.titleLabel', {})}
          placeholder={t('event.edit.titlePh', {})}
          value={form.title}
          maxLength={ITEM_TITLE_MAX}
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
            look="switch"
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
        <Field label={t('event.edit.location', {})} htmlFor="event-location" hint={form.location ? <LocationText text={form.location} /> : undefined}>
          <TextInput
            id="event-location"
            value={form.location}
            maxLength={LOCATION_MAX}
            disabled={off}
            placeholder={t('event.edit.locationPh', {})}
            onCommit={(v) => change({ location: v.trim() })}
            data-testid="event-edit-location"
          />
        </Field>
        <Field label={t('event.edit.project', {})} htmlFor="event-project">
          <TextInput id="event-project" value={form.project} maxLength={PROJECT_MAX} disabled={off} placeholder={t('event.edit.projectPh', {})} onCommit={(v) => change({ project: v.trim() })} />
        </Field>
        <Field label={t('event.edit.note', {})} htmlFor="event-note">
          <TextArea id="event-note" value={form.note} maxLength={NOTE_MAX} disabled={off} placeholder={t('event.edit.notePh', {})} onCommit={(v) => change({ note: v })} />
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
