// 日程编辑页的 hook：把 data/event-edit.ts 的规则接到 kit 的 useEditRecord 上
// • 新建的日程默认今天、9:00、本机时区；“今天”和时区用同一个（本机时区：两边各取一个，半夜前后会差一天）
// • “在你这里是几点”按本机时区换算（比 current_tz 会在电脑上刚建好就提示）
// • 时区只让选 Intl 支持的：不在表里的不写、状态报 rejected
// • 全天 ↔ 有时刻：切成全天前记住原来的时刻、时区、提醒，同一页里切回来时恢复（误点一下不丢“纽约 15:00”）；
//   没记过的（一开始就是全天）切回来用 9:00、本机时区。切成全天保留的是日程自己时区里的日期，不是“在你这里”的日期（两者可能差一天）
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { addDays, todayOf } from '../../../../shared/core/date.ts';
import { EVENT_DURATION_MAX, EVENT_SPAN_MAX_DAYS } from '../../../../shared/logic/calendar/event-span.ts';
import { deviceTz } from '../../../core/current-tz.ts';
import { useEditRecord, type EditRecord } from '../../../kit/hooks/useEditRecord.ts';
import { useTypedTitle } from '../../../kit/hooks/useTypedTitle.ts';
import { clock } from '../../../platform/clock.ts';
import { clearNewDate, pendingNewDate } from './new-date.ts';
import {
  allDayDurationOf, allDayDurationTo, allDayLastOf, durationTo, emptyForm, endAtOf, endsNextDay, formOf, hasRemind, localOf, newEventRow, normalize, patchOf,
  timedDurationOf, tzAllowed, tzChoices, type EventForm,
} from '../data/event-edit.ts';

export type { EventForm } from '../data/event-edit.ts';
export { REMIND_MIN_OPTIONS, ITEM_TITLE_MAX, LOCATION_MAX, PROJECT_MAX, NOTE_MAX } from '../data/event-edit.ts';

/** 没记过原来的时刻时，切回有时刻用这个 */
export const DEFAULT_START = '09:00';

export interface EventEdit extends EditRecord<EventForm> {
  change(p: Partial<EventForm>): void;
  /** 全天 / 有时刻切换（切回来时恢复切走前的时刻、时区、提醒） */
  setAllDay(allDay: boolean): void;
  /** 结束时刻（墙上时间，日程自己的时区）；全天为 null */
  end: string | null;
  /** 结束日期：有时刻的是结束那一刻的日期，全天的是最后一天 */
  endDate: string;
  /** 改结束日期、时刻（可跨多天，最多 31 天）：只给一样时另一样沿用现在的；全天只看 date */
  setEnd(p: { date?: string; time?: string }): void;
  /** 结束日期最晚能选到哪天：开始 + 30 天（共 31 天；有时刻的再晚就超时长上限，干脆不让选）；没日期为 undefined */
  endDateMax: string | undefined;
  /**
   * 选择器里的草稿结束（还没点“确定”）怎么样：'nextDay' 同一天比开始早、算到第二天（照样能确定）；
   * 'tooLong' 按真实时长超过上限（EVENT_DURATION_MAX，“确定”变灰）；null 正常
   */
  endCheck(v: { date: string; time: string }): 'nextDay' | 'tooLong' | null;
  tzList: readonly string[];
  /** 和本机时区不同时：在本机时区是哪天几点 */
  local: { date: string; time: string } | null;
}

export function useEventEdit(id: string, onCreated?: (id: string) => void): EventEdit {
  const rec = useEditRecord<EventForm>({
    table: 'events', id, formOf, titleOf: (f) => f.title, patchOf, newRow: newEventRow, hasRemind, ...(onCreated ? { onCreated } : {}),
    emptyForm: () => {
      const tz = deviceTz();
      // 从日历页点“＋”来的：默认是日历上选中的那天
      return emptyForm(pendingNewDate() ?? todayOf(clock.now(), tz), tz);
    },
  });
  // 表单挂上以后清掉，下次从别处新建不再沿用
  useEffect(() => clearNewDate(), []);
  const { form, update, row, markRejected } = rec;
  const original = typeof row?.['tz'] === 'string' ? row['tz'] : null;
  const change = useCallback(
    (p: Partial<EventForm>) => {
      const next = normalize({ ...form, ...p }, deviceTz());
      if (p.title !== undefined) next.title = p.title.trim();
      // 本机时区一定能写（normalize 补的、切回有时刻用的就是它）：Intl 表里可能没有它（例如 'UTC'）
      if (next.tz !== null && next.tz !== form.tz && !tzAllowed(next.tz, [original, deviceTz()])) {
        markRejected();
        return;
      }
      void update(next);
    },
    [form, update, original, markRejected],
  );
  // 打字条“展开编辑”带过来的字：填进标题、照常保存。AI 助手卡片“改一下”带过来的整条（useTypedTitle 按“记下来”同一个映射拼好的一行）：
  // 换成表单字段一次改完（日子、时刻、时长、提醒、项目、备注和直接记下的一致）
  const typed = useCallback(
    (p: { title?: string; row?: Readonly<Record<string, unknown>> }) => {
      change({ ...(p.row ? formOf(p.row) : {}), ...(p.title !== undefined ? { title: p.title } : {}) });
    },
    [change],
  );
  useTypedTitle(id, typed);
  // 切成全天前记住的：时刻、时区、提醒、时长，加上切成全天时写的时长（allDayDur；切回来时全天的天数没改过才恢复原来的时长）
  const before = useRef<(Pick<EventForm, 'time' | 'tz' | 'remind_min' | 'duration_min'> & { allDayDur: number }) | null>(null);
  const setAllDay = useCallback(
    (allDay: boolean) => {
      if (allDay) {
        if (form.time === null) return;
        const allDayDur = allDayDurationOf(form, deviceTz());
        before.current = { time: form.time, tz: form.tz, remind_min: form.remind_min, duration_min: form.duration_min, allDayDur };
        change({ time: null, ...(allDayDur === form.duration_min ? {} : { duration_min: allDayDur }) });
        return;
      }
      if (form.time !== null) return;
      const b = before.current;
      const timed = b ? { time: b.time, tz: b.tz, remind_min: b.remind_min } : { time: DEFAULT_START };
      const dur = b && b.allDayDur === form.duration_min ? b.duration_min : timedDurationOf(normalize({ ...form, ...timed }, deviceTz()), form.duration_min, deviceTz());
      change({ ...timed, ...(dur === form.duration_min ? {} : { duration_min: dur }) });
    },
    [form, change],
  );
  const endAt = endAtOf(form, deviceTz());
  const setEnd = useCallback(
    (p: { date?: string; time?: string }) => {
      const date = p.date ?? endAt?.date ?? form.date;
      if (date === '' || form.date === '') return;
      if (form.time === null) {
        change({ duration_min: allDayDurationTo(form.date, date) });
        return;
      }
      const time = p.time ?? endAt?.time ?? '';
      if (time !== '') change({ duration_min: durationTo(form, date, time, deviceTz()) });
    },
    [form, endAt?.date, endAt?.time, change],
  );
  const tzList = useMemo(() => tzChoices([original, form.tz, deviceTz()]), [original, form.tz]);
  return {
    ...rec,
    change,
    setAllDay,
    end: endAt?.time ?? null,
    endDate: endAt?.date ?? allDayLastOf(form),
    endDateMax: form.date === '' ? undefined : addDays(form.date, EVENT_SPAN_MAX_DAYS - 1),
    endCheck: (v) => {
      if (form.time === null || form.date === '') return null;
      if (durationTo(form, v.date, v.time, deviceTz()) > EVENT_DURATION_MAX) return 'tooLong';
      return endsNextDay(form, v.date, v.time) ? 'nextDay' : null;
    },
    setEnd,
    tzList,
    local: localOf(form, deviceTz()),
  };
}
