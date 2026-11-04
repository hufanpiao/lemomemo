// 设置首页的“日历”一行（R-320，定稿线框 s13：“日历 … 农历 · 节假日：中国 ›”）：只显示摘要，点了进二级页 #/settings/calendar
// • 摘要：中文界面“农历 · 节假日：中国”（中文一律显示农历，R-321）；韩文界面“공휴일: 한국”（韩文不显示农历，R-318）
// • 节假日写的是现在生效的那一个：存过就用存的，没存过按界面语言推导（和二级页亮的那一个同一口径，holidayChoice）
// • 由设置页经 calendar 的 index.ts 懒加载，挂在“日历”分组（SETTINGS_SECTION_ORDER 的 calendar）
import type { HolidaySetting } from '../../../../shared/logic/calendar/holidays.ts';
import { Pressable } from '../../../motion/components.ts';
import { useCalHolidayChoice } from '../hooks/useCalSettings.ts';
import { useCalViewT } from '../hooks/useCalViewT.ts';
import styles from './CalendarSettings.module.css';

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

export default function CalendarSettingsEntry({ onOpen }: { onOpen(): void }) {
  const t = useCalViewT();
  const hol = t(holShortKey(useCalHolidayChoice()), {});
  return (
    <section aria-labelledby="settings-cal-entry-title">
      {/* 组标题只给读屏（按标题跳读能跳到“日历”这一组）；看得见的“日历”在行里 */}
      <h2 id="settings-cal-entry-title" className={styles.srOnly}>
        {t('cal.set.title', {})}
      </h2>
      <ul className={styles.grp}>
        <li className={styles.row}>
          <Pressable className={styles.rowBtn} onClick={onOpen} data-testid="settings-cal-entry">
            <span className={styles.tx}>{t('cal.set.title', {})}</span>
            <span className={styles.v} data-testid="settings-cal-summary">
              {t('cal.set.summary', { hol })}
            </span>
            <span className={styles.chev} aria-hidden>
              ›
            </span>
          </Pressable>
        </li>
      </ul>
    </section>
  );
}
