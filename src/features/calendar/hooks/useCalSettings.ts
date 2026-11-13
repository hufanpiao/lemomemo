// 设置 › 日历 的读写（B2 FA-3 第二段）：节假日三选一 cal.holidays、周起始 cal.week_start
// • 读本机 settings 集合（同步下来的那一份），月历页和设置页共用；改了以后月历立刻按新值画
// • 写经 kit/hooks/useSettingWriter.ts（进 outbox、本机先生效；和提醒、随手记共用一份，REMIND-settings-core）；写不进本机（切换账号中、本机库不能用）时给 error
// • 连点（代码审查 L6）：同一页里的写一条接一条排队；本机集合里还没出现刚 insert 的那一行时，按记下的 id patch，不再 insert 第二次
//   （不然第二下会撞 (user_id, key) 唯一约束、进“发送失败”）——都在 createSettingWriter 里
// • 已知限制（同 core/ai-settings.ts 的 CONSENT-sugg ②）：本机还没拉到服务器上已有的那一行就 insert，会撞 (user_id, key) 唯一约束、
//   进“发送失败”；同步把那一行拉下来以后再选一次即可。这两个键只在设置页选过才有行，一般碰不到
import { resolveWeekStart, type WeekStart } from '../../../../shared/logic/calendar/cal-nav.ts';
import type { HolidaySetting } from '../../../../shared/logic/calendar/holidays.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { holidayChoice, KEY_HOLIDAYS, KEY_WEEK_START, settingValue, type SettingRow } from '../data/cal-settings.ts';

/** 只读：月历页用（存的原值，交给 holidayCountries / resolveWeekStart 去认） */
export function useCalSettingValues(): { readonly holidays: unknown; readonly weekStart: unknown } {
  const rows = useCollection<SettingRow>('settings');
  return { holidays: settingValue(rows, KEY_HOLIDAYS), weekStart: settingValue(rows, KEY_WEEK_START) };
}

/** 只读：设置首页“日历”一行的摘要用（现在生效的节假日选项，和二级页亮的那一个同一口径） */
export function useCalHolidayChoice(): HolidaySetting {
  const rows = useCollection<SettingRow>('settings');
  const locale = useUi((s) => s.locale);
  return holidayChoice(settingValue(rows, KEY_HOLIDAYS), locale);
}

export function useCalSettings(newId: () => string = () => crypto.randomUUID()) {
  const { rows, save, error } = useSettingWriter(newId);
  const locale = useUi((s) => s.locale);

  return {
    holidays: holidayChoice(settingValue(rows, KEY_HOLIDAYS), locale),
    weekStart: resolveWeekStart(settingValue(rows, KEY_WEEK_START), locale),
    error,
    /** 点了哪个就存哪个——点亮着的那个（没选过、跟界面语言亮的）也存，从此固定（R-97，代码审查 L5，和“每周第一天”一致） */
    setHolidays: (v: HolidaySetting) => save(KEY_HOLIDAYS, v),
    setWeekStart: (v: WeekStart) => save(KEY_WEEK_START, v),
  };
}
