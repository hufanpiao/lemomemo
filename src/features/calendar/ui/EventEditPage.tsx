// 日程编辑页
// 地址：#/event/<id>（编辑）、#/event/new（新建）。改了就自动保存（文本失焦、选择即存），不弹窗
// • 全天 / 有时刻：有时刻是固定时刻，按“时区”（只让选 Intl 支持的）；和当前时区不同时写出“在你这里是哪天几点”
// • 地点 / 链接：输入框下面用 kit 的 LocationText 显示，能过 safeHref 的才是可点的链接
// • 只读行、删除和撤销：和待办编辑页同一套（kit 的 useEditRecord、EditShell）
// • 时间、详情两组上面各一个小字分组名（kit GroupLabel，同纪念日编辑页）；底部整宽删除行写全“删除这个日程”
// • 开始、结束、时区、提醒都用 kit/components/Pick，不用原生日期、时刻框和系统菜单
// • “全天”开关在标题那一组（同待办编辑页“标题 + 已完成”）；地点下面那一行只在地点是链接时出
import { backOr, useEditRoute } from '../../../app/router-levels.ts';
import { fmtDay } from '../../../../shared/i18n/fmt.ts';
import { EditShell } from '../../../kit/components/EditShell.tsx';
import { Check, Field, FormGroup, GroupLabel, TextArea, TextInput } from '../../../kit/components/Form.tsx';
import { LocationText } from '../../../kit/components/LocationText.tsx';
import { DateTimeField, Select } from '../../../kit/components/Pick/Pick.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { safeHref } from '../../../../shared/logic/link.ts';
import { EVENT_SPAN_MAX_DAYS } from '../../../../shared/logic/calendar/event-span.ts';
import { useCalendarT, type CalendarMsgKey } from '../hooks/useCalendarT.ts';
import { ITEM_TITLE_MAX, LOCATION_MAX, NOTE_MAX, PROJECT_MAX, REMIND_MIN_OPTIONS, useEventEdit, type EventForm } from '../hooks/useEventEdit.ts';

/** 不带参数的那些键（t 的第二个参数要能写成 {}） */
type PlainKey = Exclude<CalendarMsgKey, 'event.edit.tzLocal' | 'event.edit.endRange' | 'event.edit.endTooLong'>;

const minKey = (v: EventForm['remind_min']): PlainKey => (v === null ? 'event.edit.min.none' : (`event.edit.min.${v}` as PlainKey));
const toMin = (v: string): EventForm['remind_min'] => REMIND_MIN_OPTIONS.find((m) => String(m) === v) ?? null;

const back = (): void => backOr('today');

export default function EventEditPage() {
  const { id, key, onCreated } = useEditRoute('event');
  return <EventEditor key={key} id={id} onCreated={onCreated} />;
}

/** 编辑器本身：整页（#/event/<id>）和电脑今天页的详情抽屉（经 ./event-drawer.ts 懒加载）共用；在不在抽屉里由 EditShell 自己看（kit useInDrawer） */
export function EventEditor({ id, onCreated }: { id: string; onCreated(id: string): void }) {
  const t = useCalendarT();
  const ed = useEventEdit(id, onCreated);
  // 只读行：一进来就判断（useEditRecord），顶部出提示、输入全禁用、不出“删除”和“改了就自动保存”
  const { form, change, off } = ed;
  const locale = useUi((u) => u.locale);
  const rawText = typeof ed.row?.['raw_text'] === 'string' ? ed.row['raw_text'] : '';

  return (
    <EditShell
      prefix="event-edit"
      kind={t(ed.isNew ? 'event.edit.newKind' : 'event.edit.kind', {})}
      backLabel={t('event.edit.back', {})}
      onBack={back}
      rec={ed}
      own={{ empty: t('event.edit.st.empty', {}), rejected: t('event.edit.st.rejected', {}) }}
      deleteLabel={t('event.edit.delete', {})}
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
        {/* “全天”开关放在标题那一组（同待办编辑页“标题 + 已完成”） */}
        <Field label="">
          <Check
            label={t('event.edit.allDay', {})}
            checked={form.time === null}
            disabled={off}
            look="switch"
            onChange={(all) => ed.setAllDay(all)}
            data-testid="event-edit-allday"
          />
        </Field>
      </FormGroup>

      <GroupLabel>{t('event.edit.groupTime', {})}</GroupLabel>
      <FormGroup>
        {/* 跨天日程：开始、结束各一行“日期 + 时刻”（全天只有日期）；结束日期不早于开始、最多 31 天（超出的由 useEventEdit 截住） */}
        {/* 开始、结束各一个选择器（有时刻的是“日期 + 时刻”两个值按钮，点哪个都打开同一个；全天只有日期），都不能清空；
            改开始时长不变、结束跟着挪（change 只改 date / time，duration_min 不动）；结束只能选开始当天到 +30 天 */}
        <Field label={t('event.edit.start', {})}>
          <DateTimeField
            mode={form.time !== null ? 'datetime' : 'date'}
            date={form.date}
            time={form.time}
            timeLabel={t('event.edit.startTime', {})}
            disabled={off}
            onDone={(v) => change(form.time !== null ? { date: v.date, time: v.time } : { date: v.date })}
            testIds={{ date: 'event-edit-date', time: 'event-edit-start' }}
          />
        </Field>
        <Field label={t('event.edit.end', {})}>
          <DateTimeField
            mode={form.time !== null ? 'datetime' : 'date'}
            date={ed.endDate}
            time={ed.end}
            timeLabel={t('event.edit.endTime', {})}
            min={form.date || undefined}
            max={ed.endDateMax}
            disabled={off}
            hint={(v) => {
              if (form.date === '') return null;
              // 按真实时长判断，超过上限时“确定”变灰并提示（bad）
              const c = ed.endCheck(v);
              if (c === 'tooLong') return { text: t('event.edit.endTooLong', { n: EVENT_SPAN_MAX_DAYS }), bad: true };
              if (c === 'nextDay') return { text: t('event.edit.endNextDay', {}) };
              return { text: t('event.edit.endRange', { from: fmtDay(form.date, locale, 'num'), to: fmtDay(ed.endDateMax ?? form.date, locale, 'num') }) };
            }}
            onDone={(v) => ed.setEnd(form.time !== null ? { date: v.date, time: v.time } : { date: v.date })}
            testIds={{ date: 'event-edit-end-date', time: 'event-edit-end' }}
          />
        </Field>
        {form.time !== null ? (
          <>
            {/* 时区 400 多项：同一种单选清单，选项区上下滚（打开时滚到选中的那个），不加搜索框 */}
            <Field label={t('event.edit.tz', {})} hint={ed.local ? t('event.edit.tzLocal', { date: ed.local.date, time: ed.local.time }) : undefined}>
              <Select
                value={form.tz ?? ''}
                disabled={off}
                options={ed.tzList.map((z) => ({ value: z, label: z }))}
                onChange={(v) => change({ tz: v })}
                data-testid="event-edit-tz"
              />
            </Field>
            <Field label={t('event.edit.remind', {})}>
              <Select
                value={String(form.remind_min)}
                disabled={off}
                options={REMIND_MIN_OPTIONS.map((v) => ({ value: String(v), label: t(minKey(v), {}) }))}
                onChange={(v) => change({ remind_min: toMin(v) })}
                data-testid="event-edit-remind"
              />
            </Field>
          </>
        ) : (
          <Field label={t('event.edit.remind', {})}>
            <Select
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

      <GroupLabel>{t('event.edit.groupDetail', {})}</GroupLabel>
      <FormGroup>
        {/* 地点是链接（能过 safeHref）时，下面一行显示成可点的链接；普通地名不在下面原样再写一遍 */}
        <Field label={t('event.edit.location', {})} htmlFor="event-location" hint={safeHref(form.location) !== undefined ? <LocationText text={form.location} /> : undefined}>
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
