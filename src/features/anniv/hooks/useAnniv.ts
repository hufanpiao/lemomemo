// 纪念日页面的 hooks（B5 S14、S15）：把 data/ 的规则接到集合、时钟、设置上
// • 列表：读 anniversaries 集合和只读 id，按本机 current_tz 的“今天”现算（每分钟看一次，跨过午夜跟着变）
// • 设置里的默认提醒（anniv.default_offsets、anniv.default_time）：编辑页显示“默认：…”、算“下一次提醒”用；服务器推送照同一份设置算
// • 编辑：kit 的 useEditRecord（改了就自动保存）；表单改动先 normalize（闰月、日子收进有效范围）
import { useCallback, useMemo } from 'react';
import { todayOf } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { settingValue, type SettingRow } from '../../../core/setting-write.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useEditRecord, type EditRecord } from '../../../kit/hooks/useEditRecord.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { clock } from '../../../platform/clock.ts';
import { dateValid, emptyForm, formOf, hasRemind, newRow, normalize, patchOf, type AnnivForm } from '../data/anniv-edit.ts';
import { annivList, type AnnivFilter, type Row } from '../data/anniv-model.ts';

export const TABLE = 'anniversaries';
export const KEY_OFFSETS = 'anniv.default_offsets';
export const KEY_TIME = 'anniv.default_time';

/** 设置里的默认提醒（原值，交给 next-date 的 offsetsOf / remindTimeOf 去认） */
export function useAnnivDefaults(): Readonly<Record<string, unknown>> {
  const rows = useCollection<SettingRow>('settings');
  const offs = settingValue(rows, KEY_OFFSETS);
  const time = settingValue(rows, KEY_TIME);
  return useMemo(() => ({ [KEY_OFFSETS]: offs, [KEY_TIME]: time }), [offs, time]);
}

/** 本机 current_tz 的“今天”（每分钟看一次，跨过午夜跟着变） */
export function useToday() {
  const now = useMinuteNow();
  const tz = currentTz();
  return { now, tz, today: todayOf(now, tz) };
}

export function useAnnivList(filter: AnnivFilter) {
  const rows = useCollection<Row>(TABLE);
  const ro = useReadonlyIds(TABLE);
  const { now, tz, today } = useToday();
  const list = useMemo(() => annivList(rows, today, tz, filter, ro), [rows, today, tz, filter, ro]);
  return { ...list, today, tz, now };
}

export interface AnnivEdit extends EditRecord<AnnivForm> {
  change(p: Partial<AnnivForm>): void;
}

export function useAnnivEdit(id: string, onCreated?: (id: string) => void): AnnivEdit {
  const rec = useEditRecord<AnnivForm>({
    table: TABLE, id, formOf, patchOf, newRow, hasRemind, titleOf: (f) => f.name, ...(onCreated ? { onCreated } : {}),
    emptyForm: () => emptyForm(todayOf(clock.now(), currentTz())),
  });
  const { form, update, markRejected } = rec;
  const change = useCallback(
    (p: Partial<AnnivForm>) => {
      const next = normalize({ ...form, ...p });
      // 月日不存在（R-403）：不写，状态报“这个日期不存在”（选项已经只给存在的日子，这里是兜底）
      if (!dateValid(next)) markRejected();
      else void update(next);
    },
    [form, update, markRejected],
  );
  return { ...rec, change };
}
