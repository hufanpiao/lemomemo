// 设置 › 日历 的两项（B2 FA-3 第二段，架构 5.12 第 1 点、R-97、数据字典第 9 节）：纯 TS
// • cal.holidays：'cn' | 'kr' | 'both'；没选过时不存这一行，按界面语言推导（中文 → cn、韩文 → kr），选过后固定（holidayCountries）
// • cal.week_start：0–6 的整数（0 周日、1 周一）；没设时按界面语言取默认（resolveWeekStart）
// • 读写一个键（settingValue、settingWrite、SettingRow）在 core/setting-write.ts，和提醒共用一份（REMIND-settings-core、FA-4 代码审查 L7），这里转出；
//   patch 内容仍由 core/setting-patch.ts 的 settingPatch 给（被软删、撤销过的顺带恢复，安全审查 FA3-2：恢复写法只在那一处）
import type { HolidaySetting } from '../../../../shared/logic/calendar/holidays.ts';

export { settingValue, settingWrite, type SettingRow, type SettingWrite } from '../../../core/setting-write.ts';

export const KEY_HOLIDAYS = 'cal.holidays';
export const KEY_WEEK_START = 'cal.week_start';

/** 设置页上“节假日”该亮哪一个：存过的值有效就用它，没存过按界面语言（和 holidayCountries 同一口径） */
export function holidayChoice(v: unknown, locale: 'zh-CN' | 'ko-KR'): HolidaySetting {
  if (v === 'cn' || v === 'kr' || v === 'both') return v;
  return locale === 'ko-KR' ? 'kr' : 'cn';
}
