// 设置首页“日历”一行右边的值（R-320，定稿线框 s13：“日历 … 农历 · 节假日：中国 ›”；SETTINGS-merge-cards M4）：
// 整行、行名“日历”、点了进二级页都由设置页（kit 的 SettingsEntryRow）画，这里只给值的文字，设置页懒加载它，没到之前值先空着
// • 摘要：中文界面“农历 · 节假日：中国”（中文一律显示农历，R-321）；韩文界面“공휴일: 한국”（韩文不显示农历，R-318）
// • 节假日写的是现在生效的那一个：存过就用存的，没存过按界面语言推导（和二级页亮的那一个同一口径，holidayChoice）
import type { HolidaySetting } from '../../../../shared/logic/calendar/holidays.ts';
import { useCalHolidayChoice } from '../hooks/useCalSettings.ts';
import { useCalViewT } from '../hooks/useCalViewT.ts';

function holShortKey(v: HolidaySetting): 'cal.set.holShort.cn' | 'cal.set.holShort.kr' | 'cal.set.holShort.both' {
  switch (v) {
    case 'cn':
      return 'cal.set.holShort.cn';
    case 'kr':
      return 'cal.set.holShort.kr';
    case 'both':
      return 'cal.set.holShort.both';
  }
}

export default function CalendarSettingsValue() {
  const t = useCalViewT();
  const hol = t(holShortKey(useCalHolidayChoice()), {});
  return <>{t('cal.set.summary', { hol })}</>;
}
