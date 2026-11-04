// 日程编辑页的 hook（B2 FA-2 第一段）：把 data/event-edit.ts 的规则接到 kit 的 useEditRecord 上
// • 新建的日程默认今天、9:00、本机时区；“今天”和时区用同一个（本机时区，代码审查 S4：两边各取一个，半夜前后会差一天）
// • “在你这里是几点”按本机时区换算（架构 4.6“换算成设备当前时区显示”；S4：比 current_tz 会在电脑上刚建好就提示）
// • 时区只让选 Intl 支持的（D7）：不在表里的不写、状态报 rejected（S5）
// • 全天 ↔ 有时刻（S3）：切成全天前记住原来的时刻、时区、提醒，同一页里切回来时恢复（误点一下不丢“纽约 15:00”）；
//   没记过的（一开始就是全天）切回来用 9:00、本机时区。切成全天保留的是日程自己时区里的日期，不是“在你这里”的日期（两者可能差一天）
import { useCallback, useMemo, useRef } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { deviceTz } from '../../../core/current-tz.ts';
import { useEditRecord, type EditRecord } from '../../../kit/hooks/useEditRecord.ts';
import { clock } from '../../../platform/clock.ts';
import {
  durationOf, emptyForm, endOf, formOf, hasRemind, localOf, newEventRow, normalize, patchOf, tzAllowed, tzChoices, type EventForm,
} from '../data/event-edit.ts';

export type { EventForm } from '../data/event-edit.ts';
export { REMIND_MIN_OPTIONS, TITLE_MAX, LOCATION_MAX, PROJECT_MAX, NOTE_MAX } from '../data/event-edit.ts';

/** 没记过原来的时刻时，切回有时刻用这个 */
export const DEFAULT_START = '09:00';

export interface EventEdit extends EditRecord<EventForm> {
  change(p: Partial<EventForm>): void;
  /** 全天 / 有时刻切换（S3：切回来时恢复切走前的时刻、时区、提醒） */
  setAllDay(allDay: boolean): void;
  /** 结束时刻（墙上时间）；全天为 null */
  end: string | null;
  setEnd(end: string): void;
  tzList: readonly string[];
  /** 和本机时区不同时：在本机时区是哪天几点 */
  local: { date: string; time: string } | null;
}

export function useEventEdit(id: string, onCreated?: (id: string) => void): EventEdit {
  const rec = useEditRecord<EventForm>({
    table: 'events', id, formOf, titleOf: (f) => f.title, patchOf, newRow: newEventRow, hasRemind, ...(onCreated ? { onCreated } : {}),
    emptyForm: () => {
      const tz = deviceTz();
      return emptyForm(todayOf(clock.now(), tz), tz);
    },
  });
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
  const before = useRef<Pick<EventForm, 'time' | 'tz' | 'remind_min'> | null>(null);
  const setAllDay = useCallback(
    (allDay: boolean) => {
      if (allDay) {
        if (form.time === null) return;
        before.current = { time: form.time, tz: form.tz, remind_min: form.remind_min };
        change({ time: null });
        return;
      }
      if (form.time !== null) return;
      const b = before.current;
      change(b ? { time: b.time, tz: b.tz, remind_min: b.remind_min } : { time: DEFAULT_START });
    },
    [form.time, form.tz, form.remind_min, change],
  );
  const setEnd = useCallback(
    (end: string) => {
      if (form.time !== null && end !== '') change({ duration_min: durationOf(form.time, end) });
    },
    [form.time, change],
  );
  const tzList = useMemo(() => tzChoices([original, form.tz, deviceTz()]), [original, form.tz]);
  return {
    ...rec,
    change,
    setAllDay,
    end: form.time === null ? null : endOf(form.time, form.duration_min),
    setEnd,
    tzList,
    local: localOf(form, deviceTz()),
  };
}
